// =============================================================================
//  app/store.js — Etat de l'application et agregations.
//
//  Module le plus consomme du projet : chaque page en depend. Il detient
//  l'unique copie des donnees (appels, lignes, annuaire), le jeu de filtres
//  courant, et toutes les agregations que les pages affichent.
//
//  Trois regles de conception :
//
//   1. AUCUN effet de bord visible. Pas de DOM, pas de `fetch` : les appels
//      reseau passent par app/api.js, le rendu par app/pages/*.js. Le store se
//      contente de detenir l'etat et de prevenir ses abonnes.
//
//   2. LES BOUCLES SONT CHAUDES. Trois mois d'appels sur une dizaine de lignes
//      representent plusieurs milliers d'enregistrements, et une page peut
//      appeler `filtered()` puis quatre agregations dans un meme rendu. D'ou
//      l'indexation par `F.xxx` (jamais un nombre en dur), la memoisation de
//      `filtered()` et l'absence d'objets intermediaires par ligne.
//
//   3. UNE COLLECTE PARTIELLE SE VOIT. `status()` distingue `ok`, `warn` (la
//      reponse est arrivee mais vide ou incomplete) et `error` (elle n'est pas
//      arrivee du tout, les donnees precedentes sont conservees).
// =============================================================================

import { getCalls, getTeam, getDirectory } from './api.js';
import { F, isMissed, isIncoming, isOutgoing } from '../shared/schema.js';
import { toE164, formatNumber } from '../shared/phone.js';
import { lineLabel, initialsOf } from '../shared/identity.js';
import { todayIso, isoDaysAgo, nextDay, daysBetween, monthSlices } from '../shared/time.js';

/** Perimetre de donnees vise par l'outil, en jours (trois mois). */
const DEFAULT_DAYS = 92;

/**
 * Garde-fou des series continues : une plage aberrante (horodatage corrompu
 * remontant a 2001) ne doit pas fabriquer une serie de 9000 points qui gele
 * le navigateur. On rogne alors le debut de la plage.
 */
const MAX_SERIES_DAYS = 731;

// -----------------------------------------------------------------------------
//  Etat public
// -----------------------------------------------------------------------------

/**
 * Filtres et navigation. Objet unique et mutable : les pages le lisent
 * directement, mais ne doivent l'ecrire QUE via `setFilter` (qui notifie).
 *
 * @type {{ page: string, from: string, to: string, preset: number|string,
 *          csi: string, dir: ''|'in'|'out'|'missed', search: string,
 *          granularity: 'day'|'week'|'month' }}
 */
export const state = {
  page: 'monitoring',
  from: '',
  to: '',
  preset: DEFAULT_DAYS,
  csi: '',
  dir: '',
  search: '',
  granularity: 'day',
};

/** Cles reconnues de `state` : un patch qui en contient d'autres est signale. */
const STATE_KEYS = Object.keys(state);

const DIRECTIONS = ['', 'in', 'out', 'missed'];
const GRANULARITIES = ['day', 'week', 'month'];

// -----------------------------------------------------------------------------
//  Etat interne
// -----------------------------------------------------------------------------

/** @type {any[][]} lignes d'appel brutes, format positionnel de shared/schema.js */
let _rows = [];

/** @type {any[]} lignes Keyyo enrichies (identite + libelle pret a afficher) */
let _lines = [];

/** @type {Map<string, any>} index des lignes par CSI, par CSI en chiffres et par E.164 */
let _lineIndex = new Map();

/** @type {Map<string, string>} annuaire : cle E.164 -> nom affichable */
let _names = new Map();

/** @type {{n: number, min: string, max: string, days: number, months: string[], csis: string[]}} */
let _meta = emptyMeta();

let _coverage = /** @type {Record<string, any>} */ ({});
let _store = /** @type {any} */ (null);
let _diag = /** @type {any} */ (null);

let _kind = /** @type {'loading'|'ok'|'warn'|'error'} */ ('loading');
let _at = /** @type {string} */ ('');
let _warning = '';

/**
 * Incremente a chaque mutation du jeu de donnees. Sert de composante de la cle
 * de memoisation : inutile de vider les caches a la main.
 */
let _dataVersion = 0;

/** Vrai des que l'utilisateur a fixe des dates explicites : on ne les bouge plus. */
let _periodPinned = false;

/** Vrai une fois la periode initialisee (au premier chargement). */
let _periodReady = false;

/** @type {Array<() => void>} */
const _subs = [];

/** Chargement en cours : le sondage de main.js ne doit pas en declencher deux. */
let _inflight = /** @type {Promise<void>|null} */ (null);

function emptyMeta() {
  return { n: 0, min: '', max: '', days: 0, months: [], csis: [] };
}

// -----------------------------------------------------------------------------
//  Abonnement
// -----------------------------------------------------------------------------

/**
 * Enregistre un abonne, appele apres chaque changement d'etat ou de donnees.
 * @param {() => void} fn
 * @returns {() => void} fonction de desabonnement.
 */
export function subscribe(fn) {
  if (typeof fn !== 'function') throw new TypeError('subscribe attend une fonction');
  _subs.push(fn);
  return function unsubscribe() {
    const i = _subs.indexOf(fn);
    if (i >= 0) _subs.splice(i, 1);
  };
}

/**
 * Notifie les abonnes. Une page qui plante ne doit pas empecher les autres de
 * se redessiner : l'erreur est signalee en console, jamais avalee.
 */
function notify() {
  const list = _subs.slice();
  for (let i = 0; i < list.length; i++) {
    try {
      list[i]();
    } catch (err) {
      console.error('[store] un abonne a echoue pendant la notification :', err);
    }
  }
}

/**
 * Fusionne un patch dans `state` puis notifie.
 *
 * Commodite volontaire : quand le patch porte un `preset` sans dates
 * explicites, la periode est recalculee a partir de lui. Des dates explicites
 * l'emportent toujours et « epinglent » la periode (un rechargement ne la
 * deplacera plus).
 *
 * @param {Partial<typeof state>} patch
 */
