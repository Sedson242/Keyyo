// Sonde TEMPORAIRE : /api/probe
// 1) decouvre le(s) CSI reel(s) via /services (independant de KEYYO_SERVICES)
// 2) teste plusieurs strategies de filtre des call_detail sur le 1er CSI (outgoing)
// 3) reporte pour chacune : count + plage de dates. A SUPPRIMER ensuite.
import { __test } from './_keyyo.js';
const { readConfig, getAccessToken } = __test;

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
    return isFinite(n)&&v!=null&&v!=='' ? new Date(n>1e12?n:n*1000) : new Date(String(v));}).filter(d=>!isNaN(d));
  if(!ts.length) return {min:null,max:null};
  return {min:new Date(Math.min(...ts)).toISOString().slice(0,10), max:new Date(Math.max(...ts)).toISOString().slice(0,10)};
}
async function getJson(url, token){
  const res=await fetch(url,{headers:{Accept:'application/json',Authorization:`Bearer ${token}`}});
  const text=await res.text(); let j; try{j=JSON.parse(text);}catch(e){}
  return {ok:res.ok, status:res.status, j, text};
}
async function tryVariant(base, csi, token, label, params){
  const url=new URL(`${base}/services/${csi}/outgoing_call_detail`);
  for(const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
  try{
    const {ok,status,j,text}=await getJson(url.toString(), token);
    if(!ok) return {label, status, error:text.slice(0,120), url:url.toString()};
    const recs=records(j); const rng=dateRange(recs);
    return {label, status, count:recs.length, min:rng.min, max:rng.max,
      has_next:!!(j&&j._links&&j._links.next), url:url.toString()};
  }catch(e){ return {label, error:e.message, url:url.toString()}; }
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{
    const cfg=readConfig();
    let token;
    try{ token=await getAccessToken(cfg); }
    catch(e){ return res.status(200).json({error:'Auth Keyyo: '+e.message}); }

    // --- Decouverte du CSI en direct ---
    let csis=[];
    try{
      const {ok,j}=await getJson(`${cfg.base}/services`, token);
      if(ok) csis=records(j).map(r=>r&&(r.csi||r.formatted_csi)).filter(Boolean).map(String);
    }catch(e){}
    // repli : valeurs de config si la decouverte echoue
    if(!csis.length) csis=Object.keys(cfg.services||{});
    const csi=csis[0];
    if(!csi) return res.status(200).json({error:'Aucun CSI trouve via /services ni dans KEYYO_SERVICES'});

    const now=Math.floor(Date.now()/1000);
    const since=now-92*86400;                       // 3 mois
    const dISO=u=>new Date(u*1000).toISOString().slice(0,10);

    const variants=[
      ['V0_baseline',{}],
      ['V1_count1000',{count:'1000'}],
      ['V2_filters_date_begin_unix',{'filters[date_begin]':String(since),'filters[date_end]':String(now)}],
      ['V3_filters_date_begin_iso',{'filters[date_begin]':dISO(since),'filters[date_end]':dISO(now)}],
      ['V4_filters_start_time_minmax',{'filters[start_time][min]':String(since),'filters[start_time][max]':String(now)}],
      ['V5_since_until_unix',{since:String(since),until:String(now)}],
      ['V6_date_begin_end_unix',{date_begin:String(since),date_end:String(now)}],
      ['V7_start_end_unix',{start:String(since),end:String(now)}],
      ['V8_count_plus_filters_unix',{count:'1000','filters[date_begin]':String(since),'filters[date_end]':String(now)}],
      ['V9_from_to_unix',{from:String(since),to:String(now)}],
      ['V10_begin_end_iso',{begin:dISO(since),end:dISO(now)}],
    ];
    const results=await Promise.all(variants.map(([l,p])=>tryVariant(cfg.base,csi,token,l,p)));
    res.status(200).json({ csis_decouverts:csis, csi_teste:csi, base:cfg.base,
      window_3mois:{since:dISO(since), until:dISO(now)},
      note:'Cherche la variante status 200 avec le plus gros count ET min proche de since.', results });
  }catch(e){ res.status(500).json({error:e.message}); }
}
