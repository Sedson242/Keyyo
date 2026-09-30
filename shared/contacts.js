// =============================================================================
//  shared/contacts.js — Export de contacts Keyyo Phone : lecture et index.
//  PUR : ni fetch, ni process, ni DOM. Importe tel quel par le back
//  (POST /api/directory) et par le front (apercu dans la page Administration),
//  pour que le navigateur et le serveur lisent le MEME fichier de la MEME
//  facon : ce que l'apercu annonce est ce que le serveur enregistre.
//
//  POURQUOI CE MODULE EXISTE. L'application nomme les correspondants avec
//  l'annuaire du Manager Keyyo (/directory_contacts). Les contacts saisis dans
//  le softphone Keyyo Phone (carnet personnel, categories « Amis » /
//  « Travail ») n'y figurent pas. Keyyo Phone sait les exporter en CSV
//  (entetes de type Bria / CounterPath, une soixantaine de colonnes) : ce
//  module lit cet export et en tire un index numero -> nom, que
//  api/_contacts.js fusionne ensuite avec l'annuaire Keyyo, lequel garde la
//  priorite en cas de doublon.
//
//  CE QU'ON SAIT DE L'EXPORT. La plupart des contacts n'ont QU'une adresse SIP
//  (`sip:33611223344@21.b2bua.sip.internal` : numero international sans `+`,
//  ou `sip:0611223344@keyyo.net` : numero national), certains n'ont qu'un
//  `business_number`, quelques-uns un numero court (`3698`). Un `display-name`
//  peut etre vide, ou etre le numero lui-meme. Un meme numero peut apparaitre
//  sous deux noms : le premier pose gagne, et la collision est signalee.
//
//  RIEN N'EST INVENTE. Les libelles sont ceux ecrits par l'utilisateur dans
//  son softphone : ni recapitalisation, ni reformulation. Les numeros passent
//  par shared/phone.js#toE164, la meme fonction que pour les appels, ce qui
//  garantit qu'une cle calculee ici correspond a un `peer` calcule la-bas.
// =============================================================================

import { toE164, formatNumber } from './phone.js';

/**
 * @typedef {Object} ImportedContact
 * @property {string}   name      libelle tel qu'ecrit dans Keyyo Phone, jamais vide
 * @property {string[]} numbers   cles E.164 (ou numeros courts), sans doublon, dans l'ordre du fichier
 * @property {string}   category  categorie Keyyo Phone (`Amis`, `Travail`...), eventuellement vide
 */

/**
 * @typedef {Object} ImportStats
 * @property {number} rows             lignes de donnees lues (hors entete, hors lignes vides)
 * @property {number} contacts         contacts retenus
 * @property {number} numbers          cles distinctes de l'index numero -> nom
 * @property {number} unnamed          lignes sans nom, ignorees
 * @property {number} withoutNumber    lignes nommees sans aucun numero exploitable, ignorees
 * @property {number} rejectedNumbers  valeurs de numero inexploitables (illisibles ou masquees)
 * @property {number} shortNumbers     numeros courts (sans `+`, six chiffres au plus), conserves tels quels
 * @property {number} collisions       numeros presents sous deux noms differents (le premier gagne)
 */

/**
 * @typedef {Object} ContactsImport
 * @property {number}            version     toujours CONTACTS_VERSION
 * @property {string}            source      toujours CONTACTS_SOURCE
 * @property {string}            filename    nom du fichier importe, ou ''
 * @property {string}            importedAt  date ISO de l'import, ou ''
 * @property {string}            importedBy  adresse (minuscules) de la personne qui a importe, ou ''
 * @property {ImportedContact[]} contacts
 * @property {ImportStats|null}  stats
 */

/** Version du format stocke (Blob). `normalizeImport` la force : un fichier d'une autre version est relu tel quel. */
export const CONTACTS_VERSION = 1;

/** Origine des contacts stockes : l'export CSV du softphone Keyyo Phone. */
export const CONTACTS_SOURCE = 'keyyo-phone-csv';