export function setFilter(patch) {
  if (!patch || typeof patch !== 'object') return;

  const next = {};
  for (const key of Object.keys(patch)) {
    if (STATE_KEYS.indexOf(key) < 0) {
      console.warn(`[store] setFilter : cle inconnue « ${key} » ignoree`);
      continue;
    }
    next[key] = patch[key];
  }

  const hasExplicitDates = next.from != null || next.to != null;
  if (next.preset != null && !hasExplicitDates) {
    const period = periodFor(next.preset);
    next.from = period.from;
    next.to = period.to;
    // Preset seul : la periode reste "vivante" et suivra la derniere date
    // connue au prochain chargement.
    _periodPinned = false;
  }
  if (hasExplicitDates) _periodPinned = true;

  let changed = false;
  for (const key of Object.keys(next)) {
    const value = coerce(key, next[key]);
    if (state[key] !== value) { state[key] = value; changed = true; }
  }

  // `from` et `to` inverses par l'utilisateur : on remet dans l'ordre plutot
  // que de renvoyer une periode vide sans explication.
  if (state.from && state.to && state.from > state.to) {
    const swap = state.from; state.from = state.to; state.to = swap;
    changed = true;
  }

  if (changed) notify();
}

/**
 * Normalise une valeur de filtre. Un `select` renvoie toujours une chaine :
 * mieux vaut une conversion centralisee qu'un `dir` a `undefined` qui ferait
 * silencieusement tomber tous les appels.
 * @param {string} key
 * @param {any} value
 */
function coerce(key, value) {
  switch (key) {
    case 'page':
    case 'csi':
    case 'search':
      return value == null ? '' : String(value);
    case 'from':
    case 'to':
      return isIsoDate(value) ? String(value) : '';
    case 'dir':
      return DIRECTIONS.indexOf(String(value == null ? '' : value)) >= 0 ? String(value == null ? '' : value) : '';
    case 'granularity':
      return GRANULARITIES.indexOf(String(value)) >= 0 ? String(value) : 'day';
    case 'preset':
      return value === 'all' ? 'all' : (Number(value) > 0 ? Math.floor(Number(value)) : DEFAULT_DAYS);
    default:
      return value;
  }
}

/** @param {unknown} v @returns {boolean} */
function isIsoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// -----------------------------------------------------------------------------
//  Periode
// -----------------------------------------------------------------------------

/**
 * Decale une date `YYYY-MM-DD` de `days` jours (negatif = vers le passe).
 * L'ancrage a midi UTC immunise le calcul contre les changements d'heure.
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
function shiftIso(iso, days) {
  const anchor = Date.parse(`${iso}T12:00:00Z`);
  if (!Number.isFinite(anchor)) return iso;
  if (!days) return iso;
  return isoDaysAgo(-days, anchor, 'UTC');
}

/**
 * Bornes correspondant a un preset.
 *
 * La fin de periode est la DERNIERE DATE CONNUE des donnees (`meta.max`) et non
 * la date du jour : quand la collecte a du retard, une fenetre calee sur
 * aujourd'hui afficherait des jours vides en fin de graphique.
 *
 * @param {number|string} preset
 * @returns {{from: string, to: string}}
 */
function periodFor(preset) {
  const to = _meta.max || todayIso();
  if (preset === 'all') {
    return { from: _meta.min || shiftIso(to, -(DEFAULT_DAYS - 1)), to };
  }
  const n = Number(preset) > 0 ? Math.floor(Number(preset)) : DEFAULT_DAYS;
  return { from: shiftIso(to, -(n - 1)), to };   // bornes incluses : n jours
}

/** Applique la periode du preset courant, sauf si l'utilisateur l'a epinglee. */
function syncPeriod() {
  if (_periodPinned) { _periodReady = true; return; }
  const period = periodFor(state.preset);
  state.from = period.from;
  state.to = period.to;
  _periodReady = true;
}

// -----------------------------------------------------------------------------
//  Lecture des donnees
// -----------------------------------------------------------------------------

/** @returns {any[][]} toutes les lignes brutes, sans filtre. */
export function getRows() {
  return _rows;
}

let _filterKey = '';
let _filterRows = /** @type {any[][]|null} */ (null);

/**
 * Lignes retenues par la periode (bornes INCLUSES, sur le champ `date`), la
 * ligne (`csi`) et le sens (`dir`).
 *
 * Memoise : les pages appellent `filtered()` plusieurs fois par rendu, et la
 * meme combinaison de filtres sur le meme jeu de donnees doit rendre le meme
 * tableau sans le recalculer. `search` n'entre pas dans le filtrage : c'est un
 * affinage propre a chaque page.
 *
 * @returns {any[][]}
 */
export function filtered() {
  const key = `${_dataVersion}|${state.from}|${state.to}|${state.csi}|${state.dir}`;
  if (key === _filterKey && _filterRows) return _filterRows;

  const from = state.from;
  const to = state.to;
  const dir = state.dir;

  // Le filtre de ligne peut arriver sous une autre forme que le CSI stocke sur
  // les lignes d'appel (fragment d'URL, numero formate) : on le ramene une
  // seule fois a la forme canonique du parc, hors de la boucle.
  let csi = state.csi ? String(state.csi) : '';
  if (csi) {
    const line = lineByCsi(csi);
    if (line && line.csi) csi = String(line.csi);
  }
  const out = [];

  for (let i = 0; i < _rows.length; i++) {
    const row = _rows[i];
    const date = row[F.date];
    if (from && date < from) continue;
    if (to && date > to) continue;
    if (csi && String(row[F.csi]) !== csi) continue;
    if (dir === 'in' && !isIncoming(row)) continue;
    if (dir === 'out' && !isOutgoing(row)) continue;
    if (dir === 'missed' && !isMissed(row)) continue;
    out.push(row);
  }

  _filterKey = key;
  _filterRows = out;
  return out;
}

