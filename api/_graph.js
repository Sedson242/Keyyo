// =============================================================================
//  api/_graph.js — Microsoft Graph, pour les photos de profil.
//
//  L'application est deja inscrite dans Entra (connexion des utilisateurs).
//  La meme inscription lui donne acces a Graph EN TANT QU'APPLICATION (client
//  credentials, scope `https://graph.microsoft.com/.default`) : aucun jeton
//  d'utilisateur, aucune variable de plus. Il faut seulement que l'inscription
//  porte la permission d'application `User.ReadBasic.All` avec le consentement
//  administrateur ; sans elle, Graph repond 403 et le Diagnostic le dit.
//
//  Ce module ne sert QUE les photos : GET /users/{adresse}/photos/{taille}/$value.
//  Un utilisateur sans photo est une reponse 404 normale, pas une erreur.
// =============================================================================

import { errorMessage } from './_config.js';

/** Tailles de photo servies par Graph (carrees, en pixels). */
export const PHOTO_SIZES = Object.freeze([48, 64, 96, 120, 240, 360]);

/** Delai d'un appel a Microsoft. */
const TIMEOUT_MS = 8000;

/** Jeton d'application en memoire : reutilise tant qu'il n'a pas expire. */
let _token = { value: '', expiresAt: 0 };

/**
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
async function timedFetch(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
  } catch (err) {
    const aborted = err && /** @type {any} */ (err).name === 'AbortError';
    throw new Error('Microsoft injoignable' + (aborted ? ' (délai de ' + TIMEOUT_MS + ' ms dépassé).' : ' : ' + errorMessage(err)));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Jeton d'application pour Graph (client credentials).
 * @param {import('./_auth.js').AuthConfig} auth
 * @returns {Promise<string>}
 */
