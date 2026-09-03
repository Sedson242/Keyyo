// =============================================================================
//  shared/identity.js — Qui est derriere une ligne Keyyo ? FONCTIONS PURES.
//
//  Objectif : afficher un PRENOM a cote de chaque ligne, deduit de l'adresse
//  email de la personne, plutot qu'un CSI illisible (`33253359565`).
//
//  L'API Manager ne fournit pas d'association « ligne -> personne » toute
//  faite : l'objet UCaaSVoIPAccount n'a ni email ni nom de personne. On la
//  reconstruit donc en croisant trois sources documentees :
//
//    1. GET /services?type=UCaaSVoIPAccount  -> les lignes (csi, name, short_number)
//    2. GET /directory_contacts              -> email + first_name + numeros
//    3. GET /services?type=EmailAccount      -> first_name + last_name par compte mail
//
//  Chaque rapprochement porte sa SOURCE, son SCORE et son INDICE (le fait
//  concret qui l'a declenche). Rien n'est devine en silence : la page
//  Diagnostic affiche les lignes non resolues et le reglage a coller pour les
//  forcer a la main (`KEYYO_LINE_EMAILS`).
// =============================================================================

import { toE164 } from './phone.js';

// -----------------------------------------------------------------------------
//  Noms et emails
// -----------------------------------------------------------------------------

/** Particules qui restent en minuscules dans un nom de famille francais. */
const PARTICLES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'van', 'von', 'da', 'di', 'del', 'della', 'af', 'ter']);

/**
 * Capitalise un fragment de nom : gere les traits d'union et l'apostrophe.
 * `jean-pierre` -> `Jean-Pierre` ; `o'brien` -> `O'Brien`.
 * @param {string} s
 * @returns {string}
 */