// -----------------------------------------------------------------------------
//  Annuaire et lignes
// -----------------------------------------------------------------------------

/**
 * Nom connu pour un numero, ou `null`. Les cles de l'index sont en E.164 :
 * `02 53 35 95 65`, `+33253359565` et `0033253359565` trouvent la meme entree.
 * @param {unknown} number
 * @returns {string|null}
 */
export function nameOf(number) {
  const key = toE164(number);
  if (!key || key === 'anonymous') return null;
  const hit = _names.get(key);
  return hit ? hit : null;
}

/**
 * Libelle affichable d'un numero : le nom quand il est connu, sinon le numero
 * formate (`Masqué` pour un appelant masque, `—` si le numero est vide).
 * @param {unknown} number
 * @returns {string}
 */
export function labelOf(number) {
  return nameOf(number) || formatNumber(number);
}

/** @returns {any[]} lignes Keyyo enrichies de leur identite et de leur libelle. */
export function getLines() {
  return _lines;
}

/**
 * Ligne Keyyo par CSI. Tolerant sur la forme du CSI recu (`33253359565`,
 * `+33253359565`, `0253359565`) : les pages et l'URL n'ont pas le meme.
 * @param {unknown} csi
 * @returns {any|null}
 */
export function lineByCsi(csi) {
  if (csi == null || csi === '') return null;
  const raw = String(csi);
  const hit = _lineIndex.get(raw)
    || _lineIndex.get(digitsOf(raw))
    || _lineIndex.get(toE164(raw));
  return hit || null;
}

/** @param {unknown} v @returns {string} chiffres seuls, forme de comparaison des CSI. */
function digitsOf(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// -----------------------------------------------------------------------------
//  Statistiques
// -----------------------------------------------------------------------------

/**
 * Cache par identite de tableau. `stats()` est appele plusieurs fois par rendu
 * sur le meme resultat de `filtered()` ; la WeakMap laisse le GC faire son
 * travail quand le tableau memoise est remplace.
 * @type {WeakMap<object, any>}
 */
const _statsCache = new WeakMap();

/**
 * @typedef {object} Stats
 * @property {number} total
 * @property {number} in
 * @property {number} out
 * @property {number} missed
 * @property {number} answered      Appels decroches, tous sens confondus.
 * @property {number} answerRate    Taux de reponse des ENTRANTS, 0 a 100.
 * @property {number} avgDuration    Duree moyenne des appels decroches, secondes.
 * @property {number} medianDuration Duree mediane des appels decroches, secondes.
 * @property {number} totalDuration  Somme des durees, secondes.
 * @property {number} uniquePeers
 */

/**
 * Indicateurs d'un jeu de lignes.
 *
 * `answerRate` est L'INDICATEUR PRINCIPAL de l'outil : entrants decroches /
 * entrants, en pourcentage. Il ne compte que les entrants — un sortant qui ne
 * repond pas n'est pas un appel qu'on a rate. Sans aucun entrant, il vaut 0
 * (jamais NaN, qui traverserait tout l'affichage).
 *
 * Les durees moyenne et mediane ne portent que sur les appels DECROCHES : les
 * non decroches durent 0 s et tireraient la moyenne vers le bas au point de la
 * rendre inutilisable.
 *
 * @param {any[][]} rows
 * @returns {Stats}
 */
export function stats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length) {
    const hit = _statsCache.get(list);
    if (hit) return hit;
  }

  let total = 0, inc = 0, outg = 0, missed = 0, answered = 0;
  let incAnswered = 0, totalDuration = 0;
  const peers = new Set();
  /** @type {number[]} */
  const durations = [];

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    total++;
    const seconds = Number(row[F.seconds]) || 0;
    const isAnswered = row[F.answered] === 1;
    totalDuration += seconds;
    if (isAnswered) { answered++; durations.push(seconds); }
    if (row[F.dir] === 0) {
      inc++;
      if (isAnswered) incAnswered++; else missed++;
    } else {
      outg++;
    }
    const peer = row[F.peer];
    if (peer) peers.add(peer);
  }

  const result = {
    total,
    in: inc,
    out: outg,
    missed,
    answered,
    answerRate: inc ? (incAnswered / inc) * 100 : 0,
    avgDuration: durations.length ? Math.round(sum(durations) / durations.length) : 0,
    medianDuration: median(durations),
    totalDuration,
    uniquePeers: peers.size,
  };

  if (list.length) _statsCache.set(list, result);
  return result;
}

/** @param {number[]} values */
function sum(values) {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s;
}

/** @param {number[]} values @returns {number} mediane arrondie, 0 si vide. */
function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// -----------------------------------------------------------------------------
//  Series temporelles
//
//  Les seaux sont des tableaux de compteurs [total, in, out, missed] et non des
//  objets : une agregation sur des milliers de lignes ne doit pas fabriquer un
//  objet par ligne. Les objets de sortie sont construits une seule fois, a la
//  fin, un par point de la serie.
// -----------------------------------------------------------------------------

const T = 0, IN = 1, OUT = 2, MISSED = 3;

/**
 * @param {any[][]} rows
 * @param {(row: any[]) => string} keyOf
 * @returns {Map<string, number[]>}
 */
function bucketBy(rows, keyOf) {
  /** @type {Map<string, number[]>} */
  const buckets = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = keyOf(row);
    if (!key) continue;
    let b = buckets.get(key);
    if (!b) { b = [0, 0, 0, 0]; buckets.set(key, b); }
    b[T]++;
    if (row[F.dir] === 0) {
      b[IN]++;
      if (row[F.answered] === 0) b[MISSED]++;
    } else {
      b[OUT]++;
    }
  }
  return buckets;
}

