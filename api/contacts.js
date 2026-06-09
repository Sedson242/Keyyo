// Vercel Serverless Function -> /api/contacts
// Synchro LIVE des contacts via Microsoft Graph (mode application / client_credentials).
// Renvoie une map normalisee { "+33XXXXXXXXX": "Nom" } consommee par le dashboard.
//
// Variables d'environnement :
//   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET   (app Azure AD)
//   GRAPH_CONTACTS_USER     = UPN de la boite PROPRIETAIRE des contacts partages
// Ciblage d'une liste precise (optionnel, au choix) :
//   GRAPH_CONTACTS_FOLDER_ID = id du dossier
//   GRAPH_CONTACTS_FOLDER    = nom du dossier (ex: "Clients")
// Autres (optionnel) :
//   CONTACTS_DEFAULT_CC=33, GRAPH_AUTHORITY, GRAPH_BASE
//
// Debug : /api/contacts?debug=1  -> nb de contacts bruts + echantillon de champs.

function readCfg() {
  return {
    tenant: process.env.GRAPH_TENANT_ID || 'c21cd161-570d-4f7e-81ac-bc2a2d8963c4',
    clientId: process.env.GRAPH_CLIENT_ID || '26c6eed4-645c-4a90-a14c-9166a9d990e8',
    clientSecret: process.env.GRAPH_CLIENT_SECRET || '6ZL8Q~8BdNtHopmV8fqbTf9YplNPbr-qgUMJiaAc',
    user: process.env.GRAPH_CONTACTS_USER || 'plecorre@bios-expertise.com',
    folderId: process.env.GRAPH_CONTACTS_FOLDER_ID || '',
    folderName: process.env.GRAPH_CONTACTS_FOLDER || '',
    cc: process.env.CONTACTS_DEFAULT_CC || '33',
    authority: (process.env.GRAPH_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
    base: (process.env.GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, ''),
  };
}

function normNum(s, cc) {
  if (s == null) return '';
  let x = String(s).replace(/[^\d+]/g, ''); if (!x) return '';
  if (x.startsWith('00')) x = '+' + x.slice(2);
  if (x[0] !== '+') { if (x.length === 10 && x[0] === '0') x = '+' + cc + x.slice(1); else x = '+' + x; }
  return x;
}
function contactName(c) {
  return (c.displayName && c.displayName.trim())
    || [c.givenName, c.surname].filter(Boolean).join(' ').trim()
    || (c.companyName || '').trim() || null;
}
// Recolte les numeros : champs standards + tout champ dont le nom contient "phone".
function phonesOf(c) {
  const out = [];
  for (const [k, v] of Object.entries(c)) {
    if (!/phone/i.test(k)) continue;
    if (Array.isArray(v)) out.push(...v);
    else if (v) out.push(v);
  }
  return out;
}
function buildMap(contacts, cc) {
  const map = {};
  for (const c of contacts) {
    const name = contactName(c); if (!name) continue;
    for (const n of phonesOf(c)) { const k = normNum(n, cc); if (k && k.length >= 8 && !map[k]) map[k] = name; }
  }
  return map;
}

let _g = { value: null, exp: 0 };
async function graphToken(cfg) {
  const now = Date.now();
  if (_g.value && now < _g.exp - 60000) return _g.value;
  const body = new URLSearchParams({
    client_id: cfg.clientId, client_secret: cfg.clientSecret,
    grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`${cfg.authority}/${cfg.tenant}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const text = await res.text(); let j = {}; try { j = JSON.parse(text); } catch (e) {}
  if (!res.ok || !j.access_token) throw new Error('Graph OAuth (' + res.status + ') : ' + (j.error_description || j.error || text.slice(0, 160)));
  _g.value = j.access_token; _g.exp = now + ((j.expires_in || 3600) * 1000);
  return _g.value;
}
async function graphGetAll(url, token, maxPages = 50) {
  const out = []; let next = url, pages = 0;
  while (next && pages < maxPages) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const text = await res.text(); let j = {}; try { j = JSON.parse(text); } catch (e) {}
    if (!res.ok) throw new Error('Graph ' + res.status + ' : ' + ((j.error && j.error.message) || text.slice(0, 160)));
    if (Array.isArray(j.value)) out.push(...j.value);
    next = j['@odata.nextLink'] || null; pages++;
  }
  return out;
}

export default async function handler(req, res) {
  const cfg = readCfg();
  for (const k of ['tenant', 'clientId', 'clientSecret', 'user']) {
    if (!cfg[k]) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ error: 'Config Graph manquante : ' + k, _need: ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_CONTACTS_USER'] });
    }
  }
  try {
    const token = await graphToken(cfg);
    const select = '$select=displayName,givenName,surname,companyName,mobilePhone,businessPhones,homePhones&$top=999';
    const u = `${cfg.base}/users/${encodeURIComponent(cfg.user)}`;

    // Resolution du dossier : par id, sinon par nom, sinon carnet par defaut.
    let folderId = cfg.folderId;
    if (!folderId && cfg.folderName) {
      const folders = await graphGetAll(`${u}/contactFolders?$select=id,displayName`, token);
      const hit = folders.find(f => (f.displayName || '').toLowerCase() === cfg.folderName.toLowerCase());
      if (!hit) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ error: `Dossier "${cfg.folderName}" introuvable`, dossiers_disponibles: folders.map(f => f.displayName) });
      }
      folderId = hit.id;
    }
    const url = folderId ? `${u}/contactFolders/${encodeURIComponent(folderId)}/contacts?${select}` : `${u}/contacts?${select}`;

    const contacts = await graphGetAll(url, token);

    if (req.query && req.query.debug) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        folder_url: url,
        nb_contacts: contacts.length,
        exemple: contacts.slice(0, 3).map(c => ({
          nom: contactName(c), mobile: c.mobilePhone, business: c.businessPhones, home: c.homePhones,
          champs_presents: Object.keys(c),
        })),
      });
    }

    const map = buildMap(contacts, cfg.cc);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(map);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ error: e.message });
  }
}

export const __test = { normNum, contactName, phonesOf, buildMap };
