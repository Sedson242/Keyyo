// =============================================================================
//  api/_auth.js — Session utilisateur et controle d'acces. Non route.
//
//  L'application authentifie ses utilisateurs aupres de Microsoft Entra ID,
//  ENTIEREMENT COTE SERVEUR (voir api/auth.js) : le navigateur ne recoit jamais
//  de jeton Microsoft, seulement un COOKIE DE SESSION signe par ce module.
//
//  POURQUOI UN COOKIE SIGNE ET PAS UN MAGASIN DE SESSIONS. Les fonctions
//  serverless n'ont pas de memoire commune, et l'archive Blob n'est pas faite
//  pour une lecture a chaque requete. Le cookie porte donc lui-meme l'identite
//  (adresse, nom, role, expiration), scellee par un HMAC-SHA256 : toute
//  modification le rend illisible, et sans le secret personne ne peut en
//  fabriquer un. Il est HttpOnly (invisible au JavaScript de la page), Secure,
//  SameSite=Lax (jamais envoye sur une requete initiee par un autre site,
//  sauf navigation de premier niveau en GET).
//
//  LA POLITIQUE D'ACCES VIT DANS shared/roles.js. Ce module ne fait que
//  l'appliquer : `requireRole` lit la session, verifie le role contre la route,
//  et repond 401 / 403 / 503 a la place de la route quand il faut refuser.
//
//  AUCUN SECRET N'EST JAMAIS RENVOYE : `authSummary` ne dit que « defini » ou
//  « absent », comme configSummary.
// =============================================================================

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sendJson } from './_config.js';
import { canAccess, allowedRoles, roleFromClaims, parseEmailList, ROLES } from '../shared/roles.js';

/** Nom du cookie de session. */
export const SESSION_COOKIE = 'keyyo_session';

/** Nom du cookie porte entre l'aller et le retour du flot d'autorisation. */
export const FLOW_COOKIE = 'keyyo_auth_flow';

/** Duree de vie d'une session : une journee de travail, large. */
const DEFAULT_SESSION_TTL_SEC = 12 * 3600;

/** Bornes de la duree de session configurable, en secondes. */
const MIN_SESSION_TTL_SEC = 15 * 60;
const MAX_SESSION_TTL_SEC = 7 * 24 * 3600;

/** Longueur minimale acceptee pour SESSION_SECRET. */
const MIN_SECRET_LENGTH = 32;

// -----------------------------------------------------------------------------
//  Configuration
// -----------------------------------------------------------------------------

/**
 * @typedef {object} AuthConfig
 * @property {boolean} configured   vrai si le flot Entra est utilisable
 * @property {string[]} missing     variables manquantes, pour le message
 * @property {string} tenantId
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string} authority     https://login.microsoftonline.com/<tenant>
 * @property {string} sessionSecret
 * @property {'explicit'|'derived'|'none'} sessionSecretSource
 * @property {number} sessionTtlSec
 * @property {string[]} directionEmails
 * @property {string} redirectUri   URI de redirection forcee, ou ''
 */

/** @param {unknown} raw @returns {string} */
function text(raw) {
  return String(raw == null ? '' : raw).trim();
}

/**
 * Lit la configuration Entra depuis l'environnement. Ne jette jamais : une
 * configuration absente est un ETAT (l'application est fermee), pas une panne.
 *
 * SESSION_SECRET est facultatif : a defaut, le secret de session est DERIVE du
 * secret client Entra par SHA-256. Cela evite une variable de plus a poser,
 * au prix d'une consequence a connaitre — changer le secret client Entra
 * deconnecte tout le monde. Poser SESSION_SECRET explicitement decouple les
 * deux.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {AuthConfig}
 */