// -----------------------------------------------------------------------------
//  Lecture CSV (RFC 4180)
// -----------------------------------------------------------------------------

/** Separateurs candidats, dans l'ordre de preference en cas d'egalite. */
const SEPARATORS = [',', ';', '\t'];

/**
 * Separateur le plus frequent HORS guillemets sur la premiere ligne. Keyyo
 * Phone ecrit des virgules, mais un fichier repasse par un tableur francais
 * ressort souvent en points-virgules.
 * @param {string} text
 * @returns {string}
 */
function detectSeparator(text) {
  /** @type {Record<string, number>} */
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') i++;
        else quoted = false;
      }
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === '\n' || c === '\r') break;
    if (c === ',' || c === ';' || c === '\t') counts[c]++;
  }
  let best = ',';
  for (const s of SEPARATORS) if (counts[s] > counts[best]) best = s;
  return best;
}

/**
 * Tableau de cellules depuis un CSV RFC 4180.
 *
 *  - retire un BOM UTF-8 en tete ; accepte CRLF, LF et CR ;
 *  - separateur detecte sur la PREMIERE ligne parmi `,` `;` et tabulation ;
 *  - un champ entre guillemets peut contenir le separateur, des retours a la
 *    ligne et des guillemets doubles (`""` = un guillemet) ;
 *  - une ligne entierement vide est ignoree ; les cellules ne sont PAS
 *    nettoyees (trim) : c'est le role de l'appelant.
 * @param {unknown} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const sep = detectSeparator(s);

  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;    // a l'interieur d'un champ entre guillemets
  let touched = false;   // la ligne courante a recu au moins un caractere

  const endRow = () => {
    if (touched) { row.push(field); rows.push(row); }
    row = []; field = ''; touched = false;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }   // guillemet echappe
        else quoted = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { quoted = true; touched = true; continue; }
    if (c === sep) { row.push(field); field = ''; touched = true; continue; }
    if (c === '\r') {
      if (s[i + 1] === '\n') i++;                         // CRLF
      endRow();
      continue;
    }
    if (c === '\n') { endRow(); continue; }
    field += c;
    touched = true;
  }
  endRow();   // derniere ligne sans retour final
  return rows;
}

// -----------------------------------------------------------------------------
//  Adresses SIP
// -----------------------------------------------------------------------------

/**
 * Numero porte par une adresse SIP :
 * `sip:33611223344@21.b2bua.sip.internal` -> `33611223344`.
 *
 *  - `sip:` / `sips:` retires (insensible a la casse), ainsi que tout ce qui
 *    suit le premier `@`, un eventuel `;` de parametres (`;user=phone`) et un
 *    prefixe `tel:` ; des chevrons `<...>` sont toleres ;
 *  - sans `@` : la valeur telle quelle (trim) ;
 *  - PAS de mise en E.164 ici : c'est `toE164` (shared/phone.js) qui s'en
 *    charge ensuite, comme pour tout autre numero.
 * @param {unknown} value
 * @returns {string}
 */
export function numberFromSip(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return '';
  s = s.replace(/^<\s*/, '').replace(/\s*>$/, '');
  s = s.replace(/^sips?:/i, '');
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(0, at);
  const semi = s.indexOf(';');
  if (semi >= 0) s = s.slice(0, semi);
  s = s.replace(/^tel:/i, '');
  return s.trim();
}

// -----------------------------------------------------------------------------
//  Analyse de l'export
// -----------------------------------------------------------------------------

/** Colonnes de numeros, par ordre de priorite (le premier numero d'un contact est son numero principal). */
const NUMBER_GROUPS = ['business_number', 'mobile_number', 'home_number', 'fax_number', 'other_number'];
const NUMBER_COL = /^(business|mobile|home|fax|other)_number\d*$/;

