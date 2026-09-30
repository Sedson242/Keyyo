// =============================================================================
//  api/_contacts.js — Annuaire complementaire : l'export de contacts Keyyo
//  Phone conserve sur Blob, et sa fusion avec l'annuaire de l'API Keyyo.
//
//  Pourquoi : /directory_contacts de l'API Keyyo ne connait que l'annuaire du
//  Manager. Les contacts saisis dans le softphone Keyyo Phone (carnet
//  personnel, categories « Amis » / « Travail ») n'y sont pas. L'utilisateur
//  les exporte en CSV, un administrateur les importe depuis la page
//  Administration (POST /api/directory), et l'historique des appels affiche
//  leurs noms. L'analyse du fichier est dans shared/contacts.js : la meme
//  fonction sert au navigateur (apercu) et au serveur (import).
//
//  Un seul objet, `keyyo/config/contacts.json`, ecrit entier a chaque import
//  (modele : api/_access.js). Cache memoire court : la carte numero -> nom est
//  demandee a chaque chargement de page, une lecture Blob par requete serait
//  trop couteuse, et l'objet change rarement (un import est un geste
//  volontaire).
//
//  PRIORITE : l'annuaire Keyyo (API) prime, l'import complete. Un numero
//  present dans les deux garde le nom de l'API ; la difference est signalee
//  (`collisions` de mergeDirectory), jamais corrigee en silence.
//
//  Sans store Blob, il n'y a pas d'annuaire complementaire : l'annuaire Keyyo
//  reste la source unique, comme au premier jour.
// =============================================================================

import { archiveEnabled, readBlobJson, writeBlobJson } from './_archive.js';
import {
  normalizeImport, emptyImport, CONTACTS_VERSION, CONTACTS_SOURCE,
} from '../shared/contacts.js';
import { toE164 } from '../shared/phone.js';
import { capitalizeName } from '../shared/identity.js';
import { F } from '../shared/schema.js';

/** Chemin de l'annuaire complementaire dans le store. */
export const CONTACTS_PATH = 'keyyo/config/contacts.json';

/** Duree du cache memoire, en millisecondes. */
const CACHE_MS = 60000;

/** @type {{at: number, imp: import('../shared/contacts.js').ContactsImport|null}} */
let _cache = { at: 0, imp: null };

/** @returns {boolean} vrai si un store Blob est relie : meme verdict que l'archive. */
export function contactsEnabled() {
  return archiveEnabled();
}

/**
 * Annuaire complementaire courant, normalise. `null` sans store Blob ;
 * `emptyImport()` si rien n'a encore ete importe. Une lecture qui echoue rend
 * la derniere version connue si elle existe, sinon un import vide — et ne
 * bloque jamais une requete : au pire, des correspondants restent en numero.
 * @param {{force?: boolean}} [opts]  `force` contourne le cache memoire
 * @returns {Promise<import('../shared/contacts.js').ContactsImport|null>}
 */
export async function loadContacts(opts) {
  if (!contactsEnabled()) return null;
  const o = opts || {};
  if (!o.force && _cache.imp && Date.now() - _cache.at < CACHE_MS) return _cache.imp;
  try {
    const raw = await readBlobJson(CONTACTS_PATH);
    const imp = raw ? normalizeImport(raw) : emptyImport();
    _cache = { at: Date.now(), imp };
    return imp;
  } catch (err) {
    if (_cache.imp) return _cache.imp;
    return emptyImport();
  }
}

/**
 * Ecrit l'annuaire complementaire entier, date et signe. Un import vide
 * (`emptyImport()`) le supprime.
 * @param {any} imp  objet ContactsImport, ou approchant : il est normalise
 * @param {string} by  adresse de l'administrateur
 * @returns {Promise<import('../shared/contacts.js').ContactsImport>}
 */
export async function saveContacts(imp, by) {
  if (!contactsEnabled()) throw new Error('Import impossible : aucun store Blob relie au projet.');
  const next = normalizeImport(imp);
  next.version = CONTACTS_VERSION;
  next.source = CONTACTS_SOURCE;
  next.importedAt = new Date().toISOString();
  next.importedBy = String(by || '').trim().toLowerCase();
  await writeBlobJson(CONTACTS_PATH, next);
  _cache = { at: Date.now(), imp: next };
  return next;
}

// -----------------------------------------------------------------------------
//  Cartes numero -> nom
// -----------------------------------------------------------------------------

/**
 * Index numero -> nom depuis les contacts de l'API Keyyo (/directory_contacts,
 * forme rendue par api/_keyyo.js#fetchDirectoryContacts).
 *
 * Premier pose gagne : les numeros principaux d'un contact sont parcourus
 * avant les numeros abreges, et l'ordre des contacts est celui de l'API. Les
 * cles sont normalisees en E.164 par shared/phone.js#toE164 : c'est la meme
 * fonction que celle utilisee pour les numeros des appels, ce qui garantit
 * qu'une cle calculee ici correspond a un `peer` calcule la-bas.
 * @param {Array<{firstName?: string, lastName?: string, company?: string, email?: string, numbers?: string[], speedNumbers?: string[]}>} contacts
 * @returns {{map: Record<string, string>, detail: {contacts: number, contactsNamed: number, contactsSkipped: number, numbers: number, speedNumbers: number, rejected: number, collisions: number}}}
 */
