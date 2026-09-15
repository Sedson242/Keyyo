// =============================================================================
//  shared/access.js — La configuration d'acces geree DANS l'application.
//  PUR : ni fetch, ni process, ni DOM.
//
//  Ce que la direction regle elle-meme, sans passer par Entra ni par les
//  variables d'environnement :
//
//    membres   qui a quel role (administrateur, direction, agent), sur quelle
//              ligne il travaille, et s'il recoit la fenetre d'appel entrant ;
//    routage   pour chaque ligne, QUI est presente a l'appel entrant. Une
//              ligne Keyyo sonne pour tout un site ; l'application, elle,
//              peut choisir a qui montrer la fenetre et a qui attribuer.
//
//  ORDRE DE PRIORITE DES ROLES, du plus fort au plus faible :
//    1. l'app role Entra (Admin / Direction), pose par l'informatique ;
//    2. cette configuration, posee par un administrateur de l'application ;
//    3. AUTH_DIRECTION_EMAILS, l'amorce en variable d'environnement ;
//    4. agent, pour toute personne du locataire.
//  `resolveEffectiveRole` applique cet ordre ; le back le rejoue a chaque
//  requete, pour qu'un changement fait ici s'applique sans reconnexion.
//
//  Le fichier est petit (quelques dizaines de membres) et immuable par
//  construction : on ne le corrige pas, on l'ecrit entier, avec qui et quand.
// =============================================================================

import { ROLES, ROLE_ADMIN, ROLE_DIRECTION, ROLE_AGENT, parseEmailList } from './roles.js';

/** Version du format. Un fichier d'une autre version est ignore. */
export const ACCESS_VERSION = 1;

/** Nombre maximal de membres : garde-fou contre un fichier qui enfle. */
const MAX_MEMBERS = 500;

/** @param {unknown} v @returns {string} */
function str(v) {
  return String(v == null ? '' : v).trim();
}

/** @param {unknown} v @returns {string} adresse en minuscules, ou ''. */
function email(v) {
  const list = parseEmailList(v);
  return list.length ? list[0] : '';
}

/** @param {unknown} v @returns {string} chiffres seuls. */
function csi(v) {
  return str(v).replace(/\D/g, '');
}

/**
 * Numero direct d'une personne : un numero complet (« +33… », « 06… »), un
 * numero court interne (« 4012 ») ou sa forme composee depuis un poste
 * (« *4012 »). Tout autre caractere est retire ; vide si rien ne reste.
 * @param {unknown} v
 * @returns {string}
 */
function directNumber(v) {
  const s = str(v).replace(/[\s.\-()]/g, '');
  const m = /^([+*]?)(\d{2,15})$/.exec(s);
  return m ? m[1] + m[2] : '';
}

/**
 * @typedef {object} Member
 * @property {string} email
 * @property {string} name
 * @property {'admin'|'direction'|'agent'} role
 * @property {string[]} lines    CSI des lignes ou la personne travaille
 * @property {boolean} popup     recoit la fenetre d'appel entrant sur ses lignes
 * @property {string} number     numero DIRECT (ligne personnelle ou numero court) :
 *                               le seul moyen de faire sonner cette personne
 *                               et non tout son site ; '' si elle n'en a pas
 */

/**
 * @typedef {object} AccessConfig
 * @property {number} version
 * @property {string} updatedAt
 * @property {string} updatedBy
 * @property {Member[]} members
 * @property {Record<string, {agents: string[]}>} routing   csi -> qui est presente a l'appel entrant
 */

/** @returns {AccessConfig} configuration vide. */
export function emptyAccess() {
  return { version: ACCESS_VERSION, updatedAt: '', updatedBy: '', members: [], routing: {} };
}

/**
 * Normalise une configuration brute (lue d'un fichier ou envoyee par la page).
 * Ce qui n'est pas exploitable est ecarte, jamais corrige en silence : une
 * adresse invalide disparait, un role inconnu devient `agent`, une ligne sans
 * chiffres est retiree. Les doublons d'adresse ne gardent que le premier.
 * @param {unknown} raw
 * @returns {AccessConfig}
 */
export function normalizeAccess(raw) {
  const out = emptyAccess();
  const r = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  if (r.version != null && Number(r.version) !== ACCESS_VERSION) return out;
  out.updatedAt = str(r.updatedAt);
  out.updatedBy = email(r.updatedBy);

  const seen = new Set();
  for (const m of Array.isArray(r.members) ? r.members : []) {
    if (!m || typeof m !== 'object') continue;
    const e = email(m.email);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    const role = ROLES.indexOf(str(m.role)) >= 0 ? str(m.role) : ROLE_AGENT;
    const lines = [];
    for (const l of Array.isArray(m.lines) ? m.lines : []) {
      const c = csi(l);
      if (c && lines.indexOf(c) < 0) lines.push(c);
    }
    out.members.push({
      email: e,
      name: str(m.name).slice(0, 120),
      role: /** @type {any} */ (role),
      lines,
      popup: m.popup !== false,
      number: directNumber(m.number),
    });
    if (out.members.length >= MAX_MEMBERS) break;
  }

  const routing = r.routing && typeof r.routing === 'object' ? r.routing : {};
  for (const key of Object.keys(routing)) {
    const c = csi(key);
    if (!c) continue;
    const entry = routing[key] && typeof routing[key] === 'object' ? routing[key] : {};
    const agents = [];
    for (const a of Array.isArray(entry.agents) ? entry.agents : []) {
      const e = email(a);
      if (e && agents.indexOf(e) < 0) agents.push(e);
    }
    out.routing[c] = { agents };
  }
  return out;
}