export function readAuthConfig(env) {
  const e = env || (typeof process !== 'undefined' && process.env ? process.env : {});

  const tenantId = text(e.ENTRA_TENANT_ID);
  const clientId = text(e.ENTRA_CLIENT_ID);
  const clientSecret = text(e.ENTRA_CLIENT_SECRET);

  let sessionSecret = text(e.SESSION_SECRET);
  /** @type {'explicit'|'derived'|'none'} */
  let sessionSecretSource = 'explicit';
  if (sessionSecret && sessionSecret.length < MIN_SECRET_LENGTH) {
    // Un secret court est pire qu'absent : il donne l'impression d'etre
    // protege. On l'ignore, et le diagnostic le dira.
    sessionSecret = '';
  }
  if (!sessionSecret && clientSecret) {
    sessionSecret = createHash('sha256').update('keyyo-session|' + clientSecret).digest('hex');
    sessionSecretSource = 'derived';
  }
  if (!sessionSecret) sessionSecretSource = 'none';

  const missing = [];
  if (!tenantId) missing.push('ENTRA_TENANT_ID');
  if (!clientId) missing.push('ENTRA_CLIENT_ID');
  if (!clientSecret) missing.push('ENTRA_CLIENT_SECRET');

  const ttlRaw = Number(text(e.SESSION_TTL_SECONDS));
  let sessionTtlSec = DEFAULT_SESSION_TTL_SEC;
  if (Number.isFinite(ttlRaw) && ttlRaw > 0) {
    sessionTtlSec = Math.min(MAX_SESSION_TTL_SEC, Math.max(MIN_SESSION_TTL_SEC, Math.round(ttlRaw)));
  }

  return {
    configured: missing.length === 0 && !!sessionSecret,
    missing,
    tenantId,
    clientId,
    clientSecret,
    authority: 'https://login.microsoftonline.com/' + encodeURIComponent(tenantId || 'common'),
    sessionSecret,
    sessionSecretSource,
    sessionTtlSec,
    directionEmails: parseEmailList(e.AUTH_DIRECTION_EMAILS),
    redirectUri: text(e.AUTH_REDIRECT_URI),
  };
}

/**
 * Resume affichable, SANS AUCUN SECRET.
 * @param {AuthConfig} auth
 * @returns {object}
 */
export function authSummary(auth) {
  const a = auth || readAuthConfig();
  const mask = (v) => (v ? 'defini' : 'absent');
  return {
    configured: !!a.configured,
    missing: a.missing || [],
    tenantId: mask(a.tenantId),
    clientId: mask(a.clientId),
    clientSecret: mask(a.clientSecret),
    sessionSecret: a.sessionSecretSource === 'explicit' ? 'defini'
      : (a.sessionSecretSource === 'derived' ? 'derive du secret client' : 'absent'),
    sessionTtlSec: a.sessionTtlSec,
    directionEmails: (a.directionEmails || []).length,
    redirectUri: a.redirectUri || '(deduite de la requete)',
  };
}

// -----------------------------------------------------------------------------
//  Scellement
// -----------------------------------------------------------------------------

