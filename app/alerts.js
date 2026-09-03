// =============================================================================
//  app/alerts.js — Alertes d'appels manques : centre, toasts, son, notifications.
//
//  UN APPEL MANQUE EST UN ENTRANT DE DUREE NULLE (l'API Keyyo ne fournit aucun
//  indicateur de decroche, cf. shared/schema.js). C'est donc `isMissed` du
//  schema partage qui tranche, jamais un test local.
//
//  Trois pieges que ce module doit eviter, et qui expliquent sa forme :
//
//   1. LA RAFALE D'OUVERTURE. Le premier chargement apporte trois mois
//      d'historique, donc des centaines de manques. Alerter dessus serait
//      inutilisable : le premier passage APPREND les manques sans rien annoncer,
//      et le fait qu'il ait eu lieu est PERSISTE (`keyyo.seenPrimed`). Une
//      variable de module ne suffirait pas : un simple rechargement de page
//      rejouerait la rafale.
//
//   2. LE QUOTA DE localStorage. Les cles deja vues sont bornees a
//      MAX_SEEN entrees a l'ecriture. Une eviction peut donc « oublier » un
//      manque ancien ; d'ou le garde-fou de fraicheur : on n'annonce que les
//      manques de moins de ALERT_MAX_AGE_S. Une alerte porte sur un evenement
//      qui vient d'arriver, pas sur un appel de juin.
//
//   3. LE CONTEXTE AUDIO INTERDIT. Un AudioContext cree avant toute interaction
//      naitrait « suspended » et resterait muet. Il est donc cree au premier
//      geste de l'utilisateur, et son etat est verifie a chaque lecture.
// =============================================================================

import { qs, on, mount, html, raw, h, icon } from './dom.js';
import { fmtDate, fmtTime } from './format.js';
import { avatar, empty, tag } from './ui.js';
import { labelOf, lineByCsi } from './store.js';
import { F, isMissed, rowKey } from '../shared/schema.js';
import { formatNumber } from '../shared/phone.js';

// -----------------------------------------------------------------------------
//  Constantes
// -----------------------------------------------------------------------------

const K_SOUND = 'keyyo.sound';
const K_NOTIF = 'keyyo.notif';
const K_SEEN = 'keyyo.seenMissed';
const K_PRIMED = 'keyyo.seenPrimed';

/** Cles de manques conservees dans localStorage (trois mois tiennent dessous). */
const MAX_SEEN = 3000;

/** Age maximal d'un manque encore digne d'une alerte, en secondes. */
const ALERT_MAX_AGE_S = 2 * 3600;

/** Manques annonces au plus par cycle : au-dela, le centre suffit. */
const BURST_MAX = 4;

/** Entrees affichees dans le centre de notifications. */
const CENTER_MAX = 12;

/** Toasts simultanes, et duree de vie de chacun. */
const TOAST_MAX = 3;
const TOAST_MS = 6000;

/** Tons de toast reconnus -> nom d'icone de index.html. */
const TOAST_ICONS = { missed: 'missed', error: 'alert', warn: 'alert', ok: 'check', info: 'info' };

// -----------------------------------------------------------------------------
//  Etat interne
// -----------------------------------------------------------------------------

let _ready = false;

let _sound = false;
let _notif = false;

/** @type {Set<string>} cles de manques deja connues. */
let _seen = new Set();

/** @type {Set<string>} cles annoncees et pas encore lues (pastille de la cloche). */
const _unread = new Set();

/** Vrai des que le premier apprentissage a eu lieu (persiste). */
let _primed = false;

/** Dernier tableau de lignes vu : le store en fabrique un neuf a chaque collecte. */
let _lastRows = /** @type {any[][]|null} */ (null);

let _popOpen = false;

/** @type {any} contexte Web Audio, cree paresseusement. */
let _audio = null;

/** Une demande d'autorisation ne doit aboutir qu'une fois (promesse ET rappel). */
let _permAsked = false;

// -----------------------------------------------------------------------------
//  Acces a localStorage — jamais bloquant
// -----------------------------------------------------------------------------

/**
 * @param {string} key
 * @returns {string|null} `null` si le stockage est indisponible (navigation privee).
 */
function lsGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

/**
 * @param {string} key
 * @param {string} value
 */
function lsSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (err) {
    // Quota atteint ou stockage refuse : les preferences ne survivront pas au
    // rechargement, mais la session en cours doit continuer normalement.
    console.warn('[alerts] preference non enregistree (' + key + ') :', err);
  }
}

function loadPrefs() {
  _sound = lsGet(K_SOUND) === '1';
  _notif = lsGet(K_NOTIF) === '1';
  _primed = lsGet(K_PRIMED) === '1';
}

function loadSeen() {
  const raw = lsGet(K_SEEN);
  if (!raw) return;
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        const key = list[i];
        if (typeof key === 'string' && key) _seen.add(key);
      }
    }
  } catch (err) {
    // Contenu corrompu : on repart d'un ensemble vide plutot que de rester
    // bloque. Le garde-fou de fraicheur evite la rafale qui en decoulerait.
    console.warn('[alerts] historique des manques illisible, remis a zero :', err);
    _seen = new Set();
  }
}

function saveSeen() {
  // Les Set conservent l'ordre d'insertion : garder la FIN du tableau garde les
  // manques les plus recemment appris, ceux qui risquent de revenir.
  const list = Array.from(_seen);
  const kept = list.length > MAX_SEEN ? list.slice(list.length - MAX_SEEN) : list;
  lsSet(K_SEEN, JSON.stringify(kept));
}

// -----------------------------------------------------------------------------
//  Son : un accord bref genere par Web Audio, sans aucun fichier
// -----------------------------------------------------------------------------

/** @returns {any|null} le contexte audio, ou `null` si l'API est absente. */
function audioContext() {
  if (_audio) return _audio;
  const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
  if (typeof Ctx !== 'function') return null;
  try {
    _audio = new Ctx();
  } catch (err) {
    console.warn('[alerts] contexte audio indisponible :', err);
    return null;
  }
  return _audio;
}

/**
 * Cree le contexte au PREMIER geste de l'utilisateur : cree plus tot, il
 * naitrait suspendu et le premier accord serait perdu.
 */
function primeAudioOnFirstGesture() {
  const prime = function () {
    document.removeEventListener('pointerdown', prime, true);
    document.removeEventListener('keydown', prime, true);
    audioContext();
  };
  document.addEventListener('pointerdown', prime, true);
  document.addEventListener('keydown', prime, true);
}

/** Accord de trois notes (do - mi - sol), 0,6 s. Ne jette jamais. */
function playChime() {
  const ctx = audioContext();
  if (!ctx) return;
  try {
    // Un contexte suspendu (onglet revenu au premier plan) doit etre relance,
    // sinon les oscillateurs jouent dans le vide.
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      const resumed = ctx.resume();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(function () { /* muet */ });
    }
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    gain.connect(ctx.destination);

    const notes = [523.25, 659.25, 783.99];
    for (let i = 0; i < notes.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(notes[i], now);
      osc.connect(gain);
      osc.start(now + i * 0.06);
      osc.stop(now + 0.62);
    }
  } catch (err) {
    console.warn('[alerts] lecture du signal sonore impossible :', err);
  }
}

// -----------------------------------------------------------------------------
//  Notifications systeme
// -----------------------------------------------------------------------------

/** @returns {boolean} */
function notifSupported() {
  return typeof window.Notification === 'function';
}

/** @returns {boolean} */
function notifGranted() {
  return notifSupported() && window.Notification.permission === 'granted';
}

/**
 * Demande l'autorisation. Deux formes existent selon les navigateurs (promesse
 * ou rappel) : on accepte les deux, et on garantit UN SEUL aboutissement.
 * @param {(permission: string) => void} done
 */
function requestPermission(done) {
  if (_permAsked) return;
  _permAsked = true;
  let settled = false;
  const finish = function (permission) {
    if (settled) return;
    settled = true;
    _permAsked = false;
    done(String(permission || 'denied'));
  };
  try {
    const res = window.Notification.requestPermission(finish);
    if (res && typeof res.then === 'function') {
      res.then(finish, function () { finish('denied'); });
    }
  } catch (err) {
    console.warn('[alerts] demande d\'autorisation refusee par le navigateur :', err);
    finish('denied');
  }
}

/**
 * @param {string} label  Nom resolu, ou numero formate.
 * @param {string} time   `HH:MM`
 * @param {string} line   Libelle de la ligne Keyyo appelee.
 * @param {string} key    Cle du manque, pour ne pas empiler deux fois le meme.
 */
function systemNotify(label, time, line, key) {
  if (!notifGranted()) return;
  try {
    const n = new window.Notification('Appel manqué — ' + label, {
      body: 'À ' + time + ' sur la ligne ' + line,
      tag: 'keyyo-missed-' + key,
      // Le son est joue par l'application quand l'utilisateur l'a demande :
      // laisser le systeme en jouer un second ferait double signal.
      silent: !!_sound,
    });
    n.onclick = function () {
      try { window.focus(); } catch (err) { /* fenetre non focalisable */ }
      n.close();
    };
  } catch (err) {
    // Certains navigateurs exigent un service worker pour construire une
    // Notification : l'echec ne doit pas interrompre la boucle d'alerte.
    console.warn('[alerts] notification systeme non affichee :', err);
  }
}

// -----------------------------------------------------------------------------
//  Interrupteurs
// -----------------------------------------------------------------------------

/**
 * @param {HTMLElement|null} el
 * @param {boolean} value
 */
function paintSwitch(el, value) {
  if (!el) return;
  el.classList.toggle('is-on', !!value);
  el.setAttribute('aria-pressed', value ? 'true' : 'false');
}

/** @param {boolean} value */
function setSound(value) {
  _sound = !!value;
  lsSet(K_SOUND, _sound ? '1' : '0');
  paintSwitch(qs('#sw-sound'), _sound);
  // Le clic est un geste utilisateur : c'est le seul moment ou l'on peut
  // prouver a l'utilisateur que le son fonctionne.
  if (_sound) playChime();
}

/** @param {boolean} value */
function setNotif(value) {
  _notif = !!value;
  lsSet(K_NOTIF, _notif ? '1' : '0');
  paintSwitch(qs('#sw-notif'), _notif);
}

/** Active les notifications systeme, en demandant l'autorisation si besoin. */
function enableNotif() {
  if (!notifSupported()) {
    setNotif(false);
    toast({
      title: 'Notifications indisponibles',
      sub: 'Ce navigateur ne propose pas les notifications système.',
      tone: 'warn',
    });
    return;
  }
  const permission = window.Notification.permission;
  if (permission === 'granted') {
    setNotif(true);
    return;
  }
  if (permission === 'denied') {
    setNotif(false);
    toast({
      title: 'Notifications bloquées',
      sub: 'Autorisez les notifications pour ce site dans les réglages du navigateur.',
      tone: 'warn',
    });
    return;
  }
  requestPermission(function (result) {
    if (result === 'granted') {
      setNotif(true);
      toast({
        title: 'Notifications activées',
        sub: 'Vous serez averti à chaque nouvel appel manqué.',
        tone: 'ok',
      });
      return;
    }
    setNotif(false);
    toast({
      title: 'Notifications refusées',
      sub: 'L’interrupteur reste éteint : le navigateur n’a pas accordé l’autorisation.',
      tone: 'warn',
    });
  });
}

// -----------------------------------------------------------------------------
//  Cloche et centre de notifications
// -----------------------------------------------------------------------------

function renderBadge() {
  const badge = qs('#bell-badge');
  if (!badge) return;
  const n = _unread.size;
  badge.textContent = n > 99 ? '99+' : String(n);
  // `.bell-badge[hidden]` est declare dans components.css : l'attribut suffit.
  badge.hidden = n === 0;
}

function openPopover() {
  const pop = qs('#notif-popover');
  const btn = qs('#btn-bell');
  if (!pop) return;
  pop.hidden = false;
  if (btn) btn.setAttribute('aria-expanded', 'true');
  _popOpen = true;
}

function closePopover() {
  const pop = qs('#notif-popover');
  const btn = qs('#btn-bell');
  if (pop) pop.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  _popOpen = false;
}

/**
 * Libelle de la ligne Keyyo qui a recu l'appel : le prenom quand il est connu,
 * sinon le numero formate — jamais un CSI nu.
 * @param {unknown} csi
 * @returns {string}
 */
function lineLabelOf(csi) {
  const line = lineByCsi(csi);
  if (line && line.label) return String(line.label);
  return formatNumber(csi);
}

/**
 * Remplit le centre de notifications avec les manques les plus recents.
 * @param {any[][]} rows lignes d'appel brutes (tout l'historique connu).
 */
export function renderCenter(rows) {
  const host = qs('#notif-list');
  if (!host) return;

  const list = Array.isArray(rows) ? rows : [];
  const missed = [];
  for (let i = 0; i < list.length; i++) {
    if (isMissed(list[i])) missed.push(list[i]);
  }
  missed.sort(function (a, b) { return (Number(b[F.ts]) || 0) - (Number(a[F.ts]) || 0); });

  if (!missed.length) {
    mount(host, empty('Aucun appel manqué', 'Sur la période collectée, tous les entrants ont été décrochés.'));
    return;
  }

  const shown = missed.slice(0, CENTER_MAX);
  let out = '';
  for (let i = 0; i < shown.length; i++) {
    const row = shown[i];
    const number = String(row[F.peer] || '');
    const label = labelOf(number);
    const fresh = _unread.has(rowKey(row));
    const meta = fmtDate(row[F.date]) + ' · ' + fmtTime(row[F.hour], row[F.minute])
      + ' · ' + lineLabelOf(row[F.csi]);
    out += html`<button class="rank-row" type="button" data-number="${number}">
      <span class="rank-avatar">${raw(avatar(label, { tone: 'missed' }))}</span>
      <span class="rank-body">
        <span class="rank-name">${label}</span>
        <div class="rank-sub">${meta}</div>
      </span>
      ${raw(fresh ? tag('Nouveau', 'missed') : '')}
    </button>`;
  }
  mount(host, html`<div class="rank-list">${raw(out)}</div>`);
}

/** @returns {number} manques annonces et pas encore lus. */
export function unreadCount() {
  return _unread.size;
}

/** Vide la pastille de la cloche et retire les marqueurs « Nouveau ». */
export function markAllRead() {
  if (!_unread.size) return;
  _unread.clear();
  renderBadge();
  renderCenter(_lastRows || []);
}

// -----------------------------------------------------------------------------
//  Messages ephemeres
// -----------------------------------------------------------------------------

/**
 * Affiche un message ephemere en bas a droite.
 *
 * `title` et `sub` sont poses en NOEUDS TEXTE par `h()` : un nom d'annuaire
 * hostile s'affiche donc tel quel, sans jamais etre interprete. Le ton ne
 * choisit que l'icone : le contrat CSS n'expose pas de variante de `.toast`.
 *
 * @param {{title: string, sub?: string, tone?: 'missed'|'ok'|'warn'|'error'|'info'}} opts
 */
export function toast(opts) {
  const o = opts || {};
  const host = qs('#toasts');
  if (!host) return;

  // Plafond : au-dela de trois messages, les plus anciens ne sont plus lus et
  // masqueraient les nouveaux.
  while (host.children.length >= TOAST_MAX && host.firstElementChild) {
    host.removeChild(host.firstElementChild);
  }

  const tone = String(o.tone == null ? 'info' : o.tone);
  const iconName = TOAST_ICONS[tone] || 'info';
  const sub = o.sub == null ? '' : String(o.sub);

  const el = h('div', { class: 'toast' }, [
    h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, raw(icon(iconName))),
    h('div', { class: 'grow' }, [
      h('div', { class: 'toast-title' }, String(o.title == null ? '' : o.title)),
      sub ? h('div', { class: 'toast-sub' }, sub) : null,
    ]),
  ]);
  host.appendChild(el);

  window.setTimeout(function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, TOAST_MS);
}

// -----------------------------------------------------------------------------
//  Detection des nouveaux manques
// -----------------------------------------------------------------------------

/**
 * Annonce un manque : centre, pastille, toast, puis son et notification si
 * l'utilisateur les a demandes.
 * @param {any[]} row
 */
function announce(row) {
  const key = rowKey(row);
  const number = String(row[F.peer] || '');
  const label = labelOf(number);
  const time = fmtTime(row[F.hour], row[F.minute]);
  const line = lineLabelOf(row[F.csi]);

  _unread.add(key);
  renderBadge();

  toast({
    title: 'Appel manqué — ' + label,
    sub: time + ' · ligne ' + line,
    tone: 'missed',
  });

  if (_sound) playChime();
  if (_notif) systemNotify(label, time, line, key);
}

/**
 * Detecte les appels manques NOUVEAUX dans un jeu de lignes.
 *
 * A appeler avec TOUT l'historique connu (`store.getRows()`), pas avec les
 * lignes filtrees : une alerte ne depend pas de la periode regardee a l'ecran.
 *
 * @param {any[][]} rows
 */
export function check(rows) {
  const list = Array.isArray(rows) ? rows : [];
  // Le store remplace `_rows` par un tableau neuf a chaque collecte : comparer
  // l'identite evite de reparcourir des milliers de lignes a chaque rendu.
  if (list === _lastRows) return;
  _lastRows = list;

  const missed = [];
  for (let i = 0; i < list.length; i++) {
    if (isMissed(list[i])) missed.push(list[i]);
  }
  // Ordre chronologique : les annonces doivent sortir dans l'ordre des appels.
  missed.sort(function (a, b) { return (Number(a[F.ts]) || 0) - (Number(b[F.ts]) || 0); });

  /** @type {any[][]} */
  const fresh = [];
  for (let i = 0; i < missed.length; i++) {
    const key = rowKey(missed[i]);
    if (_seen.has(key)) continue;
    _seen.add(key);
    fresh.push(missed[i]);
  }
  if (fresh.length) saveSeen();

  const firstRun = !_primed;
  if (firstRun) {
    // Apprentissage initial : on retient tout, on n'annonce rien. Le drapeau est
    // PERSISTE, sinon un rechargement de page rejouerait la rafale.
    _primed = true;
    lsSet(K_PRIMED, '1');
  } else if (fresh.length) {
    const nowSec = Math.floor(Date.now() / 1000);
    /** @type {any[][]} */
    const alertable = [];
    for (let i = 0; i < fresh.length; i++) {
      const age = nowSec - (Number(fresh[i][F.ts]) || 0);
      // Un manque ancien qui reapparait (eviction de cle, archive rechargee)
      // n'est plus une alerte : il rejoint le centre sans faire de bruit.
      if (age <= ALERT_MAX_AGE_S) alertable.push(fresh[i]);
    }
    const start = alertable.length > BURST_MAX ? alertable.length - BURST_MAX : 0;
    for (let i = start; i < alertable.length; i++) announce(alertable[i]);
  }

  renderCenter(list);
}

// -----------------------------------------------------------------------------
//  Amorcage
// -----------------------------------------------------------------------------

/** Restaure les preferences et cable la cloche et les interrupteurs. */
export function init() {
  if (_ready) return;
  _ready = true;

  loadPrefs();
  loadSeen();

  const sound = qs('#sw-sound');
  if (sound) {
    paintSwitch(sound, _sound);
    on(sound, 'click', function () { setSound(!_sound); });
  }

  const notif = qs('#sw-notif');
  if (notif) {
    // Une autorisation revoquee depuis la derniere visite doit se voir : on
    // n'affiche « actif » que si le navigateur l'accorde encore.
    _notif = _notif && notifGranted();
    paintSwitch(notif, _notif);
    on(notif, 'click', function () {
      if (_notif) setNotif(false);
      else enableNotif();
    });
  }

  const bell = qs('#btn-bell');
  if (bell) {
    on(bell, 'click', function () {
      if (_popOpen) closePopover();
      else openPopover();
    });
  }

  // Clic hors de la cloche : le clic sur la cloche elle-meme est ignore ici,
  // sinon il refermerait immediatement ce que le bouton vient d'ouvrir.
  document.addEventListener('click', function (ev) {
    if (!_popOpen) return;
    const target = /** @type {any} */ (ev.target);
    if (target && typeof target.closest === 'function' && target.closest('.bell')) return;
    closePopover();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && _popOpen) closePopover();
  });

  const clear = qs('#btn-notif-clear');
  if (clear) on(clear, 'click', function () { markAllRead(); });

  // Le contenu du centre est remonte a chaque collecte : la delegation est
  // posee une fois pour toutes sur le conteneur, qui lui ne bouge pas.
  const list = qs('#notif-list');
  if (list) {
    on(list, 'click', '.rank-row[data-number]', function (ev, el) {
      const number = el.getAttribute('data-number');
      closePopover();
      // C'est main.js qui ouvre la fiche du correspondant.
      document.dispatchEvent(new CustomEvent('keyyo:drill', { detail: { number: number } }));
    });
  }

  primeAudioOnFirstGesture();
  renderBadge();
}
