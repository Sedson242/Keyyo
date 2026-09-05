// =============================================================================
//  api/auth.js — GET /api/auth : connexion Microsoft Entra ID, cote serveur.
//
//  Flot « authorization code » avec PKCE, joue ENTIEREMENT ICI :
//
//    ?action=login     -> 302 vers Microsoft, avec un cookie de flot signe
//                         (state anti-rejeu, nonce, verificateur PKCE, page
//                         de retour).
//    ?code=…&state=…   -> retour de Microsoft : on verifie le cookie de flot,
//                         on echange le code contre un jeton d'identite EN
//                         PARLANT DIRECTEMENT au serveur de jetons (avec le
//                         secret client), on valide le jeton, on pose le
//                         cookie de session, on renvoie vers l'application.
//    ?action=me        -> JSON : qui est connecte, ou 401.
//    ?action=logout    -> efface la session, puis 302 vers la deconnexion
//                         Microsoft.
//
//  POURQUOI COTE SERVEUR. Aucun jeton Microsoft n'atteint le navigateur, la
//  politique de securite de contenu du site reste `script-src 'self'` et
//  `connect-src 'self'` sans exception, et le controle d'acces est applique la
//  ou il ne peut pas etre contourne — dans les fonctions qui servent les
//  donnees (api/_auth.js#requireRole).
//
//  VALIDATION DU JETON D'IDENTITE. Il est recu par un echange direct et
//  chiffre avec le serveur de jetons de Microsoft, jamais via le navigateur.
//  Dans ce cas, OpenID Connect Core (3.1.3.7, point 6) autorise a se reposer
//  sur la validation TLS du serveur plutot que sur la signature du jeton. On
//  verifie donc l'emetteur, le destinataire, le locataire, le nonce et
//  l'expiration — c'est ce qui protege d'un code injecte ou d'un jeton d'une
//  autre application — sans recuperer les cles publiques a chaque connexion.
//
//  CE QU'IL FAUT COTE ENTRA : une inscription d'application de type « Web »,
//  avec l'URI de redirection https://<domaine>/api/auth, un secret client, et
//  (facultatif) des app roles « Direction » / « Agent » attribues aux
//  personnes. Voir .env.example, section 8.
// =============================================================================

import { createHash } from 'node:crypto';
import { readParams, sendJson, rejectNonGet, errorMessage } from './_config.js';
import {
  readAuthConfig, readSession, sessionFromClaims, sessionCookieHeader, publicUser,
  FLOW_COOKIE, SESSION_COOKIE, seal, open, randomToken, parseCookies, b64url, b64urlDecode,
  cookieHeader, clearCookieHeader, appendSetCookie,
} from './_auth.js';
import { roleLabel } from '../shared/roles.js';

/** Scopes OpenID demandes. `email` est facultatif cote Entra, `profile` donne le nom. */
const SCOPES = 'openid profile email';

/** Duree de vie du cookie de flot : le temps de se connecter, pas plus. */
const FLOW_TTL_SEC = 10 * 60;

/** Delai maximal de l'echange de code, en millisecondes. */
const TOKEN_TIMEOUT_MS = 10000;

/** Tolerance d'horloge sur `iat` / `exp`, en secondes. */
const CLOCK_SKEW_SEC = 300;

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/auth')) return;

  const auth = readAuthConfig();
  const params = readParams(req);
  let action = String(params.action || '').trim().toLowerCase();
  if (!action) action = (params.code || params.error) ? 'callback' : 'me';

  try {
    if (action === 'me') return me(req, res, auth);
    if (action === 'logout') return logout(req, res, auth);

    if (!auth.configured) {
      return html(res, 503, page(
        'Connexion indisponible',
        '<p>La connexion Microsoft n’est pas configurée sur ce déploiement.</p>'
        + '<p>Variables manquantes : <code>' + esc(auth.missing.join(', ') || 'secret de session') + '</code>. '
        + 'Voir <code>.env.example</code>, section 8.</p>',
      ));
    }

    if (action === 'login') return login(req, res, auth, params);
    if (action === 'callback') return callback(req, res, auth, params);

    return sendJson(res, 400, {
      error: 'Action inconnue',
      hint: 'Actions acceptées : login, me, logout.',
    }, 'no-store');
  } catch (err) {
    return html(res, 500, page(
      'Connexion impossible',
      '<p class="err">' + esc(errorMessage(err)) + '</p>'
      + '<p><a href="/api/auth?action=login">Réessayer</a> · <a href="/">Retour à l’application</a></p>',
    ));
  }
}

