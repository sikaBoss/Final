-- ============================================================
-- Channel — Supabase schema
-- ============================================================
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query).
-- It creates every table, storage bucket, and Row Level Security (RLS)
-- policy that js/app.js, account.html, and admin.html actually call.
--
-- After running this, make your first admin with:
--   UPDATE profiles SET is_admin = true WHERE email = 'you@example.com';
-- (do this after that user has registered through register.html once)
-- ============================================================

create extension if not exists pgcrypto; -- for gen_random_uuid()

-- ============================================================
-- TABLES
-- ============================================================

-- One row per registered user, keyed to Supabase Auth's own user id.
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text not null unique,
  email         text not null unique,
  invite_code   text not null unique,
  invited_by    uuid references profiles(id),
  invite_count  integer not null default 0 check (invite_count >= 0 and invite_count <= 5),
  referral_bonus_paid boolean not null default false, -- currently unused (bonus is a flat amount paid at registration, not per-purchase) — kept for compatibility
  balance       numeric(12,2) not null default 0 check (balance >= 0),
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Products the admin adds; shown on the marketplace.
create table products (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  name            text,
  price           numeric(12,2) not null check (price > 0),
  income_per_day  numeric(12,2) not null default 5 check (income_per_day >= 0),
  days            integer not null default 120 check (days > 0),
  total_income    numeric(12,2),
  image_url       text,
  steps           text,
  created_at      timestamptz not null default now()
);

-- A user's purchase request for a product, and its approval lifecycle.
create table investments (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references profiles(id) on delete cascade,
  product_id              uuid references products(id) on delete set null,
  product_title           text not null,
  payment_screenshot_url  text,
  buyer_email             text, -- email the buyer typed at purchase time, for the admin to cross-check
  status                  text not null default 'pending' check (status in ('pending','approved','rejected')),
  daily_earning           numeric(12,2) not null default 5,
  product_price           numeric(12,2), -- currently unused (kept for compatibility) — the product's price at purchase time
  total_earned            numeric(12,2) not null default 0,
  days_elapsed            integer not null default 0,
  admin_message           text,
  created_at              timestamptz not null default now(),
  approved_at             timestamptz
);

-- Withdrawal requests, approved/rejected by the admin.
create table withdrawals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  amount        numeric(12,2) not null check (amount >= 50),
  phone_number  text not null,
  account_name  text not null, -- name registered to the mobile money number
  network       text not null check (network in ('MTN','Vodafone','AirtelTigo')),
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_message text,
  created_at    timestamptz not null default now()
);

create index idx_profiles_invite_code on profiles(invite_code);
create index idx_investments_user_id on investments(user_id);
create index idx_investments_status on investments(status);
create index idx_withdrawals_user_id on withdrawals(user_id);
create index idx_withdrawals_status on withdrawals(status);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
-- Helper: is the current logged-in user an admin? Defined now that
-- profiles exists. SECURITY DEFINER so it can read profiles.is_admin
-- even before the policies below grant broad SELECT on profiles.
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_admin from profiles p where p.id = auth.uid()),
    false
  );
$$;

-- These policies match what the current client code (app.js /
-- account.html / admin.html) needs to run with only the anon key —
-- there's no backend server, so RLS is the only thing standing
-- between a browser and the database.
--
-- NOTE ON TRUST: a few flows (crediting the +5 GHC invite bonus,
-- daily-earnings accrual, withdrawal balance changes) let a user's
-- own browser write numbers into balance/invite_count/total_earned.
-- The policies below scope *which rows* can be touched correctly,
-- but can't fully verify the *amounts* are legitimate the way a
-- real backend could. For a pilot with people you trust this is a
-- reasonable tradeoff; before real money scales up, move those
-- writes into SECURITY DEFINER RPC functions (a few starter ones
-- are included at the bottom of this file) instead of raw
-- .update() calls from the browser.

alter table profiles    enable row level security;
alter table products    enable row level security;
alter table investments enable row level security;
alter table withdrawals enable row level security;

-- ---------------- profiles ----------------