/** Colonnes d'adresses (SIP), lues APRES les colonnes de numeros, via `numberFromSip`. */
const ADDRESS_GROUPS = ['default_address', 'sip_address', 'other_address'];
const ADDRESS_COL = /^(default_address|sip_address\d*|other_address\d*)$/;

/** Colonnes portant le nom affiche, toutes equivalentes. */
const DISPLAY_COLS = ['display-name', 'display_name', 'displayname'];

/** @param {string} name @returns {number} `business_number` -> 1, `business_number2` -> 2. */
function suffixOf(name) {
  const m = /(\d+)$/.exec(name);
  return m ? Number(m[1]) : 1;
}

/**
 * Colonnes de numeros et d'adresses de l'entete, triees par priorite puis
 * par position. `xmpp_address*`, `email_address*`, `web_page*`, `collab_url`
 * et `guid` ne sont jamais retenues.
 * @param {string[]} header  entete en minuscules, trim
 * @returns {Array<{ index: number, address: boolean, rank: number }>}
 */
function numberColumns(header) {
  /** @type {Array<{ index: number, address: boolean, rank: number }>} */
  const cols = [];
  header.forEach((name, index) => {
    const group = name.replace(/\d+$/, '');
    if (NUMBER_COL.test(name)) {
      cols.push({ index, address: false, rank: NUMBER_GROUPS.indexOf(group) * 100 + suffixOf(name) });
    } else if (ADDRESS_COL.test(name)) {
      cols.push({ index, address: true, rank: 1000 + ADDRESS_GROUPS.indexOf(group) * 100 + suffixOf(name) });
    }
  });
  cols.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return cols;
}

/**
 * Position des colonnes de nom et de categorie (-1 si absentes).
 * @param {string[]} header
 * @returns {{ display: number, given: number, surname: number, category: number }}
 */
function nameColumns(header) {
  const idx = { display: -1, given: -1, surname: -1, category: -1 };
  header.forEach((name, i) => {
    if (idx.display < 0 && DISPLAY_COLS.includes(name)) idx.display = i;
    else if (idx.given < 0 && name === 'given_name') idx.given = i;
    else if (idx.surname < 0 && name === 'surname') idx.surname = i;
    else if (idx.category < 0 && name === 'categories') idx.category = i;
  });
  return idx;
}