export function directoryMapFromContacts(contacts) {
  const list = Array.isArray(contacts) ? contacts : [];
  /** @type {Record<string, string>} */
  const map = {};
  const detail = {
    contacts: list.length,
    contactsNamed: 0,
    contactsSkipped: 0,
    numbers: 0,
    speedNumbers: 0,
    rejected: 0,
    collisions: 0,
  };

  /**
   * @param {unknown} raw
   * @param {string} label
   * @param {'numbers'|'speedNumbers'} bucket
   */
  const add = (raw, label, bucket) => {
    const key = toE164(raw);
    if (!key || key === 'anonymous') { detail.rejected++; return; }
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      if (map[key] !== label) detail.collisions++;
      return;
    }
    map[key] = label;
    detail[bucket]++;
  };

  for (const contact of list) {
    const label = contact && typeof contact === 'object' ? displayLabel(contact) : '';
    if (!label) { detail.contactsSkipped++; continue; }
    detail.contactsNamed++;
    for (const n of contact.numbers || []) add(n, label, 'numbers');
    for (const n of contact.speedNumbers || []) add(n, label, 'speedNumbers');
  }

  return { map, detail };
}

/**
 * Fusion des deux sources : l'annuaire Keyyo (API) prime, l'import complete.
 *
 * Pour chaque numero de chaque contact importe : s'il est deja nomme par
 * l'API sous un autre nom, c'est une collision (kept = nom API, dropped = nom
 * import) et l'API garde la main ; sous le meme nom, rien a signaler ; sinon
 * il entre dans la carte avec `origin[n] = 'import'`. Un numero present sous
 * deux contacts DE L'IMPORT est deja signale par shared/contacts.js a
 * l'analyse (premier pose gagne) : il n'est pas recompte ici.
 * @param {Record<string, string>} apiMap  carte de l'API Keyyo, eventuellement vide
 * @param {import('../shared/contacts.js').ContactsImport|null} imp
 * @returns {{map: Record<string, string>, origin: Record<string, 'import'>, sources: {directory_contacts: number, import: number}, collisions: Array<{number: string, kept: string, dropped: string}>}}
 */
export function mergeDirectory(apiMap, imp) {
  /** @type {Record<string, string>} */
  const map = {};
  /** @type {Record<string, 'import'>} */
  const origin = {};
  /** @type {Array<{number: string, kept: string, dropped: string}>} */
  const collisions = [];

  const base = apiMap && typeof apiMap === 'object' ? apiMap : {};
  for (const key of Object.keys(base)) {
    const name = String(base[key] == null ? '' : base[key]);
    if (key && name) map[key] = name;
  }
  const fromApi = Object.keys(map).length;

  let added = 0;
  const seen = new Set();
  const contacts = imp && Array.isArray(imp.contacts) ? imp.contacts : [];
  for (const contact of contacts) {
    if (!contact || typeof contact !== 'object') continue;
    const name = String(contact.name == null ? '' : contact.name).trim();
    if (!name) continue;
    for (const raw of Array.isArray(contact.numbers) ? contact.numbers : []) {
      const key = String(raw == null ? '' : raw).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        if (map[key] !== name) collisions.push({ number: key, kept: map[key], dropped: name });
        continue;
      }
      map[key] = name;
      origin[key] = 'import';
      added++;
    }
  }

  return { map, origin, sources: { directory_contacts: fromApi, import: added }, collisions };
}

/**
 * Couverture de l'archive : quels correspondants ont un nom, et d'ou.
 * Un correspondant = une cle `toE164(row[F.peer])` distincte, hors vide et
 * hors appelant masque.
 * @param {any[]} rows  lignes de l'archive (format shared/schema.js)
 * @param {{map: Record<string, string>, origin: Record<string, string>}} merged  sortie de mergeDirectory
 * @returns {{peers: number, byDirectory: number, byImport: number, unnamed: number}}
 */
export function coverageOf(rows, merged) {
  const map = merged && merged.map && typeof merged.map === 'object' ? merged.map : {};
  const origin = merged && merged.origin && typeof merged.origin === 'object' ? merged.origin : {};
  const seen = new Set();
  let byDirectory = 0;
  let byImport = 0;
  let unnamed = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row)) continue;
    const key = toE164(row[F.peer]);
    if (!key || key === 'anonymous' || seen.has(key)) continue;
    seen.add(key);
    if (origin[key] === 'import') byImport++;
    else if (Object.prototype.hasOwnProperty.call(map, key) && map[key]) byDirectory++;
    else unnamed++;
  }
  return { peers: seen.size, byDirectory, byImport, unnamed };
}

// -----------------------------------------------------------------------------
//  Libelle d'un contact de l'API Keyyo (deplace depuis api/directory.js)
// -----------------------------------------------------------------------------

/**
 * Libelle affichable d'un contact. `lastName` vient du champ `name` de
 * DirectoryContact, souvent saisi en capitales : on le recapitalise pour ne pas
 * afficher « SEDSON » au milieu d'une liste.
 * @param {{firstName?: string, lastName?: string, company?: string, email?: string}} contact
 * @returns {string}
 */
function displayLabel(contact) {
  const first = pretty(contact.firstName);
  const last = pretty(contact.lastName);
  const person = [first, last].filter(Boolean).join(' ');
  if (person) return person;

  const company = String(contact.company || '').trim();
  if (company) return company;

  const email = String(contact.email || '').trim();
  if (email) return email.split('@')[0];

  return '';
}

/** @param {unknown} raw @returns {string} */
function pretty(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // Recapitaliser seulement si la saisie est entierement en capitales : sinon on
  // abimerait un nom deja correctement ecrit (« van der Berg »).
  return s === s.toLocaleUpperCase('fr-FR') ? capitalizeName(s) : s;
}