/** Point de serie a partir d'un seau, ou d'un trou (seau absent). */
function pointOf(label, bucket) {
  return bucket
    ? { label, value: bucket[T], in: bucket[IN], out: bucket[OUT], missed: bucket[MISSED] }
    : { label, value: 0, in: 0, out: 0, missed: 0 };
}

/**
 * Plage `YYYY-MM-DD` a couvrir par une serie continue : celle demandee, sinon
 * l'etendue reelle des lignes.
 * @param {any[][]} rows
 * @param {{from?: string, to?: string}} [range]
 * @returns {{from: string, to: string}|null}
 */
function seriesRange(rows, range) {
  let from = range && isIsoDate(range.from) ? String(range.from) : '';
  let to = range && isIsoDate(range.to) ? String(range.to) : '';

  if (!from || !to) {
    let min = '', max = '';
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i][F.date];
      if (!d) continue;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    }
    if (!from) from = min;
    if (!to) to = max;
  }

  if (!from || !to || from > to) return null;
  if (daysBetween(from, to) > MAX_SERIES_DAYS) from = shiftIso(to, -MAX_SERIES_DAYS);
  return { from, to };
}

/**
 * Serie journaliere CONTINUE : chaque jour de la plage produit un point, meme
 * sans appel. Sans cela un graphique de tendance relie deux jours distants et
 * masque les creux — il mentirait.
 *
 * @param {any[][]} rows
 * @param {{from?: string, to?: string}} [range] plage forcee (defaut : etendue des lignes).
 * @returns {Array<{label: string, value: number, in: number, out: number, missed: number}>}
 *          `label` = `YYYY-MM-DD`.
 */
export function byDay(rows, range) {
  const list = Array.isArray(rows) ? rows : [];
  const span = seriesRange(list, range);
  if (!span) return [];

  const buckets = bucketBy(list, dateKey);
  const out = [];
  let day = span.from;
  // Borne dure : la plage est deja limitee par seriesRange, la garde protege
  // seulement d'une date malformee qui empecherait la sortie de boucle.
  for (let guard = 0; guard <= MAX_SERIES_DAYS + 1; guard++) {
    out.push(pointOf(day, buckets.get(day)));
    if (day >= span.to) break;
    const next = nextDay(day);
    if (!next || next <= day) break;
    day = next;
  }
  return out;
}

/**
 * Serie mensuelle CONTINUE, meme raison que `byDay`. Les mois sont enumeres par
 * `monthSlices` (qui les rend du plus recent au plus ancien) et remis dans
 * l'ordre chronologique.
 *
 * @param {any[][]} rows
 * @param {{from?: string, to?: string}} [range]
 * @returns {Array<{label: string, value: number, in: number, out: number, missed: number}>}
 *          `label` = `YYYY-MM`.
 */
export function byMonth(rows, range) {
  const list = Array.isArray(rows) ? rows : [];
  const span = seriesRange(list, range);
  if (!span) return [];

  const buckets = bucketBy(list, monthKey);
  const months = monthSlices(span.from, span.to).map((s) => s.month).reverse();
  return months.map((ym) => pointOf(ym, buckets.get(ym)));
}

/** @param {any[]} row */
function dateKey(row) { return row[F.date]; }
/** @param {any[]} row */
function monthKey(row) { const d = row[F.date]; return d ? String(d).slice(0, 7) : ''; }

/** @param {string} iso @returns {string} lundi de la semaine de `iso`. */
function mondayOf(iso) {
  return shiftIso(iso, -weekdayOfIso(iso));
}

/**
 * Jour de semaine d'une date `YYYY-MM-DD`, 0 = lundi.
 *
 * Le champ `date` d'une ligne est DEJA en heure locale du fuseau d'affichage
 * (shared/cdr.js l'a calcule a la collecte) : il n'y a donc aucun fuseau a
 * reappliquer ici, seulement de l'arithmetique calendaire. Le resultat est mis
 * en cache car un rendu peut interroger les 92 memes dates plusieurs fois.
 * @param {string} iso
 * @returns {number}
 */
const _weekdayCache = new Map();
function weekdayOfIso(iso) {
  let w = _weekdayCache.get(iso);
  if (w === undefined) {
    const t = Date.parse(`${iso}T12:00:00Z`);
    w = Number.isFinite(t) ? (new Date(t).getUTCDay() + 6) % 7 : 0;
    if (_weekdayCache.size > 4096) _weekdayCache.clear();     // borne memoire
    _weekdayCache.set(iso, w);
  }
  return w;
}

/**
 * Repartition par heure locale.
 * @param {any[][]} rows
 * @returns {number[]} 24 entrees, index = heure.
 */
export function byHour(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = new Array(24).fill(0);
  for (let i = 0; i < list.length; i++) {
    const h = Number(list[i][F.hour]);
    if (h >= 0 && h < 24) out[h]++;
  }
  return out;
}

/**
 * Repartition par jour de semaine.
 * @param {any[][]} rows
 * @returns {number[]} 7 entrees, index 0 = lundi.
 */
export function byWeekday(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = new Array(7).fill(0);
  for (let i = 0; i < list.length; i++) {
    const d = list[i][F.date];
    if (d) out[weekdayOfIso(d)]++;
  }
  return out;
}

/**
 * Matrice jour de semaine x heure, pour la carte de chaleur.
 * @param {any[][]} rows
 * @returns {number[][]} 7 lignes (0 = lundi) de 24 colonnes.
 */
export function heatMatrix(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const m = new Array(7);
  for (let d = 0; d < 7; d++) m[d] = new Array(24).fill(0);
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const date = row[F.date];
    const h = Number(row[F.hour]);
    if (!date || !(h >= 0 && h < 24)) continue;
    m[weekdayOfIso(date)][h]++;
  }
  return m;
}

