// =============================================================================
//  app/session.js — Qui est connecte, cote navigateur.
//
//  Le navigateur ne detient AUCUN jeton : la session est un cookie HttpOnly
//  que seul le serveur lit. Ce module ne fait donc qu'une chose au demarrage,
//  demander a `/api/auth?action=me` qui est la, et retenir la reponse pour
//  que la coquille sache quoi afficher (nom, role, menus).
//
//  Le role n'est ici qu'un CONFORT D'AFFICHAGE : c'est le serveur qui refuse
//  une route a un agent, pas le front. Cacher un menu n'a jamais protege une
//  donnee.
// =============================================================================

import { getMe, ApiError } from './api.js';
import { isDirection as roleIsDirection, roleLabel as labelOfRole } from '../shared/roles.js';

/** Adresse de connexion. Une NAVIGATION, pas un fetch : le serveur redirige vers Microsoft. */
export const LOGIN_URL = '/api/auth?action=login';

/** Adresse de deconnexion. */
export const LOGOUT_URL = '/api/auth?action=logout';

/**
 * @typedef {object} SessionState
 * @property {'ready'|'anonymous'|'unconfigured'|'error'} state
 * @property {{email: string, name: string, role: string, roleLabel: string, expiresAt: string}|null} user
 * @property {string} message  explication affichable quand `state` n'est pas `ready`
 */

/** @type {SessionState} */
let _current = { state: 'anonymous', user: null, message: '' };

/**
 * Interroge le serveur. Ne jette jamais : un echec reseau donne l'etat
 * `error`, avec un message, pour que l'ecran de connexion l'affiche.
 * @returns {Promise<SessionState>}
 */
export async function resolve() {
  try {
    const body = await getMe();
    const user = body && body.user && typeof body.user === 'object' ? body.user : null;
    if (body && body.authenticated && user && user.email) {
      _current = {
        state: 'ready',
        user: {
          email: String(user.email),
          name: String(user.name || user.email),
          role: String(user.role || ''),
          roleLabel: String(user.roleLabel || labelOfRole(user.role)),
          expiresAt: String(user.expiresAt || ''),
        },
        message: '',
      };
    } else {
      _current = { state: 'anonymous', user: null, message: '' };
    }
  } catch (err) {
    _current = describeFailure(err);
  }
  return _current;
}

/**
 * @param {unknown} err
 * @returns {SessionState}
 */
function describeFailure(err) {
  if (err instanceof ApiError) {
    if (err.status === 401) return { state: 'anonymous', user: null, message: '' };
    const body = err.body && typeof err.body === 'object' ? err.body : {};
    if (err.status === 503 && body.configured === false) {
      return {
        state: 'unconfigured',
        user: null,
        message: String(body.hint || body.error || 'La connexion Microsoft n\'est pas configurée sur ce déploiement.'),
      };
    }
    return { state: 'error', user: null, message: String(err.message || 'Le serveur ne répond pas.') };
  }
  const msg = err && /** @type {any} */ (err).message ? String(/** @type {any} */ (err).message) : 'Le serveur ne répond pas.';
  return { state: 'error', user: null, message: msg };
}

/** @returns {SessionState} dernier etat connu, sans requete. */
export function current() {
  return _current;
}

/** @returns {boolean} vrai si la personne connectee est de la direction. */
export function isDirection() {
  return _current.state === 'ready' && !!_current.user && roleIsDirection(_current.user.role);
}

/** @returns {string} libelle du role de la personne connectee, ou ''. */
export function roleLabel() {
  return _current.user ? _current.user.roleLabel : '';
}

/**
 * Adresse de connexion qui ramene sur une page precise apres le retour de
 * Microsoft. Le fragment (`#/calls`) survit au voyage parce qu'il est porte
 * dans le parametre `next`, que le serveur valide (chemin relatif seulement).
 * @param {string} [next] chemin + fragment, par defaut l'URL courante.
 * @returns {string}
 */
export function loginUrl(next) {
  let target = next;
  if (target == null) {
    try {
      target = window.location.pathname + window.location.search + window.location.hash;
    } catch {
      target = '/';
    }
  }
  const s = String(target || '/');
  return LOGIN_URL + (s && s !== '/' ? '&next=' + encodeURIComponent(s) : '');
}

/**
 * Oublie la session cote navigateur. Le cookie, lui, n'est efface que par le
 * serveur (`LOGOUT_URL`) : ce module n'y a pas acces, et c'est voulu.
 */
export function forget() {
  _current = { state: 'anonymous', user: null, message: '' };
}