-- Any logged-in user can read profiles. This is required because:
--  - registration looks up an arbitrary profile by invite_code
--  - admin.html's investments/withdrawals lists join profiles for the username
--  - admin.html's user list shows everyone
-- (This does mean any logged-in user can see other users' balances/emails —
-- acceptable for a small trusted user base; add a column-limiting view
-- later if that's not okay for you.)
create policy "profiles_select_authenticated"
  on profiles for select
  to authenticated
  using (true);

-- A user may only ever create their own profile row (right after signUp).
create policy "profiles_insert_own"
  on profiles for insert
  to authenticated
  with check (id = auth.uid());

-- A user can update their own row, or the row of the person who invited
-- them (needed for the register-time +5 GHC bonus), or an admin can
-- update anyone.
create policy "profiles_update_own_inviter_or_admin"
  on profiles for update
  to authenticated
  using (
    id = auth.uid()
    or is_admin()
    or id = (select invited_by from profiles where id = auth.uid())
  )
  with check (
    id = auth.uid()
    or is_admin()
    or id = (select invited_by from profiles where id = auth.uid())
  );

-- ---------------- products ----------------

-- Anyone (including logged-out visitors browsing the marketplace) can
-- view products.
create policy "products_select_public"
  on products for select
  to anon, authenticated
  using (true);

-- Only admins add/edit/remove products.
create policy "products_insert_admin"
  on products for insert
  to authenticated
  with check (is_admin());

create policy "products_update_admin"
  on products for update
  to authenticated
  using (is_admin())
  with check (is_admin());

create policy "products_delete_admin"
  on products for delete
  to authenticated
  using (is_admin());

-- ---------------- investments ----------------

-- Users see only their own purchase requests; admins see everyone's
-- (needed for the "search by username" approval queue).
create policy "investments_select_own_or_admin"
  on investments for select
  to authenticated
  using (user_id = auth.uid() or is_admin());

-- A user may only create an investment row under their own account.
create policy "investments_insert_own"
  on investments for insert
  to authenticated
  with check (user_id = auth.uid());

-- The owner can update their own row (needed for the daily-earnings
-- accrual write from account.html); admins can update any row (approve/
-- reject). The trigger below stops a non-admin from touching anything
-- other than the earnings-progress columns.
create policy "investments_update_own_or_admin"
  on investments for update
  to authenticated
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());

-- ---------------- withdrawals ----------------

-- Users see only their own withdrawal history; admins see everyone's.
create policy "withdrawals_select_own_or_admin"
  on withdrawals for select
  to authenticated
  using (user_id = auth.uid() or is_admin());

-- A user may only request a withdrawal for themselves.
create policy "withdrawals_insert_own"
  on withdrawals for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from profiles
      where id = auth.uid()
        and created_at <= now() - interval '24 hours'
    )
    -- Ghana (GHC) is UTC+0 year-round (no DST), so UTC day/hour == Ghana local time.
    and extract(dow from (now() at time zone 'UTC')) between 1 and 5
    and extract(hour from (now() at time zone 'UTC')) >= 6
    and extract(hour from (now() at time zone 'UTC')) < 18
  );

-- Only admins approve/reject withdrawal requests.
create policy "withdrawals_update_admin"
  on withdrawals for update
  to authenticated
  using (is_admin())
  with check (is_admin());

-- ============================================================
-- GUARDRAIL TRIGGERS
-- ============================================================
-- RLS above controls *which rows* a user can touch. These triggers
-- add a second check on *which columns* a non-admin is allowed to
-- change on a row they own, since a browser could otherwise send an
-- update that flips status='approved' or sets an arbitrary balance.

create or replace function guard_investment_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if is_admin() then
    return new;
  end if;

  -- Non-admin owner: only the earnings-progress fields may move, and
  -- only forward, and only while the investment is already approved.
  if new.status is distinct from old.status
     or new.admin_message is distinct from old.admin_message
     or new.approved_at is distinct from old.approved_at
     or new.payment_screenshot_url is distinct from old.payment_screenshot_url
     or new.buyer_email is distinct from old.buyer_email
     or new.product_id is distinct from old.product_id
     or new.product_title is distinct from old.product_title
     or new.daily_earning is distinct from old.daily_earning
     or new.product_price is distinct from old.product_price
     or new.user_id is distinct from old.user_id
  then
    raise exception 'Only an admin can change that field.';
  end if;

  if old.status <> 'approved' then
    raise exception 'Investment must be approved before earnings can accrue.';
  end if;

  if new.total_earned < old.total_earned or new.days_elapsed < old.days_elapsed then
    raise exception 'Earnings progress cannot move backwards.';
  end if;

  return new;
end;
$$;

create trigger trg_guard_investment_update
  before update on investments
  for each row execute function guard_investment_update();

