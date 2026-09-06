// =============================================================================
//  app/cti.js — Pilotage de la ligne Keyyo depuis le navigateur.
//
//  Enveloppe la bibliotheque Keyyo CTI (vendor/keyyo-cti-1.1.js, versionnee et
//  servie depuis notre origine — la CSP interdit tout script tiers) derriere
//  une petite machine a etats et un instantane que l'interface repeint.
//
//  CE QUE CE MODULE FAIT, ET DANS QUEL ORDRE
//    1. demande un jeton CSI au serveur (POST /api/cti-token) — jamais les
//       identifiants Keyyo : ils ne quittent pas les fonctions ;
//    2. charge la bibliotheque a la demande, ouvre la session WebSocket ;
//    3. suit les appels de la ligne (SETUP -> CONNECT -> RELEASE / MISSED) et
//       les expose sous une forme prete a afficher, avec sonnerie et duree ;
//    4. execute les actions (appeler, decrocher, raccrocher, transferer) et
//       ECRIT CHAQUE FAIT dans le journal d'attribution (app/journal.js) — la
//       personne connectee est la seule raison pour laquelle on sait qui a
//       fait quoi ;
//    5. renouvelle le jeton avant son expiration et se reconnecte apres une
//       coupure, en restaurant la session cote Keyyo quand elle existe encore.
//
//  UNE LIGNE EST PARTAGEE. Sur ce compte, une ligne est portee par 7 a 24
//  terminaux Keyyo Phone. Tout ce que le CTI montre concerne LA LIGNE, pas la
//  personne : un appel entrant sonne pour toute l'equipe. Ce module ne devine
//  donc jamais qui a decroche au telephone ; il enregistre ce que la personne
//  FAIT ici (decrocher, appeler, transferer) et ce qu'elle DECLARE (« c'est
//  moi qui ai pris cet appel »). Le reste est « observe », sans nom.
//
//  ATTENTION, A VERIFIER EN CONDITIONS REELLES : appeler ou decrocher depuis
//  le CTI fait agir « le telephone de la ligne ». Avec plusieurs terminaux sur
//  la meme ligne, lequel decroche n'est pas documente par Keyyo. Le module
//  fait ce que l'API permet ; c'est un essai sur site qui dira si c'est le bon
//  poste qui sonne.
// =============================================================================

import { postCtiToken, ApiError } from './api.js';
import * as journal from './journal.js';
import { toE164 } from '../shared/phone.js';

/** Bibliotheque Keyyo CTI, servie par nous (voir vendor/README.md). */
const LIB_URL = '/vendor/keyyo-cti-1.1.js';

/** On renouvelle le jeton CSI ce laps de temps avant son expiration. */
const REFRESH_BEFORE_MS = 5 * 60 * 1000;

/** Delais de reconnexion apres coupure, en millisecondes, puis le dernier en boucle. */
const RECONNECT_MS = [2000, 5000, 10000, 20000, 30000];

/** Appels termines gardes a l'ecran, et duree de cette memoire. */
const RECENT_MAX = 6;
const RECENT_TTL_MS = 15 * 60 * 1000;

/** Delai d'une commande CTI sans reponse. */
const COMMAND_TIMEOUT_MS = 12000;

// -----------------------------------------------------------------------------
//  Etat
// -----------------------------------------------------------------------------

/**
 * @typedef {object} CallView
 * @property {string} callref
 * @property {'in'|'out'} dir
 * @property {string} peer        numero du correspondant, E.164 ou 'anonymous'
 * @property {string} caller
 * @property {string} callee
 * @property {'SETUP'|'CONNECT'|'RELEASE'|'MISSED'} state
 * @property {number} setupAt     secondes Unix (horloge Keyyo)
 * @property {number} connectAt
 * @property {number} releaseAt
 * @property {number} ring        secondes de sonnerie (figee des que connecte ou termine)
 * @property {number} duration    secondes de conversation
 * @property {boolean} answered
 * @property {boolean} mine       une action nominative a ete faite ici sur cet appel
 * @property {boolean} claimed
 * @property {number} seenAt      millisecondes locales de la derniere notification
 */

/** @type {{status: string, message: string, line: any, lines: any[], number: string, expiresAt: number, user: any, plugins: Array<{name: string, enabled: boolean}>, pluginsError: string, registrations: Array<{userAgent: string, ip: string}>, registrationsError: string}} */
let _state = { status: 'idle', message: '', line: null, lines: [], number: '', expiresAt: 0, user: null, plugins: [], pluginsError: '', registrations: [], registrationsError: '' };

/** Cle de la preference « decroche automatique de mon poste ». */
const AUTO_ANSWER_KEY = 'keyyo.cti.autoAnswer';

/**
 * Decroche automatique du poste de l'agent quand il appelle ou transfere.
 * C'est le comportement par defaut de Keyyo ; certains postes ne le savent
 * pas et Keyyo refuse alors l'action — d'ou un reglage, memorise sur le poste.
 * @returns {boolean}
 */
export function autoAnswer() {
  try { return localStorage.getItem(AUTO_ANSWER_KEY) !== '0'; } catch (err) { return true; }
}

/** @type {any} instance Keyyo.CTI */
let _cti = null;
let _token = '';
let _sessionId = '';
let _csiWanted = '';
/** @type {Map<string, CallView>} */
const _calls = new Map();
/** @type {Array<(snap: any) => void>} */
const _subs = [];
let _tick = 0;
let _refreshTimer = 0;
let _reconnectTimer = 0;
let _reconnectAttempt = 0;
let _stopped = false;
let _libPromise = /** @type {Promise<void>|null} */ (null);
let _skewSec = 0;

// -----------------------------------------------------------------------------
//  Abonnement et instantane
// -----------------------------------------------------------------------------

/**
 * @param {(snap: ReturnType<typeof snapshot>) => void} fn
 * @returns {() => void}
 */
export function subscribe(fn) {
  _subs.push(fn);
  return function () {
    const i = _subs.indexOf(fn);
    if (i >= 0) _subs.splice(i, 1);
  };
}

function emit() {
  const snap = snapshot();
  for (const fn of _subs.slice()) {
    try { fn(snap); } catch (err) { console.error('[cti] abonne en echec :', err); }
  }
}

/**
 * Instantane pret a afficher. Les appels actifs d'abord (sonnerie, puis en
 * cours), puis les termines recents, du plus recent au plus ancien.
 */
export function snapshot() {
  const now = nowKeyyo();
  const calls = [];
  for (const c of _calls.values()) {
    const view = Object.assign({}, c);
    if (c.state === 'SETUP') view.ring = Math.max(0, now - c.setupAt);
    else if (c.state === 'CONNECT') view.duration = Math.max(0, now - c.connectAt);
    calls.push(view);
  }
  const rank = { SETUP: 0, CONNECT: 1, RELEASE: 2, MISSED: 2 };
  calls.sort((a, b) => (rank[a.state] - rank[b.state]) || (b.seenAt - a.seenAt));
  return {
    status: _state.status,
    message: _state.message,
    line: _state.line,
    lines: _state.lines,
    number: _state.number,
    user: _state.user,
    expiresAt: _state.expiresAt,
    plugins: _state.plugins,
    pluginsError: _state.pluginsError,
    registrations: _state.registrations,
    registrationsError: _state.registrationsError,
    autoAnswer: autoAnswer(),
    connected: _state.status === 'connected',
    calls,
    active: calls.filter((c) => c.state === 'SETUP' || c.state === 'CONNECT').length,
  };
}

/** @param {string} status @param {string} [message] */
function setStatus(status, message) {
  _state.status = status;
  _state.message = message || '';
  emit();
}

/** @returns {number} secondes, sur l'horloge de Keyyo (corrigee du decalage local). */
function nowKeyyo() {
  return Math.floor(Date.now() / 1000) - _skewSec;
}

// -----------------------------------------------------------------------------
//  Chargement de la bibliotheque
// -----------------------------------------------------------------------------

