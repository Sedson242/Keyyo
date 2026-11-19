// =============================================================================
//  app/shell.js — Coquille commune aux trois pages, au rendu de 1Licence.
//
//  Ce module ne connait ni les appels ni les filtres. Il tient :
//    - les PREFERENCES D'AFFICHAGE gardees dans le navigateur (theme systeme,
//      clair ou sombre ; densite ; transparence ; animations ; menu reduit),
//      appliquees avant le premier rendu par assets/theme.js ;
//    - la PILULE D'ENCRE du menu, qui glisse sous la page active (transform
//      seulement) a chaque evenement `keyyo:route` du routeur ;
//    - le MENU DU COMPTE (avatar en haut a droite) : identite, reglages,
//      liens, deconnexion ;
//    - le BOUTON DE CONNEXION Microsoft des ecrans de connexion ;
//    - le TIROIR du menu en mobile, pour les pages sans routeur.
//
//  Tout est cable par delegation sur un balisage statique (index.html,
//  agent.html, admin.html) : un element absent est simplement ignore.
// =============================================================================

import { qs, qsa, html, raw, mount } from './dom.js';

const KEY = '1call-prefs';
const DEFAULTS = Object.freeze({ theme: 'system', density: 'comfortable', glass: 'on', motion: 'full', nav: 'full' });

