// =============================================================================
//  app/agent.js — La page agent : ma ligne, mes appels, mes collegues.
//
//  Une page a part de la supervision, volontairement petite : un agent n'a
//  pas besoin des trois mois d'historique de toute l'equipe, il a besoin de
//  decrocher, d'appeler, de transferer, et de voir ce qu'il a fait. Elle
//  s'appuie sur la meme session (cookie), la meme barre d'appel
//  (app/callbar.js) et le meme journal (app/journal.js) que la supervision.
//
//  CE QU'ELLE MONTRE, ET D'OU CA VIENT
//    - ma ligne          : /api/me (l'annuaire Keyyo rattache mon adresse a un site)
//    - mes collegues     : /api/me (noms et numeros, jamais d'adresses)
//    - mon activite      : /api/events?scope=me — UNIQUEMENT ce que j'ai fait
//                          ou declare ici. Un appel pris au telephone sans le
//                          declarer n'y est pas, et la page le dit.
//    - les noms          : /api/directory, pour nommer mes correspondants.
// =============================================================================

import * as session from './session.js';
import * as cti from './cti.js';
import * as callbar from './callbar.js';
import * as journal from './journal.js';
import { getProfile, getDirectory } from './api.js';
import { qs, on, html, raw, mount, icon } from './dom.js';
import { fmtInt, fmtDurationShort, fmtRelative, pluralize, fmtDate, fmtTime } from './format.js';
import { card, notice, empty, skeleton } from './ui.js';
import { toE164, formatNumber } from '../shared/phone.js';
import { initialsOf } from '../shared/identity.js';
import { monthOf } from '../shared/journal.js';
import { toast } from './alerts.js';

/** Rafraichissement de « mon activite », en millisecondes. */
const REFRESH_MS = 60000;

/** @type {Map<string, string>} annuaire numero E.164 -> nom */
let _names = new Map();
/** @type {any} */
let _profile = null;
let _month = '';
let _timer = 0;

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
//  Noms
// -----------------------------------------------------------------------------

/** @param {string} number @returns {string} */
function labelOf(number) {
  const key = toE164(number);
  if (key && key !== 'anonymous') {
    const hit = _names.get(key);
    if (hit) return hit;
  }
  if (_profile && Array.isArray(_profile.colleagues)) {
    const digits = String(number || '').replace(/\D/g, '');
    const c = _profile.colleagues.find((x) => String(x.number || '').replace(/\D/g, '') === digits);
    if (c) return c.name;
  }
  return formatNumber(number);
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
  if (ini && u) ini.textContent = initialsOf(u.name);
  if (sub && u) sub.textContent = u.roleLabel;
  const link = qs('#link-supervision');
  if (link) link.hidden = !session.isDirection();
  const hello = qs('#agent-hello');
  if (hello && u) hello.textContent = 'Bonjour, ' + (u.name.split(' ')[0] || u.name);
}

function paintLine() {
  const host = qs('#agent-line');
  if (!host) return;
  const snap = cti.snapshot();
  const line = snap.line || (_profile && _profile.line) || null;
  const parts = [];
  if (line) parts.push(html`<p class="agent-row-main">${line.label}${line.number ? html` <span class="faint">${line.number}</span>` : ''}</p>`);
  else parts.push(html`<p class="agent-row-sub">Aucune ligne rattachée à votre adresse : choisissez-en une dans la barre d’appel.</p>`);
  if (line && line.members) parts.push(html`<p class="agent-row-sub">${fmtInt(line.members)} ${pluralize(line.members, 'personne partage', 'personnes partagent')} cette ligne : un appel entrant sonne pour toute l’équipe.</p>`);
  mount(host, card({
    title: 'Ma ligne',
    sub: snap.connected ? 'connectée' : (snap.message || 'en attente'),
    body: raw(parts.join('')),
  }));
}

