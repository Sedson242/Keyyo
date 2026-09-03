// =============================================================================
//  api/_config.js — Lecture et validation de l'environnement.
//
//  Aucun secret n'est jamais ecrit en dur ni renvoye dans une reponse HTTP :
//  `configSummary` ne rapporte que la PRESENCE d'un secret, jamais sa valeur.
//  C'est ce resume que la page Diagnostic affiche.
//
//  Ce module porte aussi les trois helpers d'entree/sortie HTTP communs aux
//  routes (`readParams`, `flag`, `sendJson`) : le contrat n'autorise pas de
//  fichier supplementaire dans `api/`, et ces helpers relevent de la meme
//  responsabilite que `readConfig` — lire une entree exterieure sans lui faire
//  confiance. Les fichiers prefixes d'un tiret bas ne sont pas routes.
// =============================================================================

import { safeTz } from '../shared/time.js';
import { parseLineEmails } from '../shared/identity.js';

/** Base de l'API Manager 1.0. */
export const DEFAULT_BASE = 'https://api.keyyo.com/manager/1.0';

/** Point d'emission des jetons OAuth2. */
export const DEFAULT_TOKEN_URL = 'https://api.keyyo.com/oauth2/token.php';

/** Perimetre de donnees vise par l'outil : les trois derniers mois. */
export const DEFAULT_HISTORY_DAYS = 92;

// -----------------------------------------------------------------------------
//  Lecture typee et bornee
// -----------------------------------------------------------------------------

/**
 * @param {unknown} raw
 * @param {string} fallback
 * @returns {string}
 */
function text(raw, fallback) {
  const s = String(raw == null ? '' : raw).trim();
  return s || fallback;
}

/**
 * Entier borne. Une variable absente ou illisible retombe sur le defaut plutot
 * que sur 0 : `Number('')` vaut 0, ce qui desactiverait silencieusement une
 * limite (pagination, budget de temps).
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function integer(raw, fallback, min, max) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.round(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** @param {unknown} raw @returns {boolean} */
function truthy(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * @typedef {object} Config
 * @property {string} base
 * @property {string} tokenUrl
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string} refreshToken
 * @property {string} staticToken
 * @property {string} tz
 * @property {number} historyDays
 * @property {number} syncDays
 * @property {number} retentionDays
 * @property {number} pageLimit
 * @property {number} maxPages
 * @property {number} budgetMs
 * @property {Record<string, string>} lineEmails
 * @property {string} cronSecret
 * @property {boolean} blobEnabled
 */

/**
 * Lit la configuration depuis l'environnement.
 *
 * Jette si aucun moyen d'authentification n'est exploitable : mieux vaut une
 * erreur nette au premier appel qu'une cascade de 401 illisibles ensuite.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Config}
 */
export function readConfig(env) {
  const e = env || (typeof process !== 'undefined' && process.env ? process.env : {});

  const clientId = text(e.KEYYO_CLIENT_ID, '');
  const clientSecret = text(e.KEYYO_CLIENT_SECRET, '');
  const refreshToken = text(e.KEYYO_REFRESH_TOKEN, '');
  const staticToken = text(e.KEYYO_ACCESS_TOKEN, '');

  const hasOauth = !!(clientId && clientSecret && refreshToken);
  if (!hasOauth && !staticToken) {
    const missing = [];
    if (!clientId) missing.push('KEYYO_CLIENT_ID');
    if (!clientSecret) missing.push('KEYYO_CLIENT_SECRET');
    if (!refreshToken) missing.push('KEYYO_REFRESH_TOKEN');
    throw new Error(
      'Aucune authentification Keyyo configurable. Renseigner les trois variables '
      + missing.join(', ')
      + " (flot OAuth2 refresh_token, scope full_access_read_only), ou a defaut KEYYO_ACCESS_TOKEN "
      + "pour un jeton d'acces deja obtenu. Ces valeurs se definissent dans les "
      + 'variables d\'environnement du projet Vercel, jamais dans le code.',
    );
  }

  return {
    base: text(e.KEYYO_API_BASE, DEFAULT_BASE).replace(/\/+$/, ''),
    tokenUrl: text(e.KEYYO_TOKEN_URL, DEFAULT_TOKEN_URL),
    clientId,
    clientSecret,
    refreshToken,
    staticToken,
    // TZ arrive parfois au format POSIX ':UTC' : safeTz nettoie et valide.
    tz: safeTz(e.TZ || e.KEYYO_TZ),
    historyDays: integer(e.KEYYO_HISTORY_DAYS, DEFAULT_HISTORY_DAYS, 1, 800),
    syncDays: integer(e.KEYYO_SYNC_DAYS, 7, 1, 800),
    // 0 = aucune purge : l'archive garde tout ce qu'elle a vu passer.
    retentionDays: integer(e.KEYYO_RETENTION_DAYS, 0, 0, 3650),
    pageLimit: integer(e.KEYYO_PAGE_LIMIT, 200, 10, 1000),
    maxPages: integer(e.KEYYO_MAX_PAGES, 40, 1, 500),
    budgetMs: integer(e.KEYYO_BUDGET_MS, 24000, 3000, 280000),
    lineEmails: parseLineEmails(e.KEYYO_LINE_EMAILS),
    cronSecret: text(e.CRON_SECRET, ''),
    blobEnabled: !!text(e.BLOB_READ_WRITE_TOKEN, '') || truthy(e.KEYYO_FORCE_BLOB),
  };
}

