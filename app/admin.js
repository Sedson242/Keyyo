// =============================================================================
//  app/admin.js — Administration : membres, roles, lignes, routage, annuaire
//  complementaire.
//
//  Reservee aux administrateurs. Elle edite EN MEMOIRE une copie de la
//  configuration d'acces (shared/access.js), puis l'envoie entiere a
//  /api/access quand on clique « Enregistrer » : pas d'enregistrement a chaque
//  clic, pas de demi-etat. Le serveur normalise, refuse une configuration sans
//  administrateur, et signe qui a ecrit quand.
//
//  Quatre blocs :
//    1. Membres — qui a quel role, sur quelle ligne, et s'il recoit la fenetre
//       d'appel entrant. On ajoute une personne depuis l'annuaire Keyyo (les
//       adresses rattachees aux lignes) ou par son adresse.
//    2. Routage — pour chaque ligne, qui est presente a l'appel entrant.
//       Personne de coche = tout le monde sur la ligne.
//    3. Annuaire complementaire — l'export CSV des contacts de Keyyo Phone.
//       Le fichier est lu et analyse DANS LE NAVIGATEUR avec la meme fonction
//       que le serveur (shared/contacts.js) pour montrer un apercu fidele,
//       puis envoye tel quel a POST /api/directory. Ce bloc est INDEPENDANT
//       du cycle « modifications / Enregistrer » : un import est immediat et
//       a sa propre confirmation ; son etat vit dans `_import` et `_csv`, pas
//       dans `_data`, et il se repeint seul (`paintContacts`).
//    4. La barre d'enregistrement, avec la derniere modification connue.
//
//  Tout ce qui vient de l'annuaire, du fichier importe ou de l'API (noms,
//  adresses, numeros, categories, avertissements) passe par `html`.
// =============================================================================

import * as session from './session.js';
import { getAccess, postAccess, photoUrl, getDirectory, postDirectoryImport, clearDirectoryImport } from './api.js';
import { qs, on, html, raw, mount, icon, watchBrokenImages } from './dom.js';
import { fmtRelative, fmtInt, pluralize } from './format.js';
import { card, notice, empty, skeleton, tag, avatar, table } from './ui.js';
import { initialsOf } from '../shared/identity.js';
import { ROLES, ROLE_ADMIN, ROLE_DIRECTION, ROLE_AGENT, roleLabel } from '../shared/roles.js';
import { normalizeAccess, upsertMember, removeMember, adminCount } from '../shared/access.js';
import { formatNumber } from '../shared/phone.js';
import { parseContactsExport } from '../shared/contacts.js';
import { toast } from './alerts.js';

/** @type {{config: any, lines: any[], people: any[], me: any, warnings: string[]}|null} */
let _data = null;
let _dirty = false;
let _saving = false;
let _loadError = '';

/** Taille maximale d'un export accepte, en octets : le meme plafond que le serveur. */
const MAX_CSV_BYTES = 2 * 1024 * 1024;

/** Contacts montres dans l'apercu avant import. */
const PREVIEW_ROWS = 8;

/**
 * Etat de l'annuaire complementaire tel que le serveur le connait (champ
 * `imported` de GET /api/directory). Charge a part de la configuration
 * d'acces ; `null` tant que la reponse n'est pas arrivee.
 * @type {{imported: any|null, error: string}|null}
 */
let _import = null;

/**
 * Fichier en cours d'examen : son texte (renvoye tel quel au serveur), le
 * resultat de l'analyse locale, puis celui de l'import.
 * @type {{name: string, size: number, text: string, parsed: any|null, errorTitle: string, error: string, reading: boolean, sending: boolean, result: any|null}}
 */
let _csv = emptyCsv();

/** Numero du dernier fichier choisi : une lecture depassee est ignoree. */
let _csvSeq = 0;

/**
 * Numero de la derniere lecture de l'etat de l'import ou de la derniere
 * ecriture (import, suppression). La lecture interroge l'API Keyyo (jusqu'a
 * vingt secondes) apres avoir lu le store : sa reponse decrit l'etat d'AVANT
 * une ecriture terminee entre temps, et serait perimee. Elle est ignoree.
 */
