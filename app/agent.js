// =============================================================================
//  app/agent.js — La page agent : mes appels, ma ligne, mes collegues.
//
//  Trois colonnes, comme une messagerie : a gauche moi et ma ligne, au centre
//  la liste (appels d'aujourd'hui, ou collegues), a droite le detail de ce qui
//  est choisi — ou mon activite du mois quand rien ne l'est. Par-dessus, une
//  FENETRE D'APPEL sombre des que ca sonne ou qu'on est en ligne, et un
//  composeur pour appeler ou transferer.
//
//  La page ne calcule rien de la telephonie : app/cti.js tient l'etat et
//  execute les actions ; app/journal.js envoie les faits. Ici on ne fait que
//  repeindre, et decider ce qui merite d'etre mis en avant.
//
//  CE QU'ELLE MONTRE, ET D'OU CA VIENT
//    - ma ligne          : /api/cti-token (l'annuaire Keyyo rattache mon adresse)
//    - mes collegues     : /api/me (noms et numeros, jamais d'adresses)
//    - mes appels        : la ligne vue par le CTI depuis l'ouverture de la
//                          page, completee des appels observes plus tot dans
//                          la journee par mon propre journal
//    - mon activite      : /api/events?scope=me — ce que J'AI fait ou declare
//    - les noms          : /api/directory
//
//  Toute chaine venue de Keyyo passe par le gabarit `html` : ce sont des
//  donnees exterieures, hostiles par defaut.
// =============================================================================

import * as session from './session.js';
import * as cti from './cti.js';
import * as journal from './journal.js';
import { getProfile, getDirectory } from './api.js';
import { qs, on, html, raw, mount, icon } from './dom.js';
import { fmtInt, fmtDurationShort, fmtRelative, pluralize, fmtDate, fmtTime } from './format.js';
import { card, notice, empty, skeleton, tag } from './ui.js';
import { toE164, formatNumber, numberKind } from '../shared/phone.js';
import { initialsOf } from '../shared/identity.js';
import { monthOf } from '../shared/journal.js';
import { toast } from './alerts.js';

/** Rafraichissement de « mon activite », en millisecondes. */
const REFRESH_MS = 60000;

/** Nature d'un numero, en francais. */
const KIND_LABELS = {
  anonymous: 'Appelant masqué',
  internal: 'Poste interne',
  mobile: 'Mobile',
  fixe: 'Fixe',
  special: 'Numéro spécial',
  international: 'International',
  inconnu: 'Numéro',
};

// -----------------------------------------------------------------------------
//  Etat
// -----------------------------------------------------------------------------

/** @type {Map<string, string>} annuaire numero E.164 -> nom */
let _names = new Map();
/** @type {any} profil /api/me */
let _profile = null;
let _month = '';
let _timer = 0;
/** @type {{loading: boolean, error: string, events: any[], summary: any, at: string}} */
let _activity = { loading: true, error: '', events: [], summary: null, at: '' };

/** Onglet de la liste : appels ou collegues. */
let _tab = /** @type {'calls'|'people'} */ ('calls');
/** Filtre de la liste d'appels. */
let _filter = /** @type {'all'|'missed'|'in'|'out'} */ ('all');
/** Element choisi : un appel (callref) ou un collegue (index). */
let _selected = /** @type {{kind: ''|'call'|'colleague', id: string}} */ ({ kind: '', id: '' });

/** Fenetre d'appel : reduite en pastille, ou fermee pour tel appel. */
let _popupMin = false;
/** @type {Set<string>} */
const _popupClosed = new Set();

/** Composeur. */
let _dialer = /** @type {{open: boolean, mode: 'dial'|'transfer', callref: string, query: string}} */ ({ open: false, mode: 'dial', callref: '', query: '' });

/** Action en cours, pour desactiver les boutons concernes. */
let _busy = '';
let _frame = 0;

// -----------------------------------------------------------------------------
//  Ecran de connexion (meme coquille que index.html)
// -----------------------------------------------------------------------------

/** @param {{state: string, user?: any, message?: string}} s */
function showGate(s) {
  const gate = qs('#gate');
  const title = qs('#gate-title');
  const text = qs('#gate-text');
  const actions = qs('#gate-actions');
  const foot = qs('#gate-foot');
  if (!gate || !title || !text || !actions || !foot) return;

  let t = 'Connexion';
  let body = 'Vérification de la session…';
  let buttons = '';
  let note = '';
  if (s.state === 'unconfigured') {
    t = 'Application fermée';
    body = s.message || 'La connexion Microsoft n\'est pas configurée sur ce déploiement.';
  } else if (s.state === 'error') {
    t = 'Serveur injoignable';
    body = s.message || 'Impossible de vérifier la session.';
    buttons = html`<button class="btn btn--primary" type="button" data-gate-retry>Réessayer</button>`;
  } else if (s.state === 'anonymous') {
    body = 'Connectez-vous avec votre compte Microsoft de l\'organisation pour ouvrir votre ligne.';
    buttons = html`<a class="btn btn--primary" href="${session.loginUrl()}">Se connecter avec Microsoft</a>`;
    note = 'La connexion se fait sur la page de Microsoft ; l\'application ne voit jamais votre mot de passe.';
  }
  title.textContent = t;
  text.textContent = body;
  mount(actions, buttons);
  foot.textContent = note;
  gate.hidden = false;
  document.body.classList.add('is-gated');
  const app = qs('#app');
  if (app) app.setAttribute('aria-hidden', 'true');
}

function hideGate() {
  const gate = qs('#gate');
  if (gate) gate.hidden = true;
  document.body.classList.remove('is-gated');
  const app = qs('#app');
  if (app) app.removeAttribute('aria-hidden');
}

// -----------------------------------------------------------------------------
//  Noms, avatars, libelles
// -----------------------------------------------------------------------------

/** @param {string} number @returns {string} nom connu, sinon numero formate. */
function labelOf(number) {
  if (number === 'anonymous') return 'Appelant masqué';
  const key = toE164(number);
  if (key && key !== 'anonymous') {
    const hit = _names.get(key);
    if (hit) return hit;
  }
  const c = colleagueByNumber(number);
  if (c) return c.name;
  return formatNumber(number);
}

/** @param {string} number @returns {any|null} */
function colleagueByNumber(number) {
  if (!_profile || !Array.isArray(_profile.colleagues)) return null;
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return null;
  return _profile.colleagues.find((x) => String(x.number || '').replace(/\D/g, '') === digits) || null;
}

/** @param {string} label @returns {number} teinte stable, 0-359. */
function hueOf(label) {
  let h = 0;
  const s = String(label || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/**
 * @param {string} label
 * @param {'sm'|'md'|'lg'} [size]
 * @param {boolean} [dark]
 * @returns {string}
 */
function avatarOf(label, size, dark) {
  const cls = 'ag-avatar' + (size === 'lg' ? ' ag-avatar--lg' : (size === 'sm' ? ' ag-avatar--sm' : '')) + (dark ? ' ag-avatar--dark' : '');
  const ini = /^\+?\d/.test(String(label || '')) ? '#' : (initialsOf(label) || '?');
  return html`<span class="${cls}" style="--hue:${hueOf(label)}" aria-hidden="true">${ini}</span>`;
}

/** @param {number} unix @returns {string} `HH:MM` si aujourd'hui, sinon `jj/mm`. */
function whenOf(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const now = new Date();
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return same ? fmtTime(d.getHours(), d.getMinutes()) : fmtDate(d.toISOString().slice(0, 10));
}

/** @param {number} sec @returns {string} `m:ss` */
function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

// -----------------------------------------------------------------------------
//  Appels : la liste unifiee
// -----------------------------------------------------------------------------

/**
 * @typedef {object} CallItem
 * @property {string} callref
 * @property {'in'|'out'} dir
 * @property {string} peer
 * @property {string} state
 * @property {number} ring
 * @property {number} duration
 * @property {boolean} answered
 * @property {boolean} mine
 * @property {boolean} claimed
 * @property {boolean} live
 * @property {number} ts
 */

/** @returns {CallItem[]} appels vivants d'abord, puis du plus recent au plus ancien. */
function callItems() {
  const snap = cti.snapshot();
  /** @type {Map<string, CallItem>} */
  const map = new Map();
  for (const c of snap.calls) {
    map.set(c.callref, {
      callref: c.callref, dir: c.dir, peer: c.peer, state: c.state,
      ring: c.ring, duration: c.duration, answered: c.answered,
      mine: c.mine, claimed: c.claimed,
      live: c.state === 'SETUP' || c.state === 'CONNECT',
      ts: c.setupAt,
    });
  }
  // Les appels observes plus tot aujourd'hui par mon propre navigateur.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const since = Math.floor(start.getTime() / 1000);
  for (const e of _activity.events) {
    if (e.type !== 'observed' || !e.callref || Number(e.ts) < since || map.has(e.callref)) continue;
    map.set(e.callref, {
      callref: e.callref, dir: e.dir === 'out' ? 'out' : 'in', peer: e.peer || 'anonymous',
      state: e.answered === 1 ? 'RELEASE' : (e.dir === 'out' ? 'RELEASE' : 'MISSED'),
      ring: Number(e.ring) || 0, duration: Number(e.duration) || 0, answered: e.answered === 1,
      mine: false, claimed: false, live: false, ts: Number(e.ts) || 0,
    });
  }
  for (const e of _activity.events) {
    if ((e.type === 'answer' || e.type === 'claim') && map.has(e.callref)) {
      const it = map.get(e.callref);
      it.mine = true;
      if (e.type === 'claim') it.claimed = true;
    }
  }
  const rank = { SETUP: 0, CONNECT: 1 };
  return Array.from(map.values()).sort((a, b) => {
    const ra = a.live ? rank[a.state] : 2;
    const rb = b.live ? rank[b.state] : 2;
    return (ra - rb) || (b.ts - a.ts);
  });
}

/** @param {CallItem} c @returns {{text: string, icon: string, cls: string}} */
function statusOf(c) {
  const missed = c.state === 'MISSED' || (!c.live && !c.answered && c.dir === 'in');
  if (c.state === 'SETUP') {
    return c.dir === 'in'
      ? { text: 'Appel entrant · sonne depuis ' + clock(c.ring), icon: 'in', cls: 'is-live' }
      : { text: 'Appel sortant · sonne ' + clock(c.ring), icon: 'out', cls: 'is-live' };
  }
  if (c.state === 'CONNECT') return { text: 'En ligne · ' + clock(c.duration), icon: 'phone', cls: 'is-live' };
  if (missed) return { text: 'Appel manqué' + (c.ring ? ' · ' + c.ring + ' s de sonnerie' : ''), icon: 'missed', cls: 'is-missed' };
  if (c.dir === 'in') {
    return { text: (c.mine ? 'Pris par vous' : 'Appel reçu') + (c.duration ? ' · ' + fmtDurationShort(c.duration) : ''), icon: 'in', cls: 'is-in' };
  }
  return { text: (c.answered ? 'Appel émis' : 'Sans réponse') + (c.duration ? ' · ' + fmtDurationShort(c.duration) : ''), icon: 'out', cls: 'is-out' };
}

/** @param {CallItem} c @returns {boolean} */
function passesFilter(c) {
  if (_filter === 'all') return true;
  if (_filter === 'missed') return c.state === 'MISSED' || (!c.live && !c.answered && c.dir === 'in');
  return c.dir === _filter;
}

// -----------------------------------------------------------------------------
//  Rendu : barre laterale
// -----------------------------------------------------------------------------

function paintSide() {
  const u = session.current().user;
  const name = qs('#ag-user-name');
  const role = qs('#ag-user-role');
  const av = qs('#ag-user-avatar');
  if (name && u) { name.textContent = u.name; name.setAttribute('title', u.email); }
  if (role && u) role.textContent = u.roleLabel;
  if (av && u) mount(av, avatarOf(u.name, 'sm'));

  const link = qs('#link-supervision');
  if (link) link.hidden = !session.isDirection();

  const snap = cti.snapshot();
  const badge = qs('#ag-nav-live');
  if (badge) { badge.hidden = !snap.active; badge.textContent = String(snap.active); }

  const host = qs('#ag-line');
  if (!host) return;
  const line = snap.line || (_profile && _profile.line) || null;
  let dot = 'ag-dot';
  let state = '';
  if (snap.status === 'connected') { dot += ' ag-dot--ok'; state = 'connectée'; }
  else if (snap.status === 'loading' || snap.status === 'connecting') { dot += ' ag-dot--busy'; state = snap.message || 'connexion…'; }
  else if (snap.status === 'needs-line') { dot += ' ag-dot--busy'; state = 'à choisir'; }
  else { dot += ' ag-dot--bad'; state = snap.status === 'idle' ? 'fermée' : 'indisponible'; }

  const parts = [];
  parts.push(html`<div class="ag-line-head"><span class="${dot}" aria-hidden="true"></span><span class="ag-line-name">${line ? line.label : 'Ma ligne'}</span><span class="ag-line-state">${state}</span></div>`);
  if (line && line.number) parts.push(html`<div class="ag-line-number">${line.number}</div>`);
  if (line && line.members) parts.push(html`<div class="ag-line-sub">${fmtInt(line.members)} ${pluralize(line.members, 'personne partage', 'personnes partagent')} cette ligne : un appel entrant sonne pour toute l’équipe.</div>`);
  if (snap.status === 'error' || snap.status === 'disconnected') {
    parts.push(html`<div class="ag-line-msg">${snap.message || 'La ligne ne répond pas.'}</div>`);
    parts.push(html`<div class="ag-line-actions"><button class="btn btn--sm" type="button" data-act="retry-line">Réessayer</button></div>`);
  }
  if (snap.status === 'needs-line' || (snap.status === 'error' && snap.lines.length > 1 && !snap.line)) {
    parts.push(html`<div class="ag-line-sub">${snap.status === 'needs-line' ? snap.message : 'Choisir une ligne :'}</div>`);
    parts.push(html`<div class="ag-line-actions">${snap.lines.map((l) => raw(html`<button class="btn btn--sm" type="button" data-choose-line="${l.csi}">${l.label}${l.members ? raw(html` <span class="faint">(${l.members})</span>`) : ''}</button>`))}</div>`);
  }
  mount(host, parts.join(''));

  const newcall = /** @type {HTMLButtonElement|null} */ (qs('#ag-newcall'));
  if (newcall) newcall.disabled = !snap.connected;
}

// -----------------------------------------------------------------------------
//  Rendu : liste
// -----------------------------------------------------------------------------

function paintList() {
  const title = qs('#ag-list-title-text');
  const head = qs('#ag-list-filters');
  const body = qs('#ag-list');
  if (!title || !head || !body) return;

  for (const el of Array.from(document.querySelectorAll('[data-tab]'))) {
    el.classList.toggle('is-active', el.getAttribute('data-tab') === _tab);
  }

  if (_tab === 'people') {
    title.textContent = 'Collègues';
    mount(head, '');
    const list = _profile && Array.isArray(_profile.colleagues) ? _profile.colleagues : [];
    if (!list.length) {
      mount(body, html`<div class="ag-empty">${raw(empty('Aucun collègue à proposer', 'L’annuaire Keyyo ne rattache personne à vos lignes.'))}</div>`);
      return;
    }
    const managers = list.filter((c) => c.manager);
    const others = list.filter((c) => !c.manager);
    const row = (c, i) => html`<button class="ag-row${_selected.kind === 'colleague' && _selected.id === String(i) ? ' is-selected' : ''}" type="button" data-colleague="${i}">
      ${raw(avatarOf(c.name))}
      <span class="ag-row-body">
        <span class="ag-row-name">${c.name}</span>
        <span class="ag-row-status">${c.manager ? raw(tag('Manager', 'ok')) : ''}${formatNumber(c.number) || c.number} · ${c.numberKind}</span>
      </span>
      <span class="ag-row-time">${c.lines && c.lines.length ? c.lines[0] : ''}</span>
    </button>`;
    mount(body, html`${managers.length ? raw(html`<p class="dl-group">Managers</p>`) : ''}${managers.map((c) => raw(row(c, list.indexOf(c))))}
      ${others.length ? raw(html`<p class="dl-group">Collègues</p>`) : ''}${others.map((c) => raw(row(c, list.indexOf(c))))}`);
    return;
  }

  title.textContent = 'Appels';
  const filters = [['all', 'Tous'], ['missed', 'Manqués'], ['in', 'Entrants'], ['out', 'Sortants']];
  mount(head, html`<div class="segmented" role="group" aria-label="Filtre">${filters.map(([k, l]) => raw(html`<button type="button" data-filter="${k}" class="${k === _filter ? 'is-active' : ''}">${l}</button>`))}</div>`);

  const items = callItems().filter(passesFilter);
  if (!items.length) {
    const snap = cti.snapshot();
    mount(body, html`<div class="ag-empty">${raw(empty(
      snap.connected ? 'Aucun appel pour l’instant' : 'La ligne n’est pas connectée',
      snap.connected
        ? 'Les appels de votre ligne apparaîtront ici dès qu’ils sonneront.'
        : (snap.status === 'error' || snap.status === 'disconnected'
          ? 'La raison est indiquée sous « Ma ligne », à gauche.'
          : 'Dès que la ligne sera connectée, ses appels s’afficheront ici.'),
    ))}</div>`);
    return;
  }
  mount(body, items.map((c) => raw(callRow(c))).join(''));
}

/** @param {CallItem} c @returns {string} */
function callRow(c) {
  const label = labelOf(c.peer);
  const st = statusOf(c);
  const selected = _selected.kind === 'call' && _selected.id === c.callref;
  return html`<button class="ag-row${c.live ? ' is-live' : ''}${selected ? ' is-selected' : ''}" type="button" data-call="${c.callref}">
    ${raw(avatarOf(label))}
    <span class="ag-row-body">
      <span class="ag-row-name">${label}</span>
      <span class="ag-row-status ${st.cls}">${raw(icon(st.icon))}${st.text}</span>
    </span>
    <span class="ag-row-time">${whenOf(c.ts)}</span>
  </button>`;
}

// -----------------------------------------------------------------------------
//  Rendu : panneau principal
// -----------------------------------------------------------------------------

function paintMain() {
  const host = qs('#ag-main');
  if (!host) return;

  if (_selected.kind === 'call') {
    const c = callItems().find((x) => x.callref === _selected.id);
    if (c) { mount(host, callDetail(c)); return; }
    _selected = { kind: '', id: '' };
  }
  if (_selected.kind === 'colleague') {
    const list = _profile && Array.isArray(_profile.colleagues) ? _profile.colleagues : [];
    const c = list[Number(_selected.id)];
    if (c) { mount(host, colleagueDetail(c)); return; }
    _selected = { kind: '', id: '' };
  }
  mount(host, activityView());
}

/** @param {CallItem} c @returns {string} */
function callDetail(c) {
  const label = labelOf(c.peer);
  const number = c.peer === 'anonymous' ? '' : formatNumber(c.peer);
  const kind = KIND_LABELS[numberKind(c.peer)] || KIND_LABELS.inconnu;
  const st = statusOf(c);
  const snap = cti.snapshot();
  const busy = _busy === c.callref;

  const actions = [];
  if (c.state === 'SETUP' && c.dir === 'in') {
    actions.push(html`<button class="btn btn--answer btn--lg" type="button" data-act="answer" data-ref="${c.callref}"${busy ? ' disabled' : ''}>${raw(icon('in'))}Accepter</button>`);
    actions.push(html`<button class="btn btn--reject btn--lg" type="button" data-act="reject" data-ref="${c.callref}"${busy ? ' disabled' : ''}>${raw(icon('missed'))}Rejeter</button>`);
  }
  if (c.live) {
    actions.push(html`<button class="btn btn--lg" type="button" data-act="transfer" data-ref="${c.callref}"${busy ? ' disabled' : ''}>${raw(icon('peers'))}Transférer</button>`);
    if (!(c.state === 'SETUP' && c.dir === 'in')) {
      actions.push(html`<button class="btn btn--reject btn--lg" type="button" data-act="hangup" data-ref="${c.callref}"${busy ? ' disabled' : ''}>${raw(icon('close'))}Raccrocher</button>`);
    }
  } else if (c.peer && c.peer !== 'anonymous') {
    actions.push(html`<button class="btn btn--accent btn--lg" type="button" data-act="dial" data-number="${c.peer}"${!snap.connected || _busy === 'dial' ? ' disabled' : ''}>${raw(icon('out'))}${c.dir === 'in' && !c.answered ? 'Rappeler' : 'Appeler'}</button>`);
  }
  if (c.dir === 'in' && c.answered && !c.mine && !c.claimed && (c.state === 'CONNECT' || !c.live)) {
    actions.push(html`<button class="btn btn--ghost btn--lg" type="button" data-act="claim" data-ref="${c.callref}" title="Je l’ai décroché sur mon téléphone">${raw(icon('check'))}C’est moi qui ai répondu</button>`);
  }

  const facts = [];
  facts.push(['Ligne', snap.line ? snap.line.label : '—']);
  facts.push(['Sonnerie', c.ring || c.state === 'SETUP' ? clock(c.ring) : '—']);
  if (c.answered && c.state !== 'SETUP') facts.push(['Durée', c.state === 'CONNECT' ? clock(c.duration) + ' (en cours)' : (c.duration ? fmtDurationShort(c.duration) : '—')]);
  facts.push(['Heure', c.ts ? whenOf(c.ts) : '—']);
  if (c.dir === 'in' && c.answered) facts.push(['Pris par', c.mine ? 'vous' : 'non attribué']);

  return html`<div class="ag-detail-head">
      ${raw(avatarOf(label, 'lg'))}
      <div>
        <h2 class="ag-detail-name">${label}</h2>
        <p class="ag-detail-sub">${number ? number + ' · ' : ''}${kind}</p>
        <div class="ag-detail-state"><span class="ag-row-status ${st.cls}">${raw(icon(st.icon))}${st.text}</span></div>
      </div>
    </div>
    <div class="ag-actions">${raw(actions.join(''))}</div>
    <div class="ag-facts">${facts.map(([l, v]) => raw(html`<div class="ag-fact"><div class="ag-fact-label">${l}</div><div class="ag-fact-value">${v}</div></div>`))}</div>`;
}

/** @param {any} c @returns {string} */
function colleagueDetail(c) {
  const snap = cti.snapshot();
  const live = snap.calls.find((x) => x.state === 'CONNECT' || x.state === 'SETUP');
  return html`<div class="ag-detail-head">
      ${raw(avatarOf(c.name, 'lg'))}
      <div>
        <h2 class="ag-detail-name">${c.name}</h2>
        <p class="ag-detail-sub">${formatNumber(c.number) || c.number} · ${c.numberKind}${c.lines && c.lines.length ? ' · ' + c.lines.join(', ') : ''}</p>
        <div class="ag-detail-state">${c.manager ? raw(tag('Manager', 'ok')) : raw(tag('Collègue', 'neutral'))}</div>
      </div>
    </div>
    <div class="ag-actions">
      <button class="btn btn--accent btn--lg" type="button" data-act="dial" data-number="${c.number}"${!snap.connected || _busy === 'dial' ? ' disabled' : ''}>${raw(icon('out'))}Appeler</button>
      ${live ? raw(html`<button class="btn btn--lg" type="button" data-act="transfer-to" data-ref="${live.callref}" data-number="${c.number}">${raw(icon('peers'))}Lui transférer l’appel en cours</button>`) : ''}
    </div>`;
}

/** @returns {string} */
function activityView() {
  const a = _activity;
  if (a.loading) return html`<h2 class="ag-detail-name">Mon activité</h2>${raw(skeleton('card'))}${raw(skeleton('card'))}`;

  const head = html`<div><h2 class="ag-detail-name">Mon activité</h2><p class="ag-detail-sub">${monthLabel(_month)} · ce que vous avez fait ou déclaré depuis l’application${a.at ? ' · mis à jour ' + fmtRelative(a.at) : ''}</p></div>`;

  if (a.error) {
    return head + notice({ tone: 'warn', title: 'Journal indisponible.', body: html`${a.error}` });
  }

  const s = a.summary;
  const me = s && s.agents && s.agents[0] ? s.agents[0] : null;
  const taken = me ? me.taken : 0;
  const dialed = me ? me.dialed : 0;
  const transferred = me ? me.transferred : 0;
  const ringAvg = me && me.ringCount ? Math.round(me.ringTotal / me.ringCount) : 0;

  const kpis = html`<div class="ag-kpis">
    <div class="ag-kpi ag-kpi--in"><div class="ag-kpi-value">${fmtInt(taken)}</div><div class="ag-kpi-label">${pluralize(taken, 'appel pris', 'appels pris')}</div></div>
    <div class="ag-kpi ag-kpi--out"><div class="ag-kpi-value">${fmtInt(dialed)}</div><div class="ag-kpi-label">${pluralize(dialed, 'appel émis', 'appels émis')}</div></div>
    <div class="ag-kpi"><div class="ag-kpi-value">${fmtInt(transferred)}</div><div class="ag-kpi-label">${pluralize(transferred, 'transfert', 'transferts')}</div></div>
    <div class="ag-kpi ag-kpi--accent"><div class="ag-kpi-value">${ringAvg ? clock(ringAvg) : '—'}</div><div class="ag-kpi-label">sonnerie moyenne avant décroché</div></div>
  </div>`;

  const callees = me && me.callees.length
    ? html`<div class="ag-simple">${me.callees.slice(0, 8).map((c) => raw(html`<div class="ag-simple-row">
        ${raw(avatarOf(labelOf(c.to), 'sm'))}
        <div><div class="ag-simple-main">${labelOf(c.to)}</div><div class="ag-simple-sub">${formatNumber(c.to)}</div></div>
        <div class="ag-simple-metric">${fmtInt(c.count)}</div>
      </div>`))}</div>`
    : empty('Aucun appel émis ce mois-ci', 'Les appels lancés depuis cette page apparaîtront ici, avec leur destinataire.');

  const mine = a.events.filter((e) => e.type !== 'observed').slice(-10).reverse();
  const rows = mine.map((e) => {
    let what = '';
    let ico = 'phone';
    if (e.type === 'dial') { what = 'Appel émis vers ' + labelOf(e.to); ico = 'out'; }
    else if (e.type === 'answer') { what = 'Décroché ici · ' + labelOf(e.peer); ico = 'in'; }
    else if (e.type === 'claim') { what = 'Déclaré pris · ' + labelOf(e.peer); ico = 'check'; }
    else if (e.type === 'transfer') { what = 'Transféré vers ' + labelOf(e.to); ico = 'peers'; }
    else if (e.type === 'hangup') { what = 'Raccroché'; ico = 'close'; }
    const extra = e.ring ? ' · sonnerie ' + clock(e.ring) : '';
    return html`<div class="ag-simple-row">${raw(icon(ico))}
      <div><div class="ag-simple-main">${what}</div><div class="ag-simple-sub">${whenOf(Number(e.ts))}${extra}</div></div>
      <div></div></div>`;
  });

  const warn = _profile && Array.isArray(_profile.warnings) && _profile.warnings.length
    ? notice({ tone: 'warn', title: 'À savoir.', body: html`${_profile.warnings.join(' ')}` })
    : '';

  return head + kpis
    + card({ title: 'Vers qui j’appelle', sub: 'Depuis l’application, ce mois-ci', body: raw(callees) })
    + card({ title: 'Derniers faits', body: raw(rows.length ? html`<div class="ag-simple">${rows.map((r) => raw(r))}</div>` : empty('Rien pour l’instant', 'Vos actions sur les appels seront listées ici.')) })
    + warn;
}

/** @param {string} ym @returns {string} */
function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const names = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  return names[Number(m[2]) - 1] + ' ' + m[1];
}

// -----------------------------------------------------------------------------
//  Rendu : fenetre d'appel
// -----------------------------------------------------------------------------

/** @returns {CallItem|null} l'appel a mettre en avant : entrant qui sonne, sinon le premier vivant. */
function primaryCall() {
  const live = callItems().filter((c) => c.live);
  if (!live.length) return null;
  return live.find((c) => c.state === 'SETUP' && c.dir === 'in') || live[0];
}

function paintPopup() {
  const popup = qs('#call-popup');
  const pill = qs('#call-pill');
  if (!popup || !pill) return;

  const c = primaryCall();
  if (!c) {
    popup.hidden = true;
    pill.hidden = true;
    _popupMin = false;
    _popupClosed.clear();
    return;
  }
  if (_popupClosed.has(c.callref)) { popup.hidden = true; pill.hidden = true; return; }

  const label = labelOf(c.peer);
  const number = c.peer === 'anonymous' ? '' : formatNumber(c.peer);
  const snap = cti.snapshot();

  if (_popupMin) {
    popup.hidden = true;
    pill.hidden = false;
    mount(pill, html`<span class="ag-dot ag-dot--busy" aria-hidden="true"></span><span>${label}</span><span class="call-pill-timer">${c.state === 'CONNECT' ? clock(c.duration) : clock(c.ring)}</span>${raw(icon('chevron'))}`);
    return;
  }
  pill.hidden = true;
  popup.hidden = false;

  const ringingIn = c.state === 'SETUP' && c.dir === 'in';
  const busy = _busy === c.callref;
  let kicker = ringingIn ? 'Appel entrant' : (c.state === 'SETUP' ? 'Appel sortant' : 'En ligne');
  let sub = ringingIn ? 'vous appelle' : (c.state === 'SETUP' ? 'sonne…' : 'en conversation');
  let timer = c.state === 'CONNECT' ? clock(c.duration) : clock(c.ring);

  const actions = [];
  if (ringingIn) {
    actions.push(html`<button class="btn btn--reject" type="button" data-act="reject" data-ref="${c.callref}"${busy ? ' disabled' : ''}>${raw(icon('missed'))}Rejeter</button>`);
    actions.push(html`<button class="btn btn--answer" type="button" data-act="answer" data-ref="${c.callref}"${busy ? ' disabled' : ''}>${raw(icon('in'))}Accepter</button>`);
  } else {
    actions.push(html`<button class="btn btn--ghost" type="button" data-act="transfer" data-ref="${c.callref}"${busy ? ' disabled' : ''}>${raw(icon('peers'))}Transférer</button>`);
    actions.push(html`<button class="btn btn--reject" type="button" data-act="hangup" data-ref="${c.callref}"${busy ? ' disabled' : ''}>${raw(icon('close'))}Raccrocher</button>`);
  }

  const facts = [];
  if (number) facts.push(['Numéro', number]);
  facts.push(['Type', KIND_LABELS[numberKind(c.peer)] || KIND_LABELS.inconnu]);
  facts.push(['Ligne', snap.line ? snap.line.label : '—']);
  if (c.state === 'CONNECT' && c.ring) facts.push(['Décroché après', clock(c.ring)]);
  if (c.state === 'CONNECT' && c.dir === 'in' && !c.mine && !c.claimed) {
    facts.push(['Pris par', 'non attribué']);
  }

  mount(popup, html`<div class="call-card" role="dialog" aria-live="polite" aria-label="${kicker}">
    <div class="call-card-head">
      ${raw(icon('phone'))}<strong>${kicker}</strong><span>· ${snap.line ? snap.line.label : ''}</span>
      <span class="toolbar-spacer"></span>
      <button type="button" data-popup-min aria-label="Réduire" title="Réduire">${raw(icon('chevron'))}</button>
      <button type="button" data-popup-close aria-label="Fermer" title="Fermer cette fenêtre (l’appel continue)">${raw(icon('close'))}</button>
    </div>
    <div class="call-card-body">
      ${raw(avatarOf(label, 'lg', true))}
      <div class="call-card-name">${label}</div>
      <div class="call-card-sub">${sub}</div>
      <div class="call-card-timer">${timer}</div>
    </div>
    <div class="call-card-actions">${raw(actions.join(''))}</div>
    <div class="call-card-facts">
      ${facts.map(([l, v]) => raw(html`<div class="call-card-fact"><span>${l}</span><span>${v}</span></div>`))}
      ${c.state === 'CONNECT' && c.dir === 'in' && !c.mine && !c.claimed ? raw(html`<button class="btn btn--ghost btn--sm" type="button" data-act="claim" data-ref="${c.callref}" style="margin-top:6px;color:#fff">${raw(icon('check'))}C’est moi qui ai répondu</button>`) : ''}
    </div>
  </div>`);
}

// -----------------------------------------------------------------------------
//  Rendu : composeur
// -----------------------------------------------------------------------------

function paintDialer() {
  const host = qs('#ag-dialer');
  if (!host) return;
  host.hidden = !_dialer.open;
  if (!_dialer.open) return;

  const transfer = _dialer.mode === 'transfer';
  const list = _profile && Array.isArray(_profile.colleagues) ? _profile.colleagues : [];
  const q = _dialer.query.trim().toLowerCase();
  const filtered = list.filter((c) => !q || String(c.name).toLowerCase().indexOf(q) >= 0 || String(c.number).indexOf(q) >= 0);
  const managers = filtered.filter((c) => c.manager);
  const others = filtered.filter((c) => !c.manager);

  const row = (c) => html`<button class="dl-row" type="button" data-pick-number="${c.number}" data-pick-name="${c.name}">
    ${raw(avatarOf(c.name, 'sm'))}
    <span><span class="dl-row-name">${c.name}${c.manager ? raw(tag('Manager', 'ok')) : ''}</span><span class="dl-row-sub">${formatNumber(c.number) || c.number} · ${c.numberKind}${c.lines && c.lines.length ? ' · ' + c.lines.join(', ') : ''}</span></span>
    <span class="dl-row-go">${transfer ? 'Transférer' : 'Appeler'}</span>
  </button>`;

  mount(host, html`<div class="dl-card" role="dialog" aria-labelledby="dl-title">
    <div class="dl-head">
      <h2 class="dl-title" id="dl-title">${transfer ? 'Transférer l’appel à…' : 'Nouvel appel'}</h2>
      <button class="btn btn--icon btn--ghost" type="button" data-dialer-close aria-label="Fermer">${raw(icon('close'))}</button>
    </div>
    <div class="dl-form">
      <label class="field" for="dl-number">${raw(icon('phone'))}<input id="dl-number" type="tel" inputmode="tel" autocomplete="off" placeholder="${transfer ? 'Numéro de destination' : 'Numéro à appeler (06 12 34 56 78 ou 4012)'}"></label>
      <button class="btn ${transfer ? 'btn--primary' : 'btn--accent'}" type="button" id="dl-go">${raw(icon('out'))}${transfer ? 'Transférer' : 'Appeler'}</button>
    </div>
    ${list.length ? raw(html`<div class="dl-search"><label class="field" for="dl-search">${raw(icon('search'))}<input id="dl-search" type="search" autocomplete="off" placeholder="Rechercher un collègue ou un manager" value="${_dialer.query}"></label></div>`) : ''}
    <div class="dl-list">
      ${managers.length ? raw(html`<p class="dl-group">Managers</p>`) : ''}${managers.map((c) => raw(row(c)))}
      ${others.length ? raw(html`<p class="dl-group">Collègues</p>`) : ''}${others.map((c) => raw(row(c)))}
      ${!filtered.length ? raw(html`<p class="dl-empty">${list.length ? 'Aucun collègue ne correspond.' : 'Aucun collègue dans l’annuaire : saisissez un numéro.'}</p>`) : ''}
    </div>
  </div>`);

  const focusEl = /** @type {HTMLInputElement|null} */ (qs(q ? '#dl-search' : '#dl-number', host));
  if (focusEl) {
    focusEl.focus();
    if (q) focusEl.setSelectionRange(focusEl.value.length, focusEl.value.length);
  }
}

/** @param {'dial'|'transfer'} mode @param {string} [callref] */
function openDialer(mode, callref) {
  _dialer = { open: true, mode, callref: callref || '', query: '' };
  paintDialer();
}

function closeDialer() {
  if (!_dialer.open) return;
  _dialer = { open: false, mode: 'dial', callref: '', query: '' };
  paintDialer();
}

// -----------------------------------------------------------------------------
//  Ordonnancement
// -----------------------------------------------------------------------------

function schedule() {
  if (_frame) return;
  _frame = requestAnimationFrame(function () {
    _frame = 0;
    paintSide();
    paintList();
    paintMain();
    paintPopup();
  });
}

// -----------------------------------------------------------------------------
//  Actions
// -----------------------------------------------------------------------------

/**
 * @param {string} key
 * @param {() => Promise<any>} fn
 * @param {string} [success]
 * @returns {Promise<boolean>}
 */
async function run(key, fn, success) {
  _busy = key;
  schedule();
  try {
    await fn();
    if (success) toast({ title: success, tone: 'ok' });
    return true;
  } catch (err) {
    toast({ title: 'Action impossible', sub: messageOf(err), tone: 'error' });
    return false;
  } finally {
    _busy = '';
    schedule();
  }
}

function wire() {
  on(document, 'click', '[data-tab]', function (ev, el) {
    _tab = el.getAttribute('data-tab') === 'people' ? 'people' : 'calls';
    schedule();
  });
  on(document, 'click', '[data-view="activity"]', function () {
    _selected = { kind: '', id: '' };
    schedule();
  });
  on(document, 'click', '[data-filter]', function (ev, el) {
    _filter = /** @type {any} */ (el.getAttribute('data-filter') || 'all');
    schedule();
  });
  on(document, 'click', '[data-call]', function (ev, el) {
    _selected = { kind: 'call', id: el.getAttribute('data-call') || '' };
    schedule();
  });
  on(document, 'click', '[data-colleague]', function (ev, el) {
    _selected = { kind: 'colleague', id: el.getAttribute('data-colleague') || '' };
    schedule();
  });
  on(document, 'click', '[data-choose-line]', function (ev, el) {
    const csi = el.getAttribute('data-choose-line') || '';
    if (csi) run('line', function () { return cti.chooseLine(csi); });
  });
  on(document, 'click', '[data-act]', function (ev, el) {
    const act = el.getAttribute('data-act') || '';
    const ref = el.getAttribute('data-ref') || '';
    const number = el.getAttribute('data-number') || '';
    if (act === 'retry-line') { run('line', function () { return cti.start(); }); return; }
    if (act === 'answer') { run(ref, function () { return cti.answer(ref); }, 'Appel décroché.'); return; }
    if (act === 'reject') { run(ref, function () { return cti.reject(ref); }, 'Appel rejeté.'); return; }
    if (act === 'hangup') { run(ref, function () { return cti.hangup(ref); }); return; }
    if (act === 'transfer') { openDialer('transfer', ref); return; }
    if (act === 'transfer-to') { run(ref, function () { return cti.transfer(ref, number, { supervised: false }); }, 'Appel transféré à ' + labelOf(number) + '.'); return; }
    if (act === 'dial') { run('dial', function () { return cti.dial(number); }, 'Appel vers ' + labelOf(number) + ' lancé.'); return; }
    if (act === 'claim') {
      try { cti.claim(ref); toast({ title: 'Appel attribué à vous. Merci !', tone: 'ok' }); }
      catch (err) { toast({ title: 'Impossible', sub: messageOf(err), tone: 'error' }); }
      schedule();
    }
  });

  // Fenetre d'appel.
  on(document, 'click', '[data-popup-min]', function () { _popupMin = true; paintPopup(); });
  on(document, 'click', '[data-popup-close]', function () {
    const c = primaryCall();
    if (c) _popupClosed.add(c.callref);
    paintPopup();
  });
  on(document, 'click', '#call-pill', function () { _popupMin = false; paintPopup(); });

  // Composeur.
  on(document, 'click', '#ag-newcall', function () { openDialer('dial'); });
  on(document, 'click', '[data-dialer-close]', function () { closeDialer(); });
  on(document, 'click', '#ag-dialer', function (ev) {
    if (/** @type {any} */ (ev).target && /** @type {any} */ (ev).target.id === 'ag-dialer') closeDialer();
  });
  on(document, 'input', '#dl-search', function (ev, el) {
    _dialer.query = /** @type {HTMLInputElement} */ (el).value;
    paintDialer();
  });
  on(document, 'click', '#dl-go', function () { dialerGo(); });
  on(document, 'keydown', '#dl-number', function (ev) {
    if (/** @type {KeyboardEvent} */ (ev).key === 'Enter') { ev.preventDefault(); dialerGo(); }
  });
  on(document, 'click', '[data-pick-number]', function (ev, el) {
    const number = el.getAttribute('data-pick-number') || '';
    const name = el.getAttribute('data-pick-name') || number;
    if (!number) return;
    const mode = _dialer.mode;
    const ref = _dialer.callref;
    closeDialer();
    if (mode === 'transfer') run(ref, function () { return cti.transfer(ref, number, { supervised: false }); }, 'Appel transféré à ' + name + '.');
    else run('dial', function () { return cti.dial(number); }, 'Appel vers ' + name + ' lancé.');
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && _dialer.open) closeDialer();
  });

  const refresh = qs('#btn-refresh');
  if (refresh) on(refresh, 'click', function () { loadActivity(); });
}

