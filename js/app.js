
// Chanel - Core Logic (works with Supabase or Local)
const INVITE_BONUS_AMOUNT = 15; // flat GHC bonus paid to the referrer when a friend registers with their code

const Store = {
  // PRODUCTS
  async getProducts(){
    if(supabaseClient){
      const {data,error}=await supabaseClient.from('products').select('*').order('created_at',{ascending:false});
      if(error) throw error; return data;
    }else{
      return LS.get('Chanel_products', []);
    }
  },
  async addProduct(p){
    const payload = {
      title: p.title,
      name: p.name || '',
      price: Number(p.price),
      income_per_day: Number(p.income_per_day) || 5,
      days: Number(p.days) || 120,
      steps: p.steps || '',
      total_income: (Number(p.income_per_day) || 5) * ((Number(p.days)/1.5) || 120),
      image_url: p.image_url || ''
    };

    if(supabaseClient){
      // Upload the image first. The public URL is then saved with the product row.
      if(p.file){
        const safeName = p.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const name = 'product_' + Date.now() + '_' + safeName;
        const {error: uploadError} = await supabaseClient.storage.from('products').upload(name, p.file, {upsert:false});
        if(uploadError) throw new Error('Product image upload failed: ' + uploadError.message + '. Make sure the Supabase "products" storage bucket exists and is public.');
        const {data:urlData} = supabaseClient.storage.from('products').getPublicUrl(name);
        payload.image_url = urlData.publicUrl;
      }
      if(!payload.image_url) payload.image_url = 'https://via.placeholder.com/600x400?text=Chanel+Product';
      const {data,error} = await supabaseClient.from('products').insert(payload).select().single();
      if(error) throw new Error('Product could not be saved: ' + error.message);
      return data;
    }

    const list = LS.get('Chanel_products', []);
    list.unshift({id:'p'+Date.now(), ...payload, image_url:payload.image_url || 'https://via.placeholder.com/600x400?text=Chanel+Product', created_at:new Date().toISOString()});
    LS.set('Chanel_products', list);
    return list[0];
  },

  async updateProduct(id, p){
    const payload = {
      title: p.title,
      name: p.name || '',
      price: Number(p.price),
      income_per_day: Number(p.income_per_day) || 5,
      days: Number(p.days) || 120,
      steps: p.steps || '',
      total_income: (Number(p.income_per_day) || 5) * (Number(p.days) || 120),
      image_url: p.image_url || ''
    };

    if(supabaseClient){
      if(p.file){
        const safeName = p.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const name = 'product_' + Date.now() + '_' + safeName;
        const {error: uploadError} = await supabaseClient.storage.from('products').upload(name, p.file, {upsert:false});
        if(uploadError) throw new Error('Product image upload failed: ' + uploadError.message);
        const {data:urlData} = supabaseClient.storage.from('products').getPublicUrl(name);
        payload.image_url = urlData.publicUrl;
      }
      if(!payload.image_url) payload.image_url = 'https://via.placeholder.com/600x400?text=Chanel+Product';
      const {data,error} = await supabaseClient.from('products').update(payload).eq('id',id).select().single();
      if(error) throw new Error('Product could not be updated: ' + error.message);
      return data;
    }

    const list = LS.get('Chanel_products', []);
    const idx = list.findIndex(x=>x.id===id);
    if(idx===-1) throw new Error('Product not found');
    if(!payload.image_url) payload.image_url = list[idx].image_url || 'https://via.placeholder.com/600x400?text=Chanel+Product';
    list[idx] = {...list[idx], ...payload};
    LS.set('Chanel_products', list);
    return list[idx];
  },

  async deleteProduct(id){
    if(supabaseClient){
      const {error} = await supabaseClient.from('products').delete().eq('id',id);
      if(error) throw new Error('Product could not be deleted: ' + error.message);
      return;
    }
    const list = LS.get('Chanel_products', []).filter(x=>x.id!==id);
    LS.set('Chanel_products', list);
  },

  // AUTH / PROFILES
  
  async register({username,email,password,inviteCode}){
    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();
    if(supabaseClient){
      // Check the public profile table first so a repeat registration gets
      // a clear message instead of a raw database/auth error.
      const {data:existingUsername, error:usernameCheckError} = await supabaseClient
        .from('profiles').select('id').ilike('username', cleanUsername).maybeSingle();
      if(usernameCheckError) throw new Error('We could not check your username right now. Please try again.');
      if(existingUsername) throw new Error('An account with that username already exists. Please log in instead.');

      const {data:existingEmail, error:emailCheckError} = await supabaseClient
        .from('profiles').select('id').ilike('email', cleanEmail).maybeSingle();
      if(emailCheckError) throw new Error('We could not check your email right now. Please try again.');
      if(existingEmail) throw new Error('An account with that email already exists. Please log in instead.');

      const {data,error} = await supabaseClient.auth.signUp({email:cleanEmail,password});
      if(error) throw error;

      // Depending on Auth's email-confirmation setting, Supabase may return
      // an existing user without a normal error — don't let that silently
      // create a duplicate profile or claim registration succeeded.
      if(data.user?.identities && data.user.identities.length === 0)
        throw new Error('An account with that email already exists. Please log in instead.');

      const uid = data.user?.id;
      if(!uid) throw new Error('Signup failed. Please try again.');

      let invitedBy = null;
      let inviter = null;

      if(inviteCode){
        const {data:inv, error:invErr} = await supabaseClient
          .from('profiles').select('id,invite_count,balance,invite_code')
          .eq('invite_code',inviteCode).maybeSingle();
        if(invErr) throw invErr;
        if(inv){
          const count = Number(inv.invite_count || 0);
          if(count >= 5) throw new Error('This invite code has expired - max 5 uses reached');
          inviter = inv;
          invitedBy = inv.id;
        }
      }

      let myCode, ins;
      for(let attempt=0; attempt<5; attempt++){
        myCode = genCode();
        const result = await supabaseClient.from('profiles').insert({
          id:uid, username:cleanUsername, email:cleanEmail, invite_code:myCode, invited_by:invitedBy,
          invite_count:0, balance:0, is_admin: cleanEmail==='admin@Chanel.com'
        });
        ins = result.error;
        if(!ins) break; // inserted fine
        // A collision on the randomly-generated invite_code is an internal
        // detail, not a real conflict — just try again with a new code.
        const isInviteCodeCollision = /invite_code/i.test(ins.message || '') || /invite_code/i.test(ins.details || '');
        if(!isInviteCodeCollision) break; // some other error — stop and surface it below
      }
      if(ins){
        if(/username/i.test(ins.message||'') || /username/i.test(ins.details||'')){
          throw new Error('An account with that username already exists. Please log in instead.');
        }
        if(/email/i.test(ins.message||'') || /email/i.test(ins.details||'')){
          throw new Error('An account with that email already exists. Please log in instead.');
        }
        throw ins;
      }

      // Pay the referrer their flat bonus immediately, and count this
      // registration against their code's 3-use cap.
      if(inviter){
        const nextCount = Number(inviter.invite_count || 0) + 1;
        const {error:bonusErr} = await supabaseClient.from('profiles')
          .update({invite_count:nextCount, balance:Number(inviter.balance || 0)+INVITE_BONUS_AMOUNT})
          .eq('id',inviter.id).lt('invite_count',5);
        if(bonusErr) throw bonusErr;
      }

      return {code:myCode, session:data.session, user:data.user};
    }else{
      let users=LS.get('Chanel_users',[]);
      if(users.find(u=>u.username.toLowerCase()===cleanUsername.toLowerCase())) throw new Error('An account with that username already exists. Please log in instead.');
      if(users.find(u=>u.email.toLowerCase()===cleanEmail)) throw new Error('An account with that email already exists. Please log in instead.');

      const myCode=genCode();
      let invitedBy=null;
      const inviter=inviteCode ? users.find(u=>u.invite_code===inviteCode) : null;
      if(inviter){
        if((inviter.invite_count||0)>=5) throw new Error('This invite code has expired - max 5 uses reached');
        invitedBy=inviter.id;
      }

      const newUser={id:'u'+Date.now(),username:cleanUsername,email:cleanEmail,password,invite_code:myCode,invited_by:invitedBy,invite_count:0,balance:0,created_at:new Date().toISOString(),is_admin: cleanEmail==='admin@Chanel.com'};
      users.push(newUser);
      if(inviter){ inviter.invite_count=(inviter.invite_count||0)+1; inviter.balance=(inviter.balance||0)+INVITE_BONUS_AMOUNT; }
      LS.set('Chanel_users',users);
      LS.set('Chanel_session',newUser);
      return {code:myCode, session:true, user:newUser};
    }
  },


  async login(email,password){
    if(supabaseClient){
      const {data,error}=await supabaseClient.auth.signInWithPassword({email,password});
      if(error) throw error;
      return data.user;
    }else{
      const users=LS.get('Chanel_users',[]);
      const u=users.find(x=>x.email===email && x.password===password);
      if(!u) throw new Error('Invalid email or password');
      LS.set('Chanel_session', u);
      return u;
    }
  },

  async getCurrentUser(){
    if(supabaseClient){
      const {data:{user}}=await supabaseClient.auth.getUser();
      if(!user) return null;
      const {data:prof}=await supabaseClient.from('profiles').select('*').eq('id',user.id).single();
      return prof;
    }else{
      return LS.get('Chanel_session', null);
    }
  },

  async logout(){
    if(supabaseClient){ await supabaseClient.auth.signOut(); }
    else{ localStorage.removeItem('Chanel_session'); }
  },

  // PASSWORD RESET — verified by email + current account balance
  // (no email server needed). Step 1 checks the pair matches; step 2
  // actually changes the password once step 1 has passed.
  async verifyPasswordReset(email, balance){
    const cleanEmail = email.trim().toLowerCase();
    const cleanBalance = Number(balance);
    if(!cleanEmail) throw new Error('Please enter the email address on your account.');
    if(balance === '' || !Number.isFinite(cleanBalance) || cleanBalance < 0) throw new Error('Please enter your current account balance.');

    if(supabaseClient){
      const {data, error} = await supabaseClient.rpc('verify_reset_balance', {p_email:cleanEmail, p_balance:cleanBalance});
      if(error) throw new Error(error.message || 'The email and account balance do not match our records. Please check your details and try again.');
      if(!data) throw new Error('The email and account balance do not match our records. Please check your details and try again.');
      return {verified:true, email:cleanEmail};
    }

    const users = LS.get('Chanel_users', []);
    const user = users.find(u => String(u.email||'').toLowerCase() === cleanEmail);
    if(!user) throw new Error('We could not find an account with that email address.');
    if(Number(user.balance||0).toFixed(2) !== cleanBalance.toFixed(2)) throw new Error('The email and account balance do not match our records. Please check your details and try again.');
    return {verified:true, email:cleanEmail};
  },

  async resetPasswordByBalance(email, balance, newPassword){
    const cleanEmail = email.trim().toLowerCase();
    const cleanBalance = Number(balance);
    if(!newPassword || newPassword.length < 6) throw new Error('Password must be at least 6 characters.');

    if(supabaseClient){
      const {data, error} = await supabaseClient.rpc('reset_password_by_balance', {p_email:cleanEmail, p_balance:cleanBalance, p_new_password:newPassword});
      if(error) throw new Error(error.message || 'We could not update your password. Please try again.');
      if(!data) throw new Error('We could not update your password. Please try again.');
      return {success:true};
    }

    const users = LS.get('Chanel_users', []);
    const user = users.find(u => String(u.email||'').toLowerCase() === cleanEmail);
    if(!user) throw new Error('We could not find an account with that email address.');
    if(Number(user.balance||0).toFixed(2) !== cleanBalance.toFixed(2)) throw new Error('The email and account balance do not match our records. Please check your details and try again.');
    user.password = newPassword;
    LS.set('Chanel_users', users);
    return {success:true};
  },

  // INVESTMENTS
  async createInvestment({username, email, product, screenshotFile}){
    let userId, screenshotUrl;
    if(supabaseClient){
      const {data:prof}=await supabaseClient.from('profiles').select('id,email').eq('username',username).single();
      if(!prof) throw new Error('Username not found');
      if(email && prof.email && email.toLowerCase()!==prof.email.toLowerCase()){
        throw new Error('That email does not match the account for this username.');
      }
      userId=prof.id;
      if(screenshotFile){
        const name=Date.now()+'_'+screenshotFile.name;
        const {error}=await supabaseClient.storage.from('payments').upload(name,screenshotFile);
        if(error) throw error;
        const {data}=supabaseClient.storage.from('payments').getPublicUrl(name);
        screenshotUrl=data.publicUrl;
      }
      const {error}=await supabaseClient.from('investments').insert({user_id:userId,product_id:product.id,product_title:product.title,product_price:product.price,buyer_email:email,payment_screenshot_url:screenshotUrl,status:'pending',daily_earning:product.income_per_day});
      if(error) throw error;
    }else{
      const users=LS.get('Chanel_users',[]);
      const u=users.find(x=>x.username===username);
      if(!u) throw new Error('Username not found');
      if(email && u.email && email.toLowerCase()!==u.email.toLowerCase()){
        throw new Error('That email does not match the account for this username.');
      }
      userId=u.id;
      screenshotUrl = screenshotFile ? URL.createObjectURL(screenshotFile) : product.image_url;
      const invs=LS.get('Chanel_investments',[]);
      invs.push({id:'inv'+Date.now(),user_id:userId,product_id:product.id,product_title:product.title,product_price:product.price,buyer_email:email,payment_screenshot_url:screenshotUrl,status:'pending',daily_earning:product.income_per_day,total_earned:0,days_elapsed:0,created_at:new Date().toISOString(),approved_at:null});
      LS.set('Chanel_investments',invs);
    }
  },

  async getMyInvestments(userId){
    if(supabaseClient){
      const {data}=await supabaseClient.from('investments').select('*').eq('user_id',userId).order('created_at',{ascending:false});
      return data||[];
    }else{
      return LS.get('Chanel_investments',[]).filter(i=>i.user_id===userId).reverse();
    }
  },

  // EARNINGS - process daily
  async processEarnings(user){
    let investments=await this.getMyInvestments(user.id);
    let approved=investments.filter(i=>i.status==='approved');
    let gain=0;
    for(let inv of approved){
      const start=new Date(inv.approved_at);
      const now=new Date();
      const days=Math.min(120, Math.floor((now-start)/86400000));
      const should=days*(inv.daily_earning||5);
      const diff=should-(inv.total_earned||0);
      if(diff>0){
        gain+=diff;
        inv.total_earned=should; inv.days_elapsed=days;
        if(supabaseClient){
          await supabaseClient.from('investments').update({total_earned:should,days_elapsed:days}).eq('id',inv.id);
        }
      }
    }
    if(!supabaseClient && gain>0){
      LS.set('Chanel_investments', LS.get('Chanel_investments',[]).map(i=>{
        const updated=investments.find(u=>u.id===i.id);
        return updated?updated:i;
      }));
    }
    if(gain>0){
      if(supabaseClient){
        await supabaseClient.from('profiles').update({balance:(user.balance||0)+gain}).eq('id',user.id);
      }else{
        let users=LS.get('Chanel_users',[]);
        let me=users.find(u=>u.id===user.id);
        if(me){ me.balance=(me.balance||0)+gain; LS.set('Chanel_users',users); LS.set('Chanel_session',me); }
      }
      return gain;
    }
    return 0;
  }
};

window.Store=Store;