export async function graphToken(auth) {
  if (_token.value && Date.now() < _token.expiresAt - 60000) return _token.value;
  if (!auth || !auth.configured) throw new Error('Connexion Entra non configurée : ENTRA_TENANT_ID, ENTRA_CLIENT_ID et ENTRA_CLIENT_SECRET sont requis.');

  const body = new URLSearchParams({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });
  const answer = await timedFetch(auth.authority + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const text = await answer.text();
  /** @type {any} */
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!answer.ok || !payload || !payload.access_token) {
    const detail = payload && (payload.error_description || payload.error) ? String(payload.error_description || payload.error) : 'HTTP ' + answer.status;
    throw new Error('Microsoft refuse le jeton d’application Graph : ' + detail.slice(0, 300));
  }
  const ttl = Number(payload.expires_in) > 0 ? Number(payload.expires_in) * 1000 : 3600000;
  _token = { value: String(payload.access_token), expiresAt: Date.now() + ttl };
  return _token.value;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Permissions d'application portees par le jeton Graph (revendication `roles`),
 * lues dans le jeton lui-meme sans le divulguer. Vide = aucun consentement
 * administrateur n'a ete donne a l'application : Graph refusera tout.
 * @param {import('./_auth.js').AuthConfig} auth
 * @returns {Promise<string[]>}
 */
export async function graphTokenRoles(auth) {
  const token = await graphToken(auth);
  const parts = token.split('.');
  if (parts.length < 2) return [];
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Array.isArray(payload.roles) ? payload.roles.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Code et message d'erreur d'une reponse Graph, sans jamais lever.
 * @param {Response} answer
 * @returns {Promise<{code: string, message: string}>}
 */
async function graphError(answer) {
  try {
    const j = await answer.json();
    const e = j && j.error ? j.error : null;
    return { code: e ? String(e.code || '') : '', message: e ? String(e.message || '') : '' };
  } catch {
    return { code: '', message: '' };
  }
}

/**
 * Leve l'erreur qui explique un refus de Graph, avec la marche a suivre.
 * @param {Response} answer
 * @param {string} what
 * @returns {Promise<never>}
 */
async function refused(answer, what) {
  const e = await graphError(answer);
  const detail = e.message || e.code;
  throw new Error('Graph refuse ' + what + ' (HTTP ' + answer.status + (detail ? ', ' + detail.slice(0, 160) : '') + '). '
    + 'Dans l’inscription Entra de l’application, ajouter la permission d’application Microsoft Graph « User.ReadBasic.All » et accorder le consentement administrateur.');
}

/**
 * Identifiant Entra d'une personne connue par son ADRESSE DE MESSAGERIE, quand
 * cette adresse n'est pas son nom d'utilisateur (alias, autre domaine). Les
 * adresses viennent de l'annuaire Keyyo, pas d'Entra : le cas est courant.
 * @param {string} token
 * @param {string} email
 * @returns {Promise<string>} '' si personne ne porte cette adresse
 */
async function findUserIdByMail(token, email) {
  const lit = String(email).replace(/'/g, "''");
  const filters = [
    "mail eq '" + lit + "' or proxyAddresses/any(p:p eq 'smtp:" + lit + "')",
    "mail eq '" + lit + "'",
  ];
  for (const filter of filters) {
    const url = GRAPH + '/users?$select=id&$top=1&$filter=' + encodeURIComponent(filter);
    const answer = await timedFetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (answer.status === 400) continue; // filtre non accepte : forme plus simple
    if (answer.status === 401 || answer.status === 403) return refused(answer, 'la recherche d’une personne par adresse');
    if (!answer.ok) throw new Error('Graph a répondu HTTP ' + answer.status + ' à la recherche de ' + email + '.');
    const j = await answer.json();
    const first = j && Array.isArray(j.value) && j.value[0] ? j.value[0] : null;
    return first && first.id ? String(first.id) : '';
  }
  return '';
}

/**
 * @param {string} token
 * @param {string} who  nom d'utilisateur ou identifiant Entra
 * @param {number} px
 * @returns {Promise<Response>}
 */
function getPhoto(token, who, px) {
  const url = GRAPH + '/users/' + encodeURIComponent(String(who)) + '/photos/' + px + 'x' + px + '/$value';
  return timedFetch(url, { headers: { Authorization: 'Bearer ' + token } });
}

/**
 * Photo de profil d'une personne, en JPEG.
 *
 * L'adresse est d'abord prise pour le nom d'utilisateur Entra ; si Graph ne
 * connait personne sous ce nom, la personne est cherchee par son adresse de
 * messagerie. `reason` distingue « personne sans photo » de « adresse inconnue
 * d'Entra », pour le Diagnostic.
 *
 * @param {import('./_auth.js').AuthConfig} auth
 * @param {string} email  adresse (userPrincipalName ou mail) dans le locataire
 * @param {number} size   une des PHOTO_SIZES
 * @returns {Promise<{status: 'ok', bytes: Buffer, contentType: string, via: 'upn'|'mail'}|{status: 'none', reason: 'no-photo'|'no-user'}>}
 * @throws quand Graph refuse (permission absente, jeton invalide) ou est injoignable.
 */
export async function fetchUserPhoto(auth, email, size) {
  const px = PHOTO_SIZES.indexOf(Number(size)) >= 0 ? Number(size) : 96;
  const token = await graphToken(auth);
  /** @type {'upn'|'mail'} */
  let via = 'upn';
  let answer = await getPhoto(token, String(email), px);

  if (answer.status === 404) {
    const e = await graphError(answer);
    // ImageNotFound : la personne existe mais n'a pas de photo. Tout autre 404
    // (Request_ResourceNotFound…) : ce nom d'utilisateur n'existe pas.
    if (/ImageNotFound/i.test(e.code)) return { status: 'none', reason: 'no-photo' };
    const id = await findUserIdByMail(token, String(email));
    if (!id) return { status: 'none', reason: 'no-user' };
    via = 'mail';
    answer = await getPhoto(token, id, px);
    if (answer.status === 404) return { status: 'none', reason: 'no-photo' };
  }
  if (answer.status === 401 || answer.status === 403) return refused(answer, 'la lecture des photos');
  if (!answer.ok) throw new Error('Graph a répondu HTTP ' + answer.status + ' pour la photo de ' + email + '.');

  const bytes = Buffer.from(await answer.arrayBuffer());
  const contentType = String(answer.headers.get('content-type') || 'image/jpeg').split(';')[0] || 'image/jpeg';
  return { status: 'ok', bytes, contentType, via };
}
