// =============================================================================
//  api/_archive.js — Memoire longue des appels, sur Vercel Blob.
//
//  Pourquoi une archive : l'API Keyyo n'expose qu'une fenetre glissante. Sans
//  memoire, l'historique de trois mois se viderait par le bas au fil du temps.
//  L'archive conserve donc tout ce qui a ete vu passer ; les synchronisations
//  suivantes ne redemandent que les derniers jours et fusionnent.
//
//  Chemin STABLE (`addRandomSuffix: false`, `allowOverwrite: true`) : on veut
//  un seul objet, ecrase a chaque sauvegarde, et non une collection de blobs.
//
//  DEUX FACONS DE RELIER UN STORE, verifiees sur le projet reel :
//    - par OIDC (la connexion actuelle de Vercel) : le projet recoit
//      BLOB_STORE_ID, et le SDK s'authentifie lui-meme avec le jeton OIDC
//      que Vercel injecte dans chaque fonction. Aucun secret a poser.
//    - par jeton (ancienne connexion) : BLOB_READ_WRITE_TOKEN.
//  Le store peut etre PRIVE (recommande : l'archive est nominative) ; les
//  blobs se lisent alors par `get`, jamais par leur URL. BLOB_ACCESS force
//  l'acces (`private` par defaut avec BLOB_STORE_ID, `public` sinon).
//
//  Sans store relie, tout fonctionne en mode direct, sans memoire : c'est le
//  seul mode degrade acceptable, et il est signale a l'utilisateur.
// =============================================================================

import { put, get } from '@vercel/blob';
import { SCHEMA_VERSION, F, rowKey, isValidRow } from '../shared/schema.js';

/** Chemin stable de l'archive dans le store Blob. */
export const ARCHIVE_PATH = 'keyyo/history.json';

/**
 * Chemin de l'etat de synchronisation : QUAND Keyyo a ete interroge pour la
 * derniere fois. Separe de l'archive parce que celle-ci n'est reecrite que
 * lorsqu'un appel ou une couverture change : un passage qui ne trouve rien de
 * neuf n'y laisse aucune trace, et son horodatage vieillirait jusqu'a
 * declencher une collecte a chaque sondage de la page. Un objet minuscule,
 * reecrit a chaque passage, porte cette information a part.
 */
export const SYNC_STATE_PATH = 'keyyo/sync-state.json';

/** @param {string} name @returns {string} */
function env(name) {
  return typeof process !== 'undefined' && process.env ? String(process.env[name] || '').trim() : '';
}

/** @returns {boolean} vrai si un store Blob est relie (OIDC ou jeton). */
export function archiveEnabled() {
  return !!(env('BLOB_STORE_ID') || env('BLOB_READ_WRITE_TOKEN'));
}

/**
 * Mode d'acces des blobs de ce projet.
 * @returns {'private'|'public'}
 */
export function blobAccess() {
  const forced = env('BLOB_ACCESS').toLowerCase();
  if (forced === 'private' || forced === 'public') return forced;
  return env('BLOB_STORE_ID') ? 'private' : 'public';
}

/**
 * Lit un objet JSON du store. `null` s'il n'existe pas ; jette si le store
 * repond mais que l'objet est illisible.
 * @param {string} pathname
 * @returns {Promise<any|null>}
 */
export async function readBlobJson(pathname) {
  if (!archiveEnabled()) return null;
  let result;
  try {
    result = await get(pathname, { access: blobAccess() });
  } catch (err) {
    const msg = reason(err);
    if (/not.?found|404|does not exist/i.test(msg)) return null;
    throw new Error('Lecture Blob impossible (' + pathname + ') : ' + msg
      + '. Verifier que le store est bien relie au projet (BLOB_STORE_ID) et redeploye.');
  }
  if (!result || !result.stream) return null;
  try {
    return await new Response(result.stream).json();
  } catch (err) {
    throw new Error('Objet Blob ' + pathname + ' present mais illisible : ' + reason(err));
  }
}

/**
 * Ecrit un objet JSON dans le store, a un chemin stable.
 * @param {string} pathname
 * @param {any} obj
 * @returns {Promise<void>}
 */
export async function writeBlobJson(pathname, obj) {
  const access = blobAccess();
  /** @type {any} */
  const options = {
    access,
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  };
  // Un objet public relu depuis un cache CDN ferait perdre la derniere
  // sauvegarde ; en prive, la lecture passe par le SDK, sans cache.
  if (access === 'public') options.cacheControlMaxAge = 0;
  try {
    await put(pathname, JSON.stringify(obj), options);
  } catch (err) {
    throw new Error('Ecriture Blob impossible (' + pathname + ') : ' + reason(err)
      + ". Verifier que le store est relie au projet et que l'acces (BLOB_ACCESS) correspond a son type.");
  }
}

/**
 * Lit un objet BINAIRE du store (une photo). `null` s'il n'existe pas.
 * @param {string} pathname
 * @returns {Promise<{bytes: Buffer, contentType: string}|null>}
 */