-- ============================================================
-- STORAGE BUCKETS
-- ============================================================
-- "products": product images uploaded from the admin panel.
-- "payments": payment screenshots uploaded by buyers.
-- Both are public because app.js reads them back with getPublicUrl().
-- Screenshots can contain personal payment info — if that's a concern,
-- switch this bucket to private and swap getPublicUrl() for a signed
-- URL in app.js/admin.html instead.

insert into storage.buckets (id, name, public)
values ('products', 'products', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('payments', 'payments', true)
on conflict (id) do nothing;

create policy "products_bucket_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'products');

create policy "products_bucket_admin_write"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'products' and is_admin());

create policy "payments_bucket_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'payments');

create policy "payments_bucket_authenticated_upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'payments');

-- ============================================================
-- OPTIONAL, RECOMMENDED HARDENING (not wired into app.js yet)
-- ============================================================
-- These two RPCs do the same thing as the risky direct .update() calls
-- in app.js, but validate the amount server-side instead of trusting
-- whatever number the browser sends. Swap app.js to call
-- supabaseClient.rpc('accrue_investment_earnings', {...}) and
-- supabaseClient.rpc('redeem_invite_bonus', {...}) once you're ready
-- to move past the demo-trust-level policies above.

create or replace function accrue_investment_earnings(p_investment_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  inv investments%rowtype;
  days_elapsed_calc integer;
  should_have_earned numeric;
  gain numeric;
begin
  select * into inv from investments where id = p_investment_id and user_id = auth.uid();
  if not found then
    raise exception 'Investment not found.';
  end if;
  if inv.status <> 'approved' then
    return 0;
  end if;

  days_elapsed_calc := least(
    (select days from products where id = inv.product_id),
    floor(extract(epoch from (now() - inv.approved_at)) / 86400)
  );
  should_have_earned := days_elapsed_calc * inv.daily_earning;
  gain := should_have_earned - inv.total_earned;
  if gain <= 0 then
    return 0;
  end if;

  update investments
    set total_earned = should_have_earned, days_elapsed = days_elapsed_calc
    where id = p_investment_id;

  update profiles set balance = balance + gain where id = auth.uid();

  return gain;
end;
$$;

-- ============================================================
-- PASSWORD RESET BY ACCOUNT BALANCE
-- ============================================================
-- Lets a user reset their own password without an email server, by
-- proving they know the email on the account AND its current balance.
-- SECURITY DEFINER so it can read any profile's balance (not just the
-- caller's) and write directly to auth.users — something the anon key
-- can never do on its own. This is what js/app.js's
-- verifyPasswordReset()/resetPasswordByBalance() call via .rpc().

create or replace function verify_reset_balance(p_email text, p_balance numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  prof profiles%rowtype;
begin
  select * into prof from profiles where lower(email) = lower(trim(p_email));
  if not found then
    raise exception 'We could not find an account with that email address.';
  end if;
  if round(prof.balance,2) <> round(p_balance,2) then
    raise exception 'The email and account balance do not match our records. Please check your details and try again.';
  end if;
  return true;
end;
$$;

create or replace function reset_password_by_balance(p_email text, p_balance numeric, p_new_password text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  prof profiles%rowtype;
begin
  if p_new_password is null or length(p_new_password) < 6 then
    raise exception 'Password must be at least 6 characters.';
  end if;

  select * into prof from profiles where lower(email) = lower(trim(p_email));
  if not found then
    raise exception 'We could not find an account with that email address.';
  end if;
  if round(prof.balance,2) <> round(p_balance,2) then
    raise exception 'The email and account balance do not match our records. Please check your details and try again.';
  end if;

  update auth.users
    set encrypted_password = crypt(p_new_password, gen_salt('bf')),
        updated_at = now()
    where id = prof.id;

  return true;
end;
$$;

grant execute on function verify_reset_balance(text, numeric) to anon, authenticated;
grant execute on function reset_password_by_balance(text, numeric, text) to anon, authenticated;

create or replace function redeem_invite_bonus(p_invite_code text, p_new_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inviter profiles%rowtype;
begin
  select * into inviter from profiles where invite_code = p_invite_code for update;
  if not found then
    return; -- unknown code — silently ignore, matching current app behaviour
  end if;
  if inviter.invite_count >= 5 then
    return; -- code already used up
  end if;

  update profiles
    set invite_count = invite_count + 1, balance = balance + 10
    where id = inviter.id;

  update profiles set invited_by = inviter.id where id = p_new_user_id;
end;
$$;


