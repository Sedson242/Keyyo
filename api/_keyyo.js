// =============================================================
//  _keyyo.js  -  Connecteur Manager API Keyyo (OAuth2 refresh).
//
//  Sortie : { rows, meta, errors, diag } au format STRICT du dashboard :
//   [ ISO, HOUR, CALLER, CALLED, NAT, DUR, SITE, OK, CORR, WD, YM ]
//
//  v2 (hardening) :
//   - normalizeRecord ne jette plus silencieusement : repli sur tout
//     champ ressemblant a un horodatage plausible.
//   - extractRecords plus robuste (recherche profonde dans _embedded).
//   - diag : compte des enregistrements BRUTS vus vs lignes GARDEES,
//     par service/sens -> permet de savoir POURQUOI on a 0 appel.
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
    clientId: process.env.KEYYO_CLIENT_ID || '6a2407d6d65c9',
    clientSecret: process.env.KEYYO_CLIENT_SECRET || 'f7ef03477334f6fcda947896',
    refreshToken: process.env.KEYYO_REFRESH_TOKEN || '65d74d92cc9e688e614d2072f893464e78b75712',
    staticToken: process.env.KEYYO_TOKEN || '',
    services: parseServices(process.env.KEYYO_SERVICES || '33175433361=Tana,33253359565=Antsirabe'),
    resourcePath: process.env.KEYYO_RESOURCE_PATH || 'services/{csi}/{resource}',
    filterBegin: process.env.KEYYO_FILTER_BEGIN || 'date_begin',
    filterEnd: process.env.KEYYO_FILTER_END || 'date_end',
    // Endpoint confirme OK sans filtre -> off par defaut. Mettre a 1 pour tester
    // un filtrage serveur (le format Keyyo attend probablement de l'unix).
    sendDateFilters: (process.env.KEYYO_SEND_DATE_FILTERS || '0') !== '0',
    autoDiscover: (process.env.KEYYO_AUTODISCOVER || '1') !== '0',
    // 'date' (YYYY-MM-DD) | 'datetime' (YYYY-MM-DD HH:MM:SS) | 'unix'
    dateFilterFormat: process.env.KEYYO_DATE_FILTER_FORMAT || 'unix',
    historyDays: parseInt(process.env.KEYYO_HISTORY_DAYS || '120', 10),
    localizedNumbers: (process.env.KEYYO_LOCALIZED_NUMBERS || '1') === '1',
    tz: safeTz(process.env.TZ),
    maxPages: parseInt(process.env.KEYYO_MAX_PAGES || '50', 10),
    // valide les CSI contre /services au demarrage (ralentit un peu, tres instructif)
    validateCsi: (process.env.KEYYO_VALIDATE_CSI || '0') === '1',
  };
}

// ---------- OAuth2 : access_token via refresh_token (cache memoire) ----------
let _tok = { value: null, exp: 0, rotated: null };

async function getAccessToken(cfg) {
  if (cfg.refreshToken) {
    const now = Date.now();
    if (_tok.value && now < _tok.exp - 60000) return _tok.value;
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
    if (j.refresh_token && j.refresh_token !== cfg.refreshToken) _tok.rotated = j.refresh_token;
    return _tok.value;
  }
  if (cfg.staticToken) return cfg.staticToken;
  throw new Error('Auth manquante : definir KEYYO_REFRESH_TOKEN (+ CLIENT_ID/SECRET) ou KEYYO_TOKEN');
}

// ---------- Helpers ----------
// Certains environnements exposent TZ au format POSIX ":UTC" (deux-points en
// tete) que Intl.DateTimeFormat refuse. On nettoie et on valide, avec repli.
function safeTz(tz) {
  let z = String(tz == null ? '' : tz).replace(/^:/, '').trim();
  if (!z) z = 'Europe/Paris';
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: z }); return z; }
  catch (e) {
    try { new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris' }); return 'Europe/Paris'; }
    catch (e2) { return 'UTC'; }
  }
}

function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const iso = `${p.year}-${p.month}-${p.day}`;
  const wdJs = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return { iso, hour: parseInt(p.hour, 10) % 24, min: parseInt(p.minute, 10) || 0, ym: iso.slice(0, 7), wd: (wdJs + 6) % 7 };
}

