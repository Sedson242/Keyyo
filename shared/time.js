// =============================================================================
//  shared/time.js — Dates et fuseaux. FONCTIONS PURES.
//
//  Tout l'affichage est en heure locale du fuseau `tz` (Europe/Paris par
//  defaut) : c'est l'heure a laquelle l'appel a reellement sonne pour
//  l'utilisateur. Keyyo, lui, renvoie `start_time` en timestamp Unix (UTC).
//
//  Piege connu (rencontre en prod) : certains environnements exposent TZ au
//  format POSIX `:UTC`, avec deux-points en tete, qu'Intl refuse. `safeTz`
//  nettoie et valide, avec repli.
// =============================================================================

export const DEFAULT_TZ = 'Europe/Paris';

/**
 * Nettoie et valide un identifiant de fuseau.
 * @param {unknown} tz
 * @returns {string} fuseau IANA utilisable par Intl (jamais vide).
 */
export function safeTz(tz) {
  let z = String(tz == null ? '' : tz).replace(/^:/, '').trim();
  if (!z) z = DEFAULT_TZ;
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: z }); return z; } catch { /* invalide */ }
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: DEFAULT_TZ }); return DEFAULT_TZ; } catch { /* invalide */ }
  return 'UTC';
}

// Les formateurs Intl sont couteux a construire : on les met en cache par fuseau.
/** @type {Map<string, Intl.DateTimeFormat>} */
const _fmtCache = new Map();
function partsFormatter(tz) {
  let f = _fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    _fmtCache.set(tz, f);
  }
  return f;
}

/**
 * Accepte un timestamp Unix (secondes ou millisecondes, nombre ou chaine) ou
 * une chaine de date, et renvoie une Date. `null` si inexploitable.
 * @param {unknown} raw
 * @returns {Date|null}
 */
export function parseTimestamp(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();

  // Unix : Keyyo renvoie `start_time` en secondes, parfois sous forme de chaine.
  if (/^-?\d{9,}$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n > 1e12 ? n : n * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // ISO ou "YYYY-MM-DD HH:MM:SS"
  const d = new Date(s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Un horodatage est "plausible" s'il tombe entre 2000 et maintenant + 2 jours.
 * Sert a rejeter les valeurs qui ne sont pas des dates (identifiants, couts...).
 * @param {Date|null} d
 * @param {number} [now] horloge de reference, en ms (injectable pour les tests).
 * @returns {boolean}
 */
export function isPlausibleDate(d, now = Date.now()) {
  if (!d || Number.isNaN(d.getTime())) return false;
  const t = d.getTime();
  return t >= Date.UTC(2000, 0, 1) && t <= now + 2 * 864e5;
}

/**
 * Eclate une Date en composantes locales du fuseau donne.
 * @param {Date} date
 * @param {string} [tz]
 * @returns {{date: string, hour: number, minute: number, second: number, ym: string, weekday: number}}
 *          `date` = `YYYY-MM-DD`, `ym` = `YYYY-MM`, `weekday` : 0 = lundi ... 6 = dimanche.
 */
export function localParts(date, tz = DEFAULT_TZ) {
  const p = Object.fromEntries(
    partsFormatter(tz).formatToParts(date).map((x) => [x.type, x.value]),
  );
  const iso = `${p.year}-${p.month}-${p.day}`;
  // Jour de semaine calcule a midi UTC : immunise contre les decalages de fuseau.
  const jsDay = new Date(`${iso}T12:00:00Z`).getUTCDay();   // 0 = dimanche
  return {
    date: iso,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute) || 0,
    second: Number(p.second) || 0,
    ym: iso.slice(0, 7),
    weekday: (jsDay + 6) % 7,                              // 0 = lundi
  };
}

/**
 * Formate une Date au format attendu par les filtres Keyyo : `YYYY-MM-DD HH:MM`
 * (cf. doc `date_start` / `date_end` de `*_call_detail`).
 * @param {Date} date
 * @param {string} [tz]
 * @returns {string}
 */
export function toKeyyoDate(date, tz = DEFAULT_TZ) {
  const p = localParts(date, tz);
  return `${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * `YYYY-MM-DD` a partir d'un decalage en JOURS CALENDAIRES par rapport a `now`.
 * Un `days` negatif avance dans le futur.
 *
 * ARITHMETIQUE CALENDAIRE, PAS EN MILLISECONDES. Soustraire `days * 864e5`
 * puis relire la date murale melange deux echelles : les jours de bascule
 * d'heure font 23 h ou 25 h, et le calcul rate alors sa cible d'une heure —
 * donc d'un jour entier quand `now` tombe pres de minuit. On lit donc la date
 * murale UNE FOIS, puis on recule de jours entiers a l'ancrage midi UTC, ou
 * aucun changement d'heure ne peut faire basculer la date. Meme technique que
 * `nextDay`.
 * @param {number} days
 * @param {number} [now]
 * @param {string} [tz]
 * @returns {string}
 */
export function isoDaysAgo(days, now = Date.now(), tz = DEFAULT_TZ) {
  const base = localParts(new Date(now), tz).date;
  const d = new Date(`${base}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.round(Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

/** @returns {string} `YYYY-MM-DD` du jour, dans le fuseau donne. */
export function todayIso(now = Date.now(), tz = DEFAULT_TZ) {
  return localParts(new Date(now), tz).date;
}

/**
 * Decoupe une periode en tranches mensuelles, de la plus recente a la plus
 * ancienne. Chaque appel a Keyyo reste ainsi borne, ce qui evite de depasser
 * la duree maximale d'une fonction serverless sur une fenetre de 3 mois.
 * @param {string} fromIso `YYYY-MM-DD` inclus
 * @param {string} toIso   `YYYY-MM-DD` inclus
 * @returns {Array<{month: string, from: string, to: string}>}
 *          `to` est la borne EXCLUSIVE a passer a Keyyo (`date_end`).
 */
export function monthSlices(fromIso, toIso) {
  const out = [];
  if (!fromIso || !toIso || fromIso > toIso) return out;

  let [y, m] = fromIso.slice(0, 7).split('-').map(Number);
  const lastYm = toIso.slice(0, 7);

  while (true) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const monthStart = `${ym}-01`;
    // 1er du mois suivant = borne exclusive.
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const nextStart = `${ny}-${String(nm).padStart(2, '0')}-01`;

    out.push({
      month: ym,
      from: monthStart < fromIso ? fromIso : monthStart,
      to: nextStart > toIso ? nextDay(toIso) : nextStart,
    });

    if (ym >= lastYm) break;
    y = ny; m = nm;
    if (out.length > 240) break;                            // garde-fou (20 ans)
  }
  return out.reverse();                                     // le plus recent d'abord
}

/** @returns {string} lendemain de `YYYY-MM-DD`, en date calendaire pure. */
export function nextDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** @returns {number} nombre de jours entre deux dates `YYYY-MM-DD` (>= 0). */
export function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T12:00:00Z`);
  const b = Date.parse(`${toIso}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 864e5));
}
