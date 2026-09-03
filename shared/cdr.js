// =============================================================================
//  shared/cdr.js — Normalisation d'un CallDetailRecord Keyyo. FONCTIONS PURES.
//
//  Champs du type CallDetailRecord (doc Manager API 1.0) :
//    call_id, start_time (Unix), caller, caller_raw, caller_presentation,
//    caller_presentation_raw, callee, callee_raw, quantity, quantity_billed,
//    destination_name, cost, repayment, unit, roaming, translation_number,
//    translation_number_raw
//
//  Observe en plus sur le compte reel (non documente, mais present) :
//    actual_caller — renseigne quand `caller` est nul sur un appel ENTRANT.
//
//  Ce que l'API ne donne PAS : aucun champ de duree nomme `duration`, aucun
//  indicateur de decroche. `quantity` avec `unit: "second"` EST la duree, et
//  le decroche s'en deduit (voir la note dans shared/schema.js).
// =============================================================================

import { toE164 } from './phone.js';
import { parseTimestamp, isPlausibleDate, localParts } from './time.js';
import { F, ROW_LENGTH } from './schema.js';

/**
 * Premiere valeur non vide parmi une liste de noms de champs.
 * @param {Record<string, any>|null|undefined} obj
 * @param {string[]} names
 * @returns {any}
 */
function pick(obj, names) {
  if (!obj) return undefined;
  for (const n of names) {
    const v = obj[n];
    if (v != null && v !== '') return v;
  }
  return undefined;
}

// Ordre de priorite : le champ documente d'abord, les replis ensuite.
const TS_FIELDS = ['start_time', 'date', 'datetime', 'date_start', 'timestamp'];
const CALLER_FIELDS = ['caller', 'actual_caller', 'caller_presentation', 'caller_raw', 'actual_caller_raw', 'caller_presentation_raw'];
const CALLEE_FIELDS = ['callee', 'callee_raw', 'called_number', 'translation_number'];
const QTY_FIELDS = ['quantity', 'quantity_billed'];

/**
 * Convertit un enregistrement brut Keyyo en ligne normalisee (cf. shared/schema.js).
 *
 * @param {Record<string, any>} raw   Enregistrement CallDetailRecord brut.
 * @param {object} ctx
 * @param {'in'|'out'} ctx.direction  Sens, connu par l'endpoint interroge.
 * @param {string} ctx.csi            CSI de la ligne interrogee.
 * @param {string} ctx.tz             Fuseau d'affichage.
 * @param {number} [ctx.now]          Horloge de reference (injectable pour les tests).
 * @param {(raw: any, reason: string) => void} [ctx.onDrop]  Notifie chaque rejet.
 * @returns {any[]|null}              Ligne normalisee, ou `null` si inexploitable.
 */
export function normalizeCdr(raw, ctx) {
  const drop = (reason) => { ctx.onDrop && ctx.onDrop(raw, reason); return null; };
  if (!raw || typeof raw !== 'object') return drop('enregistrement non-objet');

  const ts = parseTimestamp(pick(raw, TS_FIELDS));
  if (!isPlausibleDate(ts, ctx.now)) {
    return drop(ts ? 'horodatage hors plage plausible' : 'aucun horodatage exploitable');
  }

  const out = ctx.direction === 'out';

  // Sur un entrant, `caller` est souvent nul cote Keyyo : le vrai numero se
  // trouve dans `actual_caller` ou `caller_presentation` (verifie en prod).
  const caller = toE164(pick(raw, CALLER_FIELDS) ?? '');
  let callee = toE164(pick(raw, CALLEE_FIELDS) ?? '');

  // Sur un entrant, l'appele est la ligne elle-meme. Quand Keyyo ne le repete
  // pas dans l'enregistrement, on le reconstitue depuis le CSI interroge.
  if (!callee && !out) callee = toE164(ctx.csi);
  const callerFinal = (!caller && out) ? toE164(ctx.csi) : caller;

  const unit = String(pick(raw, ['unit']) ?? 'second');
  const qty = Number(pick(raw, QTY_FIELDS) ?? 0);
  // `quantity` n'est une duree que si l'unite est la seconde. Un releve SMS ou
  // data porte un compte d'unites : le convertir en secondes serait faux.
  const seconds = (unit === 'second' && Number.isFinite(qty) && qty > 0) ? Math.round(qty) : 0;

  const costRaw = pick(raw, ['cost']);
  const cost = costRaw == null || costRaw === '' ? null : (Number.isFinite(Number(costRaw)) ? Number(costRaw) : null);

  const p = localParts(/** @type {Date} */ (ts), ctx.tz);
  const dir = out ? 1 : 0;
  const peer = out ? callee : callerFinal;

  const row = new Array(ROW_LENGTH);
  row[F.id] = String(pick(raw, ['call_id']) ?? '');
  row[F.ts] = Math.floor(/** @type {Date} */ (ts).getTime() / 1000);
  row[F.date] = p.date;
  row[F.hour] = p.hour;
  row[F.minute] = p.minute;
  row[F.dir] = dir;
  row[F.caller] = callerFinal;
  row[F.callee] = callee;
  row[F.peer] = peer;
  row[F.seconds] = seconds;
  row[F.answered] = seconds > 0 ? 1 : 0;
  row[F.csi] = String(ctx.csi ?? '');
  row[F.unit] = unit;
  row[F.cost] = cost;
  row[F.destName] = String(pick(raw, ['destination_name']) ?? '');
  return row;
}

/**
 * Extrait la liste d'enregistrements d'une reponse HAL Keyyo.
 *
 * Forme observee : `{ _embedded: { CallDetailRecord: [ ... ] } }`. La fonction
 * accepte aussi un tableau nu, un `_embedded` deja aplati, et retombe en
 * dernier recours sur le premier tableau d'objets rencontre — afin qu'un
 * changement de nom de groupe cote Keyyo ne vide pas silencieusement le flux.
 *
 * @param {unknown} payload
 * @returns {any[]}
 */
export function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const p = /** @type {Record<string, any>} */ (payload);

  const emb = p._embedded;
  if (emb && typeof emb === 'object') {
    const out = [];
    // Cas nominal et cas imbrique d'un cran.
    for (const group of Object.values(emb)) {
      if (Array.isArray(group)) out.push(...group);
      else if (group && typeof group === 'object') {
        let nested = false;
        for (const v of Object.values(group)) {
          if (Array.isArray(v)) { out.push(...v); nested = true; }
        }
        if (!nested) out.push(group);
      }
    }
    if (out.length) return out;
  }

  for (const key of ['CallDetailRecord', 'call_detail', 'calls', 'items', 'records', 'data', 'results']) {
    if (Array.isArray(p[key])) return p[key];
  }
  for (const v of Object.values(p)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
}

/**
 * Lien de pagination suivant d'une reponse HAL, s'il existe.
 * @param {unknown} payload
 * @returns {string|null}
 */
export function nextLink(payload) {
  const href = /** @type {any} */ (payload)?._links?.next?.href;
  return typeof href === 'string' && href ? href : null;
}
