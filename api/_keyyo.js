// =============================================================================
//  api/_keyyo.js — Client HTTP de l'API Keyyo Manager 1.0.
//
//  Verite terrain (verifiee sur le compte reel) :
//    - base            https://api.keyyo.com/manager/1.0
//    - auth            en-tete « Authorization: Bearer <token> »
//    - jeton           POST /oauth2/token.php, grant_type=refresh_token
//    - reponses        HAL : la charge utile est sous _embedded.<TypeName>
//    - pagination      _links.next.href, sinon limit/offset
//    - call_detail     date_start / date_end au format « YYYY-MM-DD HH:MM »,
//                      date_end EXCLUSIVE
//
//  Aucun jeton n'est jamais journalise ni renvoye : les messages d'erreur ne
//  citent que le chemin appele et la raison donnee par Keyyo.
// =============================================================================

import { extractRecords, nextLink, normalizeCdr } from '../shared/cdr.js';
import { F } from '../shared/schema.js';
import { toKeyyoDate, parseTimestamp } from '../shared/time.js';
import { isEmail } from '../shared/identity.js';

/** Delai maximal d'une requete unitaire, en millisecondes. */
const DEFAULT_TIMEOUT_MS = 15000;

/** Marge conservee avant l'echeance : inutile de lancer un appel qui n'aboutira pas. */
const DEADLINE_MARGIN_MS = 600;

// -----------------------------------------------------------------------------
//  Jeton d'acces
// -----------------------------------------------------------------------------

/**
 * Cache memoire du processus. Une fonction serverless sert plusieurs requetes :
 * sans ce cache, chaque appel bruleerait un refresh_token — or il est ROTATIF.
 * @type {Map<string, {seed: string, refreshToken: string, accessToken: string, expiresAt: number, pending: Promise<string>|null}>}
 */
const tokenCache = new Map();

/**
 * Obtient un jeton d'acces valide.
 *
 * @param {import('./_config.js').Config} cfg
 * @returns {Promise<string>}
 */
export async function getAccessToken(cfg) {
  if (cfg.staticToken && !cfg.refreshToken) return cfg.staticToken;

  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    if (cfg.staticToken) return cfg.staticToken;
    throw new Error(
      "Rafraichissement impossible : KEYYO_CLIENT_ID, KEYYO_CLIENT_SECRET et KEYYO_REFRESH_TOKEN doivent etre renseignes tous les trois.",
    );
  }

  const key = cfg.tokenUrl + '|' + cfg.clientId;
  let entry = tokenCache.get(key);
  // Si la variable d'environnement a change (redeploiement), on repart de zero
  // plutot que de reutiliser un jeton rotatif perime en memoire.
  if (!entry || entry.seed !== cfg.refreshToken) {
    entry = { seed: cfg.refreshToken, refreshToken: cfg.refreshToken, accessToken: '', expiresAt: 0, pending: null };
    tokenCache.set(key, entry);
  }

  // 60 s de marge : un jeton qui expire pendant la collecte ferait echouer des
  // requetes deja lancees.
  if (entry.accessToken && entry.expiresAt > Date.now() + 60000) return entry.accessToken;

  // Deduplique les rafraichissements concurrents : plusieurs lignes sont
  // interrogees en parallele, elles ne doivent pas consommer N refresh_token.
  if (entry.pending) return entry.pending;
  const current = entry;
  current.pending = refreshAccessToken(cfg, current)
    .then((tok) => { current.pending = null; return tok; })
    .catch((err) => { current.pending = null; throw err; });
  return current.pending;
}

/**
 * Echange le refresh_token contre un access_token.
 *
 * Le refresh_token peut etre rotatif : quand la reponse en renvoie un nouveau,
 * il remplace l'ancien pour les rafraichissements suivants DE CE PROCESSUS.
 * Limite assumee : une instance froide repart de KEYYO_REFRESH_TOKEN. Si Keyyo
 * invalide reellement l'ancien jeton a la premiere rotation, il faut mettre la
 * variable d'environnement a jour — c'est ce que dit le message d'erreur.
 *
 * @param {import('./_config.js').Config} cfg
 * @param {{refreshToken: string, accessToken: string, expiresAt: number}} entry
 * @returns {Promise<string>}
 */
