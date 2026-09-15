// =============================================================================
//  app/pages/agents.js — Vue « Attribution » : qui a pris, emis, transfere.
//
//  La seule vue qui repond a « qui a repondu ? ». Elle ne lit PAS les releves
//  d'appels Keyyo (qui ne nomment personne) mais le JOURNAL D'ATTRIBUTION :
//  les faits produits par l'application quand une personne connectee
//  decroche, appelle, transfere ou declare avoir pris un appel, et les appels
//  de la ligne observes par les navigateurs, avec leur duree de sonnerie.
//
//  REGLE D'AFFICHAGE : une statistique partielle ne doit jamais avoir l'air
//  complete. La vue met donc au meme niveau que les chiffres attribues le
//  nombre d'appels decroches PAR ON NE SAIT QUI, et le dit en toutes lettres.
//  Un agent qui prend ses appels au telephone sans passer par l'application
//  n'apparait pas ici — ce n'est pas un zero, c'est une absence.
//
//  Le perimetre est le MOIS, pas la barre de periode : le journal est range
//  par mois, et la comparaison utile est « ce mois-ci / le mois dernier ».
// =============================================================================

import { html, raw, mount, on } from '../dom.js';
import { card, sectionHead, table, tag, avatar, notice, empty, skeleton, kpi } from '../ui.js';
import { journal, loadJournal, labelOf, getLines, lineByCsi } from '../store.js';
import { photoUrl } from '../api.js';
import { fmtInt, fmtPct, fmtDurationShort, fmtRelative, fmtMonth, pluralize } from '../format.js';
import { formatNumber } from '../../shared/phone.js';
import { monthOf } from '../../shared/journal.js';

/** Mois proposes : celui-ci et les deux precedents. */
const MONTHS_BACK = 2;

/** Nombre de destinations listees. */
const CALLEES_MAX = 10;

/** @type {WeakSet<object>} racines deja cablees. */
const _wiredRoots = new WeakSet();

/** Mois choisi par l'utilisateur, ou '' pour le mois courant. */
let _month = '';

/** Personne dont la fiche est ouverte (adresse), ou ''. */
let _person = '';

/** Nombre de faits listes dans une fiche. */
const PERSON_EVENTS_MAX = 40;

// -----------------------------------------------------------------------------
//  Rendu
// -----------------------------------------------------------------------------

/**
 * @param {HTMLElement} root
 */
export function render(root) {
  const wanted = _month || currentMonth();
  const j = journal();

  // Premier passage sur ce mois : on declenche le chargement, qui notifiera.
  if (j.month !== wanted && !j.loading) loadJournal(wanted);

  const head = html`${raw(monthBar(wanted))}`;

  if ((j.month !== wanted) || j.loading) {
    mount(root, html`${raw(head)}<p class="sr-only" role="status">Chargement du journal…</p>
      <div class="kpi-grid">${raw(skeleton('card'))}${raw(skeleton('card'))}${raw(skeleton('card'))}${raw(skeleton('card'))}</div>
      ${raw(skeleton('card'))}`);
    wire(root);
    return;
  }

  if (j.error) {
    mount(root, html`${raw(head)}${raw(notice({
      tone: 'error',
      title: 'Journal indisponible.',
      body: html`${j.error} <button class="btn btn--sm" type="button" data-journal-retry>Réessayer</button>`,
    }))}`);
    wire(root);
    return;
  }

  const s = j.summary || { agents: [], calls: emptyCalls(), period: { min: 0, max: 0 } };
  if (!j.events.length) {
    mount(root, html`${raw(head)}${raw(card({
      title: 'Aucun fait enregistré pour ' + fmtMonth(wanted),
      body: raw(empty(
        'Le journal est vide pour ce mois',
        'Il se remplit quand les agents décrochent, appellent, transfèrent ou déclarent un appel depuis la barre d’appel (page agent ou supervision). Un store Blob doit être relié au projet pour le conserver.',
      )),
    }))}`);
    wire(root);
    return;
  }

  const selected = _person ? s.agents.find((a) => a.email === _person) : null;
  mount(root, html`${raw(head)}
    ${raw(kpiRow(s.calls))}
    ${raw(sectionHead('Par personne', 'D’après les actions faites dans l’application et les lignes personnelles. Cliquez une personne pour le détail de son mois.'))}
    ${raw(agentsCard(s.agents))}
    ${selected ? raw(personCard(selected, j.events)) : ''}
    <div class="dash" style="margin-top: var(--gap-5)">
      <div class="dash-left">${raw(calleesCard(s.agents))}</div>
      <div class="dash-right">${raw(methodCard(s.calls, j))}</div>
    </div>`);
  wire(root);
}

// -----------------------------------------------------------------------------
//  Blocs
// -----------------------------------------------------------------------------

/** @param {string} wanted @returns {string} */
function monthBar(wanted) {
  const months = [];
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i <= MONTHS_BACK; i++) {
    const d = new Date(now * 1000);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(monthOf(Math.floor(d.getTime() / 1000)));
  }
  const j = journal();
  return html`<div class="toolbar">
    <div class="segmented" role="group" aria-label="Mois">
      ${months.map((m) => raw(html`<button type="button" data-journal-month="${m}" class="${m === wanted ? 'is-active' : ''}">${fmtMonth(m)}</button>`))}
    </div>
    <span class="toolbar-spacer"></span>
    <span class="periodbar-info">${j.at && j.month === wanted ? 'Journal lu ' + fmtRelative(j.at) + (j.partitions ? ' · ' + fmtInt(j.partitions) + ' ' + pluralize(j.partitions, 'personne', 'personnes') : '') : ''}</span>
    <button class="btn btn--icon" type="button" data-journal-retry aria-label="Relire le journal" title="Relire le journal">${raw('<svg aria-hidden="true"><use href="#i-refresh"/></svg>')}</button>
  </div>`;
}

/** @returns {any} */
function emptyCalls() {
  return { observed: 0, answered: 0, missed: 0, attributed: 0, unattributed: 0, ringAnsweredTotal: 0, ringAnsweredCount: 0, ringMissedTotal: 0, ringMissedCount: 0 };
}

/** @param {any} c @returns {string} */
function kpiRow(c) {
  const ringAns = c.ringAnsweredCount ? Math.round(c.ringAnsweredTotal / c.ringAnsweredCount) : 0;
  const ringMissed = c.ringMissedCount ? Math.round(c.ringMissedTotal / c.ringMissedCount) : 0;
  const rate = c.answered ? (c.attributed / c.answered) * 100 : 0;
  return html`<div class="kpi-grid">
    ${raw(kpi({
      label: 'Appels observés',
      value: fmtInt(c.observed),
      foot: fmtInt(c.answered) + ' ' + pluralize(c.answered, 'décroché', 'décrochés') + ' · ' + fmtInt(c.missed) + ' ' + pluralize(c.missed, 'manqué', 'manqués'),
      why: 'Appels de la ligne vus se terminer par au moins un navigateur connecté. Un appel survenu sans aucun navigateur ouvert n’est pas observé.',
    }))}
    ${raw(kpi({
      label: 'Décrochés attribués',
      value: c.answered ? fmtPct(rate, 0) : '—',
      foot: fmtInt(c.attributed) + ' sur ' + fmtInt(c.answered) + (c.auto ? ' · ' + fmtInt(c.auto) + ' d’office' : '') + ' · ' + fmtInt(c.unattributed) + ' par on ne sait qui',
      why: 'Un appel est attribué quand une personne connectée l’a décroché depuis l’application, l’a transféré, a déclaré l’avoir pris — ou quand il a été décroché sur sa ligne personnelle (une ligne cochée pour elle seule dans l’Administration) : il est alors attribué d’office, sans clic. Le reste a été décroché sur une ligne partagée, sans passer par ici.',
      tone: c.unattributed ? 'missed' : 'ok',
    }))}
    ${raw(kpi({
      label: 'Sonnerie avant décroché',
      value: ringAns ? fmtDurationShort(ringAns) : '—',
      foot: c.ringAnsweredCount ? 'moyenne sur ' + fmtInt(c.ringAnsweredCount) + ' ' + pluralize(c.ringAnsweredCount, 'appel entrant', 'appels entrants') : 'aucun entrant décroché observé',
      why: 'Mesurée par le CTI de Keyyo : de la première sonnerie au décroché, quel que soit le poste qui a répondu.',
      tone: 'ok',
    }))}
    ${raw(kpi({
      label: 'Sonnerie des manqués',
      value: ringMissed ? fmtDurationShort(ringMissed) : '—',
      foot: c.ringMissedCount ? 'moyenne sur ' + fmtInt(c.ringMissedCount) + ' ' + pluralize(c.ringMissedCount, 'appel manqué', 'appels manqués') : 'aucun manqué observé',
      why: 'Combien de temps un appelant a attendu avant de raccrocher ou d’être renvoyé.',
      tone: 'missed',
    }))}
  </div>`;
}

/**
 * Nom affichable d'une adresse : l'annuaire des lignes (equipes) d'abord,
 * sinon la partie locale de l'adresse.
 * @param {string} email
 * @returns {string}
 */
function nameOfEmail(email) {
  const e = String(email || '').toLowerCase();
  for (const line of getLines()) {
    for (const m of line.team || []) {
      if (m && m.email && String(m.email).toLowerCase() === e && m.name) return String(m.name);
    }
  }
  const local = e.split('@')[0] || e;
  return local.split(/[._-]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ') || e;
}

/** @param {any[]} agents @returns {string} */
function agentsCard(agents) {
  const rows = agents.map((a) => {
    const name = nameOfEmail(a.email);
    const ring = a.ringCount ? Math.round(a.ringTotal / a.ringCount) : 0;
    const open = _person === a.email;
    const detail = [];
    if (a.claimed) detail.push(fmtInt(a.claimed) + ' déclaré' + (a.claimed > 1 ? 's' : ''));
    if (a.auto) detail.push(fmtInt(a.auto) + ' d’office');
    return [
      html`<button class="cell-id" type="button" data-person="${a.email}" aria-expanded="${open ? 'true' : 'false'}" title="${open ? 'Fermer la fiche' : 'Ouvrir la fiche de ' + name}">
        ${raw(avatar(name, { size: 'sm', photo: photoUrl(a.email, 48) }))}
        <div class="cell-id-body"><div class="cell-id-name">${name}</div><div class="cell-id-sub">${a.email}${a.lines && a.lines.length ? ' · ligne personnelle' : ''}</div></div>
      </button>`,
      html`<span class="tnum">${fmtInt(a.taken)}</span>${detail.length ? raw(html` <span class="faint" title="déclarés : pris au téléphone puis déclarés ici · d’office : décrochés sur sa ligne personnelle">(${detail.join(', ')})</span>`) : ''}`,
      html`<span class="tnum">${fmtInt(a.dialed)}</span>`,
      html`<span class="tnum">${fmtInt(a.transferred)}</span>`,
      html`<span class="tnum">${ring ? fmtDurationShort(ring) : '—'}</span>`,
      html`<span class="tnum">${a.talkTotal ? fmtDurationShort(a.talkTotal) : '—'}</span>`,
      html`<span class="faint">${a.lastTs ? fmtRelative(new Date(a.lastTs * 1000).toISOString()) : '—'}</span>`,
    ];
  });
  return card({
    flush: true,
    body: raw(table({
      // Sans defilement : pris et emis restent, le reste se masque selon la
      // place (les colonnes reviennent toutes en mode empile).
      columns: [
        { key: 'who', label: 'Personne', breakAnywhere: true },
        { key: 'taken', label: 'Pris', align: 'right' },
        { key: 'dialed', label: 'Émis', align: 'right' },
        { key: 'transferred', label: 'Transferts', align: 'right', priority: 'md' },
        { key: 'ring', label: 'Sonnerie moy.', align: 'right', priority: 'lg' },
        { key: 'talk', label: 'En ligne', align: 'right', priority: 'lg' },
        { key: 'last', label: 'Dernière action', align: 'right', priority: 'md' },
      ],
      rows,
      foot: html`<span class="faint">« Pris » = décroché depuis l’application, déclaré pris, ou décroché sur sa ligne personnelle ; un même appel ne compte qu’une fois.</span>`,
    })),
  });
}

/** @param {unknown} n @returns {string} chiffres seuls, pour comparer deux numeros. */
function digitsOf(n) {
  return String(n == null ? '' : n).replace(/\D/g, '');
}

/**
 * Fiche d'une personne : ses chiffres du mois et ses derniers faits.
 *
 * Tout vient du journal : ses actions (dial, answer, claim, transfer, hangup)
 * et, si elle a une ligne personnelle, les appels observes sur cette ligne.
 * « Rappelés » : parmi les appels manqués qui la concernent (sa ligne
 * personnelle, sinon toutes les lignes), ceux dont elle a recomposé le numéro
 * plus tard dans le mois.
 * @param {any} a  resume de la personne (summarize)
 * @param {any[]} events  tous les evenements du mois
 * @returns {string}
 */
function personCard(a, events) {
  const email = String(a.email).toLowerCase();
  const name = nameOfEmail(email);
  const own = new Set(Array.isArray(a.lines) ? a.lines : []);
  const list = Array.isArray(events) ? events : [];

  /** @type {Set<string>} appels relies a quelqu'un par une action nominative */
  const named = new Set();
  for (const e of list) if (e.type !== 'observed' && e.callref) named.add(String(e.csi) + ':' + String(e.callref));

  const mine = list.filter((e) => e.type !== 'observed' && String(e.email).toLowerCase() === email);
  const auto = own.size
    ? list.filter((e) => e.type === 'observed' && own.has(String(e.csi)) && !named.has(String(e.csi) + ':' + String(e.callref)))
    : [];

  // Rappels : un manque (sur sa ligne, sinon n'importe laquelle) suivi d'un
  // appel emis par elle vers le meme numero.
  const missed = list.filter((e) => e.type === 'observed' && e.dir === 'in' && e.answered !== 1 && e.peer && e.peer !== 'anonymous' && (!own.size || own.has(String(e.csi))));
  const dials = mine.filter((e) => e.type === 'dial');
  let calledBack = 0;
  for (const m of missed) {
    const p = digitsOf(m.peer);
    if (p && dials.some((d) => Number(d.ts) > Number(m.ts) && digitsOf(d.to).slice(-9) === p.slice(-9))) calledBack++;
  }

  const ring = a.ringCount ? Math.round(a.ringTotal / a.ringCount) : 0;
  const cells = [
    ['Pris', fmtInt(a.taken), [a.answered ? fmtInt(a.answered) + ' depuis l’application' : '', a.claimed ? fmtInt(a.claimed) + ' déclarés' : '', a.auto ? fmtInt(a.auto) + ' d’office' : ''].filter(Boolean).join(' · ') || 'aucun'],
    ['Émis', fmtInt(a.dialed), a.callees.length ? fmtInt(a.callees.length) + ' ' + pluralize(a.callees.length, 'destinataire', 'destinataires') : 'aucun'],
    ['Manqués', own.size ? fmtInt(a.missed) : '—', own.size ? 'sur sa ligne personnelle' : 'ligne partagée : non attribuable'],
    ['Rappelés', fmtInt(calledBack), missed.length ? 'sur ' + fmtInt(missed.length) + ' ' + pluralize(missed.length, 'manqué', 'manqués') + (own.size ? ' de sa ligne' : ' du mois') : 'aucun manqué'],
    ['Transferts', fmtInt(a.transferred), ''],
    ['Sonnerie moyenne', ring ? fmtDurationShort(ring) : '—', a.ringCount ? 'avant décroché, sur ' + fmtInt(a.ringCount) + ' ' + pluralize(a.ringCount, 'appel', 'appels') : ''],
    ['En ligne', a.talkTotal ? fmtDurationShort(a.talkTotal) : '—', 'temps de conversation des appels pris'],
    ['Dernière action', a.lastTs ? fmtRelative(new Date(a.lastTs * 1000).toISOString()) : '—', ''],
  ];

  const facts = mine.concat(auto).sort((x, y) => (Number(y.ts) || 0) - (Number(x.ts) || 0)).slice(0, PERSON_EVENTS_MAX);
  const rows = facts.map((e) => {
    const when = new Date((Number(e.ts) || 0) * 1000);
    const stamp = when.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + when.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    let what = '';
    let tone = 'neutral';
    if (e.type === 'dial') { what = 'Appel émis vers ' + (e.toName ? e.toName + ' (' + labelOf(e.to) + ')' : labelOf(e.to)); tone = 'out'; }
    else if (e.type === 'answer') { what = 'Décroché depuis l’application · ' + labelOf(e.peer); tone = 'in'; }
    else if (e.type === 'claim') { what = 'Déclaré pris · ' + labelOf(e.peer); tone = 'in'; }
    else if (e.type === 'transfer') { what = 'Transféré vers ' + (e.toName ? e.toName + ' (' + labelOf(e.to) + ')' : labelOf(e.to)); tone = 'ok'; }
    else if (e.type === 'hangup') { what = 'Raccroché'; }
    else if (e.type === 'observed') {
      if (e.dir === 'out') { what = 'Appel émis depuis son téléphone vers ' + labelOf(e.peer); tone = 'out'; }
      else if (e.answered === 1) { what = 'Décroché sur sa ligne · ' + labelOf(e.peer); tone = 'in'; }
      else { what = 'Manqué sur sa ligne · ' + labelOf(e.peer); tone = 'missed'; }
    }
    const extra = [];
    if (e.ring) extra.push('sonnerie ' + fmtDurationShort(e.ring));
    if (e.duration) extra.push('durée ' + fmtDurationShort(e.duration));
    return [
      html`<span class="nowrap">${stamp}</span>`,
      html`${raw(tag(e.type === 'observed' ? 'd’office' : e.type, /** @type {any} */ (tone)))} ${what}`,
      html`<span class="faint">${extra.join(' · ')}</span>`,
    ];
  });

  return card({
    title: raw(html`<span class="row">${raw(avatar(name, { size: 'lg', photo: photoUrl(email, 96) }))}<span>${name}</span></span>`),
    sub: email + (own.size ? ' · ligne personnelle : ' + Array.from(own).map((c) => { const l = lineByCsi(c); return l ? l.label : formatNumber(c); }).join(', ') : ' · pas de ligne personnelle : seules ses actions dans l’application comptent'),
    action: raw(html`<button class="btn btn--sm btn--ghost" type="button" data-person="${email}" data-person-card>Fermer</button>`),
    body: raw(html`<div class="diag-grid">
      ${cells.map(([l, v, sub]) => raw(html`<div class="diag-cell"><div class="diag-cell-label">${l}</div><div class="diag-cell-value">${v}</div>${sub ? raw(html`<div class="faint" style="font: var(--t-micro); margin-top: 2px">${sub}</div>`) : ''}</div>`))}
    </div>
    <div style="margin-top: var(--gap-4)">${raw(rows.length
      ? table({
        columns: [
          { key: 'when', label: 'Quand', cls: 'shrink', nowrap: true },
          { key: 'what', label: 'Fait', breakAnywhere: true },
          { key: 'extra', label: 'Détail', priority: 'md' },
        ],
        rows,
        foot: html`<span class="faint">${fmtInt(facts.length)} ${pluralize(facts.length, 'fait', 'faits')} sur ${fmtInt(mine.length + auto.length)}, du plus récent au plus ancien.</span>`,
      })
      : empty('Aucun fait ce mois-ci', 'Rien n’a été fait ni observé pour cette personne sur ce mois.'))}</div>`),
  });
}

/** @param {any[]} agents @returns {string} */
function calleesCard(agents) {
  /** @type {Map<string, {count: number, who: Set<string>}>} */
  const acc = new Map();
  for (const a of agents) {
    for (const c of a.callees || []) {
      let e = acc.get(c.to);
      if (!e) { e = { count: 0, who: new Set() }; acc.set(c.to, e); }
      e.count += c.count;
      e.who.add(nameOfEmail(a.email));
    }
  }
  const list = Array.from(acc.entries()).sort((x, y) => y[1].count - x[1].count).slice(0, CALLEES_MAX);
  if (!list.length) {
    return card({
      title: 'Vers qui on appelle',
      sub: 'Depuis l’application, ce mois-ci',
      body: raw(empty('Aucun appel émis depuis l’application', 'Les numéros composés depuis la barre d’appel apparaîtront ici.')),
    });
  }
  const rows = list.map(([to, e]) => [
    html`<div class="strong">${calleeLabel(to)}</div><div class="faint" style="font: var(--t-micro)">${formatNumber(to)}${lineByCsi(to) ? ' · ligne partagée par tout un site' : ''}</div>`,
    html`<span class="tnum">${fmtInt(e.count)}</span>`,
    html`${Array.from(e.who).join(', ')}`,
  ]);
  return card({
    title: 'Vers qui on appelle',
    sub: 'Depuis l’application, ce mois-ci',
    flush: true,
    body: raw(table({
      columns: [
        { key: 'to', label: 'Destinataire', breakAnywhere: true },
        { key: 'n', label: 'Appels', align: 'right' },
        { key: 'who', label: 'Par' },
      ],
      rows,
    })),
  });
}

/**
 * Destinataire d'un appel emis : une LIGNE DU COMPTE est nommee comme telle
 * (« Ligne BIOS TNR ») plutot que par le premier contact que l'annuaire lui
 * rattache — les collegues sans numero direct passent tous par elle.
 * @param {string} number
 * @returns {string}
 */
function calleeLabel(number) {
  const line = lineByCsi(number);
  if (line) return 'Ligne ' + String(line.label);
  return labelOf(number);
}

/** @param {any} c @param {any} j @returns {string} */
function methodCard(c, j) {
  const items = [
    ['Appels observés', fmtInt(c.observed), 'in'],
    ['Attribués à une personne', fmtInt(c.attributed), 'ok'],
    ['Décrochés sans attribution', fmtInt(c.unattributed), c.unattributed ? 'missed' : 'neutral'],
    ['Faits enregistrés', fmtInt(j.events.length), 'neutral'],
  ];
  return card({
    title: 'Comment lire ces chiffres',
    body: raw(html`<div class="stack">
      ${items.map(([label, value, tone]) => raw(html`<div class="row" style="justify-content: space-between"><span>${label}</span>${raw(tag(value, /** @type {any} */ (tone)))}</div>`))}
      <p class="faint" style="font: var(--t-sm); margin-top: 8px">Aucune API Keyyo ne dit qui a décroché : trois lignes de site sont partagées par toute l’équipe. Seules les actions faites dans l’application — décrocher, appeler, transférer, « c’est moi qui ai répondu » — relient un appel à une personne. Plus les agents passent par la barre d’appel, plus cette vue est complète.</p>
    </div>`),
  });
}

// -----------------------------------------------------------------------------
//  Cablage
// -----------------------------------------------------------------------------

/** @param {HTMLElement} root */
function wire(root) {
  if (_wiredRoots.has(root)) return;
  _wiredRoots.add(root);
  on(root, 'click', '[data-journal-month]', function (ev, el) {
    _month = el.getAttribute('data-journal-month') || '';
    loadJournal(_month || currentMonth());
  });
  on(root, 'click', '[data-journal-retry]', function () {
    loadJournal(_month || currentMonth(), { force: true });
  });
  on(root, 'click', '[data-person]', function (ev, el) {
    const email = String(el.getAttribute('data-person') || '').toLowerCase();
    _person = _person === email ? '' : email;
    render(root);
    if (_person) {
      const close = root.querySelector('[data-person-card]');
      const box = close ? close.closest('.card') : null;
      if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

/** @returns {string} */
function currentMonth() {
  return monthOf(Math.floor(Date.now() / 1000));
}