/** Reglages proposes dans le menu du compte, dans cet ordre. */
const ROWS = [
  { key: 'theme', label: 'Thème', options: [['system', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']] },
  { key: 'density', label: 'Densité', options: [['comfortable', 'Normale'], ['compact', 'Compacte']] },
  { key: 'glass', label: 'Transparence', options: [['on', 'Verre'], ['off', 'Opaque']] },
  { key: 'motion', label: 'Animations', options: [['full', 'Fluides'], ['reduce', 'Réduites']] },
];

// -----------------------------------------------------------------------------
//  Preferences
// -----------------------------------------------------------------------------

/** @returns {{theme: string, density: string, glass: string, motion: string, nav: string}} */
export function prefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    return { ...DEFAULTS, ...saved };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

function save(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (err) { /* preference non memorisee */ }
}

/** @param {Record<string, string>} p */
function apply(p) {
  const root = document.documentElement;
  if (p.theme === 'dark' || p.theme === 'light') root.dataset.theme = p.theme;
  else delete root.dataset.theme;
  if (p.glass === 'off') root.dataset.glass = 'off';
  else delete root.dataset.glass;
  if (p.motion === 'reduce') root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
  if (p.density === 'compact') root.dataset.density = 'compact';
  else delete root.dataset.density;
  if (p.nav === 'mini') root.dataset.nav = 'mini';
  else delete root.dataset.nav;
  document.dispatchEvent(new Event('keyyo:prefs'));
}

/** @returns {boolean} vrai si les animations sont coupees (systeme ou outil). */
export function reducedMotion() {
  return document.documentElement.dataset.motion === 'reduce'
    || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Change une preference. Pour le theme, le nouveau rendu s'ouvre en cercle
 * depuis le point clique (View Transitions), sinon il s'applique directement.
 * @param {string} key
 * @param {string} value
 * @param {{clientX: number, clientY: number}|null} [origin]
 */
export function setPref(key, value, origin) {
  const p = { ...prefs(), [key]: value };
  save(p);
  const run = () => apply(p);
  const doc = /** @type {any} */ (document);
  if (key !== 'theme' || reducedMotion() || typeof doc.startViewTransition !== 'function') { run(); return; }
  const root = document.documentElement;
  const x = origin ? origin.clientX : innerWidth / 2;
  const y = origin ? origin.clientY : innerHeight / 2;
  root.style.setProperty('--vt-x', x + 'px');
  root.style.setProperty('--vt-y', y + 'px');
  root.style.setProperty('--vt-r', Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 'px');
  doc.startViewTransition(run);
}

// -----------------------------------------------------------------------------
//  Pilule d'encre du menu
// -----------------------------------------------------------------------------

/** @param {boolean} [instant] sans glissement (premier placement, redimensionnement). */
export function moveIndicator(instant) {
  const nav = qs('.nav');
  const pill = nav ? qs('.nav-indicator', nav) : null;
  if (!nav || !pill) return;
  nav.classList.add('has-indicator');
  const active = /** @type {HTMLElement|null} */ (qs('.nav-item.is-active', nav));
  if (!active || !active.offsetParent) { pill.style.opacity = '0'; return; }
  // Position relative au <nav> : on remonte les parents positionnes jusqu'a lui.
  let top = 0;
  let el = /** @type {HTMLElement|null} */ (active);
  while (el && el !== nav) { top += el.offsetTop; el = /** @type {HTMLElement|null} */ (el.offsetParent); }
  pill.classList.toggle('instant', !!instant);
  pill.style.opacity = '1';
  pill.style.height = active.offsetHeight + 'px';
  pill.style.transform = 'translateY(' + top + 'px)';
}

/** Info-bulle du nom de chaque page quand le menu est reduit a ses icones. */
function syncNavTitles() {
  const mini = prefs().nav === 'mini';
  // Boutons de vue (supervision) comme liens vers une autre page (administration).
  for (const item of qsa('.nav .nav-item')) {
    const label = qs('.label', item);
    if (mini && label) item.setAttribute('title', label.textContent || '');
    else item.removeAttribute('title');
  }
  const btn = qs('#nav-collapse');
  if (btn) {
    const text = mini ? 'Agrandir le menu' : 'Réduire le menu';
    const span = qs('span', btn);
    if (span) span.textContent = text;
    btn.setAttribute('aria-label', text);
    if (mini) btn.setAttribute('title', text);
    else btn.removeAttribute('title');
  }
}

// -----------------------------------------------------------------------------
//  Menu du compte
// -----------------------------------------------------------------------------

function renderPrefRows() {
  const host = qs('[data-prefs]');
  if (!host) return;
  const p = prefs();
  let out = '';
  for (const row of ROWS) {
    let buttons = '';
    for (const [value, label] of row.options) {
      const on = p[row.key] === value;
      buttons += html`<button type="button" class="${on ? 'is-active' : ''}" aria-pressed="${on ? 'true' : 'false'}" data-pref="${row.key}" data-value="${value}">${label}</button>`;
    }
    out += html`<div class="acct-row"><span>${row.label}</span><div class="segmented" role="group" aria-label="${row.label}">${raw(buttons)}</div></div>`;
  }
  mount(host, out);
}

let _accountOpen = false;

function openAccount() {
  const pop = qs('#account-pop');
  const btn = qs('#btn-account');
  if (!pop) return;
  renderPrefRows();
  pop.hidden = false;
  _accountOpen = true;
  if (btn) btn.setAttribute('aria-expanded', 'true');
}

function closeAccount() {
  if (!_accountOpen) return;
  const pop = qs('#account-pop');
  const btn = qs('#btn-account');
  if (pop) pop.hidden = true;
  _accountOpen = false;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/**
 * Photo de profil Microsoft 365 dans l'avatar du compte. Sans photo (ou si
 * Graph la refuse), l'image est retiree et les initiales restent.
 * @param {string} email
 */
export function setAccountPhoto(email) {
  const btn = qs('#btn-account');
  const e = String(email || '').trim().toLowerCase();
  if (!btn || !e || e.indexOf('@') < 0 || btn.dataset.photo === e) return;
  btn.dataset.photo = e;
  const old = qs('img', btn);
  if (old) old.remove();
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.addEventListener('load', () => btn.classList.add('has-photo'));
  img.addEventListener('error', () => { img.remove(); btn.classList.remove('has-photo'); });
  img.src = '/api/photo?u=' + encodeURIComponent(e) + '&s=96';
  btn.appendChild(img);
}

// -----------------------------------------------------------------------------
//  Connexion
// -----------------------------------------------------------------------------

/**
 * Bouton « Se connecter avec Microsoft » : le logo en quatre carres s'assemble
 * a l'arrivee, puis s'anime pendant le passage chez Microsoft.
 * @param {string} href
 * @returns {string}
 */
export function loginButton(href) {
  return html`<a class="btn btn--primary btn--lg login-btn" href="${href}">
    <span class="ms-logo enter" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span class="login-label">Se connecter avec Microsoft</span>
  </a>`;
}

function wireLogin() {
  document.addEventListener('click', (ev) => {
    const target = /** @type {any} */ (ev.target);
    const btn = target && typeof target.closest === 'function' ? target.closest('.login-btn') : null;
    if (!btn) return;
    const mark = qs('.ms-logo', btn);
    const label = qs('.login-label', btn);
    if (mark) mark.classList.replace('enter', 'busy');
    if (label) label.textContent = 'Connexion à Microsoft…';
    btn.setAttribute('aria-busy', 'true');
  });
  // Retour arriere depuis la page Microsoft : le navigateur peut reafficher la
  // page figee, bouton encore « en cours ».
  window.addEventListener('pageshow', () => {
    for (const btn of qsa('.login-btn[aria-busy]')) {
      const mark = qs('.ms-logo', btn);
      const label = qs('.login-label', btn);
      if (mark) mark.classList.replace('busy', 'enter');
      if (label) label.textContent = 'Se connecter avec Microsoft';
      btn.removeAttribute('aria-busy');
    }
  });
}

// -----------------------------------------------------------------------------
//  Tiroir du menu (mobile)
//
//  Sur la supervision, c'est le routeur qui ouvre et ferme le tiroir (il le
//  referme a chaque changement de vue). Les pages sans routeur (administration)
//  le demandent ici avec `initShell({ drawer: true })`.
// -----------------------------------------------------------------------------

let _drawerOpen = false;

function setDrawer(open) {
  const side = qs('#sidebar');
  const scrim = qs('#nav-scrim');
  const toggle = qs('#nav-toggle');
  if (side) side.classList.toggle('is-open', open);
  if (scrim) {
    if (open) {
      // Retirer `hidden` AVANT `is-open`, et forcer un calcul de style entre
      // les deux : sans cela la transition d'ouverture ne joue pas.
      scrim.hidden = false;
      void scrim.offsetWidth;
    }
    scrim.classList.toggle('is-open', open);
  }
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  _drawerOpen = open;
}

function wireDrawer() {
  const toggle = qs('#nav-toggle');
  if (toggle) toggle.addEventListener('click', () => setDrawer(!_drawerOpen));
  const scrim = qs('#nav-scrim');
  if (scrim) scrim.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _drawerOpen) setDrawer(false);
  });
}

// -----------------------------------------------------------------------------
//  Amorcage
// -----------------------------------------------------------------------------

let _wired = false;

/**
 * Cable la coquille. Appele tot (avant le routeur) : la pilule suit ensuite
 * chaque `keyyo:route`. Rappeler la fonction ne cable rien deux fois.
 * @param {{drawer?: boolean}} [opts] `drawer` : cabler le tiroir mobile (pages
 *   sans routeur seulement, sinon le bouton l'ouvrirait et le fermerait d'un
 *   meme clic).
 */
export function initShell(opts) {
  if (_wired) return;
  _wired = true;
  if (opts && opts.drawer) wireDrawer();

  for (const el of qsa('[data-year]')) el.textContent = String(new Date().getFullYear());

  // Menu reduit (grand ecran seulement : en mobile, le menu est un tiroir).
  const collapse = qs('#nav-collapse');
  if (collapse) {
    collapse.addEventListener('click', () => setPref('nav', prefs().nav === 'mini' ? 'full' : 'mini'));
  }

  // Menu du compte.
  const accountBtn = qs('#btn-account');
  if (accountBtn) {
    accountBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (_accountOpen) closeAccount();
      else openAccount();
    });
  }
  const pop = qs('#account-pop');
  if (pop) {
    let lastClick = /** @type {any} */ (null);
    pop.addEventListener('pointerdown', (ev) => { lastClick = ev; }, true);
    pop.addEventListener('click', (ev) => {
      const target = /** @type {any} */ (ev.target);
      const btn = target && typeof target.closest === 'function' ? target.closest('[data-pref]') : null;
      if (btn) setPref(btn.getAttribute('data-pref') || '', btn.getAttribute('data-value') || '', lastClick);
    });
  }
  document.addEventListener('click', (ev) => {
    if (!_accountOpen) return;
    const target = /** @type {any} */ (ev.target);
    if (target && typeof target.closest === 'function' && target.closest('#account')) return;
    closeAccount();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _accountOpen) {
      closeAccount();
      const btn = /** @type {HTMLElement|null} */ (qs('#btn-account'));
      if (btn) btn.focus();
    }
  });

  // Pilule du menu : a chaque vue, a chaque reglage, au redimensionnement et
  // une fois les polices chargees (la hauteur des liens peut changer).
  document.addEventListener('keyyo:route', () => moveIndicator(false));
  document.addEventListener('keyyo:prefs', () => {
    syncNavTitles();
    if (_accountOpen) renderPrefRows();
    requestAnimationFrame(() => moveIndicator(true));
  });
  window.addEventListener('resize', () => moveIndicator(true));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => moveIndicator(true));
  syncNavTitles();
  requestAnimationFrame(() => moveIndicator(true));
}

wireLogin();