// -----------------------------------------------------------------------------
//  Actions
// -----------------------------------------------------------------------------

/**
 * Qui est connecte. C'est la premiere requete du front : elle decide entre
 * l'ecran de connexion et l'application.
 */
function me(req, res, auth) {
  if (!auth.configured) {
    return sendJson(res, 503, {
      authenticated: false,
      configured: false,
      error: 'Authentification non configurée',
      missing: auth.missing,
      hint: 'Renseigner ' + (auth.missing.join(', ') || 'SESSION_SECRET') + ' dans Vercel, puis redéployer.',
    }, 'no-store');
  }
  const session = readSession(req, auth);
  if (!session) {
    return sendJson(res, 401, {
      authenticated: false,
      configured: true,
      login: '/api/auth?action=login',
    }, 'no-store');
  }
  res.setHeader('Vary', 'Cookie');
  return sendJson(res, 200, {
    authenticated: true,
    configured: true,
    user: Object.assign(publicUser(session), { roleLabel: roleLabel(session.role) }),
    logout: '/api/auth?action=logout',
  }, 'no-store');
}

/** Depart vers Microsoft. */
function login(req, res, auth, params) {
  const verifier = randomToken(48);
  const flow = {
    state: randomToken(24),
    nonce: randomToken(24),
    verifier,
    next: safeNext(params.next),
    iat: Math.floor(Date.now() / 1000),
  };
  const challenge = b64url(createHash('sha256').update(verifier, 'utf8').digest());

  const url = auth.authority + '/oauth2/v2.0/authorize'
    + '?client_id=' + encodeURIComponent(auth.clientId)
    + '&response_type=code'
    + '&response_mode=query'
    + '&redirect_uri=' + encodeURIComponent(redirectUriOf(req, auth))
    + '&scope=' + encodeURIComponent(SCOPES)
    + '&state=' + encodeURIComponent(flow.state)
    + '&nonce=' + encodeURIComponent(flow.nonce)
    + '&code_challenge=' + encodeURIComponent(challenge)
    + '&code_challenge_method=S256'
    + '&prompt=select_account';

  appendSetCookie(res, cookieHeader(FLOW_COOKIE, seal(auth.sessionSecret, flow), {
    maxAge: FLOW_TTL_SEC,
    path: '/api/auth',
  }));
  redirect(res, url);
}