export function capitalizeName(s) {
  return String(s || '')
    .split(/([-'’])/)                              // conserve les separateurs
    .map((part) => (/^[-'’]$/.test(part)
      ? part
      : part.charAt(0).toLocaleUpperCase('fr-FR') + part.slice(1).toLocaleLowerCase('fr-FR')))
    .join('');
}

/**
 * Forme comparable d'un nom : minuscules, accents retires, ponctuation en
 * espaces. Permet de rapprocher « Stéphane SEDSON » et « stephane.sedson ».
 * @param {unknown} s
 * @returns {string}
 */
export function normalizeName(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // retire les diacritiques
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** @param {unknown} s @returns {string[]} jetons significatifs d'un nom. */
export function nameTokens(s) {
  return normalizeName(s).split(' ').filter((t) => t.length > 1 && !PARTICLES.has(t));
}

/**
 * Verifie qu'une chaine est une adresse email exploitable.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isEmail(s) {
  return typeof s === 'string' && /^[^\s@"<>,;]+@[^\s@"<>,;]+\.[a-z]{2,}$/i.test(s.trim());
}

/**
 * Deduit prenom et nom d'une adresse email.
 *
 * Cas traites :
 *   `stephane.sedson@x.fr`      -> { first: 'Stephane', last: 'Sedson' }  (sans accent)
 *   `jean-pierre.durand@x.fr`   -> { first: 'Jean-Pierre', last: 'Durand' }
 *   `p.lecorre@x.fr`            -> { first: null, last: 'Lecorre' }  (initiale, pas un prenom)
 *   `contact@x.fr`, `sav@x.fr`  -> { first: null, last: null }       (boite fonctionnelle)
 *   `plecorre@x.fr`             -> { first: null, last: null }       (aucun separateur : on ne devine pas)
 *
 * Les accents ne sont PAS reconstituables depuis une adresse email : quand
 * l'API fournit un `first_name`, il est toujours prefere a cette deduction.
 *
 * @param {unknown} email
 * @returns {{first: string|null, last: string|null, local: string}}
 */
export function nameFromEmail(email) {
  const empty = { first: null, last: null, local: '' };
  if (!isEmail(email)) return empty;

  const local = String(email).trim().toLowerCase().split('@')[0];
  const cleaned = local.replace(/\+.*$/, '').replace(/\d+$/, '');   // retire +alias et suffixe numerique
  if (!cleaned) return empty;

  // Boites fonctionnelles : ce ne sont pas des personnes.
  if (FUNCTIONAL_MAILBOXES.has(cleaned)) return { ...empty, local: cleaned };

  const parts = cleaned.split(/[._]+/).filter(Boolean);
  if (parts.length < 2) return { ...empty, local: cleaned };         // un seul bloc : ambigu

  const [head, ...tail] = parts;
  const lastRaw = tail.join(' ');
  return {
    first: head.length >= 2 ? capitalizeName(head) : null,           // 1 caractere = initiale
    last: lastRaw.length >= 2 ? capitalizeName(lastRaw) : null,
    local: cleaned,
  };
}

/** Adresses qui designent un service, pas une personne. */
const FUNCTIONAL_MAILBOXES = new Set([
  'contact', 'info', 'infos', 'accueil', 'standard', 'sav', 'support', 'admin',
  'administration', 'compta', 'comptabilite', 'facturation', 'commercial',
  'commercial1', 'direction', 'rh', 'recrutement', 'noreply', 'no-reply',
  'postmaster', 'webmaster', 'hello', 'bonjour', 'secretariat', 'devis',
]);

/**
 * Prenom seul deduit d'une adresse email. Repli le plus simple.
 * @param {unknown} email
 * @returns {string|null}
 */
export function firstNameFromEmail(email) {
  return nameFromEmail(email).first;
}

/**
 * Similarite entre deux libelles de personne, dans [0, 1].
 *
 * Indice de Jaccard sur les jetons, majore quand un jeton entier coincide :
 * « Ligne Stéphane » et « Stephane Sedson » partagent `stephane` et sortent
 * donc bien au-dessus du seuil, sans qu'un simple prefixe commun suffise.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function nameSimilarity(a, b) {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (!ta.size || !tb.size) return 0;

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  if (!shared) return 0;

  const union = ta.size + tb.size - shared;
  const jaccard = shared / union;
  // Une coincidence de jeton entier est un signal fort : on la valorise.
  const coverage = shared / Math.min(ta.size, tb.size);
  return Math.min(1, 0.45 * jaccard + 0.55 * coverage);
}

// -----------------------------------------------------------------------------
//  Rapprochement ligne <-> personne
// -----------------------------------------------------------------------------

/** Seuil de similarite de nom en dessous duquel on ne rapproche pas. */
export const NAME_MATCH_THRESHOLD = 0.6;

/**
 * @typedef {object} Person
 * @property {string|null} email
 * @property {string|null} firstName
 * @property {string|null} lastName
 * @property {string} displayName
 * @property {string} source      Regle qui a produit le rapprochement.
 * @property {number} confidence  0 a 1.
 * @property {string} evidence    Le fait concret ayant declenche le rapprochement.
 */

/**
 * @typedef {object} VoipLine
 * @property {string} csi
 * @property {string} [formattedCsi]
 * @property {string} [name]
 * @property {string} [shortNumber]
 * @property {string} [presentedNumber]
 */

/**
 * @typedef {object} DirectoryContact
 * @property {string} [uid]
 * @property {string} [email]
 * @property {string} [firstName]
 * @property {string} [lastName]
 * @property {string} [company]
 * @property {string} [job]
 * @property {string[]} [numbers]       Tous les numeros du contact.
 * @property {string[]} [speedNumbers]  Numeros courts / abreges.
 */

/**
 * @typedef {object} EmailAccount
 * @property {string} csi
 * @property {string} [email]
 * @property {string} [firstName]
 * @property {string} [lastName]
 * @property {string} [name]
 */

/**
 * Construit l'identite d'une personne a partir d'un contact d'annuaire, en
 * completant les trous par deduction depuis l'email.
 * @param {DirectoryContact|EmailAccount} src
 * @param {{source: string, confidence: number, evidence: string}} meta
 * @returns {Person}
 */
function personFrom(src, meta) {
  const email = isEmail(src.email) ? String(src.email).trim().toLowerCase() : null;
  const guessed = nameFromEmail(email);
  // Le nom fourni par l'API est toujours prefere : lui seul porte les accents.
  const firstName = clean(src.firstName) || guessed.first;
  const lastName = clean(src.lastName) || guessed.last;
  const displayName = [firstName, lastName].filter(Boolean).join(' ')
    || clean(/** @type {any} */ (src).name)
    || (email ? email.split('@')[0] : '')
    || '';
  return { email, firstName, lastName, displayName, ...meta };
}

/** @param {unknown} s @returns {string|null} */
function clean(s) {
  const v = String(s == null ? '' : s).trim();
  return v ? v : null;
}

/**
 * Resout l'identite de chaque ligne VoIP.
 *
 * Les regles sont evaluees dans l'ordre ; la premiere qui aboutit gagne, mais
 * TOUS les candidats trouves sont conserves dans `candidates` pour que la page
 * Diagnostic puisse montrer les rapprochements ecartes.
 *
 * @param {object} input
 * @param {VoipLine[]} input.voipLines
 * @param {DirectoryContact[]} [input.directoryContacts]
 * @param {EmailAccount[]} [input.emailAccounts]
 * @param {Record<string, string>} [input.overrides]  `{ csi: email }` force a la main.
 * @returns {Array<VoipLine & {person: Person|null, candidates: Person[]}>}
 */
export function resolveLineIdentities(input) {
  const lines = input.voipLines || [];
  const contacts = input.directoryContacts || [];
  const mailboxes = input.emailAccounts || [];
  const overrides = input.overrides || {};

  // Index numero -> contact, pour un rapprochement exact et peu couteux.
  /** @type {Map<string, DirectoryContact>} */
  const byNumber = new Map();
  /** @type {Map<string, DirectoryContact>} */
  const bySpeed = new Map();
  /** @type {Map<string, DirectoryContact|EmailAccount>} */
  const byEmail = new Map();

  for (const c of contacts) {
    for (const n of c.numbers || []) {
      const k = toE164(n);
      if (k && k !== 'anonymous' && !byNumber.has(k)) byNumber.set(k, c);
    }
    for (const n of c.speedNumbers || []) {
      const k = String(n || '').replace(/\D/g, '');
      if (k && !bySpeed.has(k)) bySpeed.set(k, c);
    }
    if (isEmail(c.email)) {
      const k = String(c.email).trim().toLowerCase();
      if (!byEmail.has(k)) byEmail.set(k, c);
    }
  }
  for (const m of mailboxes) {
    if (isEmail(m.email)) {
      const k = String(m.email).trim().toLowerCase();
      // L'annuaire est prioritaire : il porte les numeros, donc le lien a la ligne.
      if (!byEmail.has(k)) byEmail.set(k, m);
    }
  }

  return lines.map((line) => {
    /** @type {Person[]} */
    const candidates = [];
    const lineNumbers = [line.csi, line.formattedCsi, line.presentedNumber]
      .map((n) => toE164(n)).filter((n) => n && n !== 'anonymous');

    // -- Regle 1 : reglage manuel. Souverain sur tout le reste. ---------------
    const forced = overrides[String(line.csi)] || overrides[String(line.formattedCsi || '')];
    if (isEmail(forced)) {
      const email = String(forced).trim().toLowerCase();
      const known = byEmail.get(email);
      candidates.push(personFrom(known ? { ...known, email } : { email }, {
        source: 'override',
        confidence: 1,
        evidence: `KEYYO_LINE_EMAILS associe ${line.csi} a ${email}`,
      }));
    }

    // -- Regle 2 : un contact d'annuaire porte le numero de la ligne. ---------
    for (const num of lineNumbers) {
      const hit = byNumber.get(num);
      if (hit) {
        candidates.push(personFrom(hit, {
          source: 'directory_number',
          confidence: 0.95,
          evidence: `contact d'annuaire « ${nameOf(hit)} » porte le numero ${num}`,
        }));
        break;
      }
    }

    // -- Regle 3 : correspondance sur le numero court (poste). ---------------
    const short = String(line.shortNumber || '').replace(/\D/g, '');
    if (short) {
      const hit = bySpeed.get(short);
      if (hit) {
        candidates.push(personFrom(hit, {
          source: 'directory_short_number',
          confidence: 0.85,
          evidence: `numero abrege ${short} de « ${nameOf(hit)} » = poste de la ligne`,
        }));
      }
    }

    // -- Regles 4 et 5 : rapprochement par le nom de la ligne. ---------------
    if (clean(line.name)) {
      /** @type {{src: any, sim: number, kind: 'directory'|'mailbox'}|null} */
      let best = null;
      for (const c of contacts) {
        const sim = nameSimilarity(line.name, nameOf(c));
        if (sim >= NAME_MATCH_THRESHOLD && (!best || sim > best.sim)) best = { src: c, sim, kind: 'directory' };
      }
      for (const m of mailboxes) {
        const label = nameOf(m) || nameFromEmail(m.email).local;
        const sim = nameSimilarity(line.name, label);
        if (sim >= NAME_MATCH_THRESHOLD && (!best || sim > best.sim)) best = { src: m, sim, kind: 'mailbox' };
      }
      if (best) {
        candidates.push(personFrom(best.src, {
          source: best.kind === 'directory' ? 'directory_name' : 'email_account_name',
          confidence: Number((0.7 * best.sim).toFixed(3)),
          evidence: `nom de ligne « ${line.name} » proche de « ${nameOf(best.src)} » (${Math.round(best.sim * 100)} %)`,
        }));
      }
    }

    // -- Regle 6 : le nom de la ligne EST un prenom, sans email connu. -------
    if (!candidates.length) {
      const tokens = nameTokens(line.name);
      if (tokens.length && tokens.length <= 3 && !/ligne|poste|standard|accueil|fax|groupe|sda/i.test(String(line.name))) {
        candidates.push({
          email: null,
          firstName: capitalizeName(tokens[0]),
          lastName: tokens[1] ? capitalizeName(tokens.slice(1).join(' ')) : null,
          displayName: capitalizeName(tokens.join(' ')),
          source: 'line_name',
          confidence: 0.35,
          evidence: `aucun email rattache : prenom lu sur le nom de ligne « ${line.name} »`,
        });
      }
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return { ...line, person: candidates[0] || null, candidates };
  });
}

/** Libelle « Prenom Nom » d'un contact ou d'un compte mail. */
function nameOf(src) {
  return [clean(src.firstName), clean(src.lastName)].filter(Boolean).join(' ')
    || clean(src.name)
    || clean(src.email)
    || '';
}

/**
 * Libelle court d'une ligne pour l'interface : le prenom quand on le connait,
 * sinon le numero formate. Jamais un CSI nu.
 * @param {{person?: Person|null, name?: string, formattedCsi?: string, csi?: string}} line
 * @returns {string}
 */
export function lineLabel(line) {
  if (!line) return '—';
  const p = line.person;
  if (p && p.firstName) return p.firstName;
  if (p && p.displayName) return p.displayName;
  const n = clean(line.name);
  if (n) return n;
  return clean(line.formattedCsi) || clean(line.csi) || '—';
}

/**
 * Initiales pour un pastille d'avatar.
 * @param {unknown} label
 * @returns {string}
 */
export function initialsOf(label) {
  const t = nameTokens(label);
  if (!t.length) {
    const s = normalizeName(label);
    return s ? s.charAt(0).toUpperCase() : '?';
  }
  return ((t[0][0] || '') + (t[1] ? t[1][0] : '')).toUpperCase();
}

/**
 * Analyse le reglage `KEYYO_LINE_EMAILS`.
 * Format : `33253359565=stephane.sedson@bios-expertise.com,33175433361=autre@x.fr`
 * (JSON accepte aussi).
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function parseLineEmails(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return out;

  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) if (isEmail(v)) out[String(k).replace(/\D/g, '')] = String(v).toLowerCase();
      }
      return out;
    } catch { /* on retombe sur le format simple */ }
  }

  for (const pair of s.split(/[,;\n]+/)) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const csi = pair.slice(0, i).replace(/\D/g, '');
    const email = pair.slice(i + 1).trim().toLowerCase();
    if (csi && isEmail(email)) out[csi] = email;
  }
  return out;
}