// Horodatage : accepte unix (s ou ms) et chaines ISO / "YYYY-MM-DD HH:MM:SS".
function parseTimestamp(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' || /^\d{9,}$/.test(String(raw).trim())) {
    const n = Number(raw); if (!isFinite(n)) return null;
    const d = new Date(n > 1e12 ? n : n * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(raw).trim().replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

// Un horodatage "plausible" = entre 2000 et maintenant+2j.
function plausibleDate(d) {
  if (!d || isNaN(d.getTime())) return false;
  const y = d.getUTCFullYear();
  return y >= 2000 && d.getTime() <= Date.now() + 2 * 864e5;
}

function pick(o, names, dflt) { for (const n of names) if (o && o[n] != null && o[n] !== '') return o[n]; return dflt; }

// Repli : si aucun champ nomme ne donne de date, on scanne TOUTES les valeurs
// de l'enregistrement a la recherche d'un horodatage plausible. Empeche le
// rejet silencieux de toutes les lignes si Keyyo nomme le champ autrement.
function findAnyTimestamp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let best = null;
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    if (typeof v === 'object') continue;
    // indices : la cle evoque une date/heure -> priorite
    const looksDateKey = /date|time|heure|start|begin|debut|setup|connect|stamp|ts\b/i.test(k);
    const d = parseTimestamp(v);
    if (plausibleDate(d)) {
      if (looksDateKey) return d;       // match fort, on s'arrete
      if (!best) best = d;              // sinon on retient un candidat
    }
  }
  return best;
}

// Keyyo Manager API (CallDetailRecord) : start_time = unix string,
// quantity = durée en secondes, caller souvent null en entrant -> actual_caller.
const DATE_FIELDS = ['start_time', 'date', 'datetime', 'date_start', 'start_date', 'start', 'call_start', 'begin_date', 'date_begin', 'setup_date', 'connect_date', 'answer_date', 'timestamp', 'ts', 'call_date', 'time', 'heure', 'heure_appel'];
const CALLER_FIELDS = ['caller', 'actual_caller', 'caller_presentation', 'calling_number', 'calling', 'from', 'src', 'source', 'origin', 'a_number', 'caller_number', 'caller_raw', 'actual_caller_raw', 'caller_presentation_raw'];
const CALLED_FIELDS = ['callee', 'called_number', 'called', 'to', 'dst', 'destination', 'b_number', 'called_party', 'callee_raw'];
const DUR_FIELDS = ['quantity', 'quantity_billed', 'duration', 'billsec', 'billed_duration', 'real_duration', 'len', 'call_duration', 'duree', 'talk_duration'];

function normalizeRecord(raw, ctx) {
  const { direction, site, tz } = ctx;
  let ts = parseTimestamp(pick(raw, DATE_FIELDS));
  if (!plausibleDate(ts)) ts = findAnyTimestamp(raw);   // <-- repli anti rejet total
  if (!plausibleDate(ts)) { ctx.dropped && ctx.dropped(raw); return null; }

  const caller = String(pick(raw, CALLER_FIELDS, '')).trim();
  const called = String(pick(raw, CALLED_FIELDS, '')).trim();
  let dur = pick(raw, DUR_FIELDS, null);
  if (dur == null) {
    const c = parseTimestamp(pick(raw, ['connect_date', 'answer_date'])), r = parseTimestamp(pick(raw, ['release_date', 'end_date', 'hangup_date']));
    dur = (c && r) ? Math.max(0, Math.round((r - c) / 1000)) : 0;
  }
  dur = parseInt(dur, 10); if (isNaN(dur) || dur < 0) dur = 0;
  const nat = direction === 'out' ? 1 : 0;
  const { iso, hour, min, ym, wd } = localParts(ts, tz);
  return [iso, hour, caller, called, nat, dur, site, dur > 0 ? 1 : 0, nat === 1 ? called : caller, wd, ym, min];
}

// Extraction robuste : _embedded (a plat ou imbrique), enveloppes connues,
// sinon recherche du premier tableau d'objets dans la reponse.
function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const out = [];
  if (payload._embedded && typeof payload._embedded === 'object') {
    for (const g of Object.values(payload._embedded)) {
      if (Array.isArray(g)) out.push(...g);
      else if (g && typeof g === 'object') {
        // _embedded.<groupe>.<liste>
        let nested = false;
        for (const v of Object.values(g)) if (Array.isArray(v)) { out.push(...v); nested = true; }
        if (!nested) out.push(g);
      }
    }
    if (out.length) return out;
  }
  for (const k of ['call_detail', 'call_details', 'calls', 'data', 'result', 'results', 'items', 'records', 'list']) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  // dernier recours : premier tableau d'objets trouve
  for (const v of Object.values(payload)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return out;
}