let _importSeq = 0;

let _clearing = false;

function emptyCsv() {
  return { name: '', size: 0, text: '', parsed: null, errorTitle: '', error: '', reading: false, sending: false, result: null };
}

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
    // La carte de l'annuaire complementaire ne depend pas de la configuration
    // d'acces : elle reste montee, et utilisable, quand /api/access echoue.
    mount(host, notice({ tone: 'error', title: 'Administration indisponible.', body: html`${_loadError} <button class="btn btn--sm" type="button" data-admin-reload>Réessayer</button>` })
      + html`<div id="adm-contacts">${raw(contactsCard())}</div>`);
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
  // La carte de l'annuaire complementaire a son propre conteneur : ses
  // changements d'etat (lecture, envoi, resultat) ne repeignent qu'elle, sans
  // toucher aux champs en cours de saisie dans les deux autres cartes.
  mount(host, warn + membersCard() + routingCard() + html`<div id="adm-contacts">${raw(contactsCard())}</div>`);
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

// -----------------------------------------------------------------------------
//  Annuaire complementaire (export de contacts Keyyo Phone)
// -----------------------------------------------------------------------------

/**
 * Carte de l'annuaire complementaire : etat conserve par le serveur, marche a
 * suivre, choix du fichier, apercu de l'analyse locale, resultat de l'import.
 * Rendue apres le routage ; ne depend ni de `_data` ni de `_dirty`.
 * @returns {string}
 */
function contactsCard() {
  const busy = _csv.sending || _clearing;
  return card({
    title: 'Annuaire complémentaire',
    sub: 'Les contacts de Keyyo Phone ne sont pas dans l’annuaire du compte. Importez leur export CSV : les correspondants de l’historique prennent leur nom. L’annuaire Keyyo garde la priorité en cas de doublon.',
    cls: 'adm-import',
    body: raw(html`${raw(importStateLine())}
      <p class="adm-import-how">Dans Keyyo Phone : Contacts → menu → Exporter (CSV). Le fichier est lu dans le navigateur avant tout envoi ; 2 Mo au plus.</p>
      <div class="adm-import-pick">
        <label class="field" for="adm-contacts-file">${raw(icon('download'))}<input type="file" id="adm-contacts-file" accept=".csv,text/csv" aria-label="Export de contacts Keyyo Phone (CSV)"${busy ? ' disabled' : ''}></label>
      </div>
      ${raw(importPreview())}
      ${raw(importResult())}`),
  });
}

/** Ligne d'etat : ce que le serveur conserve aujourd'hui, et le bouton de suppression. */
function importStateLine() {
  if (!_import) {
    return html`<div class="adm-import-state"><span class="faint">Lecture de l’état de l’import…</span></div>`;
  }
  if (_import.error) {
    return notice({
      tone: 'warn',
      title: 'État de l’import inconnu.',
      body: html`${_import.error} <button class="btn btn--sm" type="button" data-contacts-reload>Réessayer</button>`,
    });
  }
  const imp = _import.imported;
  if (!imp) return html`<div class="adm-import-state"><span>Aucun export importé.</span></div>`;
  const count = Number(imp.count) || 0;
  const numbers = Number(imp.numbers) || 0;
  return html`<div class="adm-import-state">
    <span>${fmtInt(count)} ${pluralize(count, 'contact', 'contacts')} · ${fmtInt(numbers)} ${pluralize(numbers, 'numéro', 'numéros')} · importé ${fmtRelative(imp.importedAt)}${imp.importedBy ? ' par ' + imp.importedBy : ''}${imp.filename ? ' · ' + imp.filename : ''}</span>
    <button class="btn btn--ghost btn--sm" type="button" id="adm-contacts-clear"${_clearing || _csv.sending ? ' disabled' : ''}>${_clearing ? 'Suppression…' : 'Supprimer l’import'}</button>
  </div>`;
}

/**
 * Grille des compteurs de l'analyse (shared/contacts.js#ImportStats). Les
 * compteurs qui signalent des lignes perdues ressortent des qu'ils sont
 * positifs.
 * @param {any} stats
 * @returns {string}
 */