/** @param {any} summary @param {any[]} events */
function paintActivity(summary, events) {
  const host = qs('#agent-activity');
  if (!host) return;
  const me = summary && summary.agents && summary.agents[0] ? summary.agents[0] : null;
  const taken = me ? me.taken : 0;
  const dialed = me ? me.dialed : 0;
  const transferred = me ? me.transferred : 0;
  const ringAvg = me && me.ringCount ? Math.round(me.ringTotal / me.ringCount) : 0;

  const kpis = html`<div class="agent-kpis">
    <div class="agent-kpi agent-kpi--in"><div class="agent-kpi-value">${fmtInt(taken)}</div><div class="agent-kpi-label">${pluralize(taken, 'appel pris', 'appels pris')}</div></div>
    <div class="agent-kpi agent-kpi--out"><div class="agent-kpi-value">${fmtInt(dialed)}</div><div class="agent-kpi-label">${pluralize(dialed, 'appel émis', 'appels émis')}</div></div>
    <div class="agent-kpi"><div class="agent-kpi-value">${fmtInt(transferred)}</div><div class="agent-kpi-label">${pluralize(transferred, 'transfert', 'transferts')}</div></div>
    <div class="agent-kpi agent-kpi--ok"><div class="agent-kpi-value">${ringAvg ? fmtDurationShort(ringAvg) : '—'}</div><div class="agent-kpi-label">sonnerie moyenne avant décroché</div></div>
  </div>`;

  const callees = me && me.callees.length
    ? html`<div class="agent-list">${me.callees.slice(0, 8).map((c) => html`<div class="agent-row">
        ${raw(icon('out'))}
        <div><div class="agent-row-main">${labelOf(c.to)}</div><div class="agent-row-sub">${formatNumber(c.to)}</div></div>
        <div class="agent-row-metric">${fmtInt(c.count)}</div>
      </div>`)}</div>`
    : empty('Aucun appel émis ce mois-ci', 'Les appels lancés depuis cette page apparaîtront ici, avec leur destinataire.');

  mount(host, card({
    title: 'Mon activité — ' + monthLabel(_month),
    sub: 'Ce que vous avez fait ou déclaré depuis l’application. Un appel pris au téléphone sans le déclarer n’y figure pas.',
    body: raw(kpis + html`<h3 class="card-title" style="margin-top:18px">Vers qui j’appelle</h3>` + callees),
  }));

  const recent = qs('#agent-recent');
  if (!recent) return;
  const mine = (events || []).filter((e) => e.type !== 'observed').slice(-12).reverse();
  const rows = mine.map((e) => {
    const when = new Date(Number(e.ts) * 1000);
    const iso = when.toISOString().slice(0, 10);
    let what = '';
    let ico = 'phone';
    if (e.type === 'dial') { what = 'Appel émis vers ' + labelOf(e.to); ico = 'out'; }
    else if (e.type === 'answer') { what = 'Décroché depuis l’application · ' + labelOf(e.peer); ico = 'in'; }
    else if (e.type === 'claim') { what = 'Déclaré pris · ' + labelOf(e.peer); ico = 'in'; }
    else if (e.type === 'transfer') { what = 'Transféré vers ' + labelOf(e.to); ico = 'peers'; }
    else if (e.type === 'hangup') { what = 'Raccroché'; ico = 'close'; }
    const extra = e.ring ? ' · sonnerie ' + fmtDurationShort(e.ring) : '';
    return html`<div class="agent-row">${raw(icon(ico))}
      <div><div class="agent-row-main">${what}</div><div class="agent-row-sub">${fmtDate(iso)} ${fmtTime(when.getHours(), when.getMinutes())}${extra}</div></div>
      <div></div></div>`;
  });
  mount(recent, card({
    title: 'Derniers faits',
    body: raw(rows.length ? html`<div class="agent-list">${rows.map((r) => raw(r))}</div>` : empty('Rien pour l’instant', 'Vos actions dans la barre d’appel seront listées ici.')),
  }));
}

function paintColleagues() {
  const host = qs('#agent-colleagues');
  if (!host || !_profile) return;
  const list = Array.isArray(_profile.colleagues) ? _profile.colleagues : [];
  const managers = list.filter((c) => c.manager);
  const body = list.length
    ? html`<p class="agent-row-sub">${fmtInt(list.length)} ${pluralize(list.length, 'collègue', 'collègues')}${managers.length ? ', dont ' + fmtInt(managers.length) + ' ' + pluralize(managers.length, 'manager', 'managers') : ''}. Le bouton « Collègues » de la barre d’appel les propose pour appeler ou transférer.</p>`
    : html`<p class="agent-row-sub">L’annuaire Keyyo ne rattache personne à vos lignes : aucun collègue à proposer.</p>`;
  const warn = _profile.warnings && _profile.warnings.length
    ? notice({ tone: 'warn', title: 'À savoir.', body: html`${_profile.warnings.join(' ')}` })
    : '';
  mount(host, card({ title: 'Mes collègues', body: raw(body + warn) }));
}

/** @param {string} ym @returns {string} */
function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const names = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  return names[Number(m[2]) - 1] + ' ' + m[1];
}

// -----------------------------------------------------------------------------
//  Chargement
// -----------------------------------------------------------------------------

async function loadActivity() {
  try {
    const res = await journal.month({ month: _month, scope: 'me' });
    paintActivity(res.summary, res.events);
    const stamp = qs('#agent-updated');
    if (stamp) stamp.textContent = 'Mis à jour ' + fmtRelative(new Date().toISOString());
  } catch (err) {
    const host = qs('#agent-activity');
    if (host) {
      mount(host, card({
        title: 'Mon activité',
        body: raw(notice({
          tone: 'warn',
          title: 'Journal indisponible.',
          body: html`${err && err.message ? err.message : String(err)}`,
        })),
      }));
    }
  }
}

async function startApp() {
  hideGate();
  paintHeader();
  _month = monthOf(Math.floor(Date.now() / 1000));

  const activity = qs('#agent-activity');
  if (activity) mount(activity, skeleton('card'));

  try {
    _profile = await getProfile();
  } catch (err) {
    const host = qs('#agent-line');
    if (host) {
      mount(host, notice({
        tone: 'error',
        title: 'Profil indisponible.',
        body: html`${err && err.message ? err.message : String(err)} La ligne peut quand même être ouverte depuis la barre d’appel.`,
      }));
    }
    _profile = { colleagues: [], line: null, lines: [], warnings: [] };
  }

  getDirectory().then(function (dir) {
    const map = dir && dir.map && typeof dir.map === 'object' ? dir.map : {};
    const names = new Map();
    for (const k of Object.keys(map)) {
      const e = toE164(k);
      if (e && e !== 'anonymous' && !names.has(e)) names.set(e, String(map[k]));
    }
    _names = names;
    callbar.setLabelOf(labelOf);
    loadActivity();
  }).catch(function (err) {
    console.warn('[agent] annuaire indisponible :', err);
  });

  callbar.init({
    host: '#callbar',
    labelOf,
    colleagues: _profile.colleagues,
    toast,
  });
  cti.subscribe(paintLine);
  paintLine();
  paintColleagues();

  cti.start({ csi: _profile.line ? _profile.line.csi : undefined });

  loadActivity();
  journal.subscribe(function () {
    // Apres chaque envoi reussi, l'activite affichee peut avoir change.
    const j = journal.status();
    if (!j.pending && !j.lastError) loadActivity();
  });
  _timer = window.setInterval(function () { if (!document.hidden) loadActivity(); }, REFRESH_MS);

  const refresh = qs('#btn-refresh');
  if (refresh) on(refresh, 'click', function () { loadActivity(); });
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
