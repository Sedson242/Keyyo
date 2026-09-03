// =============================================================================
//  app/format.js — Mise en forme francaise. FONCTIONS PURES, ZERO DEPENDANCE.
//
//  Contrat de robustesse : AUCUNE fonction de ce module ne jette. Une entree
//  nulle, vide, non numerique ou hors plage renvoie le tiret cadratin (—), ou
//  une chaine vide quand un tiret n'aurait pas de sens. Une page ne doit jamais
//  s'effondrer parce que l'API a renvoye `null` dans une colonne.
//
//  Pourquoi midi UTC pour les dates ? Les dates calendaires manipulees par
//  l'application sont des chaines `YYYY-MM-DD` deja calculees dans le fuseau
//  d'affichage par shared/time.js. Les reconstruire avec `new Date('2026-09-03')`
//  donne minuit UTC, donc le 2 septembre a 21 h pour un navigateur en UTC-3 :
//  le jour affiche serait faux. On ancre donc a 12:00 UTC et on formate en UTC,
//  ce qui rend l'affichage independant du fuseau du poste client.
//
//  Seule exception : fmtClock et fmtRelative traitent des INSTANTS (horodatage
//  de derniere synchronisation, heure d'un appel) et s'affichent dans le fuseau
//  du navigateur, qui est celui de l'utilisateur devant l'ecran.
// =============================================================================

import { parseTimestamp } from '../shared/time.js';

/** Valeur affichee quand la donnee est absente ou inexploitable. */
const DASH = '—';

// Espace insecable. Ecrit en sequence d'echappement a dessein : un U+00A0
// litteral dans le source est invisible et se ferait aplatir en espace
// ordinaire au premier reformatage. C'est lui qui colle l'unite a son nombre.
const NBSP = '\u00A0';

/** Jours de la semaine, index 0 = lundi — meme convention que shared/time.js#localParts. */
export const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

// -----------------------------------------------------------------------------
//  Outils internes
// -----------------------------------------------------------------------------

/**
 * Convertit une entree en nombre fini. L'API Keyyo renvoie regulierement ses
 * nombres sous forme de chaines (`quantity`, `start_time`), d'ou la tolerance.
 * @param {unknown} v
 * @returns {number|null} `null` si ce n'est pas un nombre exploitable.
 */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** @returns {number|null} duree en secondes entieres, >= 0, ou `null`. */
function toSeconds(v) {
  const n = toNum(v);
  if (n == null || n < 0) return null;
  return Math.round(n);
}

/** @returns {string} nombre sur deux chiffres (`5` -> `05`). */
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// Les formateurs Intl sont couteux a construire : un par jeu d'options, en cache.
/** @type {Map<string, Intl.DateTimeFormat>} */
const _dateFmt = new Map();
function dtf(key, options) {
  let f = _dateFmt.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('fr-FR', options);
    _dateFmt.set(key, f);
  }
  return f;
}

/** @type {Map<number, Intl.NumberFormat>} */
const _numFmt = new Map();
function nf(maxDigits) {
  let f = _numFmt.get(maxDigits);
  if (!f) {
    f = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: maxDigits });
    _numFmt.set(maxDigits, f);
  }
  return f;
}

/**
 * Transforme une date calendaire en Date ancree a midi UTC (voir l'en-tete).
 * Accepte `YYYY-MM-DD`, `YYYY-MM` (jour 1) et `YYYY-MM-DDTHH:MM...` (partie date).
 * @param {unknown} iso
 * @returns {Date|null}
 */
function dayDate(iso) {
  if (iso == null) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(iso).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = m[3] === undefined ? 1 : Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const out = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  // Rejette les dates rebouclees (31 fevrier -> 3 mars) : c'est une saisie fausse.
  if (out.getUTCMonth() !== mo - 1 || out.getUTCDate() !== d) return null;
  return out;
}

