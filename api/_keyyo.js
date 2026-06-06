// =============================================================
//  _keyyo.js  -  Connecteur Manager API Keyyo avec OAuth2 auto.
//
//  AUTH (verifie) : client_credentials NON supporte par Keyyo.
//  -> On utilise un refresh_token (obtenu une fois via le navigateur)
//     pour recuperer automatiquement un access_token frais a chaque appel.
//
//  Manager API :
//    base    : https://api.keyyo.com/manager/1.0
//    auth    : Authorization: Bearer <access_token>
//    chemin  : services/<CSI>/incoming_call_detail | outgoing_call_detail
//    reponse : HAL/JSON (_embedded, pagination _links.next)
//    filtres : filters[<cle>]=<valeur>
//
//  Sortie : { rows, meta } au format STRICT du dashboard :
//   [ ISO, HOUR, CALLER, CALLED, NAT, DUR, SITE, OK, CORR, WD, YM ]
// =============================================================
 
function parseServices(raw) {
  if (!raw) return {};
  const s = String(raw).trim();
  if (s.startsWith('{')) { try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch (e) {} }
  const out = {};
  for (const pair of s.split(/[,;\n]+/)) {
    const i = pair.search(/[=:]/);
    if (i > 0) { const csi = pair.slice(0, i).trim(); const site = pair.slice(i + 1).trim(); if (csi && site) out[csi] = site; }
  }
  if (Object.keys(out).length) return out;
  throw new Error('KEYYO_SERVICES illisible. Format simple: 33175433361=Tana,33253359565=Antsirabe (ou JSON). Recu: "' + s.slice(0, 40) + '"');
}
 
function readConfig() {
  return {
    base: (process.env.KEYYO_API_BASE || 'https://api.keyyo.com/manager/1.0').replace(/\/+$/, ''),
    tokenUrl: process.env.KEYYO_TOKEN_URL || 'https://api.keyyo.com/oauth2/token.php',
    // OAuth2
    clientId: process.env.KEYYO_CLIENT_ID || '6a2407d6d65c9',
    clientSecret: process.env.KEYYO_CLIENT_SECRET || 'f7ef03477334f6fcda947896',
    refreshToken: process.env.KEYYO_REFRESH_TOKEN || '65d74d92cc9e688e614d2072f893464e78b75712',
    staticToken: process.env.KEYYO_TOKEN || 'TY5LT4QwGEX\/CulWFjwKBRMXRNA4D4yaiTFimk77MTaWQtoCovG\/S4yJ7s7i3nvuJxLMMXSOnhuUsggHRKQiTXjeIL9BJE8TjH+wHZWijHOw1vvH1AATtNdq8aZeDnQwfSsVWMpEJ7XHnfwlC2aSHOjArJ17I\/6K63xIsoCkUZxhnyQ4yxI\/WpV8tK7vwKwBvRpfkI+sPGnmRgPr4311uLwpuyNAeCeOZXu9jWAOVXm\/PL2fuZMN4eE2SF7BjeFmPkxxIatCT9GmW7K3WMt91eGPuRWyeDR1YBzJ1a6WV2W9bHcVmOACfX0D',        // fallback : access_token colle a la main
    // Services
    services: parseServices(process.env.KEYYO_SERVICES || '33175433361=Tana,33253359565=Antsirabe'),
    resourcePath: process.env.KEYYO_RESOURCE_PATH || 'services/{csi}/{resource}',
    filterBegin: process.env.KEYYO_FILTER_BEGIN || 'date_begin',
    filterEnd: process.env.KEYYO_FILTER_END || 'date_end',
    sendDateFilters: (process.env.KEYYO_SEND_DATE_FILTERS || '1') === '1',
    historyDays: parseInt(process.env.KEYYO_HISTORY_DAYS || '120', 10),
    localizedNumbers: (process.env.KEYYO_LOCALIZED_NUMBERS || '1') === '1',
    tz: process.env.TZ || 'Europe/Paris',
    maxPages: parseInt(process.env.KEYYO_MAX_PAGES || '50', 10),
  };
}
 
