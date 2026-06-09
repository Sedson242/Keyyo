// Sonde TEMPORAIRE : /api/probe
// Teste plusieurs strategies de filtrage/pagination des call_detail sur le
// 1er CSI (outgoing) et reporte, pour chacune : count + plage de dates.
// But : identifier la variante qui ramene >= 3 mois. A SUPPRIMER ensuite.

function parseServices(raw){ if(!raw) return {}; const s=String(raw).trim();
  if(s.startsWith('{')){ try{const o=JSON.parse(s); if(o&&typeof o==='object') return o;}catch(e){} }
  const out={}; for(const p of s.split(/[,;\n]+/)){ const i=p.search(/[=:]/); if(i>0){const c=p.slice(0,i).trim(),v=p.slice(i+1).trim(); if(c&&v) out[c]=v;} } return out; }

async function getToken(){
  const body=new URLSearchParams({ client_id:process.env.KEYYO_CLIENT_ID||'6a2407d6d65c9', client_secret:process.env.KEYYO_CLIENT_SECRET||'f7ef03477334f6fcda947896',
    grant_type:'refresh_token', refresh_token:process.env.KEYYO_REFRESH_TOKEN||'65d74d92cc9e688e614d2072f893464e78b75712' });
  const res=await fetch(process.env.KEYYO_TOKEN_URL||'https://api.keyyo.com/oauth2/token.php',
    {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body});
  const t=await res.text(); let j={}; try{j=JSON.parse(t);}catch(e){} return j.access_token||null;
}

function records(payload){
  const out=[];
  if(payload&&payload._embedded&&typeof payload._embedded==='object'){
    for(const g of Object.values(payload._embedded)){ if(Array.isArray(g)) out.push(...g);
      else if(g&&typeof g==='object'){ let nested=false; for(const v of Object.values(g)) if(Array.isArray(v)){out.push(...v);nested=true;} if(!nested) out.push(g); } }
  }
  return out;
}
function dateRange(recs){
  const ts=recs.map(r=>{const v=r.start_time??r.date??r.datetime; const n=Number(v);
    return isFinite(n)? new Date(n>1e12?n:n*1000) : new Date(String(v));}).filter(d=>!isNaN(d));
  if(!ts.length) return {min:null,max:null};
  const min=new Date(Math.min(...ts)), max=new Date(Math.max(...ts));
  return {min:min.toISOString().slice(0,10), max:max.toISOString().slice(0,10)};
}

async function tryVariant(base, csi, token, label, params){
  const url=new URL(`${base}/services/${csi}/outgoing_call_detail`);
  for(const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
  try{
    const res=await fetch(url.toString(),{headers:{Accept:'application/json',Authorization:`Bearer ${token}`}});
    const text=await res.text(); let j; try{j=JSON.parse(text);}catch(e){}
    if(!res.ok) return {label, status:res.status, error:text.slice(0,160), url:url.toString()};
    const recs=records(j); const rng=dateRange(recs);
    return {label, status:res.status, count:recs.length, min:rng.min, max:rng.max,
      has_next:!!(j&&j._links&&j._links.next), url:url.toString()};
  }catch(e){ return {label, error:e.message, url:url.toString()}; }
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{
    const base=(process.env.KEYYO_API_BASE||'https://api.keyyo.com/manager/1.0').replace(/\/+$/,'');
    const csi=Object.keys(parseServices(process.env.KEYYO_SERVICES))[0];
    const token=await getToken(); if(!token) return res.status(200).json({error:'OAuth: pas de token'});

    const now=Math.floor(Date.now()/1000);
    const since=now-92*86400;                       // 3 mois
    const dISO=u=>new Date(u*1000).toISOString().slice(0,10);

    const variants=[
      ['V0_baseline',{}],
      ['V1_count1000',{count:'1000'}],
      ['V2_filters_date_begin_unix',{[`filters[date_begin]`]:String(since),[`filters[date_end]`]:String(now)}],
      ['V3_filters_date_begin_iso',{[`filters[date_begin]`]:dISO(since),[`filters[date_end]`]:dISO(now)}],
      ['V4_filters_start_time_minmax',{[`filters[start_time][min]`]:String(since),[`filters[start_time][max]`]:String(now)}],
      ['V5_since_until_unix',{since:String(since),until:String(now)}],
      ['V6_date_begin_end_unix',{date_begin:String(since),date_end:String(now)}],
      ['V7_start_end_unix',{start:String(since),end:String(now)}],
      ['V8_count_plus_filters_unix',{count:'1000',[`filters[date_begin]`]:String(since),[`filters[date_end]`]:String(now)}],
    ];
    const results=await Promise.all(variants.map(([l,p])=>tryVariant(base,csi,token,l,p)));
    res.status(200).json({ csi, window_3mois:{since:dISO(since), until:dISO(now)},
      note:'Cherche la variante avec le plus gros count ET min proche de la borne since.', results });
  }catch(e){ res.status(500).json({error:e.message}); }
}