export async function readBlobBytes(pathname) {
  if (!archiveEnabled()) return null;
  let result;
  try {
    result = await get(pathname, { access: blobAccess() });
  } catch (err) {
    const msg = reason(err);
    if (/not.?found|404|does not exist/i.test(msg)) return null;
    throw new Error('Lecture Blob impossible (' + pathname + ') : ' + msg);
  }
  if (!result || !result.stream) return null;
  const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
  const type = result.blob && result.blob.contentType ? String(result.blob.contentType) : '';
  return { bytes, contentType: type || 'application/octet-stream' };
}

/**
 * Ecrit un objet BINAIRE dans le store, a un chemin stable.
 * @param {string} pathname
 * @param {Buffer} bytes
 * @param {string} contentType
 * @returns {Promise<void>}
 */
export async function writeBlobBytes(pathname, bytes, contentType) {
  const access = blobAccess();
  /** @type {any} */
  const options = { access, contentType: contentType || 'application/octet-stream', addRandomSuffix: false, allowOverwrite: true };
  if (access === 'public') options.cacheControlMaxAge = 0;
  try {
    await put(pathname, bytes, options);
  } catch (err) {
    throw new Error('Ecriture Blob impossible (' + pathname + ') : ' + reason(err));
  }
}

/** @param {unknown} err @returns {string} */
function reason(err) {
  const s = (err && /** @type {any} */ (err).message ? String(/** @type {any} */ (err).message) : String(err))
    .replace(/\s+/g, ' ').trim();
  return s.length > 240 ? s.slice(0, 240) + '…' : s;
}

/** @param {unknown} v @returns {Record<string, any>} */
function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? /** @type {any} */ (v) : {};
}

/**
 * Lit l'archive.
 *
 * Renvoie `null` quand il n'y a rien a lire OU quand la version stockee differe
 * de SCHEMA_VERSION : dans ce cas l'archive est volontairement ignoree, la
 * collecte repartira sur la fenetre complete et l'ecrasera au bon format.
 *
 * `lines` est l'instantane des lignes et de leurs identites au moment de la
 * sauvegarde : il permet de servir une archive fraiche SANS solliciter Keyyo.
 *
 * @returns {Promise<{version: number, savedAt: string, rows: any[], coverage: Record<string, any>, lines: any[]}|null>}
 */
export async function loadArchive() {
  if (!archiveEnabled()) return null;

  /** @type {any} */
  let payload = null;
  try {
    payload = await readBlobJson(ARCHIVE_PATH);
  } catch (err) {
    throw new Error(reason(err) + ' L\'archive sera reconstruite au prochain rebalayage complet (?full=1).');
  }
  if (!payload) return null;                          // premier remplissage

  if (!payload || typeof payload !== 'object') return null;
  if (Number(payload.version) !== SCHEMA_VERSION) return null;   // format perime

  const raw = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = [];
  for (const row of raw) {
    if (isValidRow(row)) rows.push(row);              // une ligne corrompue ne doit pas casser le rendu
  }

  return {
    version: SCHEMA_VERSION,
    savedAt: payload.savedAt ? String(payload.savedAt) : '',
    rows,
    coverage: plainObject(payload.coverage),
    lines: Array.isArray(payload.lines) ? payload.lines.filter((l) => l && typeof l === 'object') : [],
  };
}

/**
 * Ecrit l'archive. Renvoie `false` si aucun store n'est configure (mode direct),
 * l'horodatage ecrit en cas de succes, et JETTE si l'ecriture a echoue alors
 * qu'elle etait possible — un echec d'ecriture silencieux ferait perdre
 * l'historique sans que personne ne le sache.
 *
 * @param {{rows: any[], coverage?: Record<string, any>, lines?: any[]}} payload
 * @returns {Promise<string|false>}
 */
export async function saveArchive(payload) {
  if (!archiveEnabled()) return false;

  const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
  const savedAt = new Date().toISOString();
  await writeBlobJson(ARCHIVE_PATH, {
    version: SCHEMA_VERSION,
    savedAt,
    rows,
    coverage: plainObject(payload && payload.coverage),
    lines: Array.isArray(payload && payload.lines) ? payload.lines : [],
  });
  return savedAt;
}

/**
 * Lit l'etat de synchronisation. `null` sans store, sans objet, ou si
 * l'objet est illisible : cet etat n'est qu'une optimisation, jamais une
 * condition pour servir les appels.
 * @returns {Promise<{checkedAt: string, strategy: string}|null>}
 */