async function refreshAccessToken(cfg, entry) {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', cfg.clientId);
  body.set('client_secret', cfg.clientSecret);
  body.set('refresh_token', entry.refreshToken);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  let res = null;
  let text = '';
  try {
    res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (err) {
    const aborted = err && /** @type {any} */ (err).name === 'AbortError';
    throw new Error(
      "Serveur de jetons Keyyo injoignable (" + cfg.tokenUrl + ') : '
      + (aborted ? 'delai de ' + DEFAULT_TIMEOUT_MS + ' ms depasse' : shortText(err))
      + ". Verifier la connectivite sortante de la fonction et la valeur de KEYYO_TOKEN_URL.",
    );
  } finally {
    clearTimeout(timer);
  }

  /** @type {any} */
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok || !data || !data.access_token) {
    const reason = data && (data.error_description || data.error)
      ? String(data.error_description || data.error)
      : 'HTTP ' + res.status + (text ? ' — ' + shortText(text) : '');
    throw new Error(
      'Keyyo refuse le rafraichissement du jeton (' + reason + '). '
      + 'Verifier KEYYO_CLIENT_ID et KEYYO_CLIENT_SECRET, puis surtout KEYYO_REFRESH_TOKEN : '
      + "ce jeton est rotatif, un jeton deja consomme est definitivement invalide et doit etre regenere, "
      + 'avec le scope full_access_read_only.',
    );
  }

  entry.accessToken = String(data.access_token);
  const ttl = Number(data.expires_in);
  entry.expiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 60 ? ttl * 1000 : 3600000);
  if (data.refresh_token && String(data.refresh_token) !== entry.refreshToken) {
    entry.refreshToken = String(data.refresh_token);
  }
  return entry.accessToken;
}

// -----------------------------------------------------------------------------
//  Requetes
// -----------------------------------------------------------------------------

/**
 * Construit une URL absolue. Accepte un chemin relatif (`/services`) ou une
 * URL complete (lien de pagination HAL).
 *
 * La query est encodee a la main plutot que via URLSearchParams : celui-ci
 * encode l'espace en `+`, alors que `date_start` vaut « YYYY-MM-DD HH:MM » et
 * doit partir en `%20`.
 *
 * @param {import('./_config.js').Config} cfg
 * @param {string} pathOrUrl
 * @param {Record<string, any>|null} [params]
 * @returns {string}
 */