/** @returns {Promise<void>} */
function loadLibrary() {
  if (window.Keyyo && window.Keyyo.CTI) return Promise.resolve();
  if (_libPromise) return _libPromise;
  _libPromise = new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = LIB_URL;
    s.async = true;
    s.onload = function () {
      if (window.Keyyo && window.Keyyo.CTI) resolve();
      else reject(new Error('La bibliothèque CTI s\'est chargée sans exposer Keyyo.CTI.'));
    };
    s.onerror = function () {
      _libPromise = null;
      reject(new Error('Impossible de charger ' + LIB_URL + '.'));
    };
    document.head.appendChild(s);
  });
  return _libPromise;
}

// -----------------------------------------------------------------------------
//  Cycle de vie
// -----------------------------------------------------------------------------

/**
 * Ouvre (ou rouvre) la session CTI. Idempotent : rappeler pendant une
 * connexion en cours ne fait rien.
 * @param {{csi?: string}} [opts] `csi` force la ligne (choix de l'utilisateur).
 * @returns {Promise<void>}
 */
export async function start(opts) {
  const o = opts || {};
  if (o.csi) _csiWanted = String(o.csi);
  if (_state.status === 'connecting' || _state.status === 'loading') return;
  _stopped = false;
  clearTimers();
  setStatus('loading', 'Ouverture de la ligne…');

  try {
    const grant = await postCtiToken({ csi: _csiWanted || undefined });
    _token = String(grant.token || '');
    _state.line = grant.line || null;
    _state.lines = Array.isArray(grant.lines) ? grant.lines : [];
    _state.number = String(grant.number || '').replace(/\D/g, '');
    _state.expiresAt = Date.parse(String(grant.expiresAt || '')) || (Date.now() + 3600000);
    _state.user = grant.user || null;
    _state.plugins = Array.isArray(grant.plugins) ? grant.plugins : [];
    _state.pluginsError = String(grant.pluginsError || '');
    _state.registrations = Array.isArray(grant.registrations) ? grant.registrations : [];
    _state.registrationsError = String(grant.registrationsError || '');
    if (!_token) throw new Error('Le serveur n\'a pas rendu de jeton CSI.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.body && Array.isArray(err.body.lines)) {
      _state.lines = err.body.lines;
      _state.line = null;
      setStatus('needs-line', String(err.body.hint || err.body.error || 'Choisir une ligne.'));
      return;
    }
    setStatus('error', messageOf(err));
    return;
  }

  try {
    await loadLibrary();
  } catch (err) {
    setStatus('error', messageOf(err));
    return;
  }

  connect(false);
}

/** Ferme la session et oublie tout. */
export function stop() {
  _stopped = true;
  clearTimers();
  if (_cti && typeof _cti.destroy_session === 'function' && window.Keyyo && window.Keyyo.CSB && window.Keyyo.CSB.connected) {
    try { _cti.destroy_session(function () {}); } catch (err) { /* deja fermee */ }
  }
  _cti = null;
  _sessionId = '';
  _token = '';
  _calls.clear();
  setStatus('idle', '');
}

/**
 * Change de ligne : ferme la session courante et en ouvre une sur `csi`.
 * @param {string} csi
 */
export function chooseLine(csi) {
  stop();
  return start({ csi: String(csi) });
}

/**
 * Regle le decroche automatique du poste, sur la session courante et pour
 * les suivantes (preference memorisee sur ce poste).
 * @param {boolean} on
 * @returns {Promise<void>}
 */
export async function setAutoAnswer(on) {
  const value = !!on;
  try { localStorage.setItem(AUTO_ANSWER_KEY, value ? '1' : '0'); } catch (err) { /* stockage indisponible */ }
  if (_cti && _state.status === 'connected') {
    await command(function (cb) { _cti.set_auto_answer(value, cb); });
  }
  emit();
}

/**
 * Demande au serveur d'activer un plugin CTI de la ligne (seul `websocket`
 * est accepte), puis rouvre la session : un plugin active ne vaut que pour
 * les sessions suivantes.
 * @param {string} name
 * @returns {Promise<{name: string, ok: boolean, error: string}>}
 */
