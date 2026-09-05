// =============================================================================
//  shared/roles.js — Roles et politique d'acces. PUR : ni fetch, ni process,
//  ni DOM. Importe a l'identique par le back (qui applique la politique) et
//  par le front (qui n'affiche que ce que la politique autorise).
//
//  DEUX ROLES, PAS PLUS.
//
//    direction  supervise : voit les appels de tout le monde, les identites,
//               le diagnostic, et peut declencher une collecte.
//    agent      travaille : voit sa propre activite, passe et transfere des
//               appels, consulte l'annuaire.
//
//  La politique est ecrite ROUTE PAR ROUTE et REFUSE PAR DEFAUT : une route
//  absente de la table n'est ouverte a personne. Ajouter une route sans
//  l'inscrire ici la rend inaccessible — c'est voulu, on prefere un 403 a une
//  fuite. Le back est le seul juge ; le front ne fait que cacher les menus.
//
//  D'OU VIENT LE ROLE. De l'identite Microsoft Entra, par deux chemins :
//    1. le claim `roles` du jeton d'identite, rempli par les « app roles »
//       declares sur l'application Entra et attribues aux personnes ;
//    2. a defaut, une liste d'adresses de direction posee en variable
//       d'environnement (AUTH_DIRECTION_EMAILS), pour demarrer sans avoir a
//       configurer les app roles.
//  Toute personne authentifiee du locataire est au moins `agent` : ce sont
//  les employes, et la page agent ne montre que leur propre activite.
// =============================================================================

/** @type {'direction'} */
export const ROLE_DIRECTION = 'direction';
/** @type {'agent'} */
export const ROLE_AGENT = 'agent';

/** Les roles, du plus au moins privilegie. */
export const ROLES = Object.freeze([ROLE_DIRECTION, ROLE_AGENT]);

/**
 * Valeurs d'app role Entra reconnues, apres normalisation (minuscules, sans
 * accents). `Direction`, `direction`, `DIRECTION` sont donc equivalents.
 * @type {Record<string, string>}
 */
const ENTRA_ROLE_VALUES = Object.freeze({
  direction: ROLE_DIRECTION,
  manager: ROLE_DIRECTION,
  agent: ROLE_AGENT,
});

/**
 * Politique d'acces : route -> roles autorises. Une route absente est fermee.
 * Les routes sont les chemins EXACTS des fonctions serverless, sans query.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const POLICY = Object.freeze({
  // Supervision : donnees nominatives de toute l'equipe.
  '/api/calls': Object.freeze([ROLE_DIRECTION]),
  '/api/team': Object.freeze([ROLE_DIRECTION]),
  '/api/health': Object.freeze([ROLE_DIRECTION]),
  '/api/sync': Object.freeze([ROLE_DIRECTION]),
  '/api/oauth': Object.freeze([ROLE_DIRECTION]),
  // Outils de travail : chaque agent y a droit.
  '/api/directory': Object.freeze([ROLE_DIRECTION, ROLE_AGENT]),
  '/api/me': Object.freeze([ROLE_DIRECTION, ROLE_AGENT]),
  '/api/cti-token': Object.freeze([ROLE_DIRECTION, ROLE_AGENT]),
  '/api/events': Object.freeze([ROLE_DIRECTION, ROLE_AGENT]),
});

/**
 * @param {unknown} s
 * @returns {string} minuscules, sans accents ni espaces autour.
 */
function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

/** Forme minimale d'une adresse : quelque chose, une arobase, un domaine avec un point. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Liste d'adresses depuis une variable d'environnement : separateurs virgule,
 * point-virgule, espace ou retour a la ligne. Les valeurs qui n'ont pas la
 * forme d'une adresse sont ecartees, jamais corrigees.
 * @param {unknown} raw
 * @returns {string[]} adresses en minuscules, sans doublon.
 */
export function parseEmailList(raw) {
  const out = [];
  const parts = String(raw == null ? '' : raw).split(/[\s,;]+/);
  for (const p of parts) {
    const v = fold(p);
    if (v && EMAIL_RE.test(v) && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

/**
 * Role d'une personne a partir de son jeton d'identite.
 *
 * @param {{roles?: unknown, email?: unknown, preferred_username?: unknown}} claims
 * @param {{directionEmails?: string[]}} [opts]
 * @returns {'direction'|'agent'}
 */
export function roleFromClaims(claims, opts) {
  const c = claims && typeof claims === 'object' ? claims : {};
  const o = opts || {};

  // 1. App roles Entra. Le claim est un tableau de chaines ; on tolere une
  //    chaine seule, que certains gabarits produisent.
  const rawRoles = Array.isArray(c.roles) ? c.roles : (c.roles ? [c.roles] : []);
  let best = '';
  for (const r of rawRoles) {
    const mapped = ENTRA_ROLE_VALUES[fold(r)];
    if (mapped === ROLE_DIRECTION) return ROLE_DIRECTION;
    if (mapped && !best) best = mapped;
  }

  // 2. Liste d'adresses de direction.
  const email = fold(c.email || c.preferred_username);
  const list = Array.isArray(o.directionEmails) ? o.directionEmails : [];
  if (email && list.indexOf(email) >= 0) return ROLE_DIRECTION;

  return best || ROLE_AGENT;
}

/**
 * Roles autorises sur une route. Tableau vide pour une route inconnue.
 * @param {unknown} route chemin exact, sans query (`/api/calls`).
 * @returns {ReadonlyArray<string>}
 */
export function allowedRoles(route) {
  const key = String(route == null ? '' : route).split('?')[0];
  return Object.prototype.hasOwnProperty.call(POLICY, key) ? POLICY[key] : Object.freeze([]);
}

/**
 * Une personne de ce role peut-elle appeler cette route ? Refus par defaut :
 * route inconnue, role inconnu ou vide -> faux.
 * @param {unknown} route
 * @param {unknown} role
 * @returns {boolean}
 */
export function canAccess(route, role) {
  const r = String(role == null ? '' : role);
  if (ROLES.indexOf(r) < 0) return false;
  return allowedRoles(route).indexOf(r) >= 0;
}

/** @param {unknown} role @returns {boolean} */
export function isDirection(role) {
  return String(role == null ? '' : role) === ROLE_DIRECTION;
}

/**
 * Libelle affichable d'un role.
 * @param {unknown} role
 * @returns {string}
 */
export function roleLabel(role) {
  const r = String(role == null ? '' : role);
  if (r === ROLE_DIRECTION) return 'Direction';
  if (r === ROLE_AGENT) return 'Agent';
  return 'Sans rôle';
}