/**
 * @param {AccessConfig} config
 * @param {unknown} who
 * @returns {Member|null}
 */
export function memberOf(config, who) {
  const e = email(who);
  if (!e || !config) return null;
  return (config.members || []).find((m) => m.email === e) || null;
}

/**
 * Role donne par la configuration, ou '' si la personne n'y figure pas.
 * @param {AccessConfig} config
 * @param {unknown} who
 * @returns {string}
 */
export function configRoleOf(config, who) {
  const m = memberOf(config, who);
  return m ? m.role : '';
}

/**
 * Lignes affectees a une personne par la configuration (peut etre vide).
 * @param {AccessConfig} config
 * @param {unknown} who
 * @returns {string[]}
 */
export function linesOf(config, who) {
  const m = memberOf(config, who);
  return m ? m.lines.slice() : [];
}

/**
 * Qui est presente a l'appel entrant d'une ligne. Tableau vide = pas de
 * routage : tout le monde sur la ligne.
 * @param {AccessConfig} config
 * @param {unknown} line
 * @returns {string[]}
 */
export function routingFor(config, line) {
  const c = csi(line);
  const entry = config && config.routing ? config.routing[c] : null;
  return entry && Array.isArray(entry.agents) ? entry.agents.slice() : [];
}

/**
 * La fenetre d'appel entrant doit-elle etre presentee a cette personne sur
 * cette ligne ? Oui si la ligne n'a pas de routage, ou si elle y figure — et
 * si son profil ne l'a pas coupee.
 * @param {AccessConfig} config
 * @param {unknown} who
 * @param {unknown} line
 * @returns {boolean}
 */
export function shouldPopup(config, who, line) {
  const m = memberOf(config, who);
  if (m && m.popup === false) return false;
  const agents = routingFor(config, line);
  if (!agents.length) return true;
  const e = email(who);
  return !!e && agents.indexOf(e) >= 0;
}

/** Rang des roles, pour comparer. */
const RANK = { [ROLE_ADMIN]: 3, [ROLE_DIRECTION]: 2, [ROLE_AGENT]: 1 };

/**
 * Role effectif d'une session, selon l'ordre de priorite du module.
 *
 * @param {object} input
 * @param {string} input.sessionRole      role porte par le cookie
 * @param {string} input.roleSource       'entra' | 'env' | 'none' — d'ou vient sessionRole
 * @param {string} [input.configRole]     role donne par la configuration, ou ''
 * @returns {'admin'|'direction'|'agent'}
 */
export function resolveEffectiveRole(input) {
  const s = ROLES.indexOf(str(input && input.sessionRole)) >= 0 ? str(input.sessionRole) : ROLE_AGENT;
  const c = ROLES.indexOf(str(input && input.configRole)) >= 0 ? str(input.configRole) : '';
  const source = str(input && input.roleSource);
  // L'app role Entra est pose par l'informatique : la configuration ne peut
  // que le completer vers le haut, jamais le retirer.
  if (source === 'entra') return /** @type {any} */ (RANK[c] > RANK[s] ? c : s);
  // Sinon la configuration fait foi des qu'elle nomme la personne ; a defaut,
  // le cookie (amorce AUTH_DIRECTION_EMAILS, ou agent).
  return /** @type {any} */ (c || s);
}

/**
 * Ajoute ou met a jour un membre. Renvoie une NOUVELLE configuration.
 * @param {AccessConfig} config
 * @param {Partial<Member> & {email: string}} patch
 * @returns {AccessConfig}
 */
export function upsertMember(config, patch) {
  const next = normalizeAccess(config);
  const e = email(patch && patch.email);
  if (!e) return next;
  const current = next.members.find((m) => m.email === e);
  const merged = Object.assign({ email: e, name: '', role: ROLE_AGENT, lines: [], popup: true, number: '' }, current || {}, patch || {}, { email: e });
  const normalized = normalizeAccess({ version: ACCESS_VERSION, members: [merged] }).members[0];
  if (!normalized) return next;
  if (current) next.members[next.members.indexOf(current)] = normalized;
  else next.members.push(normalized);
  return next;
}

/**
 * Retire un membre (et le sort des routages). Renvoie une NOUVELLE configuration.
 * @param {AccessConfig} config
 * @param {unknown} who
 * @returns {AccessConfig}
 */
export function removeMember(config, who) {
  const next = normalizeAccess(config);
  const e = email(who);
  next.members = next.members.filter((m) => m.email !== e);
  for (const key of Object.keys(next.routing)) {
    next.routing[key].agents = next.routing[key].agents.filter((a) => a !== e);
  }
  return next;
}

/**
 * Lignes PERSONNELLES : celles qu'une seule personne de la configuration
 * declare comme siennes. Sur une telle ligne, tout appel decroche est le sien
 * — c'est ce qui permet l'attribution automatique (shared/journal.js).
 * @param {AccessConfig} config
 * @returns {Record<string, string>} csi -> adresse de la titulaire
 */
export function lineOwners(config) {
  /** @type {Record<string, string[]>} */
  const byLine = {};
  for (const m of (config && config.members) || []) {
    for (const l of m.lines || []) (byLine[l] || (byLine[l] = [])).push(m.email);
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const l of Object.keys(byLine)) if (byLine[l].length === 1) out[l] = byLine[l][0];
  return out;
}

/**
 * Nombre d'administrateurs restants. Sert a refuser une modification qui ne
 * laisserait plus personne pour administrer.
 * @param {AccessConfig} config
 * @returns {number}
 */
export function adminCount(config) {
  return (config && config.members ? config.members : []).filter((m) => m.role === ROLE_ADMIN).length;
}