export async function enablePlugin(name) {
  const csi = (_state.line && _state.line.csi) || _csiWanted || undefined;
  const grant = await postCtiToken({ csi, enablePlugin: String(name) });
  _state.plugins = Array.isArray(grant.plugins) ? grant.plugins : _state.plugins;
  const action = grant.pluginAction || { name: String(name), ok: false, error: 'Aucune réponse du serveur.' };
  if (!action.ok) {
    emit();
    throw new Error('Activation de « ' + action.name + ' » refusée : ' + (action.error || 'raison inconnue'));
  }
  // Nouveau jeton recu : on repart dessus, avec une session neuve.
  stop();
  await start({ csi });
  return action;
}

function clearTimers() {
  if (_tick) { window.clearInterval(_tick); _tick = 0; }
  if (_refreshTimer) { window.clearTimeout(_refreshTimer); _refreshTimer = 0; }
  if (_reconnectTimer) { window.clearTimeout(_reconnectTimer); _reconnectTimer = 0; }
}

/**
 * Ouvre la session WebSocket, ou la restaure apres une coupure.
 * @param {boolean} restore
 */
function connect(restore) {
  if (_stopped) return;
  setStatus('connecting', restore ? 'Reconnexion…' : 'Connexion à la ligne…');

  if (!_cti) {
    // cookie_auto: false — la session ne vit pas dans un cookie pose par la
    // bibliotheque, mais ici, en memoire, avec le jeton qu'on renouvelle.
    _cti = new window.Keyyo.CTI({ cookie_auto: false, ping_auto: true });
    _cti.on('disconnected', onDisconnected);
    _cti.on('error', function (err) { console.warn('[cti] erreur de session :', err); });
    _cti.on('newCall', onCallNotification);
  }

  const done = function (err, res) {
    if (_stopped) return;
    if (err) {
      const code = err && err.error_code;
      if (restore && (err.status_code === 401 || code === 'invalid_session_id' || code === 'invalid_params')) {
        // La session cote Keyyo a expire : on en cree une neuve.
        _sessionId = '';
        return connect(false);
      }
      if (code === 'invalid_csi_token' || err.status_code === 400) {
        // Jeton perime : on en redemande un, puis on recommence.
        _token = '';
        return scheduleReconnect(true);
      }
      setStatus('error', 'Keyyo refuse la session : ' + messageOf(err));
      return scheduleReconnect(false);
    }
    _reconnectAttempt = 0;
    if (res && res.session_id) _sessionId = String(res.session_id);
    if (res && res.now) _skewSec = Math.floor(Date.now() / 1000) - Number(res.now);
    if (res && res.number && !_state.number) _state.number = String(res.number).replace(/\D/g, '');
    startTick();
    scheduleRefresh();
    setStatus('connected', '');
    // La bibliotheque tient la liste des appels courants : on la relit pour
    // afficher un appel deja en cours a l'ouverture de la page.
    try { for (const c of _cti.get_calls() || []) ingest(c); } catch (err) { /* liste vide */ }
    emit();
  };

  try {
    if (restore && _sessionId) _cti.restore_session(_token, _sessionId, done);
    else if (autoAnswer()) _cti.create_session(_token, done);
    else _cti.create_session(_token, false, done);
  } catch (err) {
    setStatus('error', messageOf(err));
    scheduleReconnect(false);
  }
}

function onDisconnected() {
  if (_stopped) return;
  setStatus('disconnected', 'Connexion à Keyyo perdue.');
  scheduleReconnect(false);
}

/**
 * @param {boolean} renewToken vrai pour redemander un jeton avant de se reconnecter.
 */
