// /api/contacts — Annuaire unifié : Microsoft Graph (Outlook) + Répertoire Keyyo.
// Renvoie une map normalisée { "+33XXXXXXXXX": "Nom" } pour le dashboard.
//
// Sources (env CONTACTS_SOURCE = both | graph | keyyo ; défaut both) :
//   - Microsoft Graph : GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_CONTACTS_USER
//                       (+ GRAPH_CONTACTS_FOLDER / GRAPH_CONTACTS_FOLDER_ID)
//   - Répertoire Keyyo : GET /directory_contacts (auth Keyyo déjà configurée)
// En cas de doublon, Graph est prioritaire (modifiable via CONTACTS_PRIORITY=keyyo).
// Debug : /api/contacts?debug=1   (compte par source + échantillons)
import { __test as KEYYO } from './_keyyo.js';

const CC = process.env.CONTACTS_DEFAULT_CC || '33';
function normNum(s, cc = CC) {
  if (s == null) return ''; let x = String(s).replace(/[^\d+]/g, ''); if (!x) return '';
  if (x.startsWith('00')) x = '+' + x.slice(2);
  if (x[0] !== '+') { if (x.length === 10 && x[0] === '0') x = '+' + cc + x.slice(1); else x = '+' + x; }
  return x;
}
function addAll(map, pairs) { for (const [num, name] of pairs) { const k = normNum(num); if (k && k.length >= 8 && name && !map[k]) map[k] = name; } }

/* ---------- HAL ---------- */
function halRecords(payload) {
  const out = [];
  if (Array.isArray(payload)) return payload;
  if (payload && payload._embedded && typeof payload._embedded === 'object') {
    for (const g of Object.values(payload._embedded)) {
      if (Array.isArray(g)) out.push(...g);
      else if (g && typeof g === 'object') { let nested = false; for (const v of Object.values(g)) if (Array.isArray(v)) { out.push(...v); nested = true; } if (!nested) out.push(g); }
    }
  }
  return out;
}