export async function loadSyncState() {
  if (!archiveEnabled()) return null;
  let payload = null;
  try {
    payload = await readBlobJson(SYNC_STATE_PATH);
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const checkedAt = String(payload.checkedAt || '');
  if (!checkedAt || !Number.isFinite(Date.parse(checkedAt))) return null;
  return { checkedAt, strategy: String(payload.strategy || '') };
}

/**
 * Ecrit l'etat de synchronisation. Renvoie `false` sans store ; JETTE si
 * l'ecriture echoue — l'appelant decide d'en faire une simple note.
 * @param {{checkedAt: string, strategy?: string}} state
 * @returns {Promise<boolean>}
 */
export async function saveSyncState(state) {
  if (!archiveEnabled()) return false;
  await writeBlobJson(SYNC_STATE_PATH, {
    checkedAt: String(state.checkedAt),
    strategy: String(state.strategy || ''),
  });
  return true;
}

/**
 * Fusionne deux couvertures mensuelles issues de deux passages concurrents.
 *
 * Pourquoi : le store Blob n'a pas d'ecriture conditionnelle. Deux collectes
 * qui se chevauchent (le sondage de la page et une synchronisation manuelle,
 * verifie en production) lisent la meme archive, et la seconde a ecrire
 * effacait ce que la premiere avait acquis — septembre, releve en entier,
 * redevenait « incomplet ». Ici rien ne se perd : les requetes acquises
 * s'additionnent, un mois complet le reste, l'horodatage le plus recent
 * l'emporte. Les comptes sont recalcules par l'appelant a partir des lignes
 * fusionnees ; a defaut, le plus grand des deux est garde.
 *
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @param {Record<string, number>} [counts]  comptes par mois apres fusion des lignes
 * @returns {Record<string, {count: number, syncedAt: string, complete: boolean, done: string[]}>}
 */
export function mergeCoverage(a, b, counts) {
  const pa = plainObject(a);
  const pb = plainObject(b);
  /** @type {Record<string, {count: number, syncedAt: string, complete: boolean, done: string[]}>} */
  const out = {};
  const months = new Set(Object.keys(pa).concat(Object.keys(pb)));
  for (const ym of months) {
    const x = plainObject(pa[ym]);
    const y = plainObject(pb[ym]);
    const done = new Set();
    for (const k of Array.isArray(x.done) ? x.done : []) done.add(String(k));
    for (const k of Array.isArray(y.done) ? y.done : []) done.add(String(k));
    const sx = String(x.syncedAt || '');
    const sy = String(y.syncedAt || '');
    const count = counts && Object.prototype.hasOwnProperty.call(counts, ym)
      ? Number(counts[ym]) || 0
      : Math.max(Number(x.count) || 0, Number(y.count) || 0);
    out[ym] = {
      count,
      syncedAt: sx > sy ? sx : sy,
      complete: x.complete === true || y.complete === true,
      done: Array.from(done).sort(),
    };
  }
  return out;
}

/**
 * Vrai si `next` est une version PLUS COMPLETE de `prev`.
 *
 * Keyyo peut renvoyer un appel encore en cours (duree partielle, non decroche)
 * puis le meme appel termine. La deuxieme version doit remplacer la premiere,
 * jamais l'inverse.
 *
 * @param {any[]} prev
 * @param {any[]} next
 * @returns {boolean}
 */
function isMoreComplete(prev, next) {
  const wasAnswered = Number(prev[F.answered]) === 1;
  const nowAnswered = Number(next[F.answered]) === 1;
  if (!wasAnswered && nowAnswered) return true;
  const prevSeconds = Number(prev[F.seconds]) || 0;
  const nextSeconds = Number(next[F.seconds]) || 0;
  return nextSeconds > prevSeconds;
}

/**
 * Fusionne les lignes archivees et les lignes fraiches.
 *
 * Deduplication par `shared/schema.js#rowKey` (qui exclut la duree, justement
 * pour que la version terminee d'un appel remplace la version partielle).
 *
 * @param {any[]} oldRows
 * @param {any[]} freshRows
 * @param {{retentionDays?: number, now?: number}} [opts]
 * @returns {{rows: any[], added: number, updated: number}}
 */
export function mergeRows(oldRows, freshRows, opts) {
  const o = opts || {};
  /** @type {Map<string, any[]>} */
  const byKey = new Map();
  let added = 0;
  let updated = 0;

  for (const row of Array.isArray(oldRows) ? oldRows : []) {
    if (!isValidRow(row)) continue;
    byKey.set(rowKey(row), row);
  }

  for (const row of Array.isArray(freshRows) ? freshRows : []) {
    if (!isValidRow(row)) continue;
    const key = rowKey(row);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, row); added++; continue; }
    if (isMoreComplete(prev, row)) { byKey.set(key, row); updated++; }
  }

  let rows = Array.from(byKey.values());

  const days = Number(o.retentionDays) || 0;
  if (days > 0) {
    const now = Number(o.now) || Date.now();
    const cutoff = Math.floor(now / 1000) - days * 86400;
    rows = rows.filter((row) => (Number(row[F.ts]) || 0) >= cutoff);
  }

  rows.sort((a, b) => (Number(b[F.ts]) || 0) - (Number(a[F.ts]) || 0));
  return { rows, added, updated };
}