function scheduleReconnect(renewToken) {
  if (_stopped || _reconnectTimer) return;
  const wait = RECONNECT_MS[Math.min(_reconnectAttempt, RECONNECT_MS.length - 1)];
  _reconnectAttempt++;
  _reconnectTimer = window.setTimeout(async function () {
    _reconnectTimer = 0;
    if (_stopped) return;
    if (renewToken || !_token || Date.now() > _state.expiresAt - 60000) {
      try {
        const grant = await postCtiToken({ csi: (_state.line && _state.line.csi) || _csiWanted || undefined });
        _token = String(grant.token || '');
        _state.expiresAt = Date.parse(String(grant.expiresAt || '')) || (Date.now() + 3600000);
      } catch (err) {
        setStatus('error', messageOf(err));
        return scheduleReconnect(true);
      }
    }
    connect(!!_sessionId);
  }, wait);
}

/** Renouvelle le jeton CSI avant qu'il n'expire, puis restaure la session avec. */
function scheduleRefresh() {
  if (_refreshTimer) window.clearTimeout(_refreshTimer);
  const wait = Math.max(30000, _state.expiresAt - REFRESH_BEFORE_MS - Date.now());
  _refreshTimer = window.setTimeout(async function () {
    _refreshTimer = 0;
    if (_stopped) return;
    try {
      const grant = await postCtiToken({ csi: (_state.line && _state.line.csi) || undefined });
      _token = String(grant.token || '');
      _state.expiresAt = Date.parse(String(grant.expiresAt || '')) || (Date.now() + 3600000);
      // La session courante reste ouverte ; le nouveau jeton servira a la
      // prochaine restauration. Si Keyyo coupe a l'expiration de l'ancien,
      // onDisconnected reprendra avec le nouveau.
      scheduleRefresh();
      emit();
    } catch (err) {
      console.warn('[cti] renouvellement du jeton impossible, nouvel essai dans 1 min :', err);
      _refreshTimer = window.setTimeout(scheduleRefresh, 60000);
    }
  }, wait);
}

function startTick() {
  if (_tick) return;
  _tick = window.setInterval(function () {
    // Purge des termines trop anciens, puis repeinture des compteurs.
    const cutoff = Date.now() - RECENT_TTL_MS;
    let changed = false;
    const ended = [];
    for (const [ref, c] of _calls) {
      if (c.state === 'RELEASE' || c.state === 'MISSED') {
        if (c.seenAt < cutoff) { _calls.delete(ref); changed = true; } else ended.push(c);
      }
    }
    if (ended.length > RECENT_MAX) {
      ended.sort((a, b) => a.seenAt - b.seenAt);
      for (const c of ended.slice(0, ended.length - RECENT_MAX)) { _calls.delete(c.callref); changed = true; }
    }
    if (changed || snapshot().active) emit();
  }, 1000);
}

// -----------------------------------------------------------------------------
//  Appels
// -----------------------------------------------------------------------------

/**
 * Sens et correspondant d'un appel vu de la ligne. Keyyo donne des numeros
 * internationaux sans « + » (`33253359565`) ; on compare sur les chiffres.
 * @param {any} raw
 * @returns {{dir: 'in'|'out', peer: string}}
 */
function classify(raw) {
  const line = _state.number;
  const caller = String(raw.caller || '').replace(/\D/g, '');
  const callee = String(raw.callee || '').replace(/\D/g, '');
  const isOut = !!line && caller === line;
  const other = isOut ? String(raw.callee || '') : String(raw.caller || '');
  const peer = toE164(other) || (other ? other : 'anonymous');
  return { dir: isOut ? 'out' : 'in', peer: peer === '' ? 'anonymous' : peer };
}

/**
 * Integre une notification d'appel (un objet Keyyo.Call, neuf a chaque
 * notification). Les horodatages Keyyo sont en secondes, sur son horloge.
 * @param {any} raw
 */
