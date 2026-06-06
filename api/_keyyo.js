// =============================================================
//  keyyo-client.js
//  Interroge l'API Keyyo Manager (incoming/outgoing call_detail),
//  normalise chaque appel au format attendu par le dashboard et
//  agrege l'ensemble dans { rows, meta }.
//
//  Format de ligne attendu par le dashboard (ordre STRICT) :
//   [ ISO, HOUR, CALLER, CALLED, NAT, DUR, SITE, OK, CORR, WD, YM ]
//   ISO    : "AAAA-MM-JJ"
//   HOUR   : entier (heure locale 0-23)
//   CALLER : numero appelant (string)
//   CALLED : numero appele (string)
//   NAT    : 1 = sortant, 0 = entrant
//   DUR    : duree en secondes (entier)
//   SITE   : nom du site (string)
//   OK     : 1 si duree > 0 sinon 0  (proxy "abouti")
//   CORR   : correspondant (l'autre partie : appele si sortant, appelant si entrant)
//   WD     : index jour de semaine 0=Lun ... 6=Dim
//   YM     : "AAAA-MM"
// =============================================================

const WD_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

// --- Lecture de la configuration depuis l'environnement -----------------
function readConfig() {
  const services = JSON.parse(process.env.KEYYO_SERVICES || {"33175433361":"Tana","33253359565":"Antsirabe"});
  return {
    base: (process.env.KEYYO_API_BASE || 'https://api.keyyo.com/manager/1.0'),
    clientId: process.env.KEYYO_CLIENT_ID || '6a2407d6d65c9',
    token: process.env.KEYYO_TOKEN || 'f7ef03477334f6fcda947896',
    authMode: (process.env.KEYYO_AUTH_MODE || 'bearer').toLowerCase(),
    services,                                   // { csi: siteName }
    historyDays: parseInt(process.env.KEYYO_HISTORY_DAYS || '120', 10),
    tz: process.env.TZ || 'Europe/Paris',
  };
}

// --- Helpers date / fuseau ---------------------------------------------
// Convertit un instant (Date) en composantes locales selon le fuseau cible.
function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('fr-FR', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parseInt(parts.hour, 10) % 24;
  // WD via un calcul stable (independant de la locale) :
  const wdJs = new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0=Dim..6=Sam
  const wd = (wdJs + 6) % 7;                              // 0=Lun..6=Dim
  return { iso, hour, ym: iso.slice(0, 7), wd };
}

// --- Parsing tolerant d'un horodatage Keyyo ----------------------------
// Accepte : epoch (s ou ms), "AAAA-MM-JJ HH:MM:SS", ISO 8601...
function parseTimestamp(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    return new Date(n > 1e12 ? n : n * 1000); // ms vs s
  }
  const s = String(raw).trim().replace(' ', 'T');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// --- Acces tolerant a un champ parmi plusieurs noms possibles ----------
function pick(obj, names, dflt = undefined) {
  for (const n of names) {
    if (obj && obj[n] != null && obj[n] !== '') return obj[n];
  }
  return dflt;
}

// =============================================================
//  Normalisation d'un enregistrement brut Keyyo -> ligne dashboard
//  `direction` : 'out' (sortant) ou 'in' (entrant)
//  Les listes de noms de champs couvrent les variantes courantes de
//  l'API Manager ; ajuster ici si votre flux expose d'autres cles.
// =============================================================
function normalizeRecord(raw, { direction, site, tz }) {
  const ts = parseTimestamp(
    pick(raw, ['date', 'datetime', 'start_date', 'start', 'timestamp', 'ts', 'call_date'])
  );
  if (!ts) return null;

  const caller = String(
    pick(raw, ['caller', 'calling_number', 'calling', 'from', 'src', 'source', 'origin'], '')
  ).trim();
  const called = String(
    pick(raw, ['callee', 'called_number', 'called', 'to', 'dst', 'destination', 'dest'], '')
  ).trim();

  let dur = pick(raw, ['duration', 'billsec', 'billed_duration', 'real_duration', 'len'], 0);
  dur = parseInt(dur, 10);
  if (isNaN(dur) || dur < 0) dur = 0;

  const nat = direction === 'out' ? 1 : 0;
  const ok = dur > 0 ? 1 : 0;
  const corr = nat === 1 ? called : caller; // l'autre partie
  const { iso, hour, ym, wd } = localParts(ts, tz);

  return [iso, hour, caller, called, nat, dur, site, ok, corr, wd, ym];
}

// --- Construction de l'URL d'un endpoint, selon le mode d'auth ---------
function buildUrl(cfg, csi, resource, since, until) {
  // L'API Manager scope la ressource par CSI : <base>/<csi>/<resource>
  const url = new URL(`${cfg.base}/${encodeURIComponent(csi)}/${resource}`);
  // Fenetre temporelle (noms de parametres tolerants cote Keyyo)
  if (since) url.searchParams.set('date_begin', since);
  if (until) url.searchParams.set('date_end', until);
  if (cfg.authMode === 'query') {
    url.searchParams.set('token', cfg.token);
    if (cfg.clientId) url.searchParams.set('client_id', cfg.clientId);
  }
  return url;
}