// ---------- OAuth2 : access_token via refresh_token (avec cache memoire) ----------
let _tok = { value: null, exp: 0, rotated: null };
 
async function getAccessToken(cfg) {
  // 1) refresh_token (mode recommande, automatique)
  if (cfg.refreshToken) {
    const now = Date.now();
    if (_tok.value && now < _tok.exp - 60000) return _tok.value;   // cache (marge 60s)
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: _tok.rotated || cfg.refreshToken,
    });
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    const text = await res.text();
    let j = {}; try { j = JSON.parse(text); } catch (e) {}
    if (!res.ok || !j.access_token) {
      throw new Error('OAuth refresh echoue (' + res.status + ') : ' + (j.error_description || j.error || text.slice(0, 160)));
    }
    _tok.value = j.access_token;
    _tok.exp = now + ((j.expires_in ? j.expires_in : 3600) * 1000);
    // Si Keyyo "tourne" le refresh_token, on garde le nouveau en memoire pour l'instance.
    if (j.refresh_token && j.refresh_token !== cfg.refreshToken) _tok.rotated = j.refresh_token;
    return _tok.value;
  }
  // 2) fallback : access_token statique (expire ~1h)
  if (cfg.staticToken) return cfg.staticToken;
  throw new Error('Auth manquante : definir KEYYO_REFRESH_TOKEN (+ CLIENT_ID/SECRET) ou KEYYO_TOKEN');
}
 
// ---------- Helpers ----------
function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const iso = `${p.year}-${p.month}-${p.day}`;
  const wdJs = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return { iso, hour: parseInt(p.hour, 10) % 24, ym: iso.slice(0, 7), wd: (wdJs + 6) % 7 };
}
function parseTimestamp(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) { const n = Number(raw); return new Date(n > 1e12 ? n : n * 1000); }
  const d = new Date(String(raw).trim().replace(' ', 'T')); return isNaN(d.getTime()) ? null : d;
}
function pick(o, names, dflt) { for (const n of names) if (o && o[n] != null && o[n] !== '') return o[n]; return dflt; }
 
function extractRecords(payload) {
  const out = [];
  if (payload && payload._embedded && typeof payload._embedded === 'object') {
    for (const g of Object.values(payload._embedded)) { if (Array.isArray(g)) out.push(...g); else if (g && typeof g === 'object') out.push(g); }
    if (out.length) return out;
  }
  if (Array.isArray(payload)) return payload;
  for (const k of ['call_detail', 'calls', 'data', 'result', 'results', 'items', 'records']) if (Array.isArray(payload?.[k])) return payload[k];
  return out;
}
 
function normalizeRecord(raw, { direction, site, tz }) {
  const ts = parseTimestamp(pick(raw, ['date', 'datetime', 'start_date', 'start', 'setup_date', 'connect_date', 'timestamp', 'ts', 'call_date']));
  if (!ts) return null;
  const caller = String(pick(raw, ['caller', 'calling_number', 'calling', 'from', 'src', 'source'], '')).trim();
  const called = String(pick(raw, ['callee', 'called_number', 'called', 'to', 'dst', 'destination'], '')).trim();
  let dur = pick(raw, ['duration', 'billsec', 'billed_duration', 'real_duration', 'len'], null);
  if (dur == null) {
    const c = parseTimestamp(pick(raw, ['connect_date', 'answer_date'])), r = parseTimestamp(pick(raw, ['release_date', 'end_date', 'hangup_date']));
    dur = (c && r) ? Math.max(0, Math.round((r - c) / 1000)) : 0;
  }
  dur = parseInt(dur, 10); if (isNaN(dur) || dur < 0) dur = 0;
  const nat = direction === 'out' ? 1 : 0;
  const { iso, hour, ym, wd } = localParts(ts, tz);
  return [iso, hour, caller, called, nat, dur, site, dur > 0 ? 1 : 0, nat === 1 ? called : caller, wd, ym];
}
 
