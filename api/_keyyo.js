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
  // null => mode AUTO : les lignes sont decouvertes via GET /services (toutes les
  // lignes du compte, donc les 3, sans rien coder en dur).
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'auto') return null;
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
    services: parseServices(process.env.KEYYO_SERVICES || 'auto'),
    syncDays: parseInt(process.env.KEYYO_SYNC_DAYS || '7', 10),
    resourcePath: process.env.KEYYO_RESOURCE_PATH || 'services/{csi}/{resource}',
    filterBegin: process.env.KEYYO_FILTER_BEGIN || 'date_start',
    filterEnd: process.env.KEYYO_FILTER_END || 'date_end',
    pageLimit: parseInt(process.env.KEYYO_PAGE_LIMIT || '500', 10),
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
  const fmt = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const iso = `${p.year}-${p.month}-${p.day}`;
  const wdJs = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return { iso, hour: parseInt(p.hour, 10) % 24, min: parseInt(p.minute, 10) || 0, sec: parseInt(p.second, 10) || 0, ym: iso.slice(0, 7), wd: (wdJs + 6) % 7 };
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
  const { iso, hour, min, sec, ym, wd } = localParts(ts, tz);
  return [iso, hour, caller, called, nat, dur, site, dur > 0 ? 1 : 0, nat === 1 ? called : caller, wd, ym, min, sec];
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

// --- Filtres de dates CONFORMES A LA DOC KEYYO ---
// GET /services/:csi/{incoming,outgoing}_call_detail accepte :
//   date_start / date_end : "YYYY-MM-DD HH:MM" (date_end EXCLUSIVE si HH:MM omis)
//   limit / offset        : pagination
// (source : api.keyyo.com/developers/docs/.../outgoing_call_detail)
function fmtKeyyoDate(d, tz) {
  const f = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function buildUrl(cfg, csi, resource, offset) {
  const path = cfg.resourcePath.replace('{csi}', encodeURIComponent(csi)).replace('{resource}', resource);
  const url = new URL(`${cfg.base}/${path}`);
  const since = new Date(Date.now() - cfg.historyDays * 864e5);
  const until = new Date(Date.now() + 864e5); // +1 j : date_end est exclusive
  url.searchParams.set(cfg.filterBegin, fmtKeyyoDate(since, cfg.tz));
  url.searchParams.set(cfg.filterEnd, fmtKeyyoDate(until, cfg.tz));
  url.searchParams.set('limit', String(cfg.pageLimit));
  if (offset > 0) url.searchParams.set('offset', String(offset));
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

async function fetchResource(cfg, token, csi, site, resource, direction, deadline) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  const rows = [];
  let rawSeen = 0, dropped = 0, pages = 0, sampleRaw = null, sampleKeys = null, offset = 0;
  const ctx = { direction, site, tz: cfg.tz, dropped: (r) => { dropped++; if (!sampleRaw) { sampleRaw = r; sampleKeys = Object.keys(r || {}); } } };

  let url = buildUrl(cfg, csi, resource, 0);
  for (let page = 0; page < cfg.maxPages && url && (!deadline || Date.now() < deadline); page++) {
    const payload = await fetchJson(url, headers, { retries: 1, timeoutMs: 9000 });
    const recs = extractRecords(payload);
    rawSeen += recs.length;
    if (!sampleKeys && recs[0]) sampleKeys = Object.keys(recs[0]);
    for (const rec of recs) { const row = normalizeRecord(rec, ctx); if (row) rows.push(row); }
    pages++;
    // Pagination : _links.next si fourni, sinon offset+=limit tant que la page est pleine.
    const next = payload?._links?.next?.href;
    if (next) url = next.startsWith('http') ? next : new URL(next, cfg.base + '/').toString();
    else if (recs.length >= cfg.pageLimit) { offset += cfg.pageLimit; url = buildUrl(cfg, csi, resource, offset); }
    else url = null;
  }
  return { rows, diag: { csi, site, resource, direction, rawSeen, kept: rows.length, dropped, pages, sampleKeys } };
}

// ---------- Lignes : decouverte des services + email/prenom rattaches ----------
const EMAIL_RE = /^[^\s@"<>]+@[^\s@"<>]+\.[a-z]{2,}$/i;

// Cherche en profondeur la 1re valeur ressemblant a un email ; les cles evoquant
// "mail" sont prioritaires (contact_email, email, e_mail, ...).
function findEmailDeep(o, depth = 0) {
  if (o == null || depth > 4) return null;
  if (typeof o === 'string') { const s = o.trim(); return EMAIL_RE.test(s) ? s.toLowerCase() : null; }
  if (typeof o !== 'object') return null;
  for (const [k, v] of Object.entries(o)) if (/mail/i.test(k)) { const e = findEmailDeep(v, depth + 1); if (e) return e; }
  for (const v of Object.values(o)) { const e = findEmailDeep(v, depth + 1); if (e) return e; }
  return null;
}

// prenom.nom@domaine -> "Prenom" (segment avant le 1er point de la partie locale).
export function firstNameFromEmail(email) {
  if (!email) return null;
  const local = String(email).split('@')[0];
  const first = (local.split('.')[0] || '').replace(/[\d_]+$/, '').replace(/-+$/, '');
  if (!first) return null;
  return first.split('-').map(x => x ? x.charAt(0).toUpperCase() + x.slice(1).toLowerCase() : x).join('-');
}

// GET /services -> map { csi: nom } (toutes les lignes du compte).
export async function discoverServices(cfg, token) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  const payload = await fetchJson(`${cfg.base}/services`, headers, { retries: 2, timeoutMs: 9000 });
  const recs = extractRecords(payload);
  const map = {};
  for (const r of recs) {
    if (!r || typeof r !== 'object') continue;
    const csi = pick(r, ['csi', 'CSI', 'identifier', 'service_id', 'id', 'number'], null);
    if (csi == null) continue;
    const name = String(pick(r, ['name', 'label', 'display_name', 'service_name', 'description'], '')).trim();
    map[String(csi)] = name || String(csi);
  }
  if (!Object.keys(map).length) throw new Error('GET /services : aucune ligne trouvee (verifier les droits du token)');
  return map;
}

