// Endpoint de diagnostic TEMPORAIRE : /api/debug
// V2 : sonde plusieurs noms de filtres de date pour trouver celui qui
// elargit la fenetre d'historique. A SUPPRIMER une fois regle.
// Autonome (ne depend pas de _keyyo.js).

function parseServices(raw) {
  if (!raw) return {};
  const s = String(raw).trim();
  if (s.startsWith('{')) { try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch (e) {} }
  const out = {};
  for (const pair of s.split(/[,;\n]+/)) { const i = pair.search(/[=:]/); if (i > 0) { const c = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim(); if (c && v) out[c] = v; } }
  return out;
}

async function getToken() {
  const body = new URLSearchParams({
    client_id: process.env.KEYYO_CLIENT_ID || '6a2407d6d65c9',
    client_secret: process.env.KEYYO_CLIENT_SECRET || 'f7ef03477334f6fcda947896',
    grant_type: 'refresh_token',
    refresh_token: process.env.KEYYO_REFRESH_TOKEN || '65d74d92cc9e688e614d2072f893464e78b75712',
  });
  const res = await fetch(process.env.KEYYO_TOKEN_URL || 'https://api.keyyo.com/oauth2/token.php', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
  });
  const text = await res.text();
  let j = {}; try { j = JSON.parse(text); } catch (e) {}
  return { status: res.status, access_token: j.access_token, error: j.error_description || j.error || (j.access_token ? null : text.slice(0, 200)) };
}

// Extrait les CallDetailRecord d'une reponse HAL et calcule count + periode.
function inspect(json) {
  const recs = [];
  if (json && json._embedded) for (const g of Object.values(json._embedded)) if (Array.isArray(g)) recs.push(...g);
  const times = recs.map(r => parseInt(r.start_time, 10)).filter(n => !isNaN(n));
  const toD = t => new Date(t * 1000).toISOString().slice(0, 10);
  return { count: recs.length, oldest: times.length ? toD(Math.min(...times)) : null, newest: times.length ? toD(Math.max(...times)) : null };
}

async function tryUrl(url, token) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    const text = await res.text(); let j; try { j = JSON.parse(text); } catch (e) {}
    if (res.status !== 200) return { status: res.status, error: (j && (j.error_description || j.error)) || text.slice(0, 120) };
    return { status: 200, ...inspect(j) };
  } catch (e) { return { error: e.message }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const base = (process.env.KEYYO_API_BASE || 'https://api.keyyo.com/manager/1.0').replace(/\/+$/, '');
    const csi = Object.keys(parseServices(process.env.KEYYO_SERVICES))[0];
    if (!csi) return res.status(200).json({ error: 'aucun CSI dans KEYYO_SERVICES' });

    const tok = await getToken();
    if (!tok.access_token) return res.status(200).json({ step: 'oauth', token_status: tok.status, token_error: tok.error });
    const t = tok.access_token;
    const ep = `${base}/services/${csi}/outgoing_call_detail`;

    // Fenetre testee : 365 jours
    const now = Math.floor(Date.now() / 1000);
    const since = now - 365 * 86400;
    const dNow = new Date(now * 1000).toISOString().slice(0, 10);
    const dSince = new Date(since * 1000).toISOString().slice(0, 10);
    const q = (k, v) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;

    // Liste de variantes a tester (libelle -> querystring)
    const variants = {
      '00_baseline_sans_filtre': '',
      '01_limit500': q('limit', 500),
      '02_count500': q('count', 500),
      '03_filters[start_time_after/before]_epoch': `${q('filters[start_time_after]', since)}&${q('filters[start_time_before]', now)}`,
      '04_filters[start_time_min/max]_epoch': `${q('filters[start_time_min]', since)}&${q('filters[start_time_max]', now)}`,
      '05_filters[start_time_begin/end]_epoch': `${q('filters[start_time_begin]', since)}&${q('filters[start_time_end]', now)}`,
      '06_filters[date_begin/date_end]_date': `${q('filters[date_begin]', dSince)}&${q('filters[date_end]', dNow)}`,
      '07_filters[date_begin/date_end]_epoch': `${q('filters[date_begin]', since)}&${q('filters[date_end]', now)}`,
      '08_filters[from/to]_epoch': `${q('filters[from]', since)}&${q('filters[to]', now)}`,
      '09_filters[begin/end]_epoch': `${q('filters[begin]', since)}&${q('filters[end]', now)}`,
      '10_start_time_after/before_nofilters': `${q('start_time_after', since)}&${q('start_time_before', now)}`,
      '11_filters[start_time][min/max]': `${q('filters[start_time][min]', since)}&${q('filters[start_time][max]', now)}`,
    };

    const results = {};
    for (const [label, qs] of Object.entries(variants)) {
      results[label] = await tryUrl(qs ? `${ep}?${qs}` : ep, t);
    }
    res.status(200).json({ csi, endpoint: ep, window_testee: { du: dSince, au: dNow }, resultats: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
}