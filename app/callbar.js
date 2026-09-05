// =============================================================================
//  app/callbar.js — La barre d'appel : ce que l'utilisateur voit de sa ligne.
//
//  Une bande fixe en bas de page, presente sur la supervision comme sur la
//  page agent. Elle affiche l'etat de la ligne, les appels en cours (avec la
//  sonnerie qui court, puis la duree), les appels termines recents, un champ
//  pour appeler, et un choix de collegues et de managers pour appeler ou
//  transferer en un clic.
//
//  Elle ne calcule rien : app/cti.js tient l'etat et execute les actions ;
//  cette barre le repeint a chaque instantane. Les noms viennent d'une
//  fonction `labelOf` fournie par la page hote (le store de la supervision,
//  ou l'annuaire charge par la page agent), pour ne pas dupliquer l'annuaire.
//
//  Toutes les chaines venues de Keyyo (numeros, noms) passent par le gabarit
//  `html` : la barre est une surface d'affichage de donnees exterieures.
// =============================================================================

import * as cti from './cti.js';
import * as journal from './journal.js';
import { qs, on, html, raw, mount, icon } from './dom.js';
import { formatNumber } from '../shared/phone.js';
import { fmtDurationShort } from './format.js';

/** @type {HTMLElement|null} */
let _host = null;
/** @type {(number: string) => string} */
let _labelOf = function (n) { return formatNumber(n); };
/** @type {Array<{name: string, number: string, numberKind: string, lines: string[], manager: boolean}>} */
let _colleagues = [];
/** @type {(opts: {title: string, sub?: string, tone?: string}) => void} */
let _toast = function () {};
/** Mode du panneau de choix : appeler, ou transferer un appel donne. */
let _mode = /** @type {{kind: 'dial'|'transfer', callref: string}} */ ({ kind: 'dial', callref: '' });
let _pickerOpen = false;
let _query = '';
let _collapsed = false;
/** Action en cours (pour desactiver les boutons), ou ''. */
let _busy = '';
let _note = /** @type {{text: string, tone: string}} */ ({ text: '', tone: '' });
let _wired = false;

/** Libelles d'etat de la ligne, dans le vocabulaire de l'utilisateur. */
const STATUS_LABELS = {
  idle: 'Ligne fermée',
  loading: 'Ouverture…',
  connecting: 'Connexion…',
  connected: 'Ligne connectée',
  disconnected: 'Ligne coupée',
  error: 'Ligne indisponible',
  'needs-line': 'Choisir une ligne',
};

// -----------------------------------------------------------------------------
//  Montage
// -----------------------------------------------------------------------------

/**
 * Monte la barre dans `host` et la branche sur app/cti.js.
 * @param {object} opts
 * @param {HTMLElement|string} opts.host
 * @param {(number: string) => string} [opts.labelOf]
 * @param {any[]} [opts.colleagues]
 * @param {(opts: {title: string, sub?: string, tone?: string}) => void} [opts.toast]
 */
export function init(opts) {
  const o = opts || {};
  _host = typeof o.host === 'string' ? qs(o.host) : (o.host || null);
  if (!_host) throw new Error('callbar.init : conteneur introuvable.');
  if (typeof o.labelOf === 'function') _labelOf = o.labelOf;
  if (Array.isArray(o.colleagues)) _colleagues = o.colleagues;
  if (typeof o.toast === 'function') _toast = o.toast;

  try { _collapsed = localStorage.getItem('keyyo.callbar.collapsed') === '1'; } catch (err) { _collapsed = false; }

  mount(_host, skeleton());
  document.body.classList.add('has-callbar');
  if (!_wired) { wire(); _wired = true; }
  cti.subscribe(paint);
  journal.subscribe(paintNote);
  journal.init();
  paint(cti.snapshot());
}

/** @param {any[]} list */
export function setColleagues(list) {
  _colleagues = Array.isArray(list) ? list : [];
  if (_pickerOpen) paintPicker();
}

/** @param {(number: string) => string} fn */
export function setLabelOf(fn) {
  if (typeof fn === 'function') { _labelOf = fn; paint(cti.snapshot()); }
}

function skeleton() {
  return html`<div class="callbar${_collapsed ? ' is-collapsed' : ''}" id="cb-root">
    <div class="callbar-head">
      <span class="live is-loading" id="cb-live" title="État de la ligne Keyyo">
        <span class="live-dot" aria-hidden="true"></span>
        <span id="cb-live-text">Ligne…</span>
      </span>
      <span class="callbar-line" id="cb-line"></span>
      <span class="callbar-count" id="cb-count" hidden></span>
      <span class="toolbar-spacer"></span>
      <button class="btn btn--ghost btn--sm" id="cb-toggle" type="button" aria-expanded="${!_collapsed}" aria-controls="cb-body">${_collapsed ? 'Afficher' : 'Réduire'}</button>
    </div>
    <div class="callbar-body" id="cb-body"${_collapsed ? ' hidden' : ''}>
      <div class="callbar-lines" id="cb-lines" hidden></div>
      <div class="callbar-calls" id="cb-calls"></div>
      <div class="callbar-dial">
        <label class="field field--grow" for="cb-number">
          ${raw(icon('phone'))}
          <input id="cb-number" type="tel" inputmode="tel" autocomplete="off" placeholder="Numéro à appeler (ex. 06 12 34 56 78 ou 4012)">
        </label>
        <button class="btn btn--accent" id="cb-dial" type="button">${raw(icon('out'))}Appeler</button>
        <button class="btn" id="cb-pick" type="button" aria-expanded="false" aria-controls="cb-picker">${raw(icon('peers'))}Collègues</button>
      </div>
      <div class="callbar-picker" id="cb-picker" hidden></div>
      <p class="callbar-note" id="cb-note"></p>
    </div>
  </div>`;
}

// -----------------------------------------------------------------------------
//  Rendu
// -----------------------------------------------------------------------------

/** @param {ReturnType<typeof cti.snapshot>} snap */
function paint(snap) {
  if (!_host) return;

  const live = qs('#cb-live', _host);
  const liveText = qs('#cb-live-text', _host);
  if (live && liveText) {
    live.classList.toggle('is-loading', snap.status === 'loading' || snap.status === 'connecting');
    live.classList.toggle('is-warn', snap.status === 'disconnected' || snap.status === 'needs-line');
    live.classList.toggle('is-error', snap.status === 'error' || snap.status === 'idle');
    liveText.textContent = STATUS_LABELS[snap.status] || snap.status;
    live.setAttribute('title', snap.message || STATUS_LABELS[snap.status] || '');
  }

  const line = qs('#cb-line', _host);
  if (line) {
    line.textContent = snap.line
      ? String(snap.line.label || '') + (snap.line.number ? ' · ' + snap.line.number : '')
      : (snap.status === 'error' || snap.status === 'disconnected' ? snap.message : '');
  }

  const count = qs('#cb-count', _host);
  if (count) {
    count.hidden = !snap.active;
    count.textContent = snap.active ? String(snap.active) + (snap.active > 1 ? ' appels' : ' appel') : '';
  }

  const lines = qs('#cb-lines', _host);
  if (lines) {
    const choose = snap.status === 'needs-line' || (snap.status === 'error' && snap.lines.length > 1);
    lines.hidden = !choose;
    if (choose) {
      mount(lines, html`<span class="callbar-lines-label">${snap.message || 'Choisir la ligne à piloter :'}</span>
        ${snap.lines.map((l) => html`<button class="btn btn--sm" type="button" data-choose-line="${l.csi}">${l.label}${l.members ? html` <span class="faint">(${l.members})</span>` : ''}</button>`)}`);
    }
  }

  const calls = qs('#cb-calls', _host);
  if (calls) mount(calls, snap.calls.length ? snap.calls.map((c) => raw(callCard(c))) : '');

  const dial = /** @type {HTMLButtonElement|null} */ (qs('#cb-dial', _host));
  if (dial) dial.disabled = !snap.connected || _busy === 'dial';
  const pick = /** @type {HTMLButtonElement|null} */ (qs('#cb-pick', _host));
  if (pick) pick.disabled = !_colleagues.length;

  // Un appel transfere ou termine ferme le mode transfert qui le visait.
  if (_mode.kind === 'transfer' && !snap.calls.some((c) => c.callref === _mode.callref && (c.state === 'SETUP' || c.state === 'CONNECT'))) {
    _mode = { kind: 'dial', callref: '' };
    if (_pickerOpen) paintPicker();
  }
}

/** @param {any} c @returns {string} */
function callCard(c) {
  const ringing = c.state === 'SETUP';
  const live = c.state === 'CONNECT';
  const ended = !ringing && !live;
  const missed = c.state === 'MISSED' || (ended && !c.answered && c.dir === 'in');
  const tone = missed ? 'missed' : (c.dir === 'in' ? 'in' : 'out');
  const label = c.peer === 'anonymous' ? 'Appelant masqué' : _labelOf(c.peer);
  const number = c.peer === 'anonymous' ? '' : formatNumber(c.peer);

  let meta = c.dir === 'in' ? 'Entrant' : 'Sortant';
  if (ringing) meta += ' · sonne depuis ' + fmtDurationShort(c.ring);
  else if (live) meta += ' · en ligne ' + fmtDurationShort(c.duration) + (c.ring ? ' · décroché après ' + fmtDurationShort(c.ring) : '');
  else if (missed) meta += ' · manqué après ' + fmtDurationShort(c.ring) + ' de sonnerie';
  else meta += ' · terminé' + (c.duration ? ', ' + fmtDurationShort(c.duration) : '') + (c.ring ? ' · décroché après ' + fmtDurationShort(c.ring) : '');
  if (c.mine) meta += ' · pris ici';

  const busy = _busy === c.callref;
  const buttons = [];
  if (ringing && c.dir === 'in') {
    buttons.push(html`<button class="btn btn--accent btn--sm" type="button" data-call-answer="${c.callref}"${busy ? ' disabled' : ''}>${raw(icon('in'))}Répondre</button>`);
  }
  if (ringing || live) {
    buttons.push(html`<button class="btn btn--sm" type="button" data-call-transfer="${c.callref}"${busy ? ' disabled' : ''}>Transférer</button>`);
    buttons.push(html`<button class="btn btn--ghost btn--sm" type="button" data-call-hangup="${c.callref}"${busy ? ' disabled' : ''}>Raccrocher</button>`);
  }
  if (c.dir === 'in' && c.answered && !c.mine && !c.claimed && (live || ended)) {
    buttons.push(html`<button class="btn btn--ghost btn--sm" type="button" data-call-claim="${c.callref}" title="Je l'ai décroché sur mon téléphone">C’est moi qui ai répondu</button>`);
  }

  return html`<div class="call call--${tone}${ringing ? ' is-ringing' : ''}${live ? ' is-live' : ''}" data-callref="${c.callref}">
    <span class="call-icon" aria-hidden="true">${raw(icon(missed ? 'missed' : (c.dir === 'in' ? 'in' : 'out')))}</span>
    <div class="call-body">
      <div class="call-peer">${label}${number && number !== label ? html` <span class="faint">${number}</span>` : ''}</div>
      <div class="call-meta">${meta}</div>
    </div>
    <div class="call-actions">${raw(buttons.join(''))}</div>
  </div>`;
}

/** Panneau de choix d'un collegue ou d'un manager. */
function paintPicker() {
  const panel = qs('#cb-picker', _host || undefined);
  const pick = qs('#cb-pick', _host || undefined);
  if (!panel) return;
  panel.hidden = !_pickerOpen;
  if (pick) pick.setAttribute('aria-expanded', _pickerOpen ? 'true' : 'false');
  if (!_pickerOpen) return;

  const q = _query.trim().toLowerCase();
  const list = _colleagues.filter((c) => !q || String(c.name).toLowerCase().indexOf(q) >= 0 || String(c.number).indexOf(q) >= 0);
  const managers = list.filter((c) => c.manager);
  const others = list.filter((c) => !c.manager);
  const transfer = _mode.kind === 'transfer';

  const row = (c) => html`<button class="pick-row" type="button" data-pick-number="${c.number}" data-pick-name="${c.name}">
    <span class="avatar avatar--sm" aria-hidden="true">${initials(c.name)}</span>
    <span class="pick-body">
      <span class="pick-name">${c.name}${c.manager ? html` <span class="tag tag--ok"><span class="tag-dot" aria-hidden="true"></span>Manager</span>` : ''}</span>
      <span class="pick-sub">${formatNumber(c.number) || c.number} · ${c.numberKind}${c.lines && c.lines.length ? ' · ' + c.lines.join(', ') : ''}</span>
    </span>
    <span class="pick-action">${transfer ? 'Transférer' : 'Appeler'}</span>
  </button>`;

  mount(panel, html`<div class="pick-head">
      <span class="pick-title">${transfer ? 'Transférer l’appel à…' : 'Appeler un collègue'}</span>
      ${transfer ? html`<label class="field field--grow" for="cb-transfer-number">${raw(icon('phone'))}<input id="cb-transfer-number" type="tel" inputmode="tel" autocomplete="off" placeholder="ou un numéro"></label>
        <button class="btn btn--sm" type="button" id="cb-transfer-go">Transférer</button>` : ''}
      <label class="field" for="cb-search">${raw(icon('search'))}<input id="cb-search" type="search" autocomplete="off" placeholder="Rechercher" value="${_query}"></label>
      <button class="btn btn--icon btn--ghost" type="button" id="cb-pick-close" aria-label="Fermer">${raw(icon('close'))}</button>
    </div>
    ${managers.length ? html`<p class="pick-group">Managers</p>${managers.map((c) => raw(row(c)))}` : ''}
    ${others.length ? html`<p class="pick-group">Collègues</p>${others.map((c) => raw(row(c)))}` : ''}
    ${!list.length ? html`<p class="pick-empty">Aucun collègue ne correspond.</p>` : ''}`);

  const search = /** @type {HTMLInputElement|null} */ (qs('#cb-search', panel));
  if (search && document.activeElement !== search && !q) search.focus();
}

/** Ligne d'information sous la barre : erreurs d'action, etat du journal. */
function paintNote() {
  const el = qs('#cb-note', _host || undefined);
  if (!el) return;
  const j = journal.status();
  let text = _note.text;
  let tone = _note.tone;
  if (!text) {
    if (!j.enabled) { text = 'Journal d’attribution indisponible sur ce déploiement : vos actions ne seront pas conservées.'; tone = 'warn'; }
    else if (j.lastError) { text = 'Journal : envoi en attente (' + j.lastError + ').'; tone = 'warn'; }
    else if (j.pending) { text = j.pending + ' fait(s) en attente d’envoi.'; tone = ''; }
  }
  el.textContent = text;
  el.className = 'callbar-note' + (tone ? ' is-' + tone : '');
}

/** @param {string} text @param {string} [tone] */
function note(text, tone) {
  _note = { text: text || '', tone: tone || '' };
  paintNote();
  if (text) window.setTimeout(function () { if (_note.text === text) { _note = { text: '', tone: '' }; paintNote(); } }, 8000);
}

/** @param {string} name */
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('') || '?';
}

// -----------------------------------------------------------------------------
//  Actions
// -----------------------------------------------------------------------------

function wire() {
  if (!_host) return;

  on(_host, 'click', '#cb-toggle', function () {
    _collapsed = !_collapsed;
    try { localStorage.setItem('keyyo.callbar.collapsed', _collapsed ? '1' : '0'); } catch (err) { /* stockage indisponible */ }
    const root = qs('#cb-root', _host);
    const body = qs('#cb-body', _host);
    const btn = qs('#cb-toggle', _host);
    if (root) root.classList.toggle('is-collapsed', _collapsed);
    if (body) body.hidden = _collapsed;
    if (btn) { btn.textContent = _collapsed ? 'Afficher' : 'Réduire'; btn.setAttribute('aria-expanded', _collapsed ? 'false' : 'true'); }
  });

  on(_host, 'click', '[data-choose-line]', function (ev, el) {
    const csi = el.getAttribute('data-choose-line') || '';
    if (csi) run('line', function () { return cti.chooseLine(csi); });
  });

  on(_host, 'click', '#cb-dial', function () { dialFromInput(); });
  on(_host, 'keydown', '#cb-number', function (ev) {
    if (/** @type {KeyboardEvent} */ (ev).key === 'Enter') { ev.preventDefault(); dialFromInput(); }
  });

  on(_host, 'click', '#cb-pick', function () {
    _mode = { kind: 'dial', callref: '' };
    _pickerOpen = !_pickerOpen;
    paintPicker();
  });
  on(_host, 'click', '#cb-pick-close', function () { _pickerOpen = false; _mode = { kind: 'dial', callref: '' }; paintPicker(); });
  on(_host, 'input', '#cb-search', function (ev, el) { _query = /** @type {HTMLInputElement} */ (el).value; paintPicker(); });

  on(_host, 'click', '[data-pick-number]', function (ev, el) {
    const number = el.getAttribute('data-pick-number') || '';
    const name = el.getAttribute('data-pick-name') || number;
    if (!number) return;
    if (_mode.kind === 'transfer') {
      const ref = _mode.callref;
      run(ref, function () { return cti.transfer(ref, number, { supervised: false }); }, 'Appel transféré à ' + name + '.');
      _pickerOpen = false;
      _mode = { kind: 'dial', callref: '' };
      paintPicker();
    } else {
      const input = /** @type {HTMLInputElement|null} */ (qs('#cb-number', _host));
      if (input) input.value = number;
      _pickerOpen = false;
      paintPicker();
      run('dial', function () { return cti.dial(number); }, 'Appel vers ' + name + ' lancé.');
    }
  });

  on(_host, 'click', '#cb-transfer-go', function () { transferFromInput(); });
  on(_host, 'keydown', '#cb-transfer-number', function (ev) {
    if (/** @type {KeyboardEvent} */ (ev).key === 'Enter') { ev.preventDefault(); transferFromInput(); }
  });

  on(_host, 'click', '[data-call-answer]', function (ev, el) {
    const ref = el.getAttribute('data-call-answer') || '';
    run(ref, function () { return cti.answer(ref); }, 'Appel décroché.');
  });
  on(_host, 'click', '[data-call-hangup]', function (ev, el) {
    const ref = el.getAttribute('data-call-hangup') || '';
    run(ref, function () { return cti.hangup(ref); });
  });
  on(_host, 'click', '[data-call-transfer]', function (ev, el) {
    const ref = el.getAttribute('data-call-transfer') || '';
    _mode = { kind: 'transfer', callref: ref };
    _pickerOpen = true;
    paintPicker();
  });
  on(_host, 'click', '[data-call-claim]', function (ev, el) {
    const ref = el.getAttribute('data-call-claim') || '';
    try {
      cti.claim(ref);
      note('Appel attribué à vous. Merci !', 'ok');
    } catch (err) {
      note(messageOf(err), 'error');
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && _pickerOpen) { _pickerOpen = false; _mode = { kind: 'dial', callref: '' }; paintPicker(); }
  });
}

function dialFromInput() {
  const input = /** @type {HTMLInputElement|null} */ (qs('#cb-number', _host || undefined));
  const number = input ? input.value.trim() : '';
  if (!number) { note('Saisir un numéro à appeler.', 'warn'); if (input) input.focus(); return; }
  run('dial', function () { return cti.dial(number); }, 'Appel vers ' + (_labelOf(number) || number) + ' lancé.').then(function (ok) {
    if (ok && input) input.value = '';
  });
}

function transferFromInput() {
  const input = /** @type {HTMLInputElement|null} */ (qs('#cb-transfer-number', _host || undefined));
  const number = input ? input.value.trim() : '';
  if (!number) { note('Saisir le numéro de destination.', 'warn'); if (input) input.focus(); return; }
  const ref = _mode.callref;
  run(ref, function () { return cti.transfer(ref, number, { supervised: false }); }, 'Appel transféré vers ' + number + '.');
  _pickerOpen = false;
  _mode = { kind: 'dial', callref: '' };
  paintPicker();
}

/**
 * Execute une action en bloquant les boutons concernes, et rend compte.
 * @param {string} key   identifiant de ce qui est occupe (callref, 'dial', 'line').
 * @param {() => Promise<any>} fn
 * @param {string} [success]
 * @returns {Promise<boolean>}
 */
async function run(key, fn, success) {
  _busy = key;
  paint(cti.snapshot());
  try {
    await fn();
    if (success) { note(success, 'ok'); _toast({ title: success, tone: 'ok' }); }
    return true;
  } catch (err) {
    const msg = messageOf(err);
    note(msg, 'error');
    _toast({ title: 'Action impossible', sub: msg, tone: 'error' });
    return false;
  } finally {
    _busy = '';
    paint(cti.snapshot());
  }
}

/** @param {unknown} err @returns {string} */
function messageOf(err) {
  const e = /** @type {any} */ (err);
  return e && e.message ? String(e.message) : String(e || 'erreur inconnue');
}