// Pour chaque CSI : GET /services/:csi -> email rattache + prenom deduit.
// Resultat mis en cache 1 h (process). Cle = nom de SITE (celui porte par les rows).
let _lines = { value: null, exp: 0 };
export async function getLines(cfg, token) {
  const now = Date.now();
  if (_lines.value && now < _lines.exp) return _lines.value;
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  const out = {};
  await Promise.all(Object.entries(cfg.services).map(async ([csi, site]) => {
    let email = null, serviceName = null, error = null;
    try {
      const svc = await fetchJson(`${cfg.base}/services/${encodeURIComponent(csi)}`, headers, { retries: 1, timeoutMs: 8000 });
      email = findEmailDeep(svc);
      serviceName = String(pick(svc, ['name', 'label', 'display_name', 'service_name'], '')).trim() || null;
    } catch (e) { error = e.message; }
    out[site] = { csi, site, email, firstName: firstNameFromEmail(email), serviceName, error };
  }));
  _lines.value = out; _lines.exp = now + 3600e3;
  return out;
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

export async function fetchAllCalls(opts = {}) {
  const cfg = opts.cfg || readConfig();
  if (opts.sinceDays) cfg.historyDays = opts.sinceDays;   // fenetre incrementale (synchro)

  const token = await getAccessToken(cfg);

  // Mode AUTO : decouverte de TOUTES les lignes du compte (les 3) via /services.
  if (!cfg.services) cfg.services = await discoverServices(cfg, token);
  if (!Object.keys(cfg.services).length) throw new Error('KEYYO_SERVICES vide');

  // Email + prenom rattaches a chaque ligne (n'echoue jamais le flux principal).
  let lines = {};
  try { lines = await getLines(cfg, token); } catch (e) {}

  let csiCheck = null;
  if (cfg.validateCsi) csiCheck = await validateCsis(cfg, token);

  const deadline = Date.now() + 25000; // budget global (Vercel coupe à 30s) : on rend ce qu'on a

  const tasks = [];
  for (const [csi, site] of Object.entries(cfg.services)) {
    tasks.push(fetchResource(cfg, token, csi, site, 'outgoing_call_detail', 'out', deadline));
    tasks.push(fetchResource(cfg, token, csi, site, 'incoming_call_detail', 'in', deadline));
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
    lines,
    meta: buildMeta(rows),
    errors: hint ? [...errors, hint] : errors,
    diag: { rawSeen, kept: rows.length, dropped, perTask, csiCheck, strategy: 'date_start/date_end (doc Keyyo) + limit/offset', windowDays: cfg.historyDays, services: cfg.services },
  };
}

export function buildMeta(rows) {
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