/**
 * Resume affichable de la configuration. NE CONTIENT AUCUN SECRET : chaque
 * valeur sensible est reduite a « defini » ou « absent ».
 * @param {Config} cfg
 * @returns {object}
 */
export function configSummary(cfg) {
  const mask = (v) => (v ? 'defini' : 'absent');
  const c = cfg || /** @type {any} */ ({});
  const overrides = c.lineEmails || {};
  return {
    base: c.base || '',
    tokenUrl: c.tokenUrl || '',
    tz: c.tz || '',
    auth: {
      mode: c.staticToken && !c.refreshToken ? 'jeton statique' : 'oauth2 refresh_token',
      clientId: mask(c.clientId),
      clientSecret: mask(c.clientSecret),
      refreshToken: mask(c.refreshToken),
      staticToken: mask(c.staticToken),
    },
    window: {
      historyDays: c.historyDays,
      syncDays: c.syncDays,
      retentionDays: c.retentionDays,
    },
    http: { pageLimit: c.pageLimit, maxPages: c.maxPages, budgetMs: c.budgetMs },
    lineEmails: { count: Object.keys(overrides).length, csis: Object.keys(overrides) },
    cronSecret: mask(c.cronSecret),
    blobEnabled: !!c.blobEnabled,
  };
}

// -----------------------------------------------------------------------------
//  Entrees / sorties HTTP
// -----------------------------------------------------------------------------

/**
 * Lit les parametres de requete sans supposer que le runtime fournit
 * `req.query` : sur certains environnements Node il est absent. On analyse donc
 * toujours `req.url`, puis on superpose `req.query` s'il existe.
 * @param {{url?: string, query?: any}} req
 * @returns {Record<string, string>}
 */
export function readParams(req) {
  /** @type {Record<string, string>} */
  const out = {};

  const url = String((req && req.url) || '');
  const i = url.indexOf('?');
  if (i >= 0) {
    let sp = null;
    try { sp = new URLSearchParams(url.slice(i + 1)); } catch { sp = null; }
    if (sp) for (const [k, v] of sp) out[k] = String(v == null ? '' : v);
  }

  const q = req && req.query;
  if (q && typeof q === 'object') {
    for (const k of Object.keys(q)) {
      const v = /** @type {any} */ (q)[k];
      if (Array.isArray(v)) out[k] = String(v.length ? v[0] : '');
      else if (v != null) out[k] = String(v);
    }
  }
  return out;
}

/**
 * Vrai si un drapeau de requete est actif. Un parametre present sans valeur
 * (`?force`) compte comme actif : c'est la forme que tapent les humains.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function flag(raw) {
  if (raw == null) return false;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return true;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Ecrit une reponse JSON. `cacheControl` est explicite a chaque appel : une
 * reponse vide ou en erreur ne doit JAMAIS etre mise en cache par le CDN.
 * @param {any} res
 * @param {number} status
 * @param {any} body
 * @param {string} [cacheControl]
 */
export function sendJson(res, status, body, cacheControl) {
  let payload;
  try {
    payload = JSON.stringify(body);
  } catch (err) {
    status = 500;
    payload = JSON.stringify({
      error: 'Reponse non serialisable',
      hint: 'Anomalie interne : ' + errorMessage(err) + '. Relancer avec ?debug=1 et consulter /api/health.',
    });
    cacheControl = 'no-store';
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl || 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(payload);
}

/**
 * Rejette toute methode autre que GET/HEAD. Renvoie vrai quand la reponse a
 * deja ete ecrite, ce qui permet un `if (rejectNonGet(req, res)) return;`.
 * @param {any} req
 * @param {any} res
 * @param {string} route
 * @returns {boolean}
 */
export function rejectNonGet(req, res, route) {
  const m = String((req && req.method) || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return false;
  res.setHeader('Allow', 'GET, HEAD');
  sendJson(res, 405, {
    error: 'Methode ' + m + ' non autorisee',
    hint: 'Cette route est en lecture seule : utiliser GET ' + route + '.',
  }, 'no-store');
  return true;
}

/**
 * Message d'erreur exploitable, borne en longueur pour ne pas noyer la reponse.
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
  const raw = err && /** @type {any} */ (err).message ? String(/** @type {any} */ (err).message) : String(err);
  const s = raw.trim() || 'erreur inconnue';
  return s.length > 500 ? s.slice(0, 500) + '…' : s;
}