function authHeaders(cfg) {
  const h = { Accept: 'application/json' };
  if (cfg.authMode === 'bearer') h.Authorization = `Bearer ${cfg.token}`;
  return h;
}

// --- fetch avec timeout + retries (backoff exponentiel) ----------------
async function fetchJson(url, headers, { retries = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(t);
      const text = await res.text();
      if (!res.ok) {
        // 429 / 5xx -> on retente ; 4xx "definitif" -> on remonte
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status}`);
        }
        const err = new Error(`HTTP ${res.status} : ${text.slice(0, 300)}`);
        err.fatal = true;
        throw err;
      }
      try { return JSON.parse(text); }
      catch { throw Object.assign(new Error('Reponse non-JSON de Keyyo'), { body: text.slice(0, 300) }); }
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (e.fatal) throw e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

// --- Extraction de la liste d'appels depuis une reponse Keyyo ----------
// L'API peut renvoyer un tableau, ou un objet englobant ({data:[...]}, etc.)
function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  for (const k of ['call_detail', 'calls', 'data', 'result', 'results', 'items', 'records']) {
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  // objet indexe { "0": {...}, "1": {...} }
  if (payload && typeof payload === 'object') {
    const vals = Object.values(payload).filter(v => v && typeof v === 'object');
    if (vals.length && vals.every(v => !Array.isArray(v))) return vals;
  }
  return [];
}

// --- Recuperation d'un endpoint pour un service ------------------------
async function fetchResource(cfg, csi, site, resource, direction) {
  const until = new Date();
  const since = new Date(until.getTime() - cfg.historyDays * 864e5);
  const fmt = d => d.toISOString().slice(0, 10);

  const url = buildUrl(cfg, csi, resource, fmt(since), fmt(until));
  const payload = await fetchJson(url, authHeaders(cfg));
  const records = extractRecords(payload);

  const rows = [];
  for (const rec of records) {
    const row = normalizeRecord(rec, { direction, site, tz: cfg.tz });
    if (row) rows.push(row);
  }
  return rows;
}

// =============================================================
//  Point d'entree : recupere TOUS les services, les deux sens,
//  et renvoie { rows, meta } pret pour le dashboard.
// =============================================================
export async function fetchAllCalls(cfgOverride) {
  const cfg = cfgOverride || readConfig();
  if (!cfg.token) throw new Error('KEYYO_TOKEN manquant');
  if (!Object.keys(cfg.services).length) throw new Error('KEYYO_SERVICES vide');

  const tasks = [];
  for (const [csi, site] of Object.entries(cfg.services)) {
    tasks.push(fetchResource(cfg, csi, site, 'outgoing_call_detail', 'out'));
    tasks.push(fetchResource(cfg, csi, site, 'incoming_call_detail', 'in'));
  }

  const settled = await Promise.allSettled(tasks);
  const rows = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') rows.push(...s.value);
    else errors.push(`tache#${i}: ${s.reason?.message || s.reason}`);
  });

  // Si TOUT a echoue, on remonte une vraie erreur (le serveur gardera le cache).
  if (rows.length === 0 && errors.length) {
    throw new Error('Aucune donnee recuperee. ' + errors.join(' | '));
  }

  // Tri anti-chronologique (comme l'export d'origine)
  rows.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : b[1] - a[1]));

  const meta = buildMeta(rows, cfg);
  return { rows, meta, errors };
}

// --- Construction du bloc meta -----------------------------------------
function buildMeta(rows, cfg) {
  const isos = rows.map(r => r[0]);
  const yms = [...new Set(rows.map(r => r[10]))].sort();
  const sites = [...new Set(rows.map(r => r[6]))].sort();
  const min = isos.length ? isos.reduce((a, b) => (a < b ? a : b)) : null;
  const max = isos.length ? isos.reduce((a, b) => (a > b ? a : b)) : null;
  const days = new Set(isos).size;
  return { n: rows.length, min, max, days, ym: yms, sites };
}

// --- Selftest CLI : `npm run test:keyyo` -------------------------------
if (process.argv.includes('--selftest')) {
  // Variables lues via process.env (lancer avec : node --env-file=.env.local ...)
  console.log('Test de connexion Keyyo en cours...');
  try {
    const { rows, meta, errors } = await fetchAllCalls();
    console.log(`OK : ${rows.length} appels, sites=${meta.sites.join(', ')}, periode ${meta.min} -> ${meta.max}`);
    if (errors.length) console.warn('Avertissements:', errors);
    console.log('Exemple de ligne:', rows[0]);
  } catch (e) {
    console.error('ECHEC:', e.message);
    process.exit(1);
  }
}