/**
 * Tendance a la granularite demandee.
 * @param {any[][]} rows
 * @param {'day'|'week'|'month'} [unit] defaut : `state.granularity`.
 * @returns {Array<{label: string, value: number}>}
 *          `label` : `YYYY-MM-DD` (jour), lundi de la semaine (semaine), `YYYY-MM` (mois).
 */
export function trend(rows, unit) {
  const list = Array.isArray(rows) ? rows : [];
  const u = GRANULARITIES.indexOf(String(unit)) >= 0 ? String(unit) : state.granularity;

  if (u === 'month') return byMonth(list).map(flatten);
  if (u === 'day') return byDay(list).map(flatten);

  // Semaine : seaux cales sur le lundi, serie continue de sept jours en sept
  // jours pour qu'une semaine creuse apparaisse a zero.
  const span = seriesRange(list, null);
  if (!span) return [];
  const buckets = bucketBy(list, weekKeyOf);
  const out = [];
  const lastMonday = mondayOf(span.to);
  const maxWeeks = Math.ceil(MAX_SERIES_DAYS / 7) + 2;
  let week = mondayOf(span.from);
  for (let guard = 0; guard <= maxWeeks; guard++) {
    const b = buckets.get(week);
    out.push({ label: week, value: b ? b[T] : 0 });
    if (week >= lastMonday) break;
    const next = shiftIso(week, 7);
    if (!next || next <= week) break;
    week = next;
  }
  return out;
}

/** @param {{label: string, value: number}} p */
function flatten(p) { return { label: p.label, value: p.value }; }

/** @param {any[]} row */
function weekKeyOf(row) { const d = row[F.date]; return d ? mondayOf(d) : ''; }

// -----------------------------------------------------------------------------
//  Agregations par ligne et par correspondant
// -----------------------------------------------------------------------------

/**
 * @typedef {object} LineStats
 * @property {string} csi
 * @property {string} label       Libelle pret a afficher (prenom si connu).
 * @property {any} person         Identite resolue, ou `null`.
 * @property {number} total
 * @property {number} in
 * @property {number} out
 * @property {number} missed
 * @property {number} answered
 * @property {number} answerRate  Taux de reponse des entrants, 0 a 100.
 * @property {number} seconds
 */

/**
 * Activite par ligne Keyyo, la plus chargee d'abord.
 * @param {any[][]} rows
 * @returns {LineStats[]}
 */
export function byLine(rows) {
  const list = Array.isArray(rows) ? rows : [];
  /** @type {Map<string, any>} */
  const acc = new Map();

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const csi = String(row[F.csi] || '');
    if (!csi) continue;
    let e = acc.get(csi);
    if (!e) {
      const line = lineByCsi(csi);
      e = {
        csi,
        label: line ? line.label : formatNumber(csi),
        person: line ? line.person || null : null,
        total: 0, in: 0, out: 0, missed: 0, answered: 0, answerRate: 0, seconds: 0,
        _incAnswered: 0,
      };
      acc.set(csi, e);
    }
    e.total++;
    e.seconds += Number(row[F.seconds]) || 0;
    const isAnswered = row[F.answered] === 1;
    if (isAnswered) e.answered++;
    if (row[F.dir] === 0) {
      e.in++;
      if (isAnswered) e._incAnswered++; else e.missed++;
    } else {
      e.out++;
    }
  }

  const out = [];
  for (const e of acc.values()) {
    e.answerRate = e.in ? (e._incAnswered / e.in) * 100 : 0;
    delete e._incAnswered;
    out.push(e);
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

/**
 * @typedef {object} PeerStats
 * @property {string} number   Correspondant en E.164 (`anonymous` si masque).
 * @property {string} label    Nom si connu, sinon numero formate.
 * @property {string|null} name
 * @property {number} total
 * @property {number} in
 * @property {number} out
 * @property {number} missed
 * @property {number} answered
 * @property {number} seconds
 * @property {string} lastDate `YYYY-MM-DD` du dernier contact.
 * @property {number} lastTs   Horodatage Unix du dernier contact.
 */

/**
 * Activite par correspondant, le plus appele d'abord. Les appelants masques
 * sont conserves sous la cle `anonymous` : ils forment une entree unique, qui
 * dit quelque chose sur le volume d'appels non identifiables.
 * @param {any[][]} rows
 * @returns {PeerStats[]}
 */
export function byPeer(rows) {
  const list = Array.isArray(rows) ? rows : [];
  /** @type {Map<string, PeerStats>} */
  const acc = new Map();

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const peer = row[F.peer];
    if (!peer) continue;
    let e = acc.get(peer);
    if (!e) {
      e = {
        number: peer, label: '', name: null,
        total: 0, in: 0, out: 0, missed: 0, answered: 0, seconds: 0,
        lastDate: '', lastTs: 0,
      };
      acc.set(peer, e);
    }
    e.total++;
    e.seconds += Number(row[F.seconds]) || 0;
    const isAnswered = row[F.answered] === 1;
    if (isAnswered) e.answered++;
    if (row[F.dir] === 0) {
      e.in++;
      if (!isAnswered) e.missed++;
    } else {
      e.out++;
    }
    const ts = Number(row[F.ts]) || 0;
    if (ts >= e.lastTs) { e.lastTs = ts; e.lastDate = row[F.date] || ''; }
  }

  const out = [];
  for (const e of acc.values()) {
    // Resolution du nom une seule fois par correspondant, jamais par ligne.
    e.name = nameOf(e.number);
    e.label = e.name || formatNumber(e.number);
    out.push(e);
  }
  out.sort((a, b) => (b.total - a.total) || (b.lastTs - a.lastTs));
  return out;
}

// -----------------------------------------------------------------------------
//  Rappels — la valeur metier centrale de l'outil
// -----------------------------------------------------------------------------