function importStats(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  /** @type {Array<[string, unknown, boolean?]>} */
  const cells = [
    ['Lignes lues', s.rows],
    ['Contacts', s.contacts],
    ['Numéros', s.numbers],
    ['Sans nom', s.unnamed, true],
    ['Sans numéro', s.withoutNumber, true],
    ['Numéros rejetés', s.rejectedNumbers, true],
    ['Numéros courts', s.shortNumbers],
    ['Collisions', s.collisions, true],
  ];
  return html`<div class="adm-import-stats">${cells.map((c) => {
    const v = Number(c[1]) || 0;
    const cls = 'adm-import-stat' + (c[2] && v > 0 ? ' adm-import-stat--warn' : '');
    return raw(html`<div class="${cls}"><div class="adm-import-stat-label">${c[0]}</div><div class="adm-import-stat-value">${fmtInt(v)}</div></div>`);
  })}</div>`;
}

/**
 * Avertissements (analyse locale ou reponse du serveur), en bandeau.
 * @param {unknown} list
 * @param {string} title
 * @returns {string} '' sans avertissement.
 */
function warningList(list, title) {
  const items = Array.isArray(list) ? list.filter((w) => typeof w === 'string' && w) : [];
  if (!items.length) return '';
  return notice({
    tone: 'warn',
    title,
    body: html`<ul class="adm-import-warnings">${items.map((w) => raw(html`<li>${w}</li>`))}</ul>`,
  });
}

/** Apercu du fichier choisi : lecture, erreur, ou statistiques + premiers contacts + bouton d'import. */
function importPreview() {
  if (_csv.reading) {
    return html`<div class="adm-import-preview"><span class="faint">Lecture de « ${_csv.name} »…</span></div>`;
  }
  if (_csv.errorTitle) {
    return html`<div class="adm-import-preview">
      <div class="adm-import-filename"><span class="strong">${_csv.name}</span></div>
      ${raw(notice({ tone: 'error', title: _csv.errorTitle, body: html`${_csv.error}` }))}
    </div>`;
  }
  const p = _csv.parsed;
  if (!p) return '';
  const contacts = Array.isArray(p.contacts) ? p.contacts : [];
  const n = contacts.length;
  const shown = contacts.slice(0, PREVIEW_ROWS);
  const rows = shown.map((c) => [
    html`${c && c.name ? c.name : '—'}`,
    html`${(c && Array.isArray(c.numbers) ? c.numbers : []).map(formatNumber).join(', ')}`,
    html`${c && c.category ? c.category : '—'}`,
  ]);
  const foot = n > shown.length
    ? html`Les ${fmtInt(shown.length)} premiers contacts sur ${fmtInt(n)}.`
    : html`${fmtInt(n)} ${pluralize(n, 'contact', 'contacts')}.`;
  const preview = n
    ? table({
      columns: [
        { label: 'Nom', cls: 'strong' },
        { label: 'Numéros' },
        { label: 'Catégorie', priority: 'md' },
      ],
      rows,
      foot,
    })
    : '';
  const sizeKo = fmtInt(Math.max(1, Math.round(_csv.size / 1024)));
  return html`<div class="adm-import-preview">
    <div class="adm-import-filename"><span class="strong">${_csv.name}</span> <span class="faint">· ${sizeKo} Ko</span></div>
    ${raw(importStats(p.stats))}
    ${raw(warningList(p.warnings, 'À vérifier avant d’importer.'))}
    ${raw(preview)}
    <div class="adm-import-actions">
      <button class="btn btn--primary btn--sm" type="button" id="adm-contacts-import"${!n || _csv.sending || _clearing ? ' disabled' : ''}>${_csv.sending ? 'Import…' : 'Importer ' + fmtInt(n) + ' ' + pluralize(n, 'contact', 'contacts')}</button>
      ${n ? '' : raw(html`<span class="faint">Aucun contact exploitable dans ce fichier : rien à importer.</span>`)}
    </div>
  </div>`;
}