/** Retour de Microsoft. */
async function callback(req, res, auth, params) {
  // Microsoft signale un refus (consentement, compte hors locataire...) par
  // des parametres d'erreur : on l'affiche tel quel, il est plus precis que
  // tout ce qu'on pourrait deviner.
  if (params.error) {
    return html(res, 400, page(
      'Connexion refusée',
      '<p>Microsoft a répondu : <code>' + esc(params.error) + '</code></p>'
      + (params.error_description ? '<p class="err">' + esc(params.error_description) + '</p>' : '')
      + '<p><a href="/api/auth?action=login">Réessayer</a> · <a href="/">Retour</a></p>',
    ));
  }

  const flow = open(auth.sessionSecret, parseCookies(req)[FLOW_COOKIE]);
  const now = Math.floor(Date.now() / 1000);
  if (!flow || !flow.state || !flow.nonce || !flow.verifier
    || !(Number(flow.iat) > now - FLOW_TTL_SEC - CLOCK_SKEW_SEC)) {
    return html(res, 400, page(
      'Session de connexion expirée',
      '<p>La demande de connexion est introuvable ou trop ancienne (plus de dix minutes), '
      + 'ou bien elle a été lancée dans un autre navigateur.</p>'
      + '<p><a href="/api/auth?action=login">Recommencer</a></p>',
    ));
  }
  if (!params.state || String(params.state) !== String(flow.state)) {
    // Un `state` qui ne correspond pas n'est jamais benin : on n'echange rien.
    return html(res, 400, page(
      'État invalide',
      '<p>Le paramètre <code>state</code> ne correspond pas à la demande de connexion. '
      + 'La procédure a peut-être été relancée dans un autre onglet.</p>'
      + '<p><a href="/api/auth?action=login">Recommencer</a></p>',
    ));
  }
  if (!params.code) {
    return html(res, 400, page('Code manquant', '<p>Microsoft n’a pas renvoyé de code d’autorisation.</p>'
      + '<p><a href="/api/auth?action=login">Recommencer</a></p>'));
  }

  const claims = await exchangeCode(auth, String(params.code), flow.verifier, redirectUriOf(req, auth));
  const problem = validateClaims(claims, auth, flow.nonce, now);
  if (problem) {
    return html(res, 401, page(
      'Jeton refusé',
      '<p class="err">' + esc(problem) + '</p>'
      + '<p>Vérifier que l’application Entra est bien celle du locataire configuré '
      + '(<code>ENTRA_TENANT_ID</code>, <code>ENTRA_CLIENT_ID</code>).</p>'
      + '<p><a href="/api/auth?action=login">Recommencer</a></p>',
    ));
  }

  const session = sessionFromClaims(claims, auth);
  if (!session.email) {
    return html(res, 401, page(
      'Compte sans adresse',
      '<p>Le compte Microsoft connecté ne porte ni adresse e-mail ni nom d’utilisateur exploitable. '
      + 'L’application ne peut pas l’identifier.</p>',
    ));
  }

  appendSetCookie(res, clearCookieHeader(FLOW_COOKIE, '/api/auth'));
  appendSetCookie(res, sessionCookieHeader(session, auth));
  redirect(res, flow.next || '/');
}

/** Deconnexion : le cookie est efface, puis Microsoft ferme sa session. */
function logout(req, res, auth) {
  appendSetCookie(res, clearCookieHeader(SESSION_COOKIE, '/'));
  appendSetCookie(res, clearCookieHeader(FLOW_COOKIE, '/api/auth'));
  const home = originOf(req, auth) + '/';
  if (!auth.tenantId) return redirect(res, home);
  redirect(res, auth.authority + '/oauth2/v2.0/logout?post_logout_redirect_uri=' + encodeURIComponent(home));
}

// -----------------------------------------------------------------------------
//  Echange et validation
// -----------------------------------------------------------------------------

/**
 * Echange le code contre un jeton d'identite, directement aupres de Microsoft.
 * @param {import('./_auth.js').AuthConfig} auth
 * @param {string} code
 * @param {string} verifier
 * @param {string} redirectUri
 * @returns {Promise<any>} claims du jeton d'identite (non encore valides).
 */