/**
 * @typedef {object} CallbackEntry
 * @property {string} number    Correspondant en E.164.
 * @property {string} label     Nom si connu, sinon numero formate.
 * @property {number} count     Nombre d'appels manques concernes.
 * @property {number} lastTs    Dernier manque du groupe, horodatage Unix.
 * @property {string} lastDate  `YYYY-MM-DD` de ce manque.
 * @property {number} lastHour
 * @property {number} lastMinute
 * @property {string} csi       Ligne Keyyo qui a recu ce dernier manque.
 * @property {number|null} calledBackTs  Horodatage du rappel, si rappele.
 */

/**
 * Qui reste a rappeler.
 *
 * REGLE : un appel entrant manque est considere RAPPELE s'il existe, APRES lui
 * (horodatage strictement superieur), un appel SORTANT vers le MEME
 * correspondant. La comparaison se fait sur `peer`, deja normalise en E.164 par
 * shared/cdr.js — c'est ce qui permet de rapprocher un entrant vu en
 * `+33612345678` et un sortant compose en `06 12 34 56 78`.
 *
 * Le sortant peut partir de n'importe quelle ligne du parc : si un collegue a
 * rappele, l'affaire est traitee. C'est pourquoi on ne compare pas les CSI.
 *
 * On regroupe par correspondant, car c'est la personne qu'on rappelle, pas
 * l'appel : trois manques du meme numero forment UNE tache avec `count` = 3.
 * Le groupe est en attente tant que son DERNIER manque n'a pas ete rappele —
 * un rappel anterieur ne solde pas un manque survenu apres lui.
 *
 * Comparaison volontairement STRICTE (`>`) : un sortant a la seconde exacte du
 * manque est un appel concurrent, pas un rappel. Mieux vaut une tache affichee
 * en trop qu'un client qu'on croit rappele.
 *
 * Les appelants MASQUES sont exclus : on ne peut pas les rappeler, et ils se
 * confondraient tous en une seule entree `anonymous`.
 *
 * @param {any[][]} rows
 * @returns {{pending: CallbackEntry[], done: CallbackEntry[]}}
 */
export function callbackAnalysis(rows) {
  const list = Array.isArray(rows) ? rows : [];
  /** @type {Map<string, {missed: number[], outs: number[], last: any[]|null}>} */
  const groups = new Map();

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const peer = row[F.peer];
    if (!peer || peer === 'anonymous') continue;

    const incoming = row[F.dir] === 0;
    const answered = row[F.answered] === 1;
    if (incoming && answered) continue;              // ni un manque, ni un rappel

    let g = groups.get(peer);
    if (!g) { g = { missed: [], outs: [], last: null }; groups.set(peer, g); }

    const ts = Number(row[F.ts]) || 0;
    if (incoming) {
      g.missed.push(ts);
      if (!g.last || ts > (Number(g.last[F.ts]) || 0)) g.last = row;
    } else {
      g.outs.push(ts);
    }
  }

  /** @type {CallbackEntry[]} */
  const pending = [];
  /** @type {CallbackEntry[]} */
  const done = [];

  for (const [peer, g] of groups) {
    if (!g.missed.length || !g.last) continue;       // que des sortants : rien a rappeler

    const missed = g.missed.sort((a, b) => a - b);
    const outs = g.outs.sort((a, b) => a - b);
    const lastMissedTs = missed[missed.length - 1];

    // Premier sortant strictement posterieur au dernier manque.
    let calledBackTs = null;
    for (let i = 0; i < outs.length; i++) {
      if (outs[i] > lastMissedTs) { calledBackTs = outs[i]; break; }
    }

    const row = g.last;
    const entry = {
      number: peer,
      label: labelOf(peer),
      count: 0,
      lastTs: Number(row[F.ts]) || 0,
      lastDate: row[F.date] || '',
      lastHour: Number(row[F.hour]) || 0,
      lastMinute: Number(row[F.minute]) || 0,
      csi: String(row[F.csi] || ''),
      calledBackTs,
    };

    if (calledBackTs != null) {
      entry.count = missed.length;                   // tous les manques sont soldes
      done.push(entry);
    } else {
      // Aucun sortant apres le dernier manque : les manques encore en attente
      // sont ceux qu'aucun sortant ne suit, donc ceux posterieurs au dernier
      // sortant connu.
      const lastOutTs = outs.length ? outs[outs.length - 1] : -1;
      let n = 0;
      for (let i = missed.length - 1; i >= 0; i--) {
        if (missed[i] >= lastOutTs) n++; else break;  // tableau trie : on peut sortir
      }
      entry.count = n;
      pending.push(entry);
    }
  }

  pending.sort((a, b) => b.lastTs - a.lastTs);
  done.sort((a, b) => (b.calledBackTs || 0) - (a.calledBackTs || 0));
  return { pending, done };
}

// -----------------------------------------------------------------------------
//  Chargement
// -----------------------------------------------------------------------------

/**
 * Charge appels, equipe et annuaire.
 *
 * Les trois requetes partent EN PARALLELE, mais leurs echecs ne pesent pas le
 * meme poids : l'affichage des appels ne doit pas dependre de l'annuaire. Si
 * `getTeam` ou `getDirectory` echoue, on garde les identites precedentes et on
 * le signale par un avertissement. Si `getCalls` echoue, les donnees
 * precedentes restent affichees et le statut passe en erreur — jamais un
 * tableau vide silencieux.
 *
 * @param {{force?: boolean, full?: boolean}} [opts]
 * @returns {Promise<void>}
 */
