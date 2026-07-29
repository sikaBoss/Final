
// Channel - Config & Storage Adapter
// Works in DEMO mode (localStorage) until you set Supabase keys

// The previous Supabase project (gtbsprhwndhxartzswpv) was deleted, so these
// are placeholders again. Create a new project, run schema.sql against it,
// then paste in its Project URL and anon/publishable key below (Project
// Settings → API). Until you do, the site runs in local demo mode
// (data saved in this browser's localStorage only).
const SUPABASE_URL = "https://gpuduhbppishyhfjlrmi.supabase.co"; // e.g. https://abcdefghijk.supabase.co
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwdWR1aGJwcGlzaHloZmpscm1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNjAxMzAsImV4cCI6MjEwMDkzNjEzMH0.yu3Vkjv4Fx56C1ykdKkWT02exM1F4Q8lSm-ekC6vWcY"; // Project Settings → API → anon/public key

const isSupabaseConfigured = () => {
  return SUPABASE_URL.includes('.supabase.co') && !SUPABASE_URL.includes('YOUR_PROJECT') && SUPABASE_ANON_KEY.length > 30;
};

let supabaseClient = null;
try{
  if(isSupabaseConfigured() && window.supabase){
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
}catch(e){ console.warn('Supabase init failed, using local mode', e); }

function genCode(){ return 'CH-'+Math.random().toString(36).substring(2,7).toUpperCase(); }
function toast(m){
  let t=document.createElement('div'); t.className='toast'; t.textContent=m;
  document.body.appendChild(t); setTimeout(()=>t.remove(),3500);
}

// Local DB fallback
const LS = {
  get(k, def){ try{ return JSON.parse(localStorage.getItem(k)) ?? def; }catch{ return def; } },
  set(k,v){ localStorage.setItem(k, JSON.stringify(v)); }
};

// Seed demo products if empty
function seedLocal(){
  let products = LS.get('channel_products', null);
  if(!products){
    products = [
      {id:'p1',title:'Channel Starter Pack',name:'Starter',price:200,income_per_day:5,days:120,total_income:600,image_url:'https://images.unsplash.com/photo-1555529771-7888783a18d3?w=600',steps:'1. Send 200 GHC to MTN 059XXXXXXX\n2. Name: Channel Investment\n3. Upload screenshot',created_at:new Date().toISOString()},
      {id:'p2',title:'Channel Growth Fund',name:'Growth',price:500,income_per_day:5,days:120,total_income:600,image_url:'https://images.unsplash.com/photo-1553729459-efe14ef6055d?w=600',steps:'1. Send 500 GHC to MTN 059XXXXXXX\n2. Upload proof',created_at:new Date().toISOString()},
      {id:'p3',title:'Channel Premium Pro',name:'Premium',price:1000,income_per_day:5,days:120,total_income:600,image_url:'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=600',steps:'1. Send 1000 GHC\n2. Keep reference',created_at:new Date().toISOString()},
    ];
    LS.set('channel_products', products);
  }
}
seedLocal();