async function exchangeCode(auth, code, verifier, redirectUri) {
  const body = new URLSearchParams({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: SCOPES,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  let answer;
  let text = '';
  try {
    answer = await fetch(auth.authority + '/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    text = await answer.text();
  } catch (err) {
    const aborted = err && /** @type {any} */ (err).name === 'AbortError';
    throw new Error('Serveur de jetons Microsoft injoignable'
      + (aborted ? ' (délai de ' + TOKEN_TIMEOUT_MS + ' ms dépassé).' : ' : ' + errorMessage(err)));
  } finally {
    clearTimeout(timer);
  }

  /** @type {any} */
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }

  if (!answer.ok || !payload || !payload.id_token) {
    const detail = payload && (payload.error_description || payload.error)
      ? String(payload.error_description || payload.error)
      : 'HTTP ' + answer.status;
    // Le message Microsoft cite souvent le code d'erreur AADSTS : on le garde,
    // c'est ce que l'administrateur cherchera.
    throw new Error('Microsoft a refusé l’échange du code : ' + detail.slice(0, 400));
  }

  const parts = String(payload.id_token).split('.');
  if (parts.length !== 3) throw new Error('Jeton d’identité mal formé.');
  try {
    const claims = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
    return claims && typeof claims === 'object' ? claims : {};
  } catch {
    throw new Error('Jeton d’identité illisible.');
  }
}

/**
 * Verifie les claims. Renvoie un message de refus, ou '' si tout va bien.
 * @param {any} c
 * @param {import('./_auth.js').AuthConfig} auth
 * @param {string} nonce
 * @param {number} now secondes
 * @returns {string}
 */
function validateClaims(c, auth, nonce, now) {
  const expectedIss = 'https://login.microsoftonline.com/' + auth.tenantId + '/v2.0';
  if (String(c.iss || '') !== expectedIss) return 'Émetteur inattendu : ' + String(c.iss || '(absent)') + '.';
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (aud.indexOf(auth.clientId) < 0) return 'Le jeton ne s’adresse pas à cette application.';
  if (String(c.tid || '') !== auth.tenantId) return 'Locataire inattendu : ' + String(c.tid || '(absent)') + '.';
  if (String(c.nonce || '') !== String(nonce)) return 'Le nonce du jeton ne correspond pas à la demande.';
  const exp = Number(c.exp);
  if (!(exp > now - CLOCK_SKEW_SEC)) return 'Jeton expiré.';
  const iat = Number(c.iat);
  if (Number.isFinite(iat) && iat > now + CLOCK_SKEW_SEC) return 'Jeton émis dans le futur (horloge).';
  return '';
}

// -----------------------------------------------------------------------------
//  Outils
// -----------------------------------------------------------------------------

/**
 * Page de retour apres connexion. Uniquement un chemin RELATIF a ce site :
 * jamais une URL absolue ni un `//hote`, qui ferait de cette route un
 * redirecteur ouvert.
 * @param {unknown} raw
 * @returns {string}
 */
function safeNext(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 500) return '/';
  if (!/^\/(?![\/\\])/.test(s)) return '/';
  if (/[\r\n]/.test(s)) return '/';
  return s;
}

/**
 * Origine publique du site, pour l'URI de redirection et le retour de
 * deconnexion. AUTH_REDIRECT_URI, si posee, est souveraine : elle doit
 * correspondre EXACTEMENT a ce qui est declare cote Entra.
 * @param {any} req
 * @param {import('./_auth.js').AuthConfig} auth
 * @returns {string}
 */
function originOf(req, auth) {
  if (auth.redirectUri) {
    try { return new URL(auth.redirectUri).origin; } catch { /* on retombe sur la requete */ }
  }
  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '');
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim();
  return proto + '://' + host;
}

/** @param {any} req @param {import('./_auth.js').AuthConfig} auth @returns {string} */
function redirectUriOf(req, auth) {
  return auth.redirectUri || originOf(req, auth) + '/api/auth';
}

/** @param {any} res @param {string} url */
function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/** @param {unknown} s @returns {string} */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** @param {any} res @param {number} status @param {string} body */
function html(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(body);
}

/**
 * Gabarit de page, autonome (styles en ligne, autorises par la CSP) : ces
 * pages s'affichent quand quelque chose a rate, elles ne doivent dependre de
 * rien d'autre.
 * @param {string} title
 * @param {string} inner HTML deja sur.
 * @returns {string}
 */
function page(title, inner) {
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow">'
    + '<title>' + esc(title) + ' — Keyyo</title>'
    + '<style>'
    + 'body{margin:0;padding:40px 20px;background:#faf8f5;color:#2a2018;'
    + 'font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + '.w{max-width:620px;margin:0 auto;background:#fff;border-radius:22px;padding:28px 30px;'
    + 'box-shadow:0 8px 24px -10px rgba(120,70,40,.12)}'
    + 'h1{font-size:21px;margin:0 0 14px}p{margin:0 0 10px}'
    + 'code{background:#efe9e2;padding:2px 6px;border-radius:4px;font-size:.92em;word-break:break-all}'
    + '.err{color:#b91c1c}a{color:inherit}'
    + '</style></head><body><div class="w"><h1>' + esc(title) + '</h1>' + inner + '</div></body></html>';
}