export async function load(opts) {
  // Le sondage de main.js tombe parfois pendant un chargement encore en cours :
  // on rend la promesse en vol plutot que de doubler le trafic.
  if (_inflight) return _inflight;

  const options = opts || {};
  // Un rechargement de fond (sondage de main.js) ne doit pas repasser
  // l'interface en « chargement » : les donnees affichees restent valables.
  if (_rows.length === 0) { _kind = 'loading'; notify(); }

  _inflight = (async () => {
    const [callsRes, teamRes, dirRes] = await Promise.allSettled([
      getCalls({ force: !!options.force, full: !!options.full }),
      getTeam(),
      getDirectory(),
    ]);

    /** @type {string[]} */
    const warnings = [];

    // -- Appels : source critique. ------------------------------------------
    let callsPayload = null;
    if (callsRes.status === 'fulfilled' && callsRes.value && typeof callsRes.value === 'object') {
      callsPayload = callsRes.value;
    } else {
      const err = callsRes.status === 'rejected' ? callsRes.reason : new Error('reponse /api/calls illisible');
      _kind = 'error';
      _warning = `Collecte des appels indisponible : ${messageOf(err)}. Les données affichées peuvent être plus anciennes ; réessayez avec le bouton Rafraîchir, puis consultez la page Diagnostic.`;
      _at = _at || nowIso();
      console.error('[store] /api/calls a echoue :', err);
      notify();
      return;
    }

    // -- Equipe : identites des lignes. Tolere. -----------------------------
    let teamPayload = null;
    if (teamRes.status === 'fulfilled' && teamRes.value && typeof teamRes.value === 'object') {
      teamPayload = teamRes.value;
    } else if (teamRes.status === 'rejected') {
      warnings.push(`identités des lignes indisponibles (${messageOf(teamRes.reason)})`);
      console.warn('[store] /api/team a echoue, on garde les identites precedentes :', teamRes.reason);
    }

    // -- Annuaire : noms des correspondants. Tolere. ------------------------
    let dirPayload = null;
    if (dirRes.status === 'fulfilled' && dirRes.value && typeof dirRes.value === 'object') {
      dirPayload = dirRes.value;
    } else if (dirRes.status === 'rejected') {
      warnings.push(`annuaire indisponible (${messageOf(dirRes.reason)})`);
      console.warn('[store] /api/directory a echoue, on garde l\'annuaire precedent :', dirRes.reason);
    }

    applyCalls(callsPayload, warnings);
    applyLines(callsPayload, teamPayload);
    if (dirPayload) applyDirectory(dirPayload);
    // L'annuaire indexe aussi les lignes du parc : un collegue appele en
    // interne s'affiche par son prenom, pas par son numero.
    indexOwnLines();

    // `diag` est libre : la page Diagnostic y trouve tout ce qui explique
    // l'etat courant, y compris les mois deja collectes et les sources qui
    // n'ont pas repondu.
    _diag = {
      calls: callsPayload.diag || null,
      coverage: _coverage,
      team: teamPayload ? { sources: teamPayload.sources || null, unresolved: teamPayload.unresolved || [], suggestion: teamPayload.suggestion || '' } : null,
      directory: dirPayload ? { count: Number(dirPayload.count) || _names.size, sources: dirPayload.sources || null } : null,
      partial: warnings.slice(),
    };

    syncPeriod();

    // -- Statut -------------------------------------------------------------
    const apiWarning = typeof callsPayload.warning === 'string' ? callsPayload.warning : '';
    const isEmpty = _rows.length === 0;
    _warning = [apiWarning, warnings.length ? `Collecte partielle : ${warnings.join(' ; ')}.` : '']
      .filter(Boolean).join(' ');
    _kind = (isEmpty || apiWarning || warnings.length) ? 'warn' : 'ok';
    if (isEmpty && !_warning) {
      _warning = 'Aucun appel sur la période collectée. Vérifiez la page Diagnostic : jeton, périmètre de lecture et lignes détectées.';
    }
    _at = typeof callsPayload.updatedAt === 'string' && callsPayload.updatedAt ? callsPayload.updatedAt : nowIso();

    _dataVersion++;
    notify();
  })().finally(() => { _inflight = null; });

  return _inflight;
}

/** @returns {{kind: string, at: string, warning: string, empty: boolean, store: any, diag: any, meta: any}} */
export function status() {
  return {
    kind: _kind,
    at: _at,
    warning: _warning,
    empty: _rows.length === 0,
    store: _store,
    diag: _diag,
    meta: _meta,
  };
}

// -----------------------------------------------------------------------------
//  Application d'une reponse
// -----------------------------------------------------------------------------

/**
 * @param {any} payload reponse de `GET /api/calls`
 * @param {string[]} warnings collecteur d'avertissements
 */
function applyCalls(payload, warnings) {
  // Le format positionnel n'a de sens que si les deux bouts s'accordent sur
  // l'ordre des colonnes. Une divergence lirait `seconds` a la place de `dir`,
  // avec des chiffres faux et credibles : c'est le pire des cas, on le dit.
  if (!fieldsMatch(payload.fields)) {
    warnings.push('le format des colonnes renvoyé par l\'API ne correspond pas à celui du navigateur (rechargez la page ; si cela persiste, redéployez)');
  }

  const raw = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = [];
  let dropped = 0;
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    // Verification minimale : une ligne mal formee ne doit pas casser un rendu.
    if (Array.isArray(row) && typeof row[F.date] === 'string' && row[F.date]
      && (row[F.dir] === 0 || row[F.dir] === 1)) {
      rows.push(row);
    } else {
      dropped++;
    }
  }
  if (dropped) {
    warnings.push(`${dropped} enregistrement(s) mal formés ignorés`);
    console.warn(`[store] ${dropped} lignes rejetees a la lecture de /api/calls`);
  }

  _rows = rows;
  _meta = normalizeMeta(payload.meta, rows);
  _coverage = payload.coverage && typeof payload.coverage === 'object' ? payload.coverage : {};
  _store = payload.store && typeof payload.store === 'object' ? payload.store : null;
}

/**
 * Verifie que l'ordre des colonnes annonce par l'API correspond a `F`.
 * @param {unknown} fields
 * @returns {boolean}
 */
function fieldsMatch(fields) {
  if (!Array.isArray(fields) || !fields.length) return true;   // rien a verifier
  for (const name of Object.keys(F)) {
    if (fields[F[name]] !== name) return false;
  }
  return true;
}

