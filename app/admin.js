// =============================================================================
//  app/admin.js — Administration : membres, roles, lignes, routage.
//
//  Reservee aux administrateurs. Elle edite EN MEMOIRE une copie de la
//  configuration d'acces (shared/access.js), puis l'envoie entiere a
//  /api/access quand on clique « Enregistrer » : pas d'enregistrement a chaque
//  clic, pas de demi-etat. Le serveur normalise, refuse une configuration sans
//  administrateur, et signe qui a ecrit quand.
//
//  Trois blocs :
//    1. Membres — qui a quel role, sur quelle ligne, et s'il recoit la fenetre
//       d'appel entrant. On ajoute une personne depuis l'annuaire Keyyo (les
//       adresses rattachees aux lignes) ou par son adresse.
//    2. Routage — pour chaque ligne, qui est presente a l'appel entrant.
//       Personne de coche = tout le monde sur la ligne.
//    3. La barre d'enregistrement, avec la derniere modification connue.
//
//  Tout ce qui vient de l'annuaire (noms, adresses) passe par `html`.
// =============================================================================

import * as session from './session.js';
import { getAccess, postAccess, photoUrl } from './api.js';
import { qs, on, html, raw, mount, icon, watchBrokenImages } from './dom.js';
import { fmtRelative, fmtInt, pluralize } from './format.js';
import { card, notice, empty, skeleton, tag, avatar } from './ui.js';
import { initialsOf } from '../shared/identity.js';
import { ROLES, ROLE_ADMIN, ROLE_DIRECTION, ROLE_AGENT, roleLabel } from '../shared/roles.js';
import { normalizeAccess, upsertMember, removeMember, adminCount } from '../shared/access.js';
import { toast } from './alerts.js';

/** @type {{config: any, lines: any[], people: any[], me: any, warnings: string[]}|null} */
let _data = null;
let _dirty = false;
let _saving = false;
let _loadError = '';

