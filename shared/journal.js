// =============================================================================
//  shared/journal.js — Journal d'attribution : le SEUL endroit ou un appel est
//  relie a une personne. PUR : ni fetch, ni process, ni DOM.
//
//  POURQUOI CE JOURNAL EXISTE. Aucune API Keyyo ne dit qui a pris un appel :
//  un CallDetailRecord ne nomme ni terminal ni personne, un objet Call du CTI
//  non plus, et les 56 terminaux Keyyo Phone partagent trois lignes. La seule
//  source possible est NOTRE application, parce que l'action y passe par une
//  interface ou la personne est authentifiee. Ce module fixe le format de ces
//  faits, et les agregations qu'on en tire.
//
//  UN EVENEMENT EST UN FAIT, PAS UNE DEDUCTION. Il dit ce que l'application a
//  vu ou fait, avec qui, quand. Il est IMMUABLE : on n'en corrige jamais un, on
//  en ajoute un autre. Le back est le seul a ecrire (avec l'adresse de la
//  session, jamais celle envoyee par la page), dans une partition par
//  personne et par mois — un seul ecrivain par fichier, donc pas de course.
//
//  TYPES D'EVENEMENTS
//    dial       la personne a compose un numero depuis l'application
//    answer     la personne a decroche depuis l'application
//    claim      la personne declare avoir pris cet appel (decroche au telephone)
//    transfer   la personne a transfere un appel a un numero
//    hangup     la personne a raccroche depuis l'application
//    observed   le navigateur de la personne a VU cet appel de sa ligne se
//               terminer ; il porte la duree de sonnerie mesuree par le CTI.
//               Plusieurs navigateurs voient le meme appel : `mergeEvents`
//               n'en garde qu'un par appel.
//
//  UNE STATISTIQUE PARTIELLE NE DOIT JAMAIS AVOIR L'AIR COMPLETE. `summarize`
//  rend donc, a cote des comptes, le nombre d'appels observes sans personne
//  (`unattributed`) : c'est le chiffre qui dit combien il manque.
// =============================================================================

/** Types acceptes. Tout autre type est rejete a l'ecriture. */
export const EVENT_TYPES = Object.freeze(['dial', 'answer', 'claim', 'transfer', 'hangup', 'observed']);

/** Version du format. Un fichier d'une autre version est ignore a la lecture. */
export const JOURNAL_VERSION = 1;

/** Sens d'un appel, vu de la ligne. */
export const DIR_IN = 'in';
export const DIR_OUT = 'out';

/** Longueur maximale des champs libres, pour borner un fichier de journal. */
const MAX_TEXT = 120;