function dialerGo() {
  const input = /** @type {HTMLInputElement|null} */ (qs('#dl-number'));
  const number = input ? input.value.trim() : '';
  if (!number) { toast({ title: 'Saisir un numéro.', tone: 'warn' }); if (input) input.focus(); return; }
  const mode = _dialer.mode;
  const ref = _dialer.callref;
  closeDialer();
  if (mode === 'transfer') run(ref, function () { return cti.transfer(ref, number, { supervised: false }); }, 'Appel transféré vers ' + number + '.');
  else run('dial', function () { return cti.dial(number); }, 'Appel vers ' + labelOf(number) + ' lancé.');
}

/** @param {unknown} err @returns {string} */
function messageOf(err) {
  const e = /** @type {any} */ (err);
  return e && e.message ? String(e.message) : String(e || 'erreur inconnue');
}

// -----------------------------------------------------------------------------
//  Chargement
// -----------------------------------------------------------------------------

async function loadActivity() {
  try {
    const res = await journal.month({ month: _month, scope: 'me' });
    _activity = { loading: false, error: '', events: Array.isArray(res.events) ? res.events : [], summary: res.summary || null, at: new Date().toISOString() };
  } catch (err) {
    _activity = { loading: false, error: messageOf(err), events: _activity.events, summary: _activity.summary, at: _activity.at };
  }
  schedule();
}