/** Bloc de resultat apres un import reussi : compte, couverture de l'archive, delai d'apparition. */
function importResult() {
  const r = _csv.result;
  if (!r) return '';
  const imp = r.imported && typeof r.imported === 'object' ? r.imported : {};
  const count = Number(imp.count) || 0;
  const numbers = Number(imp.numbers) || 0;
  const cov = r.coverage && typeof r.coverage === 'object' ? r.coverage : null;
  const coverage = cov
    ? 'Sur l’archive : ' + fmtInt(cov.peers) + ' correspondants distincts, ' + fmtInt(cov.byDirectory)
      + ' nommés par l’annuaire Keyyo, ' + fmtInt(cov.byImport) + ' par l’import, ' + fmtInt(cov.unnamed) + ' sans nom.'
    : 'Couverture non calculée : archive absente.';
  const collisions = Array.isArray(r.collisions) ? r.collisions.length : 0;
  const kept = collisions
    ? ' · ' + fmtInt(collisions) + ' ' + pluralize(collisions, 'numéro déjà nommé', 'numéros déjà nommés') + ' par l’annuaire Keyyo, qui garde la priorité'
    : '';
  return html`<div class="adm-import-result">
    ${raw(notice({
      tone: 'ok',
      title: 'Import terminé.',
      body: html`<p>${fmtInt(count)} ${pluralize(count, 'contact importé', 'contacts importés')} · ${fmtInt(numbers)} ${pluralize(numbers, 'numéro', 'numéros')}${kept}.</p>
        <p>${coverage}</p>
        <p>Les noms apparaissent dans la supervision au prochain rafraîchissement (bouton Actualiser), sinon d’ici cinq minutes.</p>`,
    }))}
    ${raw(warningList(r.warnings, 'Avertissements du serveur.'))}
  </div>`;
}