/** @param {unknown} v @returns {string} */
function str(v) {
  const s = String(v == null ? '' : v).trim();
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

/** @param {unknown} v @returns {number} entier >= 0, ou 0. */
function nat(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** @param {unknown} v @returns {number} horodatage Unix en secondes, ou 0. */
function ts(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Tolere des millisecondes : au-dela de l'an 2286 en secondes, c'est du ms.
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * Identifiant STABLE d'un evenement : deux navigateurs qui rapportent le meme
 * fait produisent le meme identifiant, et la fusion n'en garde qu'un.
 *
 * - `observed` : un par appel de la ligne (`observed:<csi>:<callref>`) ;
 * - actions sur un appel (`answer`, `claim`, `transfer`, `hangup`) : un par
 *   appel et par personne — rejouer l'action ne cree pas un second fait ;
 * - `dial` : un par appel quand le CTI a rendu un `callref`, sinon par
 *   personne, numero et seconde.
 *
 * @param {any} e evenement deja normalise (avec `email`).
 * @returns {string}
 */
export function eventId(e) {
  const type = str(e.type);
  const csi = str(e.csi);
  const callref = str(e.callref);
  const who = str(e.email).toLowerCase();
  if (type === 'observed') return 'observed:' + csi + ':' + callref;
  if (type === 'dial' && !callref) return 'dial:' + who + ':' + str(e.to) + ':' + nat(e.ts);
  return type + ':' + who + ':' + csi + ':' + callref;
}

/**
 * Normalise un evenement brut venu de la page. Renvoie `null` s'il est
 * inexploitable. `email` est TOUJOURS celui de la session, impose par le back :
 * la page ne peut pas ecrire au nom d'un autre.
 *
 * @param {any} raw
 * @param {{email: string, now?: number}} ctx
 * @returns {object|null}
 */
export function normalizeEvent(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const type = str(raw.type);
  if (EVENT_TYPES.indexOf(type) < 0) return null;
  const email = str(ctx && ctx.email).toLowerCase();
  if (!email) return null;

  const now = ts(ctx && ctx.now) || Math.floor(Date.now() / 1000);
  let when = ts(raw.ts) || now;
  // Un horodatage aberrant (horloge du poste fausse) est ramene a maintenant :
  // un fait date de 1970 ou de 2099 fausserait tous les mois.
  if (Math.abs(when - now) > 7 * 86400) when = now;

  const csi = str(raw.csi).replace(/\D/g, '');
  const callref = str(raw.callref);
  const dir = raw.dir === DIR_OUT ? DIR_OUT : (raw.dir === DIR_IN ? DIR_IN : '');

  /** @type {any} */
  const e = { v: JOURNAL_VERSION, type, ts: when, email, csi, callref, dir };

  if (type === 'dial' || type === 'transfer') {
    e.to = str(raw.to).replace(/[^\d+]/g, '');
    if (!e.to) return null;
    if (type === 'transfer') e.supervised = !!raw.supervised;
  }
  if (type === 'observed' || type === 'answer' || type === 'claim') {
    e.peer = str(raw.peer).replace(/[^\d+]/g, '') || (raw.peer === 'anonymous' ? 'anonymous' : '');
    e.ring = nat(raw.ring);
    e.duration = nat(raw.duration);
    e.answered = raw.answered === true || raw.answered === 1 ? 1 : 0;
  }
  if (type === 'observed' && (!csi || !callref)) return null;
  if ((type === 'answer' || type === 'claim' || type === 'hangup') && !callref) return null;

  e.id = eventId(e);
  return e;
}

/**
 * Un evenement lu depuis un fichier est-il exploitable ?
 * @param {any} e
 * @returns {boolean}
 */
export function isValidEvent(e) {
  return !!e && typeof e === 'object'
    && EVENT_TYPES.indexOf(String(e.type)) >= 0
    && typeof e.id === 'string' && e.id.length > 0
    && typeof e.email === 'string' && e.email.length > 0
    && Number(e.ts) > 0;
}

/**
 * Fusionne des listes d'evenements en dedupliquant par identifiant. Le premier
 * vu gagne : c'est l'ordre des listes qui tranche, jamais un hasard.
 * @param {...any[]} lists
 * @returns {any[]} tries par date croissante.
 */
export function mergeEvents(...lists) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const list of lists) {
    for (const e of Array.isArray(list) ? list : []) {
      if (!isValidEvent(e)) continue;
      if (!byId.has(e.id)) byId.set(e.id, e);
    }
  }
  const out = Array.from(byId.values());
  out.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) || String(a.id).localeCompare(String(b.id)));
  return out;
}

/** @param {number} unix @returns {string} `YYYY-MM` en UTC — la partition. */
export function monthOf(unix) {
  const d = new Date(ts(unix) * 1000);
  const m = d.getUTCMonth() + 1;
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m;
}

/**
 * @typedef {object} AgentSummary
 * @property {string} email
 * @property {number} dialed       appels composes depuis l'application
 * @property {number} answered     appels decroches depuis l'application
 * @property {number} claimed      appels declares pris au telephone
 * @property {number} taken        answered + claimed, sans double compte par appel
 * @property {number} transferred
 * @property {number} hungUp
 * @property {number} ringTotal    somme des sonneries des appels pris (s)
 * @property {number} ringCount    nombre d'appels pris avec une sonnerie connue
 * @property {number} talkTotal    somme des durees des appels pris (s)
 * @property {Array<{to: string, count: number}>} callees  destinations, la plus appelee d'abord
 * @property {number} lastTs
 */

/**
 * Agrege le journal par personne, et rend ce que le journal NE SAIT PAS.
 *
 * @param {any[]} events
 * @param {{email?: string}} [opts]  `email` restreint a une personne.
 * @returns {{
 *   agents: AgentSummary[],
 *   calls: { observed: number, answered: number, missed: number, attributed: number, unattributed: number,
 *            ringAnsweredTotal: number, ringAnsweredCount: number, ringMissedTotal: number, ringMissedCount: number },
 *   period: { min: number, max: number },
 * }}
 */