async function startApp() {
  hideGate();
  _month = monthOf(Math.floor(Date.now() / 1000));
  wire();
  paintSide();
  paintList();
  paintMain();

  try {
    _profile = await getProfile();
  } catch (err) {
    toast({ title: 'Profil indisponible', sub: messageOf(err), tone: 'error' });
    _profile = { colleagues: [], line: null, lines: [], warnings: [messageOf(err)] };
  }
  schedule();

  getDirectory().then(function (dir) {
    const map = dir && dir.map && typeof dir.map === 'object' ? dir.map : {};
    const names = new Map();
    for (const k of Object.keys(map)) {
      const e = toE164(k);
      if (e && e !== 'anonymous' && !names.has(e)) names.set(e, String(map[k]));
    }
    _names = names;
    schedule();
  }).catch(function (err) {
    console.warn('[agent] annuaire indisponible :', err);
  });

  journal.init();
  cti.subscribe(schedule);
  cti.start({ csi: _profile.line ? _profile.line.csi : undefined });

  loadActivity();
  journal.subscribe(function () {
    const j = journal.status();
    if (!j.pending && !j.lastError) loadActivity();
  });
  _timer = window.setInterval(function () { if (!document.hidden) loadActivity(); }, REFRESH_MS);
}

export function boot() {
  const actions = qs('#gate-actions');
  if (actions) on(actions, 'click', '[data-gate-retry]', function () { window.location.reload(); });
  document.addEventListener('keyyo:unauthenticated', function () {
    if (_timer) { window.clearInterval(_timer); _timer = 0; }
    cti.stop();
    session.forget();
    showGate({ state: 'anonymous' });
  });

  showGate({ state: 'checking' });
  session.resolve().then(function (s) {
    if (s.state !== 'ready') { showGate(s); return; }
    startApp();
  });
}

if (qs('#agent-root')) {
  boot();
} else {
  console.info('[agent] coquille absente : amorcage ignore.');
}