function buildUrl(cfg, pathOrUrl, params) {
  const s = String(pathOrUrl == null ? '' : pathOrUrl);
  let url;
  if (/^https?:\/\//i.test(s)) url = s;
  else url = String(cfg.base).replace(/\/+$/, '') + (s.startsWith('/') ? s : '/' + s);

  const parts = [];
  if (params) {
    for (const k of Object.keys(params)) {
      const v = params[k];
      if (v == null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
  }
  if (!parts.length) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
}

/** @param {string} url @returns {string} chemin seul, pour les messages d'erreur. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return String(url);
  }
}

/** @param {unknown} v @returns {string} */
function shortText(v) {
  const s = (v && /** @type {any} */ (v).message ? String(/** @type {any} */ (v).message) : String(v == null ? '' : v))
    .replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Erreur de budget de temps : signalee a part pour que la collecte renvoie ce
 * qu'elle a deja plutot que d'echouer.
 * @param {string} why
 * @returns {Error & {budget: true}}
 */
function budgetError(why) {
  const err = /** @type {any} */ (new Error('Budget de temps epuise : ' + why));
  err.budget = true;
  return err;
}

/**
 * Une requete GET, avec delai maximal et reprises.
 *
 * Reprises : jusqu'a 3 tentatives, repli exponentiel, UNIQUEMENT sur 429, 5xx
 * et erreurs reseau. Un 4xx autre que 429 est definitif — le reessayer ne fait
 * que bruler le budget de temps.
 *
 * @param {import('./_config.js').Config} cfg
 * @param {string} token
 * @param {string} url          URL absolue.
 * @param {{timeoutMs?: number, attempts?: number, deadline?: number}} opts
 * @returns {Promise<any>}
 */
async function requestJson(cfg, token, url, opts) {
  const o = opts || {};
  const attempts = Math.max(1, Math.min(3, Number(o.attempts) || 3));
  const baseTimeout = Math.max(1000, Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const deadline = Number(o.deadline) || 0;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = deadline ? deadline - Date.now() : Number.POSITIVE_INFINITY;
    if (remaining <= DEADLINE_MARGIN_MS) {
      throw budgetError('appel ' + shortUrl(url) + ' non lance');
    }
    const timeoutMs = Math.max(1000, Math.min(baseTimeout, remaining - DEADLINE_MARGIN_MS));

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res = null;
    let text = '';
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (err) {
      const aborted = err && /** @type {any} */ (err).name === 'AbortError';
      if (deadline && Date.now() >= deadline - DEADLINE_MARGIN_MS) {
        throw budgetError('appel ' + shortUrl(url) + ' interrompu');
      }
      lastError = new Error(
        'Appel Keyyo ' + shortUrl(url) + ' impossible : '
        + (aborted ? 'delai de ' + timeoutMs + ' ms depasse' : shortText(err))
        + '.',
      );
      if (attempt < attempts) { await backoff(attempt, deadline, 0); continue; }
      throw enrich(lastError, 0, '', "Reseau ou delai : verifier la disponibilite de api.keyyo.com, puis relancer avec ?force=1.");
    } finally {
      clearTimeout(timer);
    }

    // Keyyo detaille parfois la cause dans cet en-tete non standard.
    const statusReason = headerOf(res, 'x-status-reason');

    if (res.ok) {
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (err) {
        throw enrich(
          new Error('Reponse Keyyo illisible sur ' + shortUrl(url) + ' : JSON invalide (' + shortText(err) + ').'),
          res.status, statusReason,
          'Reponse recue : ' + shortText(text) + '. Verifier KEYYO_API_BASE.',
        );
      }
    }

    const retryable = res.status === 429 || res.status >= 500;
    const err = enrich(
      new Error('Keyyo a repondu ' + res.status + ' sur ' + shortUrl(url)
        + (statusReason ? ' (' + statusReason + ')' : '')
        + (text ? ' — ' + shortText(text) : '')),
      res.status, statusReason, hintForStatus(res.status),
    );
    if (!retryable || attempt >= attempts) throw err;
    lastError = err;
    await backoff(attempt, deadline, retryAfterMs(res));
  }

  throw lastError || new Error('Appel Keyyo ' + shortUrl(url) + ' echoue sans diagnostic.');
}

/**
 * Repli exponentiel, borne par l'echeance restante.
 * @param {number} attempt
 * @param {number} deadline
 * @param {number} suggested
 */
async function backoff(attempt, deadline, suggested) {
  let wait = suggested > 0 ? suggested : 400 * Math.pow(2, attempt - 1);
  wait = Math.min(wait, 4000) + Math.floor(Math.random() * 150);
  if (deadline) {
    const remaining = deadline - Date.now() - DEADLINE_MARGIN_MS;
    if (remaining <= 0) throw budgetError('plus de temps pour une nouvelle tentative');
    wait = Math.min(wait, Math.max(0, remaining - 500));
  }
  if (wait > 0) await sleep(wait);
}

/** @param {any} res @returns {number} delai suggere par Retry-After, en ms. */
function retryAfterMs(res) {
  const v = headerOf(res, 'retry-after');
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 5000);
  const at = Date.parse(v);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 5000);
  return 0;
}

/** @param {any} res @param {string} name @returns {string} */
function headerOf(res, name) {
  try {
    const v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : '';
    return v ? String(v) : '';
  } catch {
    return '';
  }
}

/**
 * @param {Error} err
 * @param {number} status
 * @param {string} statusReason
 * @param {string} hint
 * @returns {Error}
 */
function enrich(err, status, statusReason, hint) {
  const e = /** @type {any} */ (err);
  e.status = status;
  e.statusReason = statusReason;
  e.hint = hint;
  if (hint) e.message = err.message + ' — ' + hint;
  return err;
}

/** @param {number} status @returns {string} consigne actionnable. */
function hintForStatus(status) {
  if (status === 400) return "Requete refusee : verifier le format des dates (« YYYY-MM-DD HH:MM ») et le CSI interroge.";
  if (status === 401) return "Jeton refuse : regenerer KEYYO_REFRESH_TOKEN (le jeton est rotatif) et verifier le scope full_access_read_only.";
  if (status === 403) return "Acces interdit : le scope du jeton ne couvre pas cette ressource. Demander full_access_read_only.";
  if (status === 404) return "Ressource inexistante : verifier le CSI de la ligne et KEYYO_API_BASE.";
  if (status === 429) return 'Quota Keyyo atteint : baisser KEYYO_MAX_PAGES ou espacer les synchronisations.';
  if (status >= 500) return 'Panne cote Keyyo : reessayer plus tard, la collecte reprendra ou elle s\'est arretee.';
  return '';
}

/**
 * GET sur un chemin de l'API.
 * @param {import('./_config.js').Config} cfg
 * @param {string} token
 * @param {string} path
 * @param {Record<string, any>} [params]
 * @param {{timeoutMs?: number, attempts?: number, deadline?: number}} [opts]
 * @returns {Promise<any>}
 */
export async function keyyoGet(cfg, token, path, params, opts) {
  return requestJson(cfg, token, buildUrl(cfg, path, params || null), opts || {});
}

/**
 * POST sur un chemin de l'API, SANS reprise : une ecriture rejouee pourrait
 * produire deux effets. Meme lecture d'erreur que `requestJson`.
 * @param {import('./_config.js').Config} cfg
 * @param {string} token
 * @param {string} path
 * @param {Record<string, any>|null} [body]  encode en formulaire, ou vide.
 * @param {{timeoutMs?: number, deadline?: number}} [opts]
 * @returns {Promise<any>}
 */
export async function keyyoPost(cfg, token, path, body, opts) {
  const o = opts || {};
  const url = buildUrl(cfg, path, null);
  const deadline = Number(o.deadline) || 0;
  const remaining = deadline ? deadline - Date.now() : Number.POSITIVE_INFINITY;
  if (remaining <= DEADLINE_MARGIN_MS) throw budgetError('appel ' + shortUrl(url) + ' non lance');
  const timeoutMs = Math.max(1000, Math.min(Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS, remaining - DEADLINE_MARGIN_MS));

  const form = new URLSearchParams();
  for (const k of Object.keys(body || {})) {
    const v = /** @type {any} */ (body)[k];
    if (v != null && v !== '') form.set(k, String(v));
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res = null;
  let text = '';
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (err) {
    const aborted = err && /** @type {any} */ (err).name === 'AbortError';
    throw enrich(
      new Error('Appel Keyyo POST ' + shortUrl(url) + ' impossible : '
        + (aborted ? 'delai de ' + timeoutMs + ' ms depasse' : shortText(err)) + '.'),
      0, '', 'Reseau ou delai : verifier la disponibilite de api.keyyo.com.',
    );
  } finally {
    clearTimeout(timer);
  }

  const statusReason = headerOf(res, 'x-status-reason');
  if (res.ok) {
    if (!text) return {};
    try { return JSON.parse(text); } catch (err) {
      throw enrich(new Error('Reponse Keyyo illisible sur POST ' + shortUrl(url) + ' : JSON invalide.'),
        res.status, statusReason, 'Reponse recue : ' + shortText(text));
    }
  }
  throw enrich(
    new Error('Keyyo a repondu ' + res.status + ' sur POST ' + shortUrl(url)
      + (statusReason ? ' (' + statusReason + ')' : '') + (text ? ' — ' + shortText(text) : '')),
    res.status, statusReason,
    res.status === 403 || res.status === 401
      ? "Le jeton Keyyo ne porte pas le scope cti_admin : refaire l'autorisation via /api/oauth (voir .env.example, section 7)."
      : hintForStatus(res.status),
  );
}

/**
 * Frappe un jeton CSI, la cle d'une session CTI sur une ligne. Ecriture,
 * scope `cti_admin`, duree de vie annoncee d'une heure.
 *
 * Type documente `CSIToken` : `result` (« success », sinon echec), `token`,
 * `domain_masks` (domaines autorises a utiliser le jeton — le domaine du site
 * doit etre declare sur l'application Keyyo), `timestamp` (expiration, Unix
 * secondes). La reponse peut arriver nue ou enveloppee en HAL sous
 * `_embedded.CSIToken[0]` : les deux formes sont lues. En cas d'echec, les
 * cles recues sont citees pour que le diagnostic soit immediat.
 *
 * @param {import('./_config.js').Config} cfg
 * @param {string} token   jeton d'acces Keyyo (Manager).
 * @param {string} csi     ligne.
 * @param {{deadline?: number}} [opts]
 * @returns {Promise<{token: string, expiresAt: number, domainMasks: string[], keys: string[]}>}
 */
export async function mintCsiToken(cfg, token, csi, opts) {
  const id = str(csi);
  if (!id) throw new Error('mintCsiToken : CSI manquant.');
  const payload = await keyyoPost(cfg, token, '/services/' + encodeURIComponent(id) + '/csi_token', null, opts);

  /** @type {any} */
  let obj = payload && typeof payload === 'object' ? payload : {};
  const embedded = obj._embedded && typeof obj._embedded === 'object' ? obj._embedded : null;
  if (embedded) {
    for (const k of Object.keys(embedded)) {
      const v = embedded[k];
      const first = Array.isArray(v) ? v[0] : v;
      if (first && typeof first === 'object') { obj = first; break; }
    }
  }
  const result = str(obj.result).toLowerCase();
  if (result && result !== 'success') {
    throw new Error('Keyyo n\'a pas pu generer de jeton CSI pour la ligne ' + id + ' (result = ' + result + ').');
  }
  const candidates = [obj.token, obj.csi_token, obj.access_token];
  let found = '';
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) { found = c.trim(); break; }
  }
  if (!found) {
    throw new Error('Keyyo a repondu sans jeton CSI reconnaissable. Cles recues : '
      + Object.keys(obj).join(', ') + '.');
  }
  const stamp = Number(obj.timestamp);
  const expiresAt = Number.isFinite(stamp) && stamp > 1e9
    ? (stamp > 1e11 ? stamp : stamp * 1000)
    : Date.now() + 3600 * 1000;
  return {
    token: found,
    expiresAt,
    domainMasks: Array.isArray(obj.domain_masks) ? obj.domain_masks.map((d) => str(d)).filter(Boolean) : [],
    keys: Object.keys(obj),
  };
}

/**
 * GET pagine : suit `_links.next.href` tant qu'il existe, sinon avance par
 * `limit`/`offset`. Plafonne par `cfg.maxPages` — une pagination cassee cote
 * API ne doit pas boucler indefiniment dans une fonction serverless.
 *
 * `opts.stats`, si fourni, recoit `{ pages, truncated }` : le contrat impose de
 * renvoyer un tableau, c'est le seul moyen de remonter le diagnostic.
 *
 * @param {import('./_config.js').Config} cfg
 * @param {string} token
 * @param {string} path
 * @param {Record<string, any>} [params]
 * @param {{timeoutMs?: number, attempts?: number, deadline?: number, limit?: number, maxPages?: number, stats?: {pages?: number, truncated?: boolean}}} [opts]
 * @returns {Promise<any[]>}
 */
export async function keyyoGetAll(cfg, token, path, params, opts) {
  const o = opts || {};
  const limit = Math.max(1, Number(o.limit) || Number(cfg.pageLimit) || 200);
  const maxPages = Math.max(1, Number(o.maxPages) || Number(cfg.maxPages) || 40);
  const baseParams = params || {};

  /** @type {any[]} */
  const out = [];
  const seen = new Set();
  let offset = 0;
  let pages = 0;
  let truncated = false;
  let url = buildUrl(cfg, path, Object.assign({}, baseParams, { limit, offset }));

  while (url) {
    if (seen.has(url)) break;                       // garde-fou : pagination circulaire
    seen.add(url);

    const payload = await requestJson(cfg, token, url, o);
    pages++;
    const records = extractRecords(payload);
    for (let i = 0; i < records.length; i++) out.push(records[i]);

    const link = nextLink(payload);
    const hasMoreByCount = records.length >= limit;

    if (pages >= maxPages) {
      truncated = !!link || hasMoreByCount;
      break;
    }
    if (link && sameOrigin(link, cfg.base)) {
      // `offset` doit avancer MEME quand on suit un lien HAL. Si Keyyo cesse de
      // fournir `_links.next` en cours de route, la boucle retombe sur le mode
      // limit/offset ci-dessous : avec un offset reste a zero, elle redemanderait
      // les enregistrements deja lus, produisant des doublons et brulant le
      // budget de pages sans jamais atteindre la fin.
      offset += records.length;
      url = buildUrl(cfg, link, null);
      continue;
    }
    if (!hasMoreByCount) break;                     // derniere page

    offset += records.length;
    url = buildUrl(cfg, path, Object.assign({}, baseParams, { limit, offset }));
  }

  if (o.stats && typeof o.stats === 'object') {
    o.stats.pages = pages;
    o.stats.truncated = truncated;
  }
  return out;
}

/**
 * Un lien de pagination doit rester sur l'origine de l'API : on ne suit pas un
 * href pointant ailleurs, et on ne lui envoie donc jamais le jeton.
 * @param {string} link
 * @param {string} base
 * @returns {boolean}
 */
function sameOrigin(link, base) {
  if (!/^https?:\/\//i.test(link)) return true;     // relatif : sera prefixe par la base
  try {
    return new URL(link).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
//  Ressources
// -----------------------------------------------------------------------------

/** @param {unknown} v @returns {string} */
function str(v) {
  return v == null ? '' : String(v).trim();
}

/** @param {unknown} v @returns {boolean} */
function bool(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

/**
 * Liste les services du compte.
 * @param {import('./_config.js').Config} cfg
 * @param {string} token
 * @param {string} [type] `UCaaSVoIPAccount`, `EmailAccount`, …
 * @param {object} [opts]
 * @returns {Promise<any[]>}
 */
export async function fetchServices(cfg, token, type, opts) {
  /** @type {Record<string, any>} */
  const params = {};
  if (type) params.type = type;
  const raw = await keyyoGetAll(cfg, token, '/services', params, opts || {});
  if (!type) return raw;

  // FILTRAGE COTE CLIENT, INDISPENSABLE. Verifie sur un compte reel :
  // `?type=KeyyoPhone`, un type qui n'existe pas, renvoie exactement les memes
  // services que `?type=UCaaSVoIPAccount`. Le parametre `type` est donc IGNORE
  // par l'API des qu'il ne lui plait pas, et rien ne le signale.
  //
  // Sans ce filtre, `fetchEmailAccounts` recevait la liste complete et prenait
  // les lignes VoIP pour des comptes de messagerie : une ligne nommee
  // « BIOS ABE » ressortait alors comme une boite « BIOS ABE », se rapprochait
  // d'elle-meme a 100 % et fabriquait une identite qui n'existe pas.
  //
  // Un enregistrement sans `_resource_type` est conserve : on ne peut pas le
  // contredire, et le jeter perdrait des donnees que l'API a bien voulu rendre.
  const wanted = String(type);
  return raw.filter((s) => {
    if (!s || typeof s !== 'object') return false;
    const kind = s._resource_type;
    return kind == null || kind === '' || String(kind) === wanted;
  });
}

/**
 * Lignes VoIP. L'objet UCaaSVoIPAccount ne porte NI email NI nom de personne :
 * l'identite est reconstruite ailleurs (shared/identity.js).
 * @param {import('./_config.js').Config} cfg
 * @param {string} token
 * @param {object} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function fetchVoipLines(cfg, token, opts) {
  const raw = await fetchServices(cfg, token, 'UCaaSVoIPAccount', opts);
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const csi = str(r.csi);
    if (!csi) continue;
    out.push({
      csi,
      formattedCsi: str(r.formatted_csi),
      name: str(r.name),
      offerId: str(r.offer_id),
      offerName: str(r.offer_name),
      status: str(r.status),
      blockingStatus: str(r.blocking_status),
      options: Array.isArray(r.options) ? r.options.map((o) => str(o)).filter(Boolean) : [],
      shortNumber: str(r.short_number),
      presentedNumber: str(r.presented_number),
      presentedNumberRaw: str(r.presented_number_raw),
      incomingAcdCallsAllowed: bool(r.incoming_acd_calls_allowed),
    });
  }
  return out;
}

/**
 * Comptes de messagerie : une des sources d'identite (first_name / last_name).
 *
 * Le type EmailAccount ne documente pas de champ `email` ; sur le compte reel
 * c'est le CSI (ou sa forme formatee) qui EST l'adresse. On ne retient donc que
 * les valeurs qui passent `isEmail`, sans jamais fabriquer une adresse.
 *
 * @param {import('./_config.js').Config} cfg
 * @param {string} token
 * @param {object} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function fetchEmailAccounts(cfg, token, opts) {
  const raw = await fetchServices(cfg, token, 'EmailAccount', opts);
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const csi = str(r.csi);
    const candidates = [r.email, r.formatted_csi, r.csi, r.name];
    let email = '';
    for (const c of candidates) {
      const v = str(c).toLowerCase();
      if (isEmail(v)) { email = v; break; }
    }
    out.push({
      csi,
      formattedCsi: str(r.formatted_csi),
      email,
      firstName: str(r.first_name),
      lastName: str(r.last_name),
      name: str(r.name),
      quota: r.quota == null ? null : r.quota,
      status: str(r.status),
    });
  }
  return out;
}

/**
 * Contacts d'annuaire : source d'identite PRINCIPALE, car seule a porter a la
 * fois l'email et les numeros.
 *
 * Attention : dans DirectoryContact, `name` est le NOM DE FAMILLE.
 * `base64_picture` est deliberement ecarte — une photo par contact ferait
 * exploser la taille de la reponse pour un usage nul cote supervision.
 *
 * @param {import('./_config.js').Config} cfg
 * @param {string} token
 * @param {object} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function fetchDirectoryContacts(cfg, token, opts) {
  const raw = await keyyoGetAll(cfg, token, '/directory_contacts', {}, opts || {});
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const numbers = uniqueStrings([r.default_number, r.work_number, r.mobile_number, r.home_number]);
    const speedNumbers = uniqueStrings([r.work_speed_number, r.mobile_speed_number, r.home_speed_number]);
    const email = str(r.email).toLowerCase();
    out.push({
      uid: str(r.uid),
      branchUid: str(r.branch_uid),
      firstName: str(r.first_name),
      lastName: str(r.name),
      email: isEmail(email) ? email : '',
      company: str(r.company),
      job: str(r.job),
      address: str(r.address),
      zipcode: str(r.zipcode),
      city: str(r.city),
      country: str(r.country),
      numbers,
      speedNumbers,
      hasPicture: !!str(r.base64_picture),
    });
  }
  return out;
}

/** @param {any[]} values @returns {string[]} */
function uniqueStrings(values) {
  const out = [];
  for (const v of values) {
    const s = str(v);
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

/**
 * Borne de date au format attendu par Keyyo : « YYYY-MM-DD HH:MM ».
 * Accepte une Date, une date calendaire `YYYY-MM-DD` (minuit) ou une chaine
 * horodatee.
 * @param {unknown} value
 * @param {string} tz
 * @param {string} which nom du parametre, pour le message d'erreur.
 * @returns {string}
 */
function keyyoBound(value, tz, which) {
  if (value instanceof Date) return toKeyyoDate(value, tz);
  const s = str(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 00:00';
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return s.slice(0, 10) + ' ' + s.slice(11, 16);
  const d = parseTimestamp(s);
  if (d) return toKeyyoDate(d, tz);
  throw new Error(
    'Borne de date « ' + which + ' » inexploitable (' + (s || 'vide') + '). '
    + 'Attendu : une date « YYYY-MM-DD » ou un objet Date.',
  );
}

/**
 * Releve d'appels d'une ligne, pour un sens et une fenetre donnes.
 *
 * `to` est passe tel quel a `date_end`, qui est EXCLUSIVE cote Keyyo.
 * Le diagnostic renvoie le brut vu, le garde, l'ecarte et les RAISONS de rejet :
 * un ecart entre `rawSeen` et `kept` doit toujours pouvoir s'expliquer.
 *
 * @param {import('./_config.js').Config} cfg
 * @param {string} token
 * @param {{csi: string, direction: 'in'|'out', from: any, to: any, month?: string, deadline?: number, onDrop?: (raw: any, reason: string, ctx: any) => void}} args
 * @returns {Promise<{rows: any[], diag: object}>}
 */
export async function fetchCallDetail(cfg, token, args) {
  const a = args || /** @type {any} */ ({});
  const csi = str(a.csi);
  if (!csi) throw new Error('fetchCallDetail : CSI manquant, impossible de choisir la ligne a interroger.');
  const direction = a.direction === 'out' ? 'out' : 'in';
  const tz = cfg.tz;

  const dateStart = keyyoBound(a.from, tz, 'from');
  const dateEnd = keyyoBound(a.to, tz, 'to');
  const path = '/services/' + encodeURIComponent(csi) + '/'
    + (direction === 'out' ? 'outgoing_call_detail' : 'incoming_call_detail');

  /** @type {Record<string, number>} */
  const dropReasons = {};
  let dropped = 0;
  const onDrop = (raw, reason) => {
    const key = str(reason) || 'raison non precisee';
    dropped++;
    dropReasons[key] = (dropReasons[key] || 0) + 1;
    if (typeof a.onDrop === 'function') a.onDrop(raw, key, { csi, direction, month: a.month || '' });
  };

  const stats = /** @type {{pages?: number, truncated?: boolean}} */ ({});
  const startedAt = Date.now();

  const records = await keyyoGetAll(cfg, token, path, {
    date_start: dateStart,
    date_end: dateEnd,
  }, { deadline: a.deadline, stats });

  /** @type {any[]} */
  const rows = [];
  for (const rec of records) {
    const row = normalizeCdr(rec, { direction, csi, tz, onDrop });
    if (!row) continue;
    // Un releve SMS / data porte un COMPTE d'unites, pas une duree : le garder
    // le ferait passer pour un appel non decroche, donc pour un manque.
    if (row[F.unit] !== 'second') {
      onDrop(rec, 'unite non vocale : ' + (row[F.unit] || 'inconnue'));
      continue;
    }
    rows.push(row);
  }

  return {
    rows,
    diag: {
      csi,
      direction,
      month: str(a.month) || dateStart.slice(0, 7),
      from: dateStart,
      to: dateEnd,
      pages: Number(stats.pages) || 0,
      truncated: !!stats.truncated,
      rawSeen: records.length,
      kept: rows.length,
      dropped,
      dropReasons,
      elapsedMs: Date.now() - startedAt,
      ok: true,
    },
  };
}
