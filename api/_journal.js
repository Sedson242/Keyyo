// =============================================================================
//  api/_journal.js — Stockage du journal d'attribution sur Vercel Blob.
//
//  UNE PARTITION PAR PERSONNE ET PAR MOIS : `keyyo/journal/<AAAA-MM>/<cle>.json`
//  ou `<cle>` est une empreinte de l'adresse (jamais l'adresse elle-meme, qui
//  finirait dans une URL). Chaque fichier n'a qu'UN ecrivain — la personne,
//  via ses propres requetes — ce qui evite la course entre deux fonctions
//  serverless qui reecriraient le meme fichier. Le format vient de
//  shared/journal.js, et les evenements y sont dedupliques par identifiant.
//
//  Lecture pour la direction : lister le prefixe du mois, puis charger chaque
//  fichier en parallele. Au plus une soixantaine de petits fichiers : c'est
//  ce qui rend l'operation tenable dans une fonction.
//
//  Comme l'archive, le journal est INDISPONIBLE sans BLOB_READ_WRITE_TOKEN :
//  les routes le disent, et la page agent aussi.
// =============================================================================

import { put, list } from '@vercel/blob';
import { createHash } from 'node:crypto';
import { archiveEnabled } from './_archive.js';
import { JOURNAL_VERSION, isValidEvent, mergeEvents } from '../shared/journal.js';

/** Racine des fichiers de journal dans le store. */
export const JOURNAL_ROOT = 'keyyo/journal/';

/** Plafond d'evenements conserves par fichier : au-dela, les plus anciens sortent. */
const MAX_EVENTS_PER_FILE = 20000;

/** @returns {boolean} */
export function journalEnabled() {
  return archiveEnabled();
}

/**
 * Cle de partition d'une personne : empreinte courte de l'adresse.
 * @param {string} email
 * @returns {string}
 */
export function userKey(email) {
  return createHash('sha256').update(String(email || '').trim().toLowerCase(), 'utf8').digest('hex').slice(0, 20);
}

/** @param {string} month @param {string} key @returns {string} */
export function partitionPath(month, key) {
  return JOURNAL_ROOT + month + '/' + key + '.json';
}

/** @param {unknown} err @returns {string} */
function reason(err) {
  const s = (err && /** @type {any} */ (err).message ? String(/** @type {any} */ (err).message) : String(err))
    .replace(/\s+/g, ' ').trim();
  return s.length > 240 ? s.slice(0, 240) + '…' : s;
}

/**
 * Lit un fichier de partition. `null` s'il n'existe pas.
 * @param {string} pathname
 * @returns {Promise<{email: string, events: any[]}|null>}
 */
async function readPartition(pathname) {
  let hit = null;
  try {
    const res = await list({ prefix: pathname, limit: 10 });
    for (const b of (res && res.blobs) || []) {
      if (b && b.pathname === pathname) { hit = b; break; }
    }
  } catch (err) {
    throw new Error('Journal illisible (list ' + pathname + ') : ' + reason(err));
  }
  if (!hit || !hit.url) return null;
  return fetchPartition(hit.url, pathname);
}

/**
 * @param {string} url
 * @param {string} pathname
 * @returns {Promise<{email: string, events: any[]}|null>}
 */
async function fetchPartition(url, pathname) {
  /** @type {any} */
  let payload = null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    payload = await res.json();
  } catch (err) {
    throw new Error('Journal ' + pathname + ' illisible : ' + reason(err));
  }
  if (!payload || typeof payload !== 'object') return null;
  if (Number(payload.version) !== JOURNAL_VERSION) return null;
  const events = Array.isArray(payload.events) ? payload.events.filter(isValidEvent) : [];
  return { email: String(payload.email || ''), events };
}

/**
 * Ajoute des evenements a la partition d'une personne pour un mois.
 * Lecture, fusion (dedoublonnage par identifiant), ecriture.
 *
 * @param {string} email
 * @param {string} month  `AAAA-MM`
 * @param {any[]} events  deja normalises par shared/journal.js#normalizeEvent
 * @returns {Promise<{written: number, total: number, added: number}>}
 */
export async function appendEvents(email, month, events) {
  if (!journalEnabled()) throw new Error('Journal indisponible : aucun store Blob relie (BLOB_READ_WRITE_TOKEN absent).');
  const pathname = partitionPath(month, userKey(email));
  const current = await readPartition(pathname);
  const before = current ? current.events.length : 0;
  let merged = mergeEvents(current ? current.events : [], events);
  if (merged.length > MAX_EVENTS_PER_FILE) merged = merged.slice(merged.length - MAX_EVENTS_PER_FILE);

  const body = JSON.stringify({
    version: JOURNAL_VERSION,
    email: String(email).toLowerCase(),
    month,
    savedAt: new Date().toISOString(),
    events: merged,
  });
  try {
    await put(pathname, body, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } catch (err) {
    throw new Error('Ecriture du journal impossible (' + pathname + ') : ' + reason(err));
  }
  return { written: events.length, total: merged.length, added: merged.length - before };
}

/**
 * Evenements d'une personne pour un mois.
 * @param {string} email
 * @param {string} month
 * @returns {Promise<any[]>}
 */
export async function readUserMonth(email, month) {
  if (!journalEnabled()) return [];
  const part = await readPartition(partitionPath(month, userKey(email)));
  return part ? part.events : [];
}

/**
 * Tous les evenements d'un mois, toutes personnes confondues, dedupliques.
 * @param {string} month
 * @returns {Promise<{events: any[], partitions: number}>}
 */
export async function readMonth(month) {
  if (!journalEnabled()) return { events: [], partitions: 0 };
  const prefix = JOURNAL_ROOT + month + '/';
  /** @type {any[]} */
  const blobs = [];
  let cursor;
  try {
    do {
      const res = await list({ prefix, limit: 200, cursor });
      for (const b of (res && res.blobs) || []) blobs.push(b);
      cursor = res && res.hasMore ? res.cursor : undefined;
    } while (cursor);
  } catch (err) {
    throw new Error('Journal illisible (list ' + prefix + ') : ' + reason(err));
  }
  const parts = await Promise.all(blobs.map((b) => fetchPartition(b.url, b.pathname).catch(() => null)));
  const lists = parts.filter(Boolean).map((p) => /** @type {any} */ (p).events);
  return { events: mergeEvents(...lists), partitions: lists.length };
}