/** @param {unknown} v @returns {string} chaine trim, espaces multiples reduits a un ; '' si ce n'est pas une chaine. */
function tidy(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Nom d'une ligne : `display-name`, sinon `given_name surname`, sinon ''.
 * Un libelle sans AUCUNE lettre (un numero saisi comme nom) ne nomme
 * personne : il vaut ''.
 * @param {string} display @param {string} given @param {string} surname
 * @returns {string}
 */
function nameOf(display, given, surname) {
  let name = tidy(display);
  if (!name) name = tidy(given + ' ' + surname);
  return /\p{L}/u.test(name) ? name : '';
}

/** @param {number} n @param {string} one @param {string} many @returns {string} */
function plural(n, one, many) {
  return n + ' ' + (n > 1 ? many : one);
}

/**
 * Analyse un export de contacts Keyyo Phone.
 *
 *  - entetes en minuscules, trim ; `display-name`, `display_name` et
 *    `displayname` sont equivalents ;
 *  - numeros : `business_number*`, `mobile_number*`, `home_number*`,
 *    `fax_number*`, `other_number*`, PUIS les adresses `default_address`,
 *    `sip_address*`, `other_address*` (via `numberFromSip`) ; chaque valeur
 *    passe par `toE164` ; vide ou masquee -> rejetee ; un numero court est
 *    conserve tel quel ;
 *  - nom : `display-name`, sinon `given_name surname` ; sans lettre -> sans
 *    nom. Pas de recapitalisation : les libelles sont ceux de l'utilisateur ;
 *  - une ligne sans nom, ou nommee sans numero exploitable, est ignoree et
 *    comptee ; le reste devient un contact `{ name, numbers, category }`.
 *
 * `warnings` (textes d'interface, en francais) : une ligne par collision de
 * numero, une ligne resumant les lignes sans nom, une pour les lignes sans
 * numero, une si le fichier porte des caracteres de remplacement (mauvais
 * encodage).
 * @param {unknown} text  contenu du fichier CSV
 * @returns {{ contacts: ImportedContact[], stats: ImportStats, warnings: string[] }}
 * @throws {Error} « Format non reconnu… » si la premiere ligne ne contient ni
 *         `display-name` ni aucune colonne de numero ou d'adresse reconnue.
 */
export function parseContactsExport(text) {
  const source = String(text == null ? '' : text);
  const rows = parseCsv(source);
  const header = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
  const names = nameColumns(header);
  const cols = numberColumns(header);
  if (names.display < 0 && cols.length === 0) {
    throw new Error('Format non reconnu : la première ligne ne contient ni « display-name » ni colonne de numéro '
      + '(business_number, mobile_number, sip_address…). Attendu : un export CSV de contacts Keyyo Phone.');
  }

  /** @type {ImportedContact[]} */
  const contacts = [];
  /** @type {number[]} ligne du fichier (1 = entete) de chaque contact retenu, pour les avertissements */
  const lines = [];
  /** @type {ImportStats} */
  const stats = { rows: 0, contacts: 0, numbers: 0, unnamed: 0, withoutNumber: 0, rejectedNumbers: 0, shortNumbers: 0, collisions: 0 };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    stats.rows++;
    /** @param {number} i @returns {string} */
    const cell = (i) => (i >= 0 && i < row.length ? String(row[i]).trim() : '');

    const name = nameOf(cell(names.display), cell(names.given), cell(names.surname));
    if (!name) { stats.unnamed++; continue; }

    /** @type {string[]} */
    const numbers = [];
    for (const col of cols) {
      const value = cell(col.index);
      if (!value) continue;
      const key = toE164(col.address ? numberFromSip(value) : value);
      if (!key || key === 'anonymous') { stats.rejectedNumbers++; continue; }
      if (numbers.includes(key)) continue;
      numbers.push(key);
      if (!key.startsWith('+')) stats.shortNumbers++;
    }
    if (!numbers.length) { stats.withoutNumber++; continue; }

    contacts.push({ name, numbers, category: cell(names.category) });
    lines.push(r + 1);
    stats.contacts++;
  }

  const index = buildIndex(contacts);
  stats.numbers = Object.keys(index.map).length;
  stats.collisions = index.collisions.length;

  /** @type {string[]} */
  const warnings = [];
  for (const c of index.collisions) {
    warnings.push('Le numéro ' + formatNumber(c.number) + ' est attribué à « ' + c.kept + ' » ; « ' + c.dropped
      + ' » (ligne ' + lines[c.index] + ') ignoré pour ce numéro.');
  }
  if (stats.unnamed) {
    warnings.push(plural(stats.unnamed, 'ligne sans nom ignorée.', 'lignes sans nom ignorées.'));
  }
  if (stats.withoutNumber) {
    warnings.push(plural(stats.withoutNumber, 'ligne nommée sans numéro exploitable ignorée.', 'lignes nommées sans numéro exploitable ignorées.'));
  }
  if (source.includes('�')) {
    warnings.push('Le fichier ne semble pas en UTF-8 : certains accents sont perdus. Ré-exporter depuis Keyyo Phone sans le convertir.');
  }

  return { contacts, stats, warnings };
}

// -----------------------------------------------------------------------------
//  Index numero -> nom
// -----------------------------------------------------------------------------

/**
 * Index numero -> nom, premier pose gagne, avec la position du contact ecarte
 * (pour citer sa ligne dans un avertissement). Un meme nom repete sur un meme
 * numero est un doublon, pas une collision.
 * @param {unknown} contacts
 * @returns {{ map: Record<string, string>, collisions: Array<{ number: string, kept: string, dropped: string, index: number }> }}
 */
