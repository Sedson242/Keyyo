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

/**
 * Photo de profil d'une personne, en JPEG.
 *
 * @param {import('./_auth.js').AuthConfig} auth
 * @param {string} email  adresse (userPrincipalName ou mail) dans le locataire
 * @param {number} size   une des PHOTO_SIZES
 * @returns {Promise<{status: 'ok', bytes: Buffer, contentType: string}|{status: 'none'}>}
 * @throws quand Graph refuse (permission absente, jeton invalide) ou est injoignable.
 */
export async function fetchUserPhoto(auth, email, size) {
  const px = PHOTO_SIZES.indexOf(Number(size)) >= 0 ? Number(size) : 96;
  const token = await graphToken(auth);
  const url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(String(email)) + '/photos/' + px + 'x' + px + '/$value';
  const answer = await timedFetch(url, { headers: { Authorization: 'Bearer ' + token } });

  if (answer.status === 404) return { status: 'none' };
  if (answer.status === 401 || answer.status === 403) {
    let detail = '';
    try { const j = await answer.json(); detail = j && j.error ? String(j.error.message || j.error.code || '') : ''; } catch { detail = ''; }
    throw new Error('Graph refuse la lecture des photos (HTTP ' + answer.status + (detail ? ', ' + detail.slice(0, 160) : '') + '). '
      + 'Dans l’inscription Entra de l’application, ajouter la permission d’application Microsoft Graph « User.ReadBasic.All » et accorder le consentement administrateur.');
  }
  if (!answer.ok) throw new Error('Graph a répondu HTTP ' + answer.status + ' pour la photo de ' + email + '.');

  const bytes = Buffer.from(await answer.arrayBuffer());
  const contentType = String(answer.headers.get('content-type') || 'image/jpeg').split(';')[0] || 'image/jpeg';
  return { status: 'ok', bytes, contentType };
}