function ingest(raw) {
  if (!raw || !raw.callref) return;
  const ref = String(raw.callref);
  const state = String(raw.state || '').toUpperCase();
  const prev = _calls.get(ref);
  const k = classify(raw);
  const setupAt = Number(raw.setup_date) || (prev ? prev.setupAt : nowKeyyo());
  const connectAt = Number(raw.connect_date) || (prev ? prev.connectAt : 0);
  const releaseAt = Number(raw.release_date) || (prev ? prev.releaseAt : 0);
  const ended = state === 'RELEASE' || state === 'MISSED';
  const ring = connectAt ? Math.max(0, connectAt - setupAt)
    : (ended && releaseAt ? Math.max(0, releaseAt - setupAt) : (prev ? prev.ring : 0));
  const duration = connectAt ? Math.max(0, (releaseAt || nowKeyyo()) - connectAt) : 0;

  const view = {
    callref: ref,
    dir: k.dir,
    peer: k.peer,
    caller: String(raw.caller || ''),
    callee: String(raw.callee || ''),
    state: /** @type {any} */ (state || 'SETUP'),
    setupAt, connectAt, releaseAt, ring, duration,
    answered: !!connectAt,
    mine: prev ? prev.mine : false,
    claimed: prev ? prev.claimed : false,
    seenAt: Date.now(),
  };
  _calls.set(ref, view);
  return view;
}

/** @param {any} call */
function onCallNotification(call) {
  const prev = _calls.get(String(call && call.callref));
  const view = ingest(call);
  if (!view) return;

  const ended = view.state === 'RELEASE' || view.state === 'MISSED';
  const wasEnded = !!prev && (prev.state === 'RELEASE' || prev.state === 'MISSED');
  if (ended && !wasEnded) {
    // Fait OBSERVE : l'appel de la ligne s'est termine, avec sa sonnerie.
    // Chaque navigateur de l'equipe le rapporte ; le serveur n'en garde qu'un.
    journal.record({
      type: 'observed',
      ts: view.setupAt,
      csi: _state.line ? _state.line.csi : '',
      callref: view.callref,
      dir: view.dir,
      peer: view.peer,
      ring: view.ring,
      duration: view.duration,
      answered: view.answered,
    });
  }
  emit();
}

/** @param {string} callref @returns {any|null} objet Keyyo.Call courant. */
function liveCall(callref) {
  if (!_cti) return null;
  try { return _cti.get_call(String(callref)) || null; } catch (err) { return null; }
}

/**
 * Enveloppe une commande CTI (style callback) en promesse, avec delai.
 * @param {(cb: (err: any, res: any) => void) => void} run
 * @returns {Promise<any>}
 */
function command(run) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = window.setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('Keyyo ne répond pas à la commande (' + Math.round(COMMAND_TIMEOUT_MS / 1000) + ' s).'));
    }, COMMAND_TIMEOUT_MS);
    try {
      run(function (err, res) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (err) reject(new Error(messageOf(err)));
        else resolve(res);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(err);
    }
  });
}

function requireConnected() {
  if (!_cti || _state.status !== 'connected') throw new Error('La ligne n\'est pas connectée.');
}

/** @param {string} number @returns {string} numero au format Keyyo (international, sans +). */
function toKeyyoNumber(number) {
  const raw = String(number == null ? '' : number).trim();
  const e164 = toE164(raw);
  if (e164 && e164 !== 'anonymous') return e164.replace(/^\+/, '');
  // Un poste court (« 4012 ») passe tel quel : Keyyo sait le router.
  const digits = raw.replace(/\D/g, '');
  if (!digits) throw new Error('Numéro vide ou illisible : « ' + raw + ' ».');
  return digits;
}

/** @param {string} callref @param {Partial<CallView>} patch */
function mark(callref, patch) {
  const c = _calls.get(String(callref));
  if (c) Object.assign(c, patch);
}

/**
 * Compose un numero depuis la ligne.
 * @param {string} number
 * @returns {Promise<void>}
 */
export async function dial(number) {
  requireConnected();
  const to = toKeyyoNumber(number);
  try {
    await command(function (cb) { _cti.dial(to, cb); });
  } catch (err) {
    // « Cannot treat action » est la reponse brute de Keyyo : on dit vers quoi
    // et depuis quelle ligne, sinon le message ne renseigne personne.
    throw new Error('Keyyo refuse l’appel vers ' + to + ' depuis la ligne '
      + (_state.line ? _state.line.label : _state.number) + ' : ' + messageOf(err) + '.');
  }
  journal.record({
    type: 'dial',
    csi: _state.line ? _state.line.csi : '',
    to,
    dir: 'out',
  });
  emit();
}