/** Repeint la seule carte de l'annuaire complementaire, si la page est montee. */
function paintContacts() {
  const host = qs('#adm-contacts');
  if (host) mount(host, contactsCard());
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

  // Annuaire complementaire : aucun de ces gestes ne touche a `_dirty`.
  on(document, 'change', '#adm-contacts-file', function (ev, el) {
    const input = /** @type {HTMLInputElement} */ (el);
    const file = input.files && input.files.length ? input.files[0] : null;
    if (file) pickCsv(file);
  });
  on(document, 'click', '#adm-contacts-import', function () { importCsv(); });
  on(document, 'click', '#adm-contacts-clear', function () { clearImport(); });
  on(document, 'click', '[data-contacts-reload]', function () { loadImportState(); });

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

// -----------------------------------------------------------------------------
//  Annuaire complementaire : chargement, lecture du fichier, import, suppression
// -----------------------------------------------------------------------------

/**
 * Lit le champ `imported` de /api/directory, hors cache (un import doit se
 * voir tout de suite). Un echec ne bloque pas la page : la carte dit que
 * l'etat est inconnu et propose de reessayer.
 */
async function loadImportState() {
  const seq = ++_importSeq;
  _import = null;
  paintContacts();
  let next;
  try {
    const res = await getDirectory({ force: true });
    next = { imported: res && res.imported && typeof res.imported === 'object' ? res.imported : null, error: '' };
  } catch (err) {
    next = { imported: null, error: err && err.message ? String(err.message) : String(err) };
  }
  // Un import, une suppression ou une autre lecture est passe entre temps :
  // cette reponse est perimee, l'etat affiche est deja le bon.
  if (seq !== _importSeq) return;
  _import = next;
  paintContacts();
}

/**
 * Lit le fichier choisi (UTF-8, l'encodage de l'export) et l'analyse dans le
 * navigateur avec la fonction du serveur : l'apercu montre exactement ce qui
 * sera retenu. Un fichier trop gros est refuse avant toute lecture.
 * @param {File} file
 */
function pickCsv(file) {
  const seq = ++_csvSeq;
  _csv = emptyCsv();
  _csv.name = String(file.name || '');
  _csv.size = Number(file.size) || 0;

  if (_csv.size > MAX_CSV_BYTES) {
    _csv.errorTitle = 'Fichier trop volumineux.';
    _csv.error = 'Ce fichier fait ' + fmtInt(Math.round(_csv.size / 1024)) + ' Ko ; la limite est de 2 Mo. '
      + 'Un export de contacts Keyyo Phone tient en quelques dizaines de Ko : vérifier qu’il s’agit du bon fichier.';
    paintContacts();
    return;
  }

  _csv.reading = true;
  paintContacts();

  const reader = new FileReader();
  reader.onload = function () {
    // Un autre fichier a ete choisi pendant la lecture : celle-ci ne compte plus.
    if (seq !== _csvSeq) return;
    _csv.reading = false;
    _csv.text = typeof reader.result === 'string' ? reader.result : '';
    try {
      _csv.parsed = parseContactsExport(_csv.text);
    } catch (err) {
      _csv.parsed = null;
      _csv.errorTitle = 'Ce fichier n’est pas un export de contacts Keyyo Phone.';
      _csv.error = err && err.message ? String(err.message) : String(err);
    }
    paintContacts();
  };
  reader.onerror = function () {
    if (seq !== _csvSeq) return;
    _csv.reading = false;
    _csv.errorTitle = 'Lecture du fichier impossible.';
    _csv.error = reader.error && reader.error.message ? String(reader.error.message) : 'Le navigateur n’a pas pu lire ce fichier.';
    paintContacts();
  };
  reader.readAsText(file);
}

/** Envoie le texte du fichier au serveur, qui refait la meme analyse et conserve le resultat. */
async function importCsv() {
  if (_csv.sending || _csv.reading || _clearing || !_csv.parsed || !_csv.text) return;
  const n = Array.isArray(_csv.parsed.contacts) ? _csv.parsed.contacts.length : 0;
  if (!n) return;

  const current = _csv;
  current.sending = true;
  paintContacts();
  try {
    const res = await postDirectoryImport({ csv: current.text, filename: current.name });
    const imp = res && res.imported && typeof res.imported === 'object' ? res.imported : null;
    _importSeq++;   // une lecture encore en vol decrirait l'etat d'avant l'import
    _import = { imported: imp, error: '' };
    _csv = emptyCsv();
    _csv.result = res && typeof res === 'object' ? res : {};
    const count = imp && Number(imp.count) ? Number(imp.count) : n;
    toast({
      title: 'Annuaire complémentaire importé.',
      sub: fmtInt(count) + ' ' + pluralize(count, 'contact', 'contacts') + ' · les noms apparaissent au prochain rafraîchissement de la supervision.',
      tone: 'ok',
    });
  } catch (err) {
    toast({ title: 'Import refusé', sub: err && err.message ? String(err.message) : String(err), tone: 'error' });
  } finally {
    current.sending = false;
    paintContacts();
  }
}

/** Supprime l'annuaire complementaire, apres confirmation explicite. */
async function clearImport() {
  if (_clearing || _csv.sending || !_import || !_import.imported) return;
  const imp = _import.imported;
  const count = Number(imp.count) || 0;
  const ok = window.confirm(
    'Supprimer l’annuaire complémentaire ?\n\n'
    + 'Les ' + fmtInt(count) + ' contacts importés' + (imp.filename ? ' (' + String(imp.filename) + ')' : '')
    + ' ne nommeront plus les correspondants. L’annuaire Keyyo du compte n’est pas touché ; un nouvel import reste possible à tout moment.',
  );
  if (!ok) return;

  _clearing = true;
  paintContacts();
  try {
    await clearDirectoryImport();
    _importSeq++;   // idem : une lecture en vol re-afficherait l'import supprime
    _import = { imported: null, error: '' };
    _csv.result = null;
    toast({ title: 'Import supprimé.', sub: 'Les correspondants concernés reviennent en numéro au prochain rafraîchissement.', tone: 'ok' });
  } catch (err) {
    toast({ title: 'Suppression refusée', sub: err && err.message ? String(err.message) : String(err), tone: 'error' });
  } finally {
    _clearing = false;
    paintContacts();
  }
}

async function load() {
  _loadError = '';
  _data = null;
  _dirty = false;
  paint();
  // L'etat de l'annuaire complementaire se charge en parallele : son echec
  // n'empeche pas d'editer les acces, et sa reponse ne repeint que sa carte.
  loadImportState();
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