/** @param {Buffer|string} data @returns {string} base64url sans bourrage. */
export function b64url(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} s @returns {Buffer} */
export function b64urlDecode(s) {
  const t = String(s == null ? '' : s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 === 0 ? '' : '='.repeat(4 - (t.length % 4));
  return Buffer.from(t + pad, 'base64');
}

/**
 * Signature HMAC-SHA256 d'une chaine, en base64url.
 * @param {string} secret
 * @param {string} data
 * @returns {string}
 */
export function sign(secret, data) {
  return b64url(createHmac('sha256', String(secret)).update(String(data), 'utf8').digest());
}

/**
 * Scelle un objet : `<payload base64url>.<signature>`.
 * @param {string} secret
 * @param {any} obj
 * @returns {string}
 */
export function seal(secret, obj) {
  const payload = b64url(JSON.stringify(obj));
  return payload + '.' + sign(secret, payload);
}

/**
 * Descelle un jeton produit par `seal`. Renvoie `null` si la signature ne
 * correspond pas ou si la charge n'est pas du JSON. La comparaison est a temps
 * constant : une egalite naive fuirait la signature octet par octet.
 * @param {string} secret
 * @param {unknown} token
 * @returns {any|null}
 */
export function open(secret, token) {
  const s = String(token == null ? '' : token);
  const dot = s.indexOf('.');
  if (dot <= 0 || !secret) return null;
  const payload = s.slice(0, dot);
  const given = s.slice(dot + 1);
  const expected = sign(secret, payload);
  if (given.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(b64urlDecode(payload).toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** @param {number} bytes @returns {string} aleatoire fort, en base64url. */
export function randomToken(bytes) {
  return b64url(randomBytes(Math.max(16, Number(bytes) || 32)));
}

// -----------------------------------------------------------------------------
//  Cookies
// -----------------------------------------------------------------------------

/**
 * Cookies de la requete, nom -> valeur (premiere occurrence).
 * @param {any} req
 * @returns {Record<string, string>}
 */
export function parseCookies(req) {
  /** @type {Record<string, string>} */
  const out = {};
  const raw = String((req && req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * En-tete Set-Cookie. Toujours HttpOnly, Secure, SameSite=Lax : ce module ne
 * pose que des cookies d'authentification, aucun n'a de raison d'etre lu par
 * la page ni envoye depuis un autre site.
 * @param {string} name
 * @param {string} value  deja sur (base64url).
 * @param {{maxAge?: number, path?: string}} [opts]
 * @returns {string}
 */
export function cookieHeader(name, value, opts) {
  const o = opts || {};
  const parts = [name + '=' + String(value == null ? '' : value)];
  parts.push('Path=' + (o.path || '/'));
  if (typeof o.maxAge === 'number') parts.push('Max-Age=' + Math.max(0, Math.floor(o.maxAge)));
  parts.push('HttpOnly', 'Secure', 'SameSite=Lax');
  return parts.join('; ');
}

/**
 * En-tete qui EFFACE un cookie (valeur vide, Max-Age=0), avec le meme chemin
 * que celui qui l'a pose — sans quoi le navigateur en garderait une copie.
 * @param {string} name
 * @param {string} [path]
 * @returns {string}
 */
export function clearCookieHeader(name, path) {
  return cookieHeader(name, '', { maxAge: 0, path: path || '/' });
}

/**
 * Ajoute un Set-Cookie sans ecraser ceux deja poses sur la reponse.
 * @param {any} res
 * @param {string} header
 */
export function appendSetCookie(res, header) {
  const prev = res.getHeader ? res.getHeader('Set-Cookie') : null;
  /** @type {string[]} */
  let list = [];
  if (Array.isArray(prev)) list = prev.map(String);
  else if (prev) list = [String(prev)];
  list.push(header);
  res.setHeader('Set-Cookie', list);
}

// -----------------------------------------------------------------------------
//  Session
// -----------------------------------------------------------------------------

/**
 * @typedef {object} Session
 * @property {string} sub     identifiant stable Entra (`oid` de preference)
 * @property {string} email   adresse, en minuscules
 * @property {string} name    nom affichable
 * @property {'direction'|'agent'} role
 * @property {number} iat     emission, secondes Unix
 * @property {number} exp     expiration, secondes Unix
 */

/**
 * Construit la session a partir des claims verifies d'un jeton d'identite.
 * @param {any} claims
 * @param {AuthConfig} auth
 * @param {number} [now] millisecondes
 * @returns {Session}
 */
export function sessionFromClaims(claims, auth, now) {
  const c = claims && typeof claims === 'object' ? claims : {};
  const t = Math.floor((now || Date.now()) / 1000);
  const email = String(c.email || c.preferred_username || c.upn || '').trim().toLowerCase();
  return {
    sub: String(c.oid || c.sub || ''),
    email,
    name: String(c.name || email || '').trim(),
    role: roleFromClaims(c, { directionEmails: auth.directionEmails }),
    iat: t,
    exp: t + auth.sessionTtlSec,
  };
}

/**
 * Session portee par la requete, ou `null` (absente, alteree, expiree, ou
 * role inconnu).
 * @param {any} req
 * @param {AuthConfig} auth
 * @param {number} [now] millisecondes
 * @returns {Session|null}
 */
export function readSession(req, auth, now) {
  if (!auth || !auth.sessionSecret) return null;
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const s = open(auth.sessionSecret, raw);
  if (!s) return null;
  const t = Math.floor((now || Date.now()) / 1000);
  if (!(Number(s.exp) > t)) return null;
  if (!s.email || ROLES.indexOf(String(s.role)) < 0) return null;
  return {
    sub: String(s.sub || ''),
    email: String(s.email),
    name: String(s.name || s.email),
    role: /** @type {'direction'|'agent'} */ (String(s.role)),
    iat: Number(s.iat) || 0,
    exp: Number(s.exp),
  };
}

/**
 * En-tete Set-Cookie d'une session.
 * @param {Session} session
 * @param {AuthConfig} auth
 * @returns {string}
 */
export function sessionCookieHeader(session, auth) {
  const now = Math.floor(Date.now() / 1000);
  return cookieHeader(SESSION_COOKIE, seal(auth.sessionSecret, session), {
    maxAge: Math.max(0, session.exp - now),
    path: '/',
  });
}

/**
 * Vue publique d'une session, pour le front. Rien de plus que ce que la page
 * a besoin d'afficher.
 * @param {Session} session
 * @returns {{email: string, name: string, role: string, expiresAt: string}}
 */
export function publicUser(session) {
  return {
    email: session.email,
    name: session.name,
    role: session.role,
    expiresAt: new Date(session.exp * 1000).toISOString(),
  };
}

// -----------------------------------------------------------------------------
//  Garde de route
// -----------------------------------------------------------------------------

/**
 * Applique la politique d'acces a une route. Renvoie la session quand l'acces
 * est accorde ; sinon, ECRIT LA REPONSE (503, 401 ou 403) et renvoie `null`.
 * Usage : `const session = requireRole(req, res, '/api/calls'); if (!session) return;`
 *
 * Les refus ne sont jamais mis en cache, et les succes portent `Vary: Cookie`
 * pour qu'un cache navigateur ne resserve pas a une session la reponse d'une
 * autre.
 *
 * @param {any} req
 * @param {any} res
 * @param {string} route chemin exact, tel qu'inscrit dans shared/roles.js.
 * @param {AuthConfig} [auth]
 * @returns {Session|null}
 */
export function requireRole(req, res, route, auth) {
  const a = auth || readAuthConfig();

  if (!a.configured) {
    sendJson(res, 503, {
      error: 'Authentification non configurée',
      configured: false,
      authenticated: false,
      hint: 'Cette application est fermée tant que la connexion Microsoft Entra n\'est pas configurée. '
        + 'Renseigner ' + (a.missing.length ? a.missing.join(', ') : 'les variables ENTRA_*')
        + ' dans les variables d\'environnement du projet Vercel (voir .env.example, section 8), puis redéployer.',
    }, 'no-store');
    return null;
  }

  const session = readSession(req, a);
  if (!session) {
    sendJson(res, 401, {
      error: 'Authentification requise',
      configured: true,
      authenticated: false,
      login: '/api/auth?action=login',
      hint: 'Ouvrir /api/auth?action=login pour se connecter avec un compte Microsoft de l\'organisation.',
    }, 'no-store');
    return null;
  }

  if (!canAccess(route, session.role)) {
    sendJson(res, 403, {
      error: 'Accès réservé',
      configured: true,
      authenticated: true,
      role: session.role,
      hint: 'La route ' + route + ' est réservée à : ' + (allowedRoles(route).join(', ') || 'personne') + '. '
        + 'Votre compte est reconnu comme « ' + session.role + ' ».',
    }, 'no-store');
    return null;
  }

  res.setHeader('Vary', 'Cookie');
  return session;
}

/**
 * Comparaison a temps constant de deux chaines (secret de cron, etc.).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  try {
    return timingSafeEqual(x, y);
  } catch {
    return false;
  }
}
