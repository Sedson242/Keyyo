#!/usr/bin/env node
// Convertit un export CSV de contacts Outlook en contacts.json (numéro E.164 -> nom).
// Usage : node tools/outlook-csv-to-contacts.mjs contacts_outlook.csv > contacts.json
//
// Tolérant aux en-têtes FR et EN. Détecte automatiquement toute colonne dont
// l'intitulé évoque un numéro de téléphone (sauf fax). Le nom est pris dans
// "Display Name"/"Nom complet", sinon "Prénom + Nom".

import fs from 'node:fs';

function parseCSV(text){
  // parseur CSV minimal gérant guillemets et virgules/points-virgules
  const sep = (text.split('\n')[0].match(/;/g)||[]).length > (text.split('\n')[0].match(/,/g)||[]).length ? ';' : ',';
  const rows=[]; let row=[], cur='', q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=c; }
    else { if(c==='"')q=true; else if(c===sep){row.push(cur);cur='';} else if(c==='\n'){row.push(cur);rows.push(row);row=[];cur='';} else if(c==='\r'){} else cur+=c; }
  }
  if(cur.length||row.length){row.push(cur);rows.push(row);}
  return rows.filter(r=>r.some(x=>x.trim()!==''));
}
function normNum(s){
  if(s==null)return''; let x=String(s).replace(/[^\d+]/g,''); if(!x)return'';
  if(x.startsWith('00'))x='+'+x.slice(2);
  if(x[0]!=='+'){ if(x.length===10&&x[0]==='0')x='+33'+x.slice(1); else x='+'+x; }
  return x;
}

const file=process.argv[2];
if(!file){ console.error('Usage: node tools/outlook-csv-to-contacts.mjs <export.csv> > contacts.json'); process.exit(1); }
const rows=parseCSV(fs.readFileSync(file,'utf8'));
const header=rows[0].map(h=>h.trim());
const H=header.map(h=>h.toLowerCase());

const idxDisplay = H.findIndex(h=>/display name|nom complet|nom à afficher|full name/.test(h));
const idxFirst   = H.findIndex(h=>/^first name|^prénom|^prenom/.test(h));
const idxLast    = H.findIndex(h=>/^last name|^nom( de famille)?$/.test(h));
const idxCompany = H.findIndex(h=>/company|société|societe|entreprise/.test(h));
const phoneIdx = H.map((h,i)=>({h,i})).filter(({h})=>/(phone|téléphone|telephone|tel\b|mobile|portable|gsm)/.test(h)&&!/fax/.test(h)).map(({i})=>i);

const out={};
for(let r=1;r<rows.length;r++){
  const row=rows[r];
  let name = idxDisplay>=0 ? (row[idxDisplay]||'').trim() : '';
  if(!name){ const f=(idxFirst>=0?row[idxFirst]:'')||''; const l=(idxLast>=0?row[idxLast]:'')||''; name=(f+' '+l).trim(); }
  if(!name && idxCompany>=0) name=(row[idxCompany]||'').trim();
  if(!name) continue;
  for(const pi of phoneIdx){
    const k=normNum(row[pi]); if(k && k.length>=8 && !out[k]) out[k]=name;
  }
}
const n=Object.keys(out).length;
console.error(`Contacts convertis : ${n} numéro(s). Colonnes téléphone utilisées : ${phoneIdx.map(i=>header[i]).join(', ')||'(aucune)'}.`);
process.stdout.write(JSON.stringify(out,null,2)+'\n');