// --- Strategies de filtrage des call_detail (auto-decouverte de la bonne) ---
function strategyMakers(cfg) {
  const u = x => String(Math.floor(x.getTime() / 1000));
  const d = x => x.toISOString().slice(0, 10);
  const win = () => ({ since: new Date(Date.now() - cfg.historyDays * 864e5), until: new Date() });
  return [
    { label: 'baseline', make: () => ({}) },
    { label: 'filters_begin_unix', make: () => { const { since, until } = win(); return { [`filters[${cfg.filterBegin}]`]: u(since), [`filters[${cfg.filterEnd}]`]: u(until) }; } },
    { label: 'filters_begin_iso', make: () => { const { since, until } = win(); return { [`filters[${cfg.filterBegin}]`]: d(since), [`filters[${cfg.filterEnd}]`]: d(until) }; } },
    { label: 'filters_start_time_minmax', make: () => { const { since, until } = win(); return { 'filters[start_time][min]': u(since), 'filters[start_time][max]': u(until) }; } },
    { label: 'since_until_unix', make: () => { const { since, until } = win(); return { since: u(since), until: u(until) }; } },
    { label: 'date_begin_end_unix', make: () => { const { since, until } = win(); return { date_begin: u(since), date_end: u(until) }; } },
    { label: 'count_1000', make: () => ({ count: '1000' }) },
    { label: 'param_value_array', make: () => { const { since, until } = win(); return { 'param[0][name]': cfg.filterBegin, 'param[0][value]': u(since), 'param[1][name]': cfg.filterEnd, 'param[1][value]': u(until) }; } },
  ];
}

let _disc; // strategie retenue (cache process) : {label, make} | null
async function discoverStrategy(cfg, token) {
  if (_disc !== undefined) return _disc;
  if (!cfg.autoDiscover) { _disc = null; return null; }
  const csi = Object.keys(cfg.services)[0];
  if (!csi) { _disc = null; return null; }
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  const path = cfg.resourcePath.replace('{csi}', encodeURIComponent(csi)).replace('{resource}', 'outgoing_call_detail');
  // Essais EN PARALLELE (borne le temps total ~8s) pour ne pas provoquer de 504.
  const results = await Promise.allSettled(strategyMakers(cfg).map(async cand => {
    const url = new URL(`${cfg.base}/${path}`);
    for (const [k, v] of Object.entries(cand.make())) url.searchParams.set(k, v);
    if (cfg.localizedNumbers) url.searchParams.set('localized_numbers', '1');
    const payload = await fetchJson(url.toString(), headers, { retries: 0, timeoutMs: 8000 });
    const recs = extractRecords(payload);
    if (!recs.length) return null;
    let oldest = Infinity;
    for (const r of recs) { const ts = parseTimestamp(pick(r, DATE_FIELDS)) || findAnyTimestamp(r); if (ts && ts.getTime() < oldest) oldest = ts.getTime(); }
    return { label: cand.label, make: cand.make, count: recs.length, oldest };
  }));
  let best = null;
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const sc = r.value;
    if (!best || sc.oldest < best.oldest - 864e5 || (Math.abs(sc.oldest - best.oldest) <= 864e5 && sc.count > best.count)) best = sc;
  }
  _disc = best || null;
  return _disc;
}

function buildUrl(cfg, csi, resource, strat) {
  const path = cfg.resourcePath.replace('{csi}', encodeURIComponent(csi)).replace('{resource}', resource);
  const url = new URL(`${cfg.base}/${path}`);
  let params = {};
  if (strat && strat.make) params = strat.make();
  else if (cfg.sendDateFilters) {
    const until = new Date(), since = new Date(Date.now() - cfg.historyDays * 864e5);
    const fmt = (x) => cfg.dateFilterFormat === 'unix' ? String(Math.floor(x.getTime() / 1000)) : cfg.dateFilterFormat === 'datetime' ? x.toISOString().slice(0, 19).replace('T', ' ') : x.toISOString().slice(0, 10);
    params = { [`filters[${cfg.filterBegin}]`]: fmt(since), [`filters[${cfg.filterEnd}]`]: fmt(until) };
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
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
      try { return JSON.parse(text); } catch { throw Object.assign(new Error('Reponse non-JSON de Keyyo (debut: ' + text.slice(0, 80) + ')'), { fatal: true }); }
    } catch (e) { clearTimeout(t); lastErr = e; if (e.fatal) throw e; if (attempt < retries) await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); }
  }
  throw lastErr;
}

async function fetchResource(cfg, token, csi, site, resource, direction, strat, deadline) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  let url = buildUrl(cfg, csi, resource, strat);
  const rows = [];
  let rawSeen = 0, dropped = 0, pages = 0, sampleRaw = null, sampleKeys = null;
  const ctx = { direction, site, tz: cfg.tz, dropped: (r) => { dropped++; if (!sampleRaw) { sampleRaw = r; sampleKeys = Object.keys(r || {}); } } };

  for (let page = 0; page < cfg.maxPages && url && (!deadline || Date.now() < deadline); page++) {
    const payload = await fetchJson(url, headers, { retries: 1, timeoutMs: 9000 });
    const recs = extractRecords(payload);
    rawSeen += recs.length;
    if (!sampleKeys && recs[0]) sampleKeys = Object.keys(recs[0]);
    for (const rec of recs) { const row = normalizeRecord(rec, ctx); if (row) rows.push(row); }
    const next = payload?._links?.next?.href;
    url = next ? (next.startsWith('http') ? next : new URL(next, cfg.base + '/').toString()) : null;
    pages++;
  }
  return { rows, diag: { csi, site, resource, direction, rawSeen, kept: rows.length, dropped, pages, sampleKeys } };
}

