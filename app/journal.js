// =============================================================================
//  app/journal.js — File d'envoi du journal d'attribution.
//
//  Les faits (appel compose, decroche, declare pris, transfere, observe) sont
//  produits par app/cti.js au fil des evenements telephoniques. Ce module les
//  met en file et les envoie PAR LOTS a /api/events : une ecriture Blob par
//  evenement serait absurde, et un appel qui se termine produit deux ou trois
//  faits d'un coup.
//
//  Ce qui n'a pas pu partir reste en file, borne, et repart au prochain
//  passage ; a la fermeture de la page, un dernier envoi part en `keepalive`.
//  Le serveur deduplique par identifiant : envoyer deux fois n'est jamais un
//  probleme, perdre un fait en est un.
//
//  Si le serveur repond que le journal est indisponible (503, pas de store
//  Blob), la file s'arrete et le dit : inutile d'accumuler pour rien.
// =============================================================================

import { postEvents, getEvents, ApiError } from './api.js';

/** Delai entre la production d'un fait et son envoi, en millisecondes. */
const FLUSH_MS = 6000;

/** Taille de lot au-dela de laquelle on envoie sans attendre. */
const FLUSH_AT = 25;

/** Plafond de la file : au-dela, les plus anciens sont abandonnes (et dits). */
const MAX_QUEUE = 500;

/** Taille maximale d'un envoi, alignee sur le serveur. */
const MAX_BATCH = 200;

/** @type {any[]} */
let _queue = [];
let _timer = 0;
let _sending = false;
let _enabled = true;
let _lastError = '';
let _dropped = 0;
let _sent = 0;
let _lastSentAt = '';
/** @type {Array<() => void>} */
const _subs = [];

/** @param {() => void} fn @returns {() => void} */
export function subscribe(fn) {
  _subs.push(fn);
  return function () {
    const i = _subs.indexOf(fn);
    if (i >= 0) _subs.splice(i, 1);
  };
}

function notify() {
  for (const fn of _subs.slice()) {
    try { fn(); } catch (err) { console.error('[journal] abonne en echec :', err); }
  }
}

/**
 * Enregistre un fait. `ts` est pose maintenant s'il manque. Le fait part au
 * prochain envoi ; rien n'est attendu.
 * @param {any} event
 */
export function record(event) {
  if (!event || typeof event !== 'object' || !event.type) return;
  if (!_enabled) return;
  const e = Object.assign({ ts: Math.floor(Date.now() / 1000) }, event);
  _queue.push(e);
  if (_queue.length > MAX_QUEUE) {
    _dropped += _queue.length - MAX_QUEUE;
    _queue = _queue.slice(_queue.length - MAX_QUEUE);
  }
  if (_queue.length >= FLUSH_AT) flush();
  else schedule();
  notify();
}

function schedule() {
  if (_timer) return;
  _timer = window.setTimeout(function () { _timer = 0; flush(); }, FLUSH_MS);
}

/**
 * Envoie ce qui attend. Un seul envoi a la fois ; ce qui n'est pas parti
 * reste en tete de file.
 * @param {{final?: boolean}} [opts] `final` : la page se ferme, envoi en keepalive.
 * @returns {Promise<void>}
 */
export async function flush(opts) {
  const o = opts || {};
  if (_timer) { window.clearTimeout(_timer); _timer = 0; }
  if (!_enabled || _sending || !_queue.length) return;

  _sending = true;
  const batch = _queue.slice(0, MAX_BATCH);
  try {
    await postEvents(batch, { keepalive: !!o.final, timeoutMs: o.final ? 5000 : 20000 });
    _queue = _queue.slice(batch.length);
    _sent += batch.length;
    _lastSentAt = new Date().toISOString();
    _lastError = '';
  } catch (err) {
    _lastError = err && /** @type {any} */ (err).message ? String(/** @type {any} */ (err).message) : String(err);
    if (err instanceof ApiError && err.status === 503) {
      // Pas de store Blob : le journal n'existe pas sur ce deploiement.
      _enabled = false;
      _queue = [];
    } else if (err instanceof ApiError && (err.status === 400 || err.status === 413)) {
      // Le lot est refuse pour ce qu'il contient : le rejouer ne changera rien.
      _queue = _queue.slice(batch.length);
      _dropped += batch.length;
    }
    // Sinon (reseau, 5xx, 401) : on garde, on reessaiera.
  } finally {
    _sending = false;
  }
  if (_queue.length && _enabled) schedule();
  notify();
}

/** @returns {{pending: number, enabled: boolean, lastError: string, dropped: number, sent: number, lastSentAt: string}} */
export function status() {
  return { pending: _queue.length, enabled: _enabled, lastError: _lastError, dropped: _dropped, sent: _sent, lastSentAt: _lastSentAt };
}

/**
 * Relit le journal d'un mois.
 * @param {{month?: string, scope?: 'me'|'all'}} [opts]
 * @returns {Promise<any>} `{ month, scope, events, summary }`
 */
export function month(opts) {
  return getEvents(opts);
}

/**
 * Cable l'envoi de derniere minute. A appeler une fois par page.
 * `pagehide` est le seul evenement fiable a la fermeture d'un onglet ; le
 * `keepalive` laisse la requete partir apres que la page a disparu.
 */
export function init() {
  window.addEventListener('pagehide', function () { flush({ final: true }); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) flush({ final: true });
  });
}
