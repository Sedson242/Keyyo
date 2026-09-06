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
import { journal, loadJournal, labelOf, getLines } from '../store.js';
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

  mount(root, html`${raw(head)}
    ${raw(kpiRow(s.calls))}
    ${raw(sectionHead('Par personne', 'D’après les actions faites dans l’application. Une personne absente n’a rien fait ici — pas forcément rien pris.'))}
    ${raw(agentsCard(s.agents))}
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
      foot: fmtInt(c.attributed) + ' sur ' + fmtInt(c.answered) + ' · ' + fmtInt(c.unattributed) + ' par on ne sait qui',
      why: 'Un appel est attribué quand une personne connectée l’a décroché depuis l’application, l’a transféré, ou a déclaré l’avoir pris. Le reste a été décroché au téléphone sans passer par ici.',
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
    return [
      html`<div class="row"><span>${raw(avatar(name, { size: 'sm' }))}</span><div><div class="strong">${name}</div><div class="faint" style="font: var(--t-micro)">${a.email}</div></div></div>`,
      html`<span class="tnum">${fmtInt(a.taken)}</span>${a.claimed ? raw(html` <span class="faint" title="dont déclarés pris au téléphone">(${fmtInt(a.claimed)} déclarés)</span>`) : ''}`,
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
      columns: [
        { key: 'who', label: 'Personne' },
        { key: 'taken', label: 'Pris', align: 'right' },
        { key: 'dialed', label: 'Émis', align: 'right' },
        { key: 'transferred', label: 'Transferts', align: 'right' },
        { key: 'ring', label: 'Sonnerie moy.', align: 'right' },
        { key: 'talk', label: 'En ligne', align: 'right' },
        { key: 'last', label: 'Dernière action', align: 'right' },
      ],
      rows,
      minWidth: 760,
      foot: html`<span class="faint">« Pris » = décroché depuis l’application ou déclaré pris ; un même appel ne compte qu’une fois.</span>`,
    })),
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
  const body = list.length
    ? html`<div class="feed">${list.map(([to, e]) => raw(html`<div class="feed-item" style="color: var(--ink)">
        <div class="feed-title" style="color: var(--ink)">${labelOf(to)} <span class="faint">${formatNumber(to)}</span></div>
        <div class="feed-meta" style="color: var(--ink-muted)">${fmtInt(e.count)} ${pluralize(e.count, 'appel', 'appels')} · ${Array.from(e.who).join(', ')}</div>
      </div>`))}</div>`
    : empty('Aucun appel émis depuis l’application', 'Les numéros composés depuis la barre d’appel apparaîtront ici.');
  return card({ title: 'Vers qui on appelle', sub: 'Depuis l’application, ce mois-ci', body: raw(body) });
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
}

/** @returns {string} */
function currentMonth() {
  return monthOf(Math.floor(Date.now() / 1000));
}