/**
 * `meta` recalculee depuis les lignes quand l'API ne la fournit pas : les
 * bornes de periode en dependent.
 * @param {any} meta
 * @param {any[][]} rows
 */
function normalizeMeta(meta, rows) {
  const src = meta && typeof meta === 'object' ? meta : {};
  const out = emptyMeta();
  out.n = Number(src.n) >= 0 ? Number(src.n) : rows.length;
  out.min = isIsoDate(src.min) ? String(src.min) : '';
  out.max = isIsoDate(src.max) ? String(src.max) : '';
  out.months = Array.isArray(src.months) ? src.months.map(String) : [];
  out.csis = Array.isArray(src.csis) ? src.csis.map(String) : [];

  if (!out.min || !out.max || !out.csis.length) {
    let min = '', max = '';
    const csis = new Set(out.csis);
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i][F.date];
      if (d) {
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      }
      const csi = rows[i][F.csi];
      if (csi) csis.add(String(csi));
    }
    if (!out.min) out.min = min;
    if (!out.max) out.max = max;
    out.csis = Array.from(csis);
  }

  out.days = Number(src.days) > 0
    ? Math.floor(Number(src.days))
    : (out.min && out.max ? daysBetween(out.min, out.max) + 1 : 0);
  return out;
}

/**
 * Fusionne les lignes Keyyo des deux sources et les enrichit.
 * `/api/team` est prioritaire : c'est lui qui porte le rapprochement
 * ligne -> personne (source, confiance, indice) resolu cote serveur.
 * @param {any} callsPayload
 * @param {any} teamPayload
 */
function applyLines(callsPayload, teamPayload) {
  /** @type {Map<string, any>} */
  const merged = new Map();

  const fromCalls = Array.isArray(callsPayload && callsPayload.lines) ? callsPayload.lines : [];
  const fromTeam = teamPayload && Array.isArray(teamPayload.lines) ? teamPayload.lines : null;

  for (let i = 0; i < fromCalls.length; i++) {
    const line = fromCalls[i];
    if (!line || typeof line !== 'object') continue;
    const key = digitsOf(line.csi) || String(line.csi || '');
    if (key) merged.set(key, { ...line });
  }
  if (fromTeam) {
    for (let i = 0; i < fromTeam.length; i++) {
      const line = fromTeam[i];
      if (!line || typeof line !== 'object') continue;
      const key = digitsOf(line.csi) || String(line.csi || '');
      if (!key) continue;
      merged.set(key, { ...(merged.get(key) || {}), ...line });
    }
  } else if (!merged.size && _lines.length) {
    // Aucune des deux sources n'a repondu : on conserve ce qu'on savait deja.
    return;
  }

  // Une ligne qui apparait dans les appels sans figurer dans le parc doit
  // rester selectionnable : on cree une entree minimale plutot que de la taire.
  for (let i = 0; i < _meta.csis.length; i++) {
    const key = digitsOf(_meta.csis[i]) || String(_meta.csis[i]);
    if (key && !merged.has(key)) merged.set(key, { csi: String(_meta.csis[i]), person: null, candidates: [] });
  }

  const lines = [];
  const index = new Map();
  for (const line of merged.values()) {
    const label = lineLabel(line);
    const enriched = {
      ...line,
      person: line.person || null,
      label,
      initials: initialsOf(label),
      e164: toE164(line.csi || line.formattedCsi || ''),
    };
    lines.push(enriched);
    for (const key of [String(line.csi || ''), digitsOf(line.csi), String(line.formattedCsi || ''), digitsOf(line.formattedCsi), enriched.e164]) {
      if (key && !index.has(key)) index.set(key, enriched);
    }
  }

  lines.sort((a, b) => String(a.label).localeCompare(String(b.label), 'fr'));
  _lines = lines;
  _lineIndex = index;

  // Une ligne filtree qui a disparu du parc bloquerait l'affichage sur un
  // ecran vide sans expliquer pourquoi : on relache le filtre.
  if (state.csi && !lineByCsi(state.csi)) state.csi = '';
}

/**
 * Indexe l'annuaire renvoye par `/api/directory` (`{ "+33…": "Nom" }`).
 * @param {any} payload
 */
function applyDirectory(payload) {
  const map = payload.map && typeof payload.map === 'object' ? payload.map : null;
  if (!map) return;
  const names = new Map();
  for (const key of Object.keys(map)) {
    const value = map[key];
    if (value == null || value === '') continue;
    const e164 = toE164(key);
    if (!e164 || e164 === 'anonymous') continue;
    if (!names.has(e164)) names.set(e164, String(value));
  }
  _names = names;
}

/**
 * Ajoute les lignes du parc a l'index des noms, en seconde priorite : un nom
 * d'annuaire l'emporte toujours sur un libelle de ligne.
 */
function indexOwnLines() {
  for (let i = 0; i < _lines.length; i++) {
    const line = _lines[i];
    const label = line.label;
    if (!label || label === '—') continue;
    for (const key of [line.e164, toE164(line.formattedCsi), toE164(line.presentedNumber), line.shortNumber ? digitsOf(line.shortNumber) : '']) {
      if (key && key !== 'anonymous' && !_names.has(key)) _names.set(key, label);
    }
  }
}

/** @param {unknown} err @returns {string} message d'erreur exploitable. */
function messageOf(err) {
  if (!err) return 'cause inconnue';
  // ApiError porte le code HTTP : le dire evite le classique « echec du
  // chargement » qui n'aide personne a diagnostiquer.
  const anyErr = /** @type {any} */ (err);
  if (anyErr.status) return `HTTP ${anyErr.status} — ${anyErr.message || 'erreur'}`;
  return String(anyErr.message || anyErr);
}

/** @returns {string} horodatage ISO du moment. */
function nowIso() {
  return new Date().toISOString();
}