/** @returns {string} `YYYY-MM-DD` d'une Date, lu dans le fuseau du navigateur. */
function localIso(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

// -----------------------------------------------------------------------------
//  Nombres
// -----------------------------------------------------------------------------

/**
 * Entier avec separateur de milliers francais : `12480` -> `12 480`.
 * @param {unknown} n
 * @returns {string} `—` si l'entree n'est pas un nombre.
 */
export function fmtInt(n) {
  const v = toNum(n);
  if (v == null) return DASH;
  return nf(0).format(Math.round(v));
}

/**
 * Pourcentage francais : virgule decimale et espace insecable avant le signe.
 * `fmtPct(63.888)` -> `63,89 %`, `fmtPct(100)` -> `100 %`.
 *
 * `n` est deja exprime en POURCENT (0 a 100), pas en proportion : c'est la
 * lecture litterale du contrat (`63,89 %`). Les decimales inutiles sont
 * supprimees pour ne pas afficher `100,00 %` dans un indicateur.
 * @param {unknown} n
 * @param {number} [digits] nombre maximal de decimales (0 a 4, defaut 2).
 * @returns {string}
 */
export function fmtPct(n, digits) {
  const v = toNum(n);
  if (v == null) return DASH;
  const d = toNum(digits);
  const max = d == null ? 2 : Math.min(4, Math.max(0, Math.trunc(d)));
  return nf(max).format(v) + NBSP + '%';
}

/**
 * Choisit le singulier ou le pluriel. Renvoie LE MOT SEUL, a composer avec le
 * nombre : `fmtInt(n) + ' ' + pluralize(n, 'appel', 'appels')`.
 * En francais, 0 et 1 prennent le singulier.
 * @param {unknown} n
 * @param {string} one
 * @param {string} [many] defaut : `one` suivi d'un `s`.
 * @returns {string}
 */
export function pluralize(n, one, many) {
  const singular = one == null ? '' : String(one);
  const plural = many == null ? (singular ? singular + 's' : '') : String(many);
  const v = toNum(n);
  if (v == null) return plural;
  return Math.abs(v) < 2 ? singular : plural;
}

// -----------------------------------------------------------------------------
//  Durees
// -----------------------------------------------------------------------------

/**
 * Duree lisible : `0 s`, `42 s`, `4 min 12 s`, `4 min`, `1 h 05`.
 * Au-dela d'une heure les secondes sont abandonnees : a cette echelle elles
 * n'apportent rien et allongent la colonne.
 * @param {unknown} seconds
 * @returns {string} `—` si la duree est absente ou negative.
 */
export function fmtDuration(seconds) {
  const t = toSeconds(seconds);
  if (t == null) return DASH;
  if (t === 0) return '0' + NBSP + 's';
  if (t < 60) return t + NBSP + 's';
  if (t < 3600) {
    const m = Math.floor(t / 60);
    const s = t % 60;
    return s === 0
      ? m + NBSP + 'min'
      : m + NBSP + 'min' + NBSP + pad2(s) + NBSP + 's';
  }
  const h = Math.floor(t / 3600);
  return h + NBSP + 'h' + NBSP + pad2(Math.floor((t % 3600) / 60));
}

/**
 * Duree compacte pour les cellules etroites : `0s`, `42s`, `4m12`, `1h05`.
 * @param {unknown} seconds
 * @returns {string} `—` si la duree est absente ou negative.
 */
export function fmtDurationShort(seconds) {
  const t = toSeconds(seconds);
  if (t == null) return DASH;
  if (t < 60) return t + 's';
  if (t < 3600) return Math.floor(t / 60) + 'm' + pad2(t % 60);
  return Math.floor(t / 3600) + 'h' + pad2(Math.floor((t % 3600) / 60));
}

/**
 * Duree cumulee, pour les totaux : `12 h 40`, `40 min`, `12 s`.
 * Contrairement a fmtDuration, on ne descend jamais a deux unites au-dessus
 * de la minute : un total de plusieurs heures se lit en heures et minutes.
 * @param {unknown} seconds
 * @returns {string} `—` si la duree est absente ou negative.
 */
export function fmtHms(seconds) {
  const t = toSeconds(seconds);
  if (t == null) return DASH;
  if (t >= 3600) {
    return Math.floor(t / 3600) + NBSP + 'h' + NBSP + pad2(Math.floor((t % 3600) / 60));
  }
  if (t >= 60) return Math.floor(t / 60) + NBSP + 'min';
  return t + NBSP + 's';
}

// -----------------------------------------------------------------------------
//  Dates calendaires (chaines `YYYY-MM-DD`)
// -----------------------------------------------------------------------------

/**
 * Date numerique : `2026-09-03` -> `03/09/2026`.
 * @param {unknown} iso
 * @returns {string} `—` si la date est absente ou invalide.
 */
export function fmtDate(iso) {
  const d = dayDate(iso);
  if (!d) return DASH;
  return dtf('date', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/**
 * Date en clair : `2026-09-03` -> `3 septembre 2026`.
 * @param {unknown} iso
 * @returns {string} `—` si la date est absente ou invalide.
 */
export function fmtDateLong(iso) {
  const d = dayDate(iso);
  if (!d) return DASH;
  return dtf('dateLong', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

/**
 * Jour abrege pour les axes de graphiques : `2026-09-03` -> `mer. 3 sept.`.
 * @param {unknown} iso
 * @returns {string} chaine VIDE si la date est invalide : un tiret sur un axe
 *          de graphique serait un repere trompeur.
 */
export function fmtDayShort(iso) {
  const d = dayDate(iso);
  if (!d) return '';
  return dtf('dayShort', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

/**
 * Mois abrege : `2026-09` -> `sept. 2026`. Accepte aussi `YYYY-MM-DD`.
 * @param {unknown} ym
 * @returns {string} chaine vide si le mois est invalide (usage en libelle d'axe).
 */
export function fmtMonth(ym) {
  const d = dayDate(ym);
  if (!d) return '';
  return dtf('month', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(d);
}

// -----------------------------------------------------------------------------
//  Heures
// -----------------------------------------------------------------------------

/**
 * Heure d'un appel a partir des colonnes `hour` et `minute` du schema :
 * `fmtTime(14, 5)` -> `14:05`. Aucune conversion de fuseau : ces deux valeurs
 * sont deja l'heure locale d'affichage (cf. shared/schema.js).
 * @param {unknown} hour   0 a 23
 * @param {unknown} minute 0 a 59 (defaut 0)
 * @returns {string} `—` hors plage.
 */
export function fmtTime(hour, minute) {
  const h = toNum(hour);
  if (h == null) return DASH;
  const m = toNum(minute);
  const hh = Math.trunc(h);
  const mm = m == null ? 0 : Math.trunc(m);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return DASH;
  return pad2(hh) + ':' + pad2(mm);
}

/**
 * Heure precise d'un INSTANT, dans le fuseau du navigateur : `14:05:31`.
 * Accepte une chaine ISO, un timestamp Unix (secondes ou millisecondes) ou une
 * Date — la tolerance vient de shared/time.js#parseTimestamp.
 * @param {unknown} isoDateTime
 * @returns {string} `—` si l'instant est inexploitable.
 */
export function fmtClock(isoDateTime) {
  const d = isoDateTime instanceof Date ? isoDateTime : parseTimestamp(isoDateTime);
  if (!d || Number.isNaN(d.getTime())) return DASH;
  return dtf('clock', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

/**
 * Anciennete d'un INSTANT, en francais : `à l'instant`, `il y a 4 min`,
 * `il y a 2 h`, `hier`, puis la date au-dela.
 *
 * Les seuils sont glissants (24 h, 48 h) et non calendaires : c'est le
 * comportement attendu d'un indicateur de fraicheur, et cela evite toute
 * arithmetique de fuseau. Un instant dans le futur (horloge serveur en avance)
 * est traite comme « a l'instant » plutot que comme une valeur negative.
 * @param {unknown} isoDateTime
 * @param {number} [now] horloge de reference en ms (injectable pour les tests).
 * @returns {string} `—` si l'instant est inexploitable.
 */
export function fmtRelative(isoDateTime, now) {
  const d = isoDateTime instanceof Date ? isoDateTime : parseTimestamp(isoDateTime);
  if (!d || Number.isNaN(d.getTime())) return DASH;
  const ref = toNum(now);
  const sec = Math.floor(((ref == null ? Date.now() : ref) - d.getTime()) / 1000);

  if (sec < 60) return "à l'instant";
  const min = Math.floor(sec / 60);
  if (min < 60) return 'il y a ' + min + NBSP + 'min';
  const hours = Math.floor(min / 60);
  if (hours < 24) return 'il y a ' + hours + NBSP + 'h';
  if (hours < 48) return 'hier';
  return fmtDate(localIso(d));
}