export function summarize(events, opts) {
  const o = opts || {};
  const only = o.email ? String(o.email).toLowerCase() : '';
  const list = Array.isArray(events) ? events : [];

  /** @type {Map<string, AgentSummary & {_calleeMap: Map<string, number>, _taken: Set<string>}>} */
  const agents = new Map();
  /** @type {Map<string, any>} appels observes, par cle csi:callref */
  const observed = new Map();
  /** @type {Set<string>} appels ayant au moins une action nominative */
  const attributed = new Set();
  let min = 0;
  let max = 0;

  const agentOf = (email) => {
    let a = agents.get(email);
    if (!a) {
      a = {
        email, dialed: 0, answered: 0, claimed: 0, taken: 0, transferred: 0, hungUp: 0,
        ringTotal: 0, ringCount: 0, talkTotal: 0, callees: [], lastTs: 0,
        _calleeMap: new Map(), _taken: new Set(),
      };
      agents.set(email, a);
    }
    return a;
  };

  for (const e of list) {
    if (!isValidEvent(e)) continue;
    const t = Number(e.ts) || 0;
    if (!min || t < min) min = t;
    if (t > max) max = t;

    const callKey = str(e.csi) + ':' + str(e.callref);

    if (e.type === 'observed') {
      if (!observed.has(callKey)) observed.set(callKey, e);
      continue;
    }

    if (e.callref) attributed.add(callKey);
    if (only && String(e.email).toLowerCase() !== only) continue;

    const a = agentOf(String(e.email).toLowerCase());
    if (t > a.lastTs) a.lastTs = t;

    if (e.type === 'dial') {
      a.dialed++;
      const to = str(e.to);
      if (to) a._calleeMap.set(to, (a._calleeMap.get(to) || 0) + 1);
    } else if (e.type === 'answer' || e.type === 'claim') {
      if (e.type === 'answer') a.answered++; else a.claimed++;
      // Un appel decroche depuis l'application PUIS declare pris ne compte
      // qu'une fois dans « pris ».
      if (!a._taken.has(callKey)) {
        a._taken.add(callKey);
        a.taken++;
        if (Number(e.ring) > 0) { a.ringTotal += nat(e.ring); a.ringCount++; }
        a.talkTotal += nat(e.duration);
      }
    } else if (e.type === 'transfer') {
      a.transferred++;
    } else if (e.type === 'hangup') {
      a.hungUp++;
    }
  }

  // Les durees des appels pris viennent de preference de l'observation (elle
  // est complete : sonnerie ET duree finale), l'action ayant pu etre
  // enregistree avant la fin de l'appel.
  for (const a of agents.values()) {
    for (const key of a._taken) {
      const obs = observed.get(key);
      if (!obs) continue;
      if (nat(obs.duration) > a.talkTotal) a.talkTotal = Math.max(a.talkTotal, nat(obs.duration));
    }
  }

  const calls = {
    observed: 0, answered: 0, missed: 0, attributed: 0, unattributed: 0,
    ringAnsweredTotal: 0, ringAnsweredCount: 0, ringMissedTotal: 0, ringMissedCount: 0,
  };
  for (const [key, obs] of observed) {
    calls.observed++;
    const isIn = obs.dir === DIR_IN;
    if (obs.answered === 1) {
      calls.answered++;
      if (isIn && nat(obs.ring) > 0) { calls.ringAnsweredTotal += nat(obs.ring); calls.ringAnsweredCount++; }
      if (attributed.has(key)) calls.attributed++; else calls.unattributed++;
    } else if (isIn) {
      calls.missed++;
      if (nat(obs.ring) > 0) { calls.ringMissedTotal += nat(obs.ring); calls.ringMissedCount++; }
    }
  }

  const out = [];
  for (const a of agents.values()) {
    a.callees = Array.from(a._calleeMap.entries())
      .map(([to, count]) => ({ to, count }))
      .sort((x, y) => y.count - x.count || x.to.localeCompare(y.to));
    delete a._calleeMap;
    delete a._taken;
    out.push(a);
  }
  out.sort((x, y) => (y.taken + y.dialed) - (x.taken + x.dialed) || x.email.localeCompare(y.email));

  return { agents: out, calls, period: { min, max } };
}