// -----------------------------------------------------------------------------
//  Ecran de connexion (meme coquille)
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
  } else if (s.state === 'forbidden') {
    t = 'Réservé aux administrateurs';
    body = 'Votre compte (' + (s.user ? s.user.email : '') + ') est reconnu comme « ' + (s.user ? s.user.roleLabel : '') + ' ». '
      + 'Un administrateur peut vous donner ce rôle depuis cette page ; pour le tout premier, poser AUTH_ADMIN_EMAILS dans Vercel.';
    buttons = html`<a class="btn btn--ghost" href="/agent.html">Ma ligne</a><a class="btn btn--ghost" href="${session.LOGOUT_URL}">Changer de compte</a>`;
  } else if (s.state === 'anonymous') {
    body = 'Connectez-vous avec votre compte Microsoft de l\'organisation.';
    buttons = html`<a class="btn btn--primary" href="${session.loginUrl()}">Se connecter avec Microsoft</a>`;
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
//  Rendu
// -----------------------------------------------------------------------------

function paintHeader() {
  const u = session.current().user;
  const name = qs('#account-name');
  const sub = qs('#account-sub');
  const ini = qs('#account-initials');
  if (name && u) { name.textContent = u.name; name.setAttribute('title', u.email); }
  if (sub && u) sub.textContent = u.roleLabel;
  if (ini && u) ini.textContent = initialsOf(u.name);
}

function paint() {
  const host = qs('#admin-main');
  if (!host) return;
  if (_loadError) {
    mount(host, notice({ tone: 'error', title: 'Administration indisponible.', body: html`${_loadError} <button class="btn btn--sm" type="button" data-admin-reload>Réessayer</button>` }));
    paintBar();
    return;
  }
  if (!_data) {
    mount(host, skeleton('card') + skeleton('card'));
    paintBar();
    return;
  }
  const warn = _data.warnings && _data.warnings.length
    ? notice({ tone: 'warn', title: 'À savoir.', body: html`${_data.warnings.join(' ')}` })
    : '';
  mount(host, warn + membersCard() + routingCard());
  paintBar();
}

/** @param {string} csi @returns {any|null} */
function lineOf(csi) {
  return (_data && _data.lines ? _data.lines : []).find((l) => l.csi === csi) || null;
}

function membersCard() {
  const members = _data.config.members;
  const lines = _data.lines || [];
  // Tableau ecrit a la main, mais sur le meme contrat que ui.table : pas de
  // largeur minimale (plus de defilement horizontal), `data-label` pour le
  // mode empile des petits conteneurs. Toutes les colonnes sont des reglages :
  // aucune ne se masque, les cases a cocher passent a la ligne.
  const rows = members.map((m, idx) => html`<tr data-member="${m.email}">
    <td data-label="Personne" class="break">
      <div class="row">${raw(avatar(m.name || m.email, { size: 'sm', photo: photoUrl(m.email, 48) }))}
        <div class="adm-person"><div class="strong">${m.name || '—'}</div><div class="faint" style="font: var(--t-micro)">${m.email}</div></div></div>
    </td>
    <td data-label="Rôle">
      <div class="select-pill"><select data-role="${m.email}" aria-label="Rôle de ${m.email}">
        ${ROLES.map((r) => raw(html`<option value="${r}"${r === m.role ? ' selected' : ''}>${roleLabel(r)}</option>`))}
      </select></div>
    </td>
    <td data-label="Lignes">
      <div class="adm-checks">${lines.map((l) => raw(html`<label class="adm-check"><input type="checkbox" data-line="${l.csi}" data-email="${m.email}"${m.lines.indexOf(l.csi) >= 0 ? ' checked' : ''}> ${l.label}</label>`))}
        ${lines.length ? '' : raw(html`<span class="faint">aucune ligne Keyyo lue</span>`)}</div>
    </td>
    <td data-label="Appel entrant"><label class="adm-check"><input type="checkbox" data-popup="${m.email}"${m.popup ? ' checked' : ''}> reçoit la fenêtre</label></td>
    <td data-label="Numéro direct"><label class="field adm-number" for="adm-number-${idx}">${raw(icon('phone'))}<input id="adm-number-${idx}" type="tel" inputmode="tel" autocomplete="off" placeholder="4012 ou 06…" value="${m.number || ''}" data-number="${m.email}" aria-label="Numéro direct de ${m.email}"></label></td>
    <td class="num" data-label=""><button class="btn btn--ghost btn--sm" type="button" data-remove="${m.email}" title="Retirer de la configuration" aria-label="Retirer ${m.email}">${raw(icon('close'))}</button></td>
  </tr>`);

  const known = new Set(members.map((m) => m.email));
  const candidates = (_data.people || []).filter((p) => !known.has(p.email));

  return card({
    title: 'Membres',
    sub: fmtInt(members.length) + ' ' + pluralize(members.length, 'personne configurée', 'personnes configurées')
      + ' · ' + fmtInt(adminCount(_data.config)) + ' ' + pluralize(adminCount(_data.config), 'administrateur', 'administrateurs')
      + '. Une personne absente d’ici est « agent », sur la ligne que l’annuaire Keyyo lui rattache.',
    body: raw(html`<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">Personne</th><th scope="col">Rôle</th><th scope="col">Lignes</th><th scope="col">Appel entrant</th><th scope="col">Numéro direct</th><th scope="col"></th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => raw(r)) : raw(html`<tr><td colspan="6">${raw(empty('Aucun membre configuré', 'Ajoutez les personnes ci-dessous. Tant que la liste est vide, les rôles viennent d’Entra et des variables d’environnement.'))}</td></tr>`)}</tbody>
    </table></div>
    <p class="adm-hint">Numéro direct : la ligne personnelle ou le numéro court de la personne (« 4012 », « *4012 » ou « 06… »). C’est ce que l’application compose pour la joindre ou lui transférer un appel ; sans lui, l’appel passe par la ligne du site et sonne pour tout le monde. Une ligne cochée pour une seule personne devient sa ligne personnelle : les appels qui y sont décrochés lui sont attribués d’office.</p>
    <div class="adm-add">
      <div class="select-pill"><select id="adm-pick" aria-label="Personne de l’annuaire">
        <option value="">Ajouter depuis l’annuaire Keyyo…</option>
        ${candidates.map((p) => raw(html`<option value="${p.email}" data-name="${p.name}" data-lines="${p.lines.join(',')}">${p.name} · ${p.email}</option>`))}
      </select></div>
      <span class="faint">ou</span>
      <label class="field" for="adm-email">${raw(icon('mail'))}<input id="adm-email" type="email" autocomplete="off" placeholder="adresse@entreprise.fr"></label>
      <label class="field" for="adm-name">${raw(icon('people'))}<input id="adm-name" type="text" autocomplete="off" placeholder="Prénom Nom"></label>
      <button class="btn btn--primary btn--sm" type="button" id="adm-add">Ajouter</button>
    </div>`),
  });
}

function routingCard() {
  const lines = _data.lines || [];
  const members = _data.config.members;
  if (!lines.length) {
    return card({ title: 'Routage des appels entrants', body: raw(empty('Aucune ligne Keyyo lue', 'Le routage se règle ligne par ligne ; vérifier la page Diagnostic.')) });
  }
  const blocks = lines.map((l) => {
    const routing = _data.config.routing[l.csi] || { agents: [] };
    const onLine = members.filter((m) => m.lines.indexOf(l.csi) >= 0 || !m.lines.length);
    const checks = onLine.length
      ? onLine.map((m) => raw(html`<label class="adm-check"><input type="checkbox" data-route="${l.csi}" data-email="${m.email}"${routing.agents.indexOf(m.email) >= 0 ? ' checked' : ''}> ${m.name || m.email}${m.popup ? '' : raw(html` <span class="faint">(fenêtre coupée)</span>`)}</label>`))
      : [raw(html`<span class="faint">aucun membre configuré sur cette ligne</span>`)];
    return html`<div class="adm-route">
      <div class="adm-route-head"><span class="strong">${l.label}</span> <span class="faint">${l.number} · ${fmtInt(l.members)} ${pluralize(l.members, 'contact rattaché', 'contacts rattachés')} dans l’annuaire</span>
        ${routing.agents.length ? raw(tag(fmtInt(routing.agents.length) + ' ' + pluralize(routing.agents.length, 'personne présentée', 'personnes présentées'), 'ok')) : raw(tag('tout le monde', 'neutral'))}</div>
      <div class="adm-checks">${checks}</div>
    </div>`;
  });
  return card({
    title: 'Routage des appels entrants',
    sub: 'Pour chaque ligne, qui voit la fenêtre « Appel entrant » et peut décrocher depuis l’application. Personne de coché : tout le monde sur la ligne. Le téléphone Keyyo Phone, lui, sonne pour tout le site quoi qu’il arrive.',
    body: raw(blocks.join('')),
  });
}

function paintBar() {
  const bar = qs('#admin-bar');
  if (!bar) return;
  const c = _data ? _data.config : null;
  const stamp = c && c.updatedAt ? 'Dernière modification ' + fmtRelative(c.updatedAt) + (c.updatedBy ? ' par ' + c.updatedBy : '') : 'Jamais enregistrée';
  mount(bar, html`<span class="faint">${stamp}</span>
    <span class="toolbar-spacer"></span>
    ${_dirty ? raw(tag('modifications non enregistrées', 'missed')) : ''}
    <button class="btn btn--ghost btn--sm" type="button" data-admin-reload${_saving ? ' disabled' : ''}>Annuler</button>
    <button class="btn btn--primary" type="button" id="adm-save"${!_dirty || _saving || !_data ? ' disabled' : ''}>${_saving ? 'Enregistrement…' : 'Enregistrer'}</button>`);
}

// -----------------------------------------------------------------------------
//  Edition
// -----------------------------------------------------------------------------

function markDirty() {
  _dirty = true;
  paint();
}

function wire() {
  on(document, 'click', '[data-admin-reload]', function () { load(); });
  on(document, 'click', '[data-gate-retry]', function () { window.location.reload(); });

  on(document, 'change', 'select[data-role]', function (ev, el) {
    const email = el.getAttribute('data-role') || '';
    _data.config = upsertMember(_data.config, { email, role: /** @type {any} */ (el).value });
    markDirty();
  });
  on(document, 'change', 'input[data-line]', function (ev, el) {
    const email = el.getAttribute('data-email') || '';
    const csi = el.getAttribute('data-line') || '';
    const m = _data.config.members.find((x) => x.email === email);
    if (!m) return;
    const lines = m.lines.filter((l) => l !== csi);
    if (/** @type {HTMLInputElement} */ (el).checked) lines.push(csi);
    _data.config = upsertMember(_data.config, { email, lines });
    markDirty();
  });
  on(document, 'change', 'input[data-popup]', function (ev, el) {
    const email = el.getAttribute('data-popup') || '';
    _data.config = upsertMember(_data.config, { email, popup: /** @type {HTMLInputElement} */ (el).checked });
    markDirty();
  });
  on(document, 'change', 'input[data-number]', function (ev, el) {
    const email = el.getAttribute('data-number') || '';
    const value = /** @type {HTMLInputElement} */ (el).value;
    const next = upsertMember(_data.config, { email, number: value });
    const m = next.members.find((x) => x.email === email);
    if (value.trim() && m && !m.number) {
      toast({ title: 'Numéro non retenu', sub: 'Saisir un numéro complet (06…), un numéro court (4012) ou sa forme composée (*4012).', tone: 'warn' });
      return;
    }
    _data.config = next;
    markDirty();
  });
  on(document, 'click', '[data-remove]', function (ev, el) {
    const email = el.getAttribute('data-remove') || '';
    _data.config = removeMember(_data.config, email);
    markDirty();
  });
  on(document, 'change', 'input[data-route]', function (ev, el) {
    const csi = el.getAttribute('data-route') || '';
    const email = el.getAttribute('data-email') || '';
    const next = normalizeAccess(_data.config);
    const entry = next.routing[csi] || { agents: [] };
    entry.agents = entry.agents.filter((a) => a !== email);
    if (/** @type {HTMLInputElement} */ (el).checked) entry.agents.push(email);
    next.routing[csi] = entry;
    _data.config = next;
    markDirty();
  });

  on(document, 'change', '#adm-pick', function (ev, el) {
    const select = /** @type {HTMLSelectElement} */ (el);
    const email = select.value;
    if (!email) return;
    const opt = select.options[select.selectedIndex];
    const name = opt ? opt.getAttribute('data-name') || '' : '';
    const lines = opt ? String(opt.getAttribute('data-lines') || '').split(',').filter(Boolean) : [];
    _data.config = upsertMember(_data.config, { email, name, role: ROLE_AGENT, lines, popup: true });
    markDirty();
  });
  on(document, 'click', '#adm-add', function () { addFromForm(); });
  on(document, 'keydown', '#adm-email, #adm-name', function (ev) {
    if (/** @type {KeyboardEvent} */ (ev).key === 'Enter') { ev.preventDefault(); addFromForm(); }
  });

  on(document, 'click', '#adm-save', function () { save(); });

  window.addEventListener('beforeunload', function (ev) {
    if (!_dirty) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
}

function addFromForm() {
  const emailEl = /** @type {HTMLInputElement|null} */ (qs('#adm-email'));
  const nameEl = /** @type {HTMLInputElement|null} */ (qs('#adm-name'));
  const email = emailEl ? emailEl.value.trim().toLowerCase() : '';
  const name = nameEl ? nameEl.value.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast({ title: 'Adresse invalide', sub: 'Saisir une adresse e-mail complète.', tone: 'warn' });
    if (emailEl) emailEl.focus();
    return;
  }
  _data.config = upsertMember(_data.config, { email, name, role: ROLE_AGENT, lines: [], popup: true });
  if (emailEl) emailEl.value = '';
  if (nameEl) nameEl.value = '';
  markDirty();
}

async function save() {
  if (!_data || _saving) return;
  if (!adminCount(_data.config)) {
    toast({ title: 'Il faut au moins un administrateur', sub: 'Donnez le rôle Administrateur à une personne avant d’enregistrer.', tone: 'error' });
    return;
  }
  _saving = true;
  paintBar();
  try {
    const res = await postAccess(_data.config);
    _data.config = normalizeAccess(res.config || _data.config);
    _dirty = false;
    toast({ title: 'Configuration enregistrée.', tone: 'ok' });
  } catch (err) {
    toast({ title: 'Enregistrement refusé', sub: err && err.message ? String(err.message) : String(err), tone: 'error' });
  } finally {
    _saving = false;
    paint();
  }
}

async function load() {
  _loadError = '';
  _data = null;
  _dirty = false;
  paint();
  try {
    const res = await getAccess();
    _data = {
      config: normalizeAccess(res.config),
      lines: Array.isArray(res.lines) ? res.lines : [],
      people: Array.isArray(res.people) ? res.people : [],
      me: res.me || null,
      warnings: Array.isArray(res.warnings) ? res.warnings : [],
    };
  } catch (err) {
    _loadError = err && err.message ? String(err.message) : String(err);
  }
  paint();
}

export function boot() {
  wire();
  document.addEventListener('keyyo:unauthenticated', function () {
    session.forget();
    showGate({ state: 'anonymous' });
  });
  showGate({ state: 'checking' });
  session.resolve().then(function (s) {
    if (s.state !== 'ready') { showGate(s); return; }
    if (!session.isAdmin()) { showGate({ state: 'forbidden', user: s.user }); return; }
    hideGate();
    watchBrokenImages();
    paintHeader();
    load();
  });
}

if (qs('#admin-root')) {
  boot();
} else {
  console.info('[admin] coquille absente : amorcage ignore.');
}