function buildIndex(contacts) {
  /** @type {Record<string, string>} */
  const map = {};
  /** @type {Array<{ number: string, kept: string, dropped: string, index: number }>} */
  const collisions = [];
  const list = Array.isArray(contacts) ? contacts : [];
  list.forEach((c, index) => {
    if (!c || typeof c.name !== 'string' || !c.name || !Array.isArray(c.numbers)) return;
    for (const n of c.numbers) {
      if (typeof n !== 'string' || !n) continue;
      if (Object.prototype.hasOwnProperty.call(map, n)) {
        if (map[n] !== c.name) collisions.push({ number: n, kept: map[n], dropped: c.name, index });
        continue;
      }
      map[n] = c.name;
    }
  });
  return { map, collisions };
}

/**
 * Index numero -> nom, premier pose gagne (ordre des contacts). Une collision
 * est un numero deja pose sous un AUTRE nom : le second est ignore et liste.
 * @param {ImportedContact[]} contacts
 * @returns {{ map: Record<string, string>, collisions: Array<{ number: string, kept: string, dropped: string }> }}
 */
export function contactsToMap(contacts) {
  const { map, collisions } = buildIndex(contacts);
  return { map, collisions: collisions.map(({ number, kept, dropped }) => ({ number, kept, dropped })) };
}

// -----------------------------------------------------------------------------
//  Objet stocke
// -----------------------------------------------------------------------------

/** Compteurs d'un `ImportStats`, dans l'ordre. */
const STAT_KEYS = ['rows', 'contacts', 'numbers', 'unnamed', 'withoutNumber', 'rejectedNumbers', 'shortNumbers', 'collisions'];

/** @param {unknown} v @returns {number} entier >= 0, ou 0. */
function nat(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Objet stocke vide : aucun export importe.
 * @returns {ContactsImport}
 */
export function emptyImport() {
  return { version: CONTACTS_VERSION, source: CONTACTS_SOURCE, filename: '', importedAt: '', importedBy: '', contacts: [], stats: null };
}

/**
 * Objet stocke valide, depuis n'importe quoi (fichier Blob relu, corps de
 * requete, `null`). Jamais d'exception.
 *
 *  - `version` forcee a CONTACTS_VERSION, `source` a CONTACTS_SOURCE ;
 *  - `filename`, `importedAt`, `importedBy` : chaines trim (`importedBy` en
 *    minuscules), '' sinon ;
 *  - `contacts` : objets a `name` non vide, `numbers` passes par `toE164` et
 *    dedoublonnes (vide ou masque ecarte ; contact sans numero ecarte),
 *    `category` chaine ;
 *  - `stats` : compteurs recopies (nombres uniquement, 0 sinon) si un objet
 *    est present, `null` sinon.
 * @param {unknown} raw
 * @returns {ContactsImport}
 */
export function normalizeImport(raw) {
  const out = emptyImport();
  const src = /** @type {any} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});

  out.filename = tidy(src.filename);
  out.importedAt = tidy(src.importedAt);
  out.importedBy = tidy(src.importedBy).toLowerCase();

  const list = Array.isArray(src.contacts) ? src.contacts : [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const name = tidy(c.name);
    if (!name) continue;
    const given = Array.isArray(c.numbers) ? c.numbers : (c.numbers == null ? [] : [c.numbers]);
    /** @type {string[]} */
    const numbers = [];
    for (const n of given) {
      const key = toE164(n);
      if (!key || key === 'anonymous' || numbers.includes(key)) continue;
      numbers.push(key);
    }
    if (!numbers.length) continue;
    out.contacts.push({ name, numbers, category: tidy(c.category) });
  }

  if (src.stats && typeof src.stats === 'object') {
    /** @type {any} */
    const stats = {};
    for (const k of STAT_KEYS) stats[k] = nat(src.stats[k]);
    out.stats = stats;
  }
  return out;
}