function buildUrl(cfg, csi, resource) {
  const path = cfg.resourcePath.replace('{csi}', encodeURIComponent(csi)).replace('{resource}', resource);
  const url = new URL(`${cfg.base}/${path}`);
  if (cfg.sendDateFilters) {
    const until = new Date(), since = new Date(Date.now() - cfg.historyDays * 864e5), d = x => x.toISOString().slice(0, 10);
    url.searchParams.set(`filters[${cfg.filterBegin}]`, d(since));
    url.searchParams.set(`filters[${cfg.filterEnd}]`, d(until));
  }
  if (cfg.localizedNumbers) url.searchParams.set('localized_numbers', '1');
  return url.toString();
}
 
async function fetchJson(url, headers, { retries = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal }); clearTimeout(t);
      const text = await res.text();
      if (!res.ok) {
        const reason = res.headers.get('x-status-reason') || text.slice(0, 200);
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} ${reason}`);
        throw Object.assign(new Error(`HTTP ${res.status} ${reason}`), { fatal: true });
      }
      if (!text) return {};
      try { return JSON.parse(text); } catch { throw Object.assign(new Error('Reponse non-JSON de Keyyo'), { fatal: true }); }
    } catch (e) { clearTimeout(t); lastErr = e; if (e.fatal) throw e; if (attempt < retries) await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); }
  }
  throw lastErr;
}
 
async function fetchResource(cfg, token, csi, site, resource, direction) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  let url = buildUrl(cfg, csi, resource);
  const rows = [];
  for (let page = 0; page < cfg.maxPages && url; page++) {
    const payload = await fetchJson(url, headers);
    for (const rec of extractRecords(payload)) { const row = normalizeRecord(rec, { direction, site, tz: cfg.tz }); if (row) rows.push(row); }
    const next = payload?._links?.next?.href;
    url = next ? (next.startsWith('http') ? next : new URL(next, cfg.base + '/').toString()) : null;
  }
  return rows;
}
 
export async function fetchAllCalls(cfgOverride) {
  const cfg = cfgOverride || readConfig();
  if (!Object.keys(cfg.services).length) throw new Error('KEYYO_SERVICES vide');
 
  const token = await getAccessToken(cfg);     // 1 seul refresh par invocation (puis cache)
 
  const tasks = [];
  for (const [csi, site] of Object.entries(cfg.services)) {
    tasks.push(fetchResource(cfg, token, csi, site, 'outgoing_call_detail', 'out'));
    tasks.push(fetchResource(cfg, token, csi, site, 'incoming_call_detail', 'in'));
  }
  const settled = await Promise.allSettled(tasks);
  const rows = [], errors = [];
  settled.forEach((s, i) => s.status === 'fulfilled' ? rows.push(...s.value) : errors.push(`tache#${i}: ${s.reason?.message || s.reason}`));
  if (rows.length === 0 && errors.length) throw new Error('Aucune donnee recuperee. ' + errors.join(' | '));
 
  rows.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : b[1] - a[1]));
  return { rows, meta: buildMeta(rows), errors };
}
 
function buildMeta(rows) {
  const isos = rows.map(r => r[0]);
  return {
    n: rows.length,
    min: isos.length ? isos.reduce((a, b) => a < b ? a : b) : null,
    max: isos.length ? isos.reduce((a, b) => a > b ? a : b) : null,
    days: new Set(isos).size,
    ym: [...new Set(rows.map(r => r[10]))].sort(),
    sites: [...new Set(rows.map(r => r[6]))].sort(),
  };
}
 
if (process.argv.includes('--selftest')) {
  console.log('Test Keyyo (OAuth refresh + Manager API)...');
  try {
    const { rows, meta, errors } = await fetchAllCalls();
    console.log(`OK : ${rows.length} appels | sites=${meta.sites.join(', ')} | ${meta.min} -> ${meta.max}`);
    if (errors.length) console.warn('Avertissements:', errors);
    if (rows[0]) console.log('Exemple:', JSON.stringify(rows[0]));
  } catch (e) { console.error('ECHEC:', e.message); process.exit(1); }
}