// Vercel Serverless Function -> /api/contacts
// Synchro LIVE des contacts via Microsoft Graph (mode application / client_credentials).
// Lit le carnet d'un mailbox (le propriétaire du dossier partagé) et renvoie une map
// normalisée { "+33XXXXXXXXX": "Nom" } consommée par le dashboard.
//
// Variables d'environnement requises :
//   GRAPH_TENANT_ID        (Directory / tenant ID)
//   GRAPH_CLIENT_ID        (Application client ID)
//   GRAPH_CLIENT_SECRET    (valeur du secret client)
//   GRAPH_CONTACTS_USER    (UPN ou objectId du mailbox propriétaire des contacts)
// Optionnel :
//   GRAPH_CONTACTS_FOLDER_ID  (id d'un dossier de contacts précis ; sinon tous)
//   CONTACTS_DEFAULT_CC       (indicatif pays par défaut, défaut "33")
//   GRAPH_AUTHORITY           (défaut https://login.microsoftonline.com)
//   GRAPH_BASE                (défaut https://graph.microsoft.com/v1.0)

function readCfg() {
  return {
    tenant: process.env.GRAPH_TENANT_ID || 'c21cd161-570d-4f7e-81ac-bc2a2d8963c4',
    clientId: process.env.GRAPH_CLIENT_ID || '26c6eed4-645c-4a90-a14c-9166a9d990e8',
    clientSecret: process.env.GRAPH_CLIENT_SECRET || '6ZL8Q~8BdNtHopmV8fqbTf9YplNPbr-qgUMJiaAc',
    user: process.env.GRAPH_CONTACTS_USER || 'plecorre@bios-expertise.com',
    folder: process.env.GRAPH_CONTACTS_FOLDER_ID || '',
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
function buildMap(contacts, cc) {
  const map = {};
  for (const c of contacts) {
    const name = contactName(c); if (!name) continue;
    const nums = [c.mobilePhone, ...(c.businessPhones || []), ...(c.homePhones || [])].filter(Boolean);
    for (const n of nums) { const k = normNum(n, cc); if (k && k.length >= 8 && !map[k]) map[k] = name; }
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
    // Cibler une liste : par ID (GRAPH_CONTACTS_FOLDER_ID) ou par NOM (GRAPH_CONTACTS_FOLDER)
    let folderId = cfg.folder;
    const folderName = process.env.GRAPH_CONTACTS_FOLDER || 'Clients';
    if (!folderId && folderName) {
      const folders = await graphGetAll(`${u}/contactFolders?$select=id,displayName`, token);
      const hit = folders.find(f => (f.displayName || '').toLowerCase() === folderName.toLowerCase());
      if (!hit) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ error: `Dossier "${folderName}" introuvable`, dossiers_disponibles: folders.map(f => f.displayName) });
      }
      folderId = hit.id;
    }
    const url = folderId ? `${u}/contactFolders/${encodeURIComponent(folderId)}/contacts?${select}` : `${u}/contacts?${select}`;const contacts = await graphGetAll(url, token);
    const map = buildMap(contacts, cfg.cc);
    // Cache CDN 1h : Graph n'est interrogé qu'une fois par heure quel que soit le trafic.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(map);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ error: e.message });
  }
}

export const __test = { normNum, contactName, buildMap };
