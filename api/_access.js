// =============================================================================
//  api/_access.js — Lecture et ecriture de la configuration d'acces (Blob).
//
//  Un seul objet, `keyyo/config/access.json`, ecrit entier par un
//  administrateur depuis la page Administration (api/access.js). Le format et
//  les regles sont dans shared/access.js ; ce module ne fait que le stockage
//  et un cache memoire court : la garde `requireRole` relit la configuration a
//  chaque requete pour qu'un changement de role s'applique sans reconnexion,
//  et une lecture Blob par requete serait trop couteuse.
//
//  Sans store Blob, il n'y a pas de configuration : les roles viennent alors
//  d'Entra et de AUTH_DIRECTION_EMAILS, comme au premier jour.
// =============================================================================

import { archiveEnabled, readBlobJson, writeBlobJson } from './_archive.js';
import { normalizeAccess, emptyAccess, ACCESS_VERSION } from '../shared/access.js';

/** Chemin de la configuration dans le store. */
export const ACCESS_PATH = 'keyyo/config/access.json';

/** Duree du cache memoire, en millisecondes. */
const CACHE_MS = 30000;

/** @type {{at: number, config: import('../shared/access.js').AccessConfig|null}} */
let _cache = { at: 0, config: null };

/** @returns {boolean} */
export function accessEnabled() {
  return archiveEnabled();
}

/**
 * Configuration courante, normalisee. `null` sans store Blob. Une lecture
 * qui echoue rend la derniere version connue si elle existe, sinon une
 * configuration vide — et ne bloque jamais une requete.
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<import('../shared/access.js').AccessConfig|null>}
 */
export async function loadAccess(opts) {
  if (!accessEnabled()) return null;
  const o = opts || {};
  if (!o.force && _cache.config && Date.now() - _cache.at < CACHE_MS) return _cache.config;
  try {
    const raw = await readBlobJson(ACCESS_PATH);
    const config = raw ? normalizeAccess(raw) : emptyAccess();
    _cache = { at: Date.now(), config };
    return config;
  } catch (err) {
    if (_cache.config) return _cache.config;
    return emptyAccess();
  }
}

/**
 * Ecrit la configuration entiere, datee et signee.
 * @param {import('../shared/access.js').AccessConfig} config
 * @param {string} by adresse de l'administrateur
 * @returns {Promise<import('../shared/access.js').AccessConfig>}
 */
export async function saveAccess(config, by) {
  if (!accessEnabled()) throw new Error('Configuration impossible : aucun store Blob relie au projet.');
  const next = normalizeAccess(config);
  next.version = ACCESS_VERSION;
  next.updatedAt = new Date().toISOString();
  next.updatedBy = String(by || '').toLowerCase();
  await writeBlobJson(ACCESS_PATH, next);
  _cache = { at: Date.now(), config: next };
  return next;
}