/* ---------- Microsoft Graph ---------- */
let _g = { value: 0, exp: 0 };
async function graphToken(c) {
  const now = Date.now(); if (_g.value && now < _g.exp - 60000) return _g.value;
  const body = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' });
  const res = await fetch(`${c.authority}/${c.tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const t = await res.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
  if (!res.ok || !j.access_token) throw new Error('Graph OAuth (' + res.status + ') : ' + (j.error_description || j.error || t.slice(0, 140)));
  _g.value = j.access_token; _g.exp = now + ((j.expires_in || 3600) * 1000); return _g.value;
}
async function graphAll(url, token, max = 50) {
  const out = []; let next = url, p = 0;
  while (next && p < max) { const res = await fetch(next, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const t = await res.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
    if (!res.ok) throw new Error('Graph ' + res.status + ' : ' + ((j.error && j.error.message) || t.slice(0, 140)));
    if (Array.isArray(j.value)) out.push(...j.value); next = j['@odata.nextLink'] || null; p++; }
  return out;
}
function gName(c) { return (c.displayName && c.displayName.trim()) || [c.givenName, c.surname].filter(Boolean).join(' ').trim() || (c.companyName || '').trim() || null; }
function gPhones(c) { const o = []; for (const [k, v] of Object.entries(c)) { if (!/phone/i.test(k)) continue; if (Array.isArray(v)) o.push(...v); else if (v) o.push(v); } return o; }
async function graphContacts(token, u, folderId, select, depth = 0, seen = new Set()) {
  if (folderId) { if (seen.has(folderId)) return []; seen.add(folderId); }
  const path = folderId ? `${u}/contactFolders/${encodeURIComponent(folderId)}/contacts?${select}` : `${u}/contacts?${select}`;
  let c = []; try { c = await graphAll(path, token); } catch (e) {}
  if (depth < 6) { const ch = folderId ? `${u}/contactFolders/${encodeURIComponent(folderId)}/childFolders?$select=id,displayName` : `${u}/contactFolders?$select=id,displayName`;
    let kids = []; try { kids = await graphAll(ch, token); } catch (e) {}
    for (const k of kids) c = c.concat(await graphContacts(token, u, k.id, select, depth + 1, seen)); }
  return c;
}
async function fromGraph(map) {
  const c = { tenant: process.env.GRAPH_TENANT_ID, clientId: process.env.GRAPH_CLIENT_ID, clientSecret: process.env.GRAPH_CLIENT_SECRET,
    user: process.env.GRAPH_CONTACTS_USER, folderId: process.env.GRAPH_CONTACTS_FOLDER_ID || '', folderName: process.env.GRAPH_CONTACTS_FOLDER || '',
    authority: (process.env.GRAPH_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/+$/, ''), base: (process.env.GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '') };
  if (!c.tenant || !c.clientId || !c.clientSecret || !c.user) return { skipped: 'config Graph absente', count: 0 };
  const token = await graphToken(c);
  const u = `${c.base}/users/${encodeURIComponent(c.user)}`;
  const select = '$select=displayName,givenName,surname,companyName,mobilePhone,businessPhones,homePhones&$top=999';
  let folderId = c.folderId;
  if (!folderId && c.folderName) { const fs = await graphAll(`${u}/contactFolders?$select=id,displayName`, token);
    const hit = fs.find(f => (f.displayName || '').toLowerCase() === c.folderName.toLowerCase());
    if (!hit) return { error: `Dossier Graph "${c.folderName}" introuvable`, dossiers: fs.map(f => f.displayName), count: 0 };
    folderId = hit.id; }
  const contacts = await graphContacts(token, u, folderId, select);
  let n = 0; for (const ct of contacts) { const nm = gName(ct); if (!nm) continue; for (const ph of gPhones(ct)) { const k = normNum(ph); if (k && k.length >= 8 && !map[k]) { map[k] = nm; n++; } } }
  return { count: n, raw: contacts.length };
}

/* ---------- Répertoire Keyyo ---------- */
function deepStrings(o, out = []) { if (o == null) return out; if (typeof o !== 'object') { out.push(String(o)); return out; } for (const v of Object.values(o)) deepStrings(v, out); return out; }
function kName(c) {
  return (c.display_name || c.displayname || c.name || c.fullname || c.full_name || '').toString().trim()
    || [c.firstname || c.first_name || c.given_name, c.lastname || c.last_name || c.surname].filter(Boolean).join(' ').trim()
    || (c.company || c.organization || c.companyname || c.company_name || '').toString().trim() || null;
}
function kPhones(c) {
  const out = [];
  for (const [k, v] of Object.entries(c)) {
    if (/fax/i.test(k)) continue;
    if (!/num|phone|tel|mobile|gsm|portable/i.test(k)) continue;
    if (Array.isArray(v)) for (const x of v) out.push(x && typeof x === 'object' ? (x.number || x.value || x.tel || x.phone) : x);
    else if (v && typeof v === 'object') out.push(v.number || v.value); else out.push(v);
  }
  if (!out.length) for (const s of deepStrings(c)) if (/^\+?[\d .()/-]{8,}$/.test(s)) out.push(s);
  return out.filter(Boolean);
}
async function fromKeyyo(map) {
  let cfg; try { cfg = KEYYO.readConfig(); } catch (e) { return { skipped: 'config Keyyo absente', count: 0 }; }
  let token; try { token = await KEYYO.getAccessToken(cfg); } catch (e) { return { error: 'Auth Keyyo : ' + e.message, count: 0 }; }
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  let url = `${cfg.base}/directory_contacts`, all = [], pages = 0;
  while (url && pages < 50) {
    const res = await fetch(url, { headers }); const t = await res.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
    if (!res.ok) { if (pages === 0) return { error: 'Keyyo ' + res.status + ' : ' + t.slice(0, 120), count: 0 }; break; }
    all.push(...halRecords(j)); const nx = j && j._links && j._links.next && j._links.next.href;
    url = nx ? (nx.startsWith('http') ? nx : new URL(nx, cfg.base + '/').toString()) : null; pages++;
  }
  let n = 0; for (const c of all) { const nm = kName(c); if (!nm) continue; for (const ph of kPhones(c)) { const k = normNum(ph); if (k && k.length >= 8 && !map[k]) { map[k] = nm; n++; } } }
  return { count: n, raw: all.length, sample: all[0] ? Object.keys(all[0]) : null };
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  const source = (process.env.CONTACTS_SOURCE || 'both').toLowerCase();
  const priorityKeyyo = (process.env.CONTACTS_PRIORITY || 'graph').toLowerCase() === 'keyyo';
  const map = {}; const diag = { source };
  try {
    // L'ordre détermine la priorité (le premier qui pose une clé gagne).
    const order = priorityKeyyo ? ['keyyo', 'graph'] : ['graph', 'keyyo'];
    for (const src of order) {
      if (source !== 'both' && source !== src) continue;
      diag[src] = src === 'graph' ? await fromGraph(map) : await fromKeyyo(map);
    }
    if (req.query && req.query.debug) { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ total: Object.keys(map).length, ...diag, exemple: Object.entries(map).slice(0, 6) }); }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(map);
  } catch (e) { res.setHeader('Cache-Control', 'no-store'); res.status(200).json({ error: e.message, ...diag }); }
}

export const __test = { normNum, kName, kPhones, gName, gPhones, halRecords };