/**
 * Decroche un appel entrant depuis l'application.
 * @param {string} callref
 */
export async function answer(callref) {
  requireConnected();
  const call = liveCall(callref);
  if (!call) throw new Error('Cet appel n\'est plus en cours.');
  await command(function (cb) { call.answer(cb); });
  const v = _calls.get(String(callref));
  mark(callref, { mine: true });
  journal.record({
    type: 'answer',
    csi: _state.line ? _state.line.csi : '',
    callref: String(callref),
    dir: v ? v.dir : 'in',
    peer: v ? v.peer : '',
    ring: v ? (v.state === 'SETUP' ? Math.max(0, nowKeyyo() - v.setupAt) : v.ring) : 0,
    answered: true,
  });
  emit();
}

/**
 * Rejette un appel entrant qui sonne : Keyyo l'envoie sur la messagerie de la
 * ligne. Pas de fait nominatif : personne ne l'a pris.
 * @param {string} callref
 */
export async function reject(callref) {
  requireConnected();
  const call = liveCall(callref);
  if (!call) throw new Error('Cet appel n\'est plus en cours.');
  await command(function (cb) { call.reject(cb); });
  emit();
}

/**
 * Raccroche un appel.
 * @param {string} callref
 */
export async function hangup(callref) {
  requireConnected();
  const call = liveCall(callref);
  if (!call) throw new Error('Cet appel n\'est plus en cours.');
  await command(function (cb) { call.hang_up(cb); });
  const v = _calls.get(String(callref));
  journal.record({
    type: 'hangup',
    csi: _state.line ? _state.line.csi : '',
    callref: String(callref),
    dir: v ? v.dir : '',
  });
  emit();
}

/**
 * Transfere le correspondant d'un appel vers un autre numero.
 * Pour un entrant, c'est l'appelant qu'on transfere ; pour un sortant, l'appele.
 * @param {string} callref
 * @param {string} number
 * @param {{supervised?: boolean}} [opts] supervise : n'aboutit que si le destinataire decroche.
 */
export async function transfer(callref, number, opts) {
  requireConnected();
  const o = opts || {};
  const call = liveCall(callref);
  if (!call) throw new Error('Cet appel n\'est plus en cours.');
  const v = _calls.get(String(callref));
  const side = v && v.dir === 'out' ? 'callee' : 'caller';
  const to = toKeyyoNumber(number);
  if (o.supervised) await command(function (cb) { call.supervised_transfer(side, to, 30, cb); });
  else await command(function (cb) { call.transfer(side, to, cb); });
  mark(callref, { mine: true });
  journal.record({
    type: 'transfer',
    csi: _state.line ? _state.line.csi : '',
    callref: String(callref),
    dir: v ? v.dir : '',
    to,
    supervised: !!o.supervised,
  });
  emit();
}

/**
 * La personne declare avoir pris cet appel au telephone. C'est une
 * DECLARATION, pas une mesure : le journal la range a part (`claim`).
 * @param {string} callref
 */
export function claim(callref) {
  const v = _calls.get(String(callref));
  if (!v) throw new Error('Cet appel n\'est plus affiché.');
  if (v.dir !== 'in') throw new Error('Seul un appel entrant peut être déclaré pris.');
  if (v.claimed) return;
  mark(callref, { mine: true, claimed: true });
  journal.record({
    type: 'claim',
    ts: v.setupAt,
    csi: _state.line ? _state.line.csi : '',
    callref: String(callref),
    dir: 'in',
    peer: v.peer,
    ring: v.ring,
    duration: v.duration,
    answered: v.answered,
  });
  emit();
}

// -----------------------------------------------------------------------------
//  Divers
// -----------------------------------------------------------------------------

/** @param {unknown} err @returns {string} */
function messageOf(err) {
  if (!err) return 'erreur inconnue';
  const e = /** @type {any} */ (err);
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message) + (e.error_code ? ' (' + e.error_code + ')' : '');
  try { return JSON.stringify(e); } catch (x) { return String(e); }
}