async function validateCsis(cfg, token) {
  try {
    const payload = await fetchJson(`${cfg.base}/services`, { Accept: 'application/json', Authorization: `Bearer ${token}` });
    const recs = extractRecords(payload);
    const known = new Set();
    for (const r of recs) for (const v of Object.values(r || {})) if (v != null) known.add(String(v));
    const unknown = Object.keys(cfg.services).filter(csi => !known.has(String(csi)));
    return { servicesSeen: recs.length, unknownCsi: unknown };
  } catch (e) { return { error: e.message }; }
}

export async function fetchAllCalls(cfgOverride) {
  const cfg = cfgOverride || readConfig();
  if (!Object.keys(cfg.services).length) throw new Error('KEYYO_SERVICES vide');

  const token = await getAccessToken(cfg);

  let csiCheck = null;
  if (cfg.validateCsi) csiCheck = await validateCsis(cfg, token);

  const deadline = Date.now() + 25000; // budget global (Vercel coupe à 30s) : on rend ce qu'on a
  const strat = await discoverStrategy(cfg, token);

  const tasks = [];
  for (const [csi, site] of Object.entries(cfg.services)) {
    tasks.push(fetchResource(cfg, token, csi, site, 'outgoing_call_detail', 'out', strat, deadline));
    tasks.push(fetchResource(cfg, token, csi, site, 'incoming_call_detail', 'in', strat, deadline));
  }
  const settled = await Promise.allSettled(tasks);
  const rows = [], errors = [], perTask = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') { rows.push(...s.value.rows); perTask.push(s.value.diag); }
    else errors.push(`tache#${i}: ${s.reason?.message || s.reason}`);
  });

  const rawSeen = perTask.reduce((a, d) => a + d.rawSeen, 0);
  const dropped = perTask.reduce((a, d) => a + d.dropped, 0);

  // Diagnostic explicite : on distingue 3 mondes au lieu de renvoyer "0" muet.
  let hint = null;
  if (rows.length === 0) {
    if (errors.length && rawSeen === 0) {
      throw new Error('Aucune donnee recuperee. ' + errors.join(' | '));
    } else if (rawSeen > 0 && dropped > 0) {
      hint = `Keyyo a renvoye ${rawSeen} enregistrement(s) mais ${dropped} ont ete ecartes a la normalisation `
        + `(champ date/heure non reconnu). Cles vues: ${(perTask.find(d => d.sampleKeys)?.sampleKeys || []).join(', ') || 'n/a'}.`;
    } else {
      hint = `Keyyo a repondu 200 mais 0 enregistrement de detail d'appel. Causes probables : `
        + `CSI errone (les valeurs de KEYYO_SERVICES doivent etre les identifiants de service, pas forcement les numeros), `
        + `fenetre de dates vide, ou cles de filtre/format incorrects. Verifier /api/debug.`;
    }
  }

  rows.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : b[1] - a[1]));
  return {
    rows,
    meta: buildMeta(rows),
    errors: hint ? [...errors, hint] : errors,
    diag: { rawSeen, kept: rows.length, dropped, perTask, csiCheck, strategy: strat ? strat.label : 'baseline' },
  };
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

// export pour tests offline et reutilisation (probe)
export const __test = { extractRecords, normalizeRecord, parseTimestamp, findAnyTimestamp, buildUrl, readConfig, getAccessToken, safeTz };

if (process.argv.includes('--selftest')) {
  console.log('Test Keyyo (OAuth refresh + Manager API)...');
  try {
    const { rows, meta, errors, diag } = await fetchAllCalls();
    console.log(`OK : ${rows.length} appels gardes | ${diag.rawSeen} bruts | sites=${meta.sites.join(', ')} | ${meta.min} -> ${meta.max}`);
    if (errors.length) console.warn('Avertissements:', errors);
    console.log('Diag par tache:'); for (const d of diag.perTask) console.log('  ', JSON.stringify(d));
    if (rows[0]) console.log('Exemple:', JSON.stringify(rows[0]));
  } catch (e) { console.error('ECHEC:', e.message); process.exit(1); }
}
