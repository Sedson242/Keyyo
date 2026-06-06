// Endpoint de diagnostic TEMPORAIRE : /api/debug
// Affiche la reponse brute de l'API Keyyo pour comprendre pourquoi
// le reporting est vide. A SUPPRIMER une fois le probleme resolu.
// Autonome : ne depend pas de _keyyo.js.

function parseServices(raw) {
  if (!raw) return {};
  const s = String(raw).trim();
  if (s.startsWith('{')) { try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch (e) {} }
  const out = {};
  for (const pair of s.split(/[,;\n]+/)) {
    const i = pair.search(/[=:]/);
    if (i > 0) { const c = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim(); if (c && v) out[c] = v; }
  }
  return out;
}

async function getToken() {
  const body = new URLSearchParams({
    client_id: process.env.KEYYO_CLIENT_ID || '',
    client_secret: process.env.KEYYO_CLIENT_SECRET || '',
    grant_type: 'refresh_token',
    refresh_token: process.env.KEYYO_REFRESH_TOKEN || '',
  });
  const res = await fetch(process.env.KEYYO_TOKEN_URL || 'https://api.keyyo.com/oauth2/token.php', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
  });
  const text = await res.text();
  let j = {}; try { j = JSON.parse(text); } catch (e) {}
  return { status: res.status, access_token: j.access_token, error: j.error_description || j.error || (j.access_token ? null : text.slice(0, 200)) };
}

// Reduit les gros tableaux _embedded a { count, sample } pour rester lisible.
function summarize(json) {
  if (!json || typeof json !== 'object') return json;
  const o = Array.isArray(json) ? { _array_count: json.length, _array_sample: json[0] ?? null } : { ...json };
  if (o._embedded && typeof o._embedded === 'object') {
    const emb = {};
    for (const [k, v] of Object.entries(o._embedded)) emb[k] = Array.isArray(v) ? { count: v.length, sample: v[0] ?? null } : v;
    o._embedded = emb;
  }
  return o;
}

async function raw(url, token) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (e) {}
    return { url, status: res.status, body: json ? summarize(json) : text.slice(0, 600) };
  } catch (e) { return { url, error: e.message }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const base = (process.env.KEYYO_API_BASE || 'https://api.keyyo.com/manager/1.0').replace(/\/+$/, '');
    const services = parseServices(process.env.KEYYO_SERVICES);
    const csiList = Object.keys(services);
    const csi = csiList[0];

    const tok = await getToken();
    if (!tok.access_token) {
      return res.status(200).json({ step: 'oauth', token_status: tok.status, token_error: tok.error, services_config: services });
    }
    const t = tok.access_token;
    const out = {
      env: { base, csi_configures: csiList, services_map: services },
      oauth: { status: tok.status, token_ok: true },
      A_services: await raw(`${base}/services`, t),
      B_service_detail: csi ? await raw(`${base}/services/${csi}`, t) : '(aucun CSI configuré)',
      C_outgoing_sans_filtre: csi ? await raw(`${base}/services/${csi}/outgoing_call_detail`, t) : null,
      D_incoming_sans_filtre: csi ? await raw(`${base}/services/${csi}/incoming_call_detail`, t) : null,
    };
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
