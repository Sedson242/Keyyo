// =============================================================================
//  app/pages/monitoring.js — Vue principale : supervision des appels.
//
//  Trame reprise de la maquette de reference (voir l'en-tete de pages.css) :
//
//    dash
//    +-- dash-left
//    |     card > statbar            (total, entrants, sortants)
//    |     card.rate-card            (taux de reponse + histogramme + top)
//    +-- dash-right
//    |     card--dark               (a rappeler)
//    |     card > splits            (repartition des appels)
//    +-- dash-wide
//          sectionHead + card--flush > table   (lignes et collaborateurs)
//
//  Trois regles suivies ici :
//
//   1. AUCUNE DONNEE INVENTEE. L'API Keyyo n'expose aucun indicateur de
//      decroche : un appel manque est un ENTRANT de duree nulle. Le taux de
//      reponse d'une periode se calcule donc (entrants - manques) / entrants,
//      et la carte le dit a l'utilisateur au lieu de laisser croire a une
//      mesure directe.
//
//   2. RIEN DE FAUX QUAND IL N'Y A RIEN. Une periode precedente sans aucun
//      entrant ne donne pas « 0 point » d'ecart mais « pas de comparaison
//      possible » ; une periode vide affiche une piste d'action, pas un vide.
//
//   3. UN SEUL JEU D'ECOUTEURS. `render` est rappelee a chaque changement
//      d'etat ; le cablage se fait donc une seule fois par racine, par
//      delegation, et survit aux remontages successifs.
// =============================================================================

import { html, raw, mount, on } from '../dom.js';
import {
  card, sectionHead, statbar, split, table, rankRow,
  avatar, avatarStack, meter, empty, notice, skeleton, tag,
} from '../ui.js';
import { barChart, areaChart, attachChartTips } from '../charts.js';
import {
  state, setFilter, filtered, getRows, stats,
  byDay, byMonth, byLine, callbackAnalysis,
  labelOf, lineByCsi, status, journal, loadJournal, nameOfEmail, firstNameOfEmail, effectiveGranularity,
} from '../store.js';
import { photoUrl } from '../api.js';
import {
  fmtInt, fmtPct, fmtHms, fmtTime, fmtDate, fmtDayShort, fmtMonth, fmtDurationShort, pluralize,
} from '../format.js';
import { F, isIncoming, isOutgoing, isMissed } from '../../shared/schema.js';
import { summarize, monthOf } from '../../shared/journal.js';
import { showPerson } from './agents.js';

/** Nombre de rappels listes dans la carte sombre : au-dela, c'est la vue Manques. */
const FEED_MAX = 5;

/** Taille des classements « Top collaborateurs » et « Top lignes ». */
const RANK_MAX = 5;

/**
 * Au-dela de ce nombre de points, l'histogramme du taux de reponse devient
 * une courbe : 92 barres d'un jour sur 600 px ne se lisent pas.
 */
const RATE_BARS_MAX = 16;

/** Lignes dont le detail (collaborateurs rattaches) est deplie, par CSI en chiffres. */
const _openLines = new Set();

/** Ecart minimal, en points, en dessous duquel le taux est dit stable. */
const DELTA_EPSILON = 0.5;

/** Seuils de coloration de la barre de taux, en pourcentage. */
const RATE_GOOD = 85;
const RATE_BAD = 60;

/**
 * Racines deja cablees. `mount` remplace le contenu de la section mais pas la
 * section elle-meme : sans cette memoire, chaque rendu ajouterait un jeu
 * d'ecouteurs supplementaire sur le meme element.
 * @type {WeakSet<object>}
 */
const _wiredRoots = new WeakSet();

// -----------------------------------------------------------------------------
//  Rendu
// -----------------------------------------------------------------------------

/**
 * Point d'entree de la vue.
 * @param {HTMLElement} root  La `section.page[data-page="monitoring"]`.
 */
export function render(root) {
  const st = status();

  // -- Etat 1 : chargement. L'ossature est decorative, l'attente est annoncee.
  if (st.kind === 'loading') {
    mount(root, loadingView());
    return;
  }

  const rows = filtered();
  const head = st.kind === 'error' ? errorNotice(st) : '';

  // -- Etat 2 : la collecte a repondu, mais rien ne tombe dans la periode.
  if (!rows.length) {
    mount(root, html`${raw(head)}${raw(emptyView())}`);
    wire(root);
    return;
  }

  // -- Etat 3 : rendu complet.
  const s = stats(rows);
  const callbacks = callbackAnalysis(rows);
  const lines = byLine(rows);

  // Le journal du mois nomme les personnes (Top collaborateurs, collaborateurs
  // d'une ligne) : demande une fois, il notifie a l'arrivee.
  const j = journal();
  const month = monthOf(Math.floor(Date.now() / 1000));
  if (j.month !== month && !j.loading) loadJournal(month);

  mount(root, html`${raw(head)}<div class="dash">
    <div class="dash-left">
      ${raw(countersCard(s))}
      ${raw(rateCard(rows, s, lines))}
    </div>
    <div class="dash-right">
      ${raw(callbackCard(callbacks.pending))}
      ${raw(splitCard(s))}
    </div>
    <div class="dash-wide">
      ${raw(sectionHead('Lignes et collaborateurs', periodLabel() + ' · cliquez un CSI pour voir qui travaille sur la ligne'))}
      ${raw(linesCard(lines, s))}
    </div>
  </div>`);

  wire(root);
  // Les info-bulles sont delegues depuis la racine : un seul appel couvre tous
  // les graphiques inseres ci-dessus.
  attachChartTips(root);
}

// -----------------------------------------------------------------------------
//  Etats de bord
// -----------------------------------------------------------------------------

/** @returns {string} ossature de chargement, calee sur la trame finale. */
function loadingView() {
  return html`<p class="sr-only" role="status">Chargement des appels…</p>
  <div class="dash">
    <div class="dash-left">${raw(skeleton('card'))}${raw(skeleton('card'))}</div>
    <div class="dash-right">${raw(skeleton('card'))}${raw(skeleton('card'))}</div>
    <div class="dash-wide">${raw(skeleton('card'))}</div>
  </div>`;
}

/**
 * Bandeau d'erreur de collecte. Le message vient du store (donc de l'API) :
 * il est compose avec le gabarit `html` avant d'entrer dans `notice.body`.
 * @param {{warning?: string}} st
 * @returns {string}
 */
function errorNotice(st) {
  const message = st && st.warning
    ? String(st.warning)
    : 'La dernière collecte des appels a échoué. Les chiffres affichés peuvent être plus anciens.';
  return notice({
    tone: 'error',
    title: 'Collecte en erreur.',
    body: html`${message} <button class="link" type="button" data-goto="diagnostics">Ouvrir le Diagnostic</button>`,
  });
}

/** @returns {string} etat vide, avec la manoeuvre a tenter. */
function emptyView() {
  return card({
    title: 'Aucun appel sur la période',
    sub: periodLabel(),
    action: raw(html`<button class="btn btn--sm" type="button" data-goto="diagnostics">Ouvrir le Diagnostic</button>`),
    body: raw(empty(
      'Rien à afficher pour ces filtres',
      'Élargissez la période avec « Tout » dans la barre de période, retirez le filtre de ligne, ou vérifiez le jeton et les lignes détectées sur la page Diagnostic.',
    )),
  });
}

// -----------------------------------------------------------------------------
//  Bloc 1 — bandeau de compteurs
// -----------------------------------------------------------------------------

/**
 * @param {any} s  Sortie de `stats()`.
 * @returns {string}
 */
function countersCard(s) {
  return card({
    body: raw(statbar([
      { label: 'Appels sur la période', value: fmtInt(s.total), icon: 'phone' },
      { label: 'Entrants', value: fmtInt(s.in), icon: 'in', tone: 'in' },
      { label: 'Sortants', value: fmtInt(s.out), icon: 'out', tone: 'out' },
    ])),
  });
}

// -----------------------------------------------------------------------------
//  Bloc 2 — taux de reponse
// -----------------------------------------------------------------------------

/**
 * Grande carte du taux de reponse : le chiffre et sa comparaison a gauche,
 * l'histogramme sous le chiffre, le classement des collaborateurs a droite.
 * @param {any[][]} rows   Lignes filtrees.
 * @param {any} s          Sortie de `stats(rows)`.
 * @param {any[]} lines    Sortie de `byLine(rows)`.
 * @returns {string}
 */
function rateCard(rows, s, lines) {
  const title = state.from && state.to
    ? 'Taux de réponse sur la période : ' + fmtDate(state.from) + ' au ' + fmtDate(state.to)
    : 'Taux de réponse sur la période';

  return card({
    cls: 'rate-card',
    title,
    sub: 'Un appel manqué est un entrant de durée nulle : le taux vaut (entrants − manqués) / entrants. Une période sans appel entrant n’est pas tracée.',
    action: raw(granularitySelect(state.granularity)),
    body: raw(html`<div class="rate-body">
      <div class="rate-figure">
        <div>
          <div class="metric-xl">${fmtPct(s.answerRate, 1)}</div>
          ${raw(deltaHtml(s, previousStats()))}
        </div>
        ${raw(rateChart(rows))}
      </div>
      <div class="rate-rank">
        <div class="rate-rank-cols">
          <div>
            <p class="rate-rank-title">Top collaborateurs</p>
            <p class="rate-rank-hint muted">Ce mois-ci, d’après les actions faites dans l’application.</p>
            ${raw(peopleRank())}
          </div>
          <div>
            <p class="rate-rank-title">Top lignes</p>
            <p class="rate-rank-hint muted">Sur la période, appels décrochés par ligne.</p>
            ${raw(lineRank(lines))}
          </div>
        </div>
      </div>
    </div>`),
  });
}

/**
 * Graphique du taux : des barres tant qu'elles restent lisibles (mois,
 * semaines, ou une quinzaine de jours), une courbe au-dela. Les periodes sans
 * entrant sont des trous dans la courbe, pas des zeros qui feraient plonger
 * le trace chaque week-end.
 * @param {any[][]} rows
 * @returns {string}
 */
function rateChart(rows) {
  const series = rateSeries(rows);
  const format = (v) => fmtPct(v, 0);

  if (series.length <= RATE_BARS_MAX) {
    return barChart({
      data: series.map((p) => ({ label: p.label, value: p.value == null ? 0 : p.value, hint: p.hint })),
      maxTicks: 5,
      showTrack: true,
      format,
    });
  }
  // En courbe, les periodes sans entrant sont simplement OMISES : un trou par
  // week-end hachait le trace en morceaux et en points isoles, illisible. La
  // courbe relie donc les seuls jours qui ont recu des appels, et l'axe ne
  // porte que ces jours-la.
  const points = series.filter((p) => p.value != null);
  if (!points.length) {
    return areaChart({ series: [], height: 240, format });
  }
  return areaChart({
    series: [{ name: 'Taux de réponse', color: 'var(--in)', points }],
    height: 240,
    maxTicks: 5,
    showDots: points.length <= 20,
    format,
  });
}

/**
 * Selecteur de granularite. Il pilote `state.granularity`, donc l'histogramme
 * de cette carte comme toute vue qui lit la meme cle.
 * @param {string} current
 * @returns {string}
 */
function granularitySelect(current) {
  const auto = effectiveGranularity('auto');
  const names = { day: 'jour', week: 'semaine', month: 'mois' };
  const options = [
    { value: 'auto', label: 'Automatique (par ' + names[auto] + ')' },
    { value: 'month', label: 'Par mois' },
    { value: 'week', label: 'Par semaine' },
    { value: 'day', label: 'Par jour' },
  ];
  let out = '';
  for (let i = 0; i < options.length; i++) {
    const selected = options[i].value === current ? ' selected' : '';
    out += html`<option value="${options[i].value}"${raw(selected)}>${options[i].label}</option>`;
  }
  return html`<span class="select-pill">
    <label class="sr-only" for="gran-select">Granularité de l'histogramme</label>
    <select id="gran-select">${raw(out)}</select>
  </span>`;
}

/**
 * Comparaison a la periode precedente de meme longueur.
 *
 * L'ecart est exprime en POINTS de taux (et non en pourcentage d'un
 * pourcentage), arrondi a l'unite : la source ne justifie pas plus de
 * precision sur une comparaison de fenetres.
 *
 * @param {any} current   Sortie de `stats()` sur la periode courante.
 * @param {any|null} previous  Sortie de `stats()` sur la fenetre precedente.
 * @returns {string}
 */
function deltaHtml(current, previous) {
  // Sans entrant sur la fenetre precedente, il n'y a pas de taux a comparer :
  // afficher « 0 point » laisserait croire a une stabilite mesuree.
  if (!previous || !previous.in) {
    return html`<div class="metric-delta">
      <span class="flat">Pas de comparaison possible</span> — aucun appel entrant sur la période précédente.
    </div>`;
  }

  const diff = current.answerRate - previous.answerRate;
  const points = Math.round(Math.abs(diff));
  let cls = 'flat';
  let text = 'Stable';
  if (Math.abs(diff) >= DELTA_EPSILON) {
    cls = diff > 0 ? 'up' : 'down';
    text = (diff > 0 ? 'En hausse de ' : 'En baisse de ')
      + fmtInt(points) + ' ' + pluralize(points, 'point', 'points');
  }

  return html`<div class="metric-delta">
    <span class="${cls}">${text}</span> — période précédente ${fmtPct(previous.answerRate, 1)}.
  </div>`;
}

/**
 * Serie de l'histogramme : un taux de reponse par periode, de 0 a 100.
 *
 * `byDay` et `byMonth` portent `in` et `missed` (contrairement a `trend`, qui
 * ne rend qu'un volume) : le taux se calcule donc ici, periode par periode.
 * @param {any[][]} rows
 * @returns {Array<{label: string, value: number, hint: string}>}
 */
function rateSeries(rows) {
  const range = { from: state.from, to: state.to };
  const unit = effectiveGranularity();

  if (unit === 'month') {
    return byMonth(rows, range).map((p) => ratePoint(fmtMonth(p.label), p.in, p.missed));
  }

  const days = byDay(rows, range);

  if (unit === 'week') {
    // La semaine n'est pas fournie avec `in` et `missed` : on agrege les points
    // journaliers sur leur lundi. `byDay` rend une serie continue et
    // chronologique, donc l'ordre des cles suit l'ordre des semaines.
    const order = [];
    const buckets = new Map();
    for (let i = 0; i < days.length; i++) {
      const key = mondayOf(days[i].label);
      if (!key) continue;
      let b = buckets.get(key);
      if (!b) { b = { in: 0, missed: 0 }; buckets.set(key, b); order.push(key); }
      b.in += days[i].in;
      b.missed += days[i].missed;
    }
    return order.map((key) => {
      const b = buckets.get(key);
      // Une semaine se lit par son lundi : « sem. du 07/09 ».
      return ratePoint('sem. ' + fmtDayShort(key), b.in, b.missed);
    });
  }

  return days.map((p) => ratePoint(fmtDayShort(p.label), p.in, p.missed));
}

/**
 * Point du graphique. Une periode sans entrant vaut `null` : un trou dans la
 * courbe, et l'info-bulle le dit — pas un zero qui se lirait comme un echec.
 * @param {string} label
 * @param {number} incoming
 * @param {number} missed
 * @returns {{label: string, value: number|null, hint: string}}
 */
function ratePoint(label, incoming, missed) {
  const inc = Number(incoming) || 0;
  const lost = Number(missed) || 0;
  return {
    label: label,
    value: inc ? ((inc - lost) / inc) * 100 : null,
    hint: inc
      ? fmtInt(inc) + ' ' + pluralize(inc, 'entrant', 'entrants')
        + ', ' + fmtInt(lost) + ' ' + pluralize(lost, 'manqué', 'manqués')
      : 'aucun appel entrant',
  };
}

/**
 * Top collaborateurs : DES PERSONNES, nommees par leur adresse e-mail, d'apres
 * le journal d'attribution du mois. Les releves Keyyo ne disent jamais qui a
 * decroche une ligne partagee : seul le journal le sait. Le clic ouvre la
 * fiche de la personne dans la vue Attribution.
 * @returns {string}
 */
function peopleRank() {
  const j = journal();
  if (j.loading && !j.summary) return skeleton('text') + skeleton('text') + skeleton('text');
  if (j.error) {
    return notice({ tone: 'warn', title: 'Journal indisponible.', body: html`${j.error}` });
  }
  const agents = j.summary && Array.isArray(j.summary.agents) ? j.summary.agents.slice() : [];
  const active = agents.filter((a) => (a.taken + a.dialed) > 0);
  if (!active.length) {
    return html`<p class="rate-rank-hint muted">Aucun appel pris ni émis depuis l’application ce mois-ci. Les personnes apparaissent ici dès qu’elles décrochent, appellent ou passent un appel depuis la barre d’appel.</p>`;
  }
  active.sort((a, b) => (b.taken - a.taken) || (b.dialed - a.dialed) || a.email.localeCompare(b.email));
  const top = active.slice(0, RANK_MAX);

  let out = '';
  for (let i = 0; i < top.length; i++) {
    const a = top[i];
    const rate = (a.taken + a.missed) > 0 && a.lines && a.lines.length ? (a.taken / (a.taken + a.missed)) * 100 : null;
    out += html`<div data-person-open="${a.email}" title="Ouvrir la fiche de ${nameOfEmail(a.email)} dans la vue Attribution">${raw(rankRow({
      rank: i + 1,
      label: firstNameOfEmail(a.email),
      sub: fmtInt(a.taken) + ' ' + pluralize(a.taken, 'pris', 'pris') + ' · ' + fmtInt(a.dialed) + ' ' + pluralize(a.dialed, 'émis', 'émis'),
      metric: rate == null ? fmtInt(a.taken + a.dialed) : fmtPct(rate, 0),
      photo: photoUrl(a.email, 48),
    }))}</div>`;
  }
  return html`<div class="rank-list">${raw(out)}</div>`;
}

/**
 * Top lignes : les lignes du parc classees par appels decroches sur la
 * periode. Le clic filtre toute l'application sur la ligne.
 * @param {any[]} lines  Sortie de `byLine()`.
 * @returns {string}
 */
function lineRank(lines) {
  const ranked = [];
  for (let i = 0; i < lines.length; i++) {
    // `incoming` est conserve pour distinguer « 0 % de reponse » d'un « aucun
    // entrant a decrocher » : une ligne exclusivement sortante afficherait
    // sinon un taux de 0 % qui se lit comme un reproche.
    ranked.push({
      csi: lines[i].csi,
      name: lines[i].label,
      handled: lines[i].answered,
      rate: lines[i].answerRate,
      incoming: lines[i].in,
    });
  }
  if (!ranked.length) {
    return html`<p class="rate-rank-hint muted">Aucune ligne n’a d’appel sur la période.</p>`;
  }
  ranked.sort((a, b) => b.handled - a.handled);
  const top = ranked.slice(0, RANK_MAX);

  let out = '';
  for (let i = 0; i < top.length; i++) {
    // Le csi voyage sur une enveloppe : `rankRow` ne pose pas d'attribut, et
    // c'est la delegation sur `[data-csi]` qui rend la ligne actionnable.
    out += html`<div data-csi="${top[i].csi}" title="Filtrer l’application sur cette ligne">${raw(rankRow({
      rank: i + 1,
      label: top[i].name,
      sub: fmtInt(top[i].handled) + ' ' + pluralize(top[i].handled, 'appel décroché', 'appels décrochés'),
      metric: top[i].incoming ? fmtPct(top[i].rate, 0) : '—',
    }))}</div>`;
  }
  return html`<div class="rank-list">${raw(out)}</div>`;
}

// -----------------------------------------------------------------------------
//  Bloc 3 — carte sombre : a rappeler
// -----------------------------------------------------------------------------

/**
 * @param {any[]} pending  `callbackAnalysis(rows).pending`.
 * @returns {string}
 */
function callbackCard(pending) {
  const list = Array.isArray(pending) ? pending : [];
  const sub = list.length
    ? fmtInt(list.length) + ' ' + pluralize(list.length, 'numéro en attente', 'numéros en attente')
    : 'Tous les appels manqués ont reçu un rappel';

  if (!list.length) {
    // `ui.empty` ecrit son titre en `--ink`, illisible sur la carte sombre :
    // l'etat vide reprend donc les classes du fil, prevues pour ce fond.
    return card({
      dark: true,
      title: 'À rappeler',
      sub: sub,
      body: raw(html`<div class="feed">
        <div class="feed-item">
          <span class="feed-dot feed-dot--ok" aria-hidden="true"></span>
          <div>
            <div class="feed-title">Aucun rappel en attente</div>
            <div class="feed-meta">Chaque appel manqué de la période a été suivi d’un appel sortant vers le même correspondant.</div>
          </div>
        </div>
      </div>`),
    });
  }

  const shown = list.slice(0, FEED_MAX);
  let items = '';
  for (let i = 0; i < shown.length; i++) {
    const entry = shown[i];
    const meta = fmtTime(entry.lastHour, entry.lastMinute)
      + ' · ' + labelOf(entry.csi)
      + ' · ' + fmtInt(entry.count) + ' ' + pluralize(entry.count, 'appel manqué', 'appels manqués');

    // Des <div> dans un <button> : `feed-title` et `feed-meta` supposent des
    // elements de type bloc (troncature par ellipse), et le fil doit rester
    // atteignable au clavier avec un seul element focalisable par ligne.
    items += html`<button class="feed-item" type="button" data-peer="${entry.number}">
      <span class="feed-dot feed-dot--missed" aria-hidden="true"></span>
      <div>
        <div class="feed-title">${entry.label}</div>
        <div class="feed-meta">${meta}</div>
      </div>
    </button>`;
  }

  const labels = [];
  for (let i = 0; i < list.length; i++) labels.push(list[i].label);

  return card({
    dark: true,
    title: 'À rappeler',
    sub: sub,
    body: raw(html`<div class="feed">${raw(items)}</div>
    <div class="feed-foot">
      ${raw(avatarStack(labels, 4))}
      <span class="toolbar-spacer"></span>
      <button class="btn btn--sm" type="button" data-goto="missed">Voir les appels manqués</button>
    </div>`),
  });
}

// -----------------------------------------------------------------------------
//  Bloc 4 — repartition des appels
// -----------------------------------------------------------------------------

/**
 * @param {any} s  Sortie de `stats()`.
 * @returns {string}
 */
function splitCard(s) {
  const parts = [
    { label: 'Entrants', value: s.in, tone: undefined },
    { label: 'Sortants', value: s.out, tone: 'out' },
    { label: 'Manqués', value: s.missed, tone: 'missed' },
  ];

  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += split({
      label: parts[i].label,
      value: fmtInt(parts[i].value) + ' ' + pluralize(parts[i].value, 'appel', 'appels'),
      pct: pctOf(parts[i].value, s.total),
      tone: parts[i].tone,
    });
  }

  return card({
    title: 'Répartition des appels',
    sub: 'Part de chaque catégorie dans le total. Les manqués sont un sous-ensemble des entrants : les trois parts ne totalisent donc pas 100 %.',
    body: raw(html`<div class="splits">${raw(out)}</div>`),
  });
}

// -----------------------------------------------------------------------------
//  Bloc 5 — lignes et collaborateurs
// -----------------------------------------------------------------------------

/**
 * Tableau du parc. La premiere cellule porte un bouton qui filtre toute
 * l'application sur la ligne : un `<tr>` cliquable serait hors d'atteinte au
 * clavier.
 * @param {any[]} lines  Sortie de `byLine()`.
 * @param {any} s        Sortie de `stats()`, pour le pied de tableau.
 * @returns {string}
 */
function linesCard(lines, s) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i];
    const line = lineByCsi(e.csi);
    const person = e.person;
    const shared = !person && !!(line && line.shared);
    const team = line && Array.isArray(line.team) ? line.team.length : 0;
    const name = (person && (person.firstName || person.displayName)) || e.label;
    const mail = person && person.email
      ? person.email
      : (shared ? 'ligne partagée' + (team ? ' par ' + fmtInt(team) + ' ' + pluralize(team, 'personne', 'personnes') : '') : 'identité non résolue');
    const lineName = (line && (line.name || line.formattedCsi)) || e.csi;
    const key = digitsOf(e.csi);
    const open = _openLines.has(key);

    rows.push([
      // Le CSI deplie la ligne : qui y travaille, et ce que chacun y a fait.
      html`<button class="link line-toggle" type="button" data-line-toggle="${e.csi}" aria-expanded="${open ? 'true' : 'false'}" title="${open ? 'Replier' : 'Voir les collaborateurs de cette ligne'}"><span class="line-toggle-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>${e.csi}</button>`,
      html`<div class="cell-id">
        ${raw(avatar(name, { photo: person && person.email ? photoUrl(person.email, 48) : '' }))}
        <div class="cell-id-body">
          <div class="cell-id-name">${name}</div>
          <div class="cell-id-sub">${mail}</div>
        </div>
      </div>`,
      html`${lineName}`,
      html`${fmtInt(e.in)}`,
      html`${fmtInt(e.out)}`,
      html`${fmtInt(e.missed)}`,
      html`<div class="row">
        ${raw(meter(e.answerRate, rateTone(e.answerRate, e.in)))}
        <span class="nowrap">${e.in ? fmtPct(e.answerRate, 0) : '—'}</span>
      </div>`,
      html`${fmtHms(e.seconds)}`,
    ]);
    if (open) rows.push({ span: raw(lineDetail(e, line)), cls: 'line-detail-row' });
  }

  const reset = state.csi
    ? html`<button class="btn btn--sm btn--ghost" type="button" data-csi="">Toutes les lignes</button>`
    : '';

  return card({
    flush: true,
    // Sans defilement : le nom de ligne double souvent le libelle du
    // collaborateur (lignes partagees), la duree et le detail des sens sont
    // secondaires. Le CSI reste : c'est le bouton qui deplie la ligne.
    body: raw(table({
      columns: [
        { label: 'CSI', cls: 'shrink', nowrap: true },
        { label: 'Collaborateur', breakAnywhere: true },
        { label: 'Ligne', priority: 'lg' },
        { label: 'Entrants', align: 'right', priority: 'md' },
        { label: 'Sortants', align: 'right', priority: 'md' },
        { label: 'Manqués', align: 'right' },
        { label: 'Taux de réponse', nowrap: true },
        { label: 'Durée cumulée', align: 'right', priority: 'lg' },
      ],
      rows: rows,
      foot: raw(html`<span>${fmtInt(lines.length)} ${pluralize(lines.length, 'ligne', 'lignes')} · ${fmtInt(s.total)} ${pluralize(s.total, 'appel', 'appels')}</span>${raw(reset)}`),
    })),
  });
}

/** @param {unknown} v @returns {string} chiffres seuls, forme de comparaison des CSI. */
function digitsOf(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

/**
 * Detail d'une ligne : LES PERSONNES qui y travaillent (equipe de la ligne,
 * plus toute personne dont le journal porte un fait sur cette ligne), avec ce
 * que chacune y a fait ce mois-ci d'apres le journal d'attribution — pris,
 * manques, emis, taux de reponse. Une ligne partagee ne dit pas qui a
 * decroche : seules les actions faites dans l'application comptent, et la
 * carte le dit plutot que de laisser lire des zeros comme des absences.
 * @param {any} e     Agregat `byLine` de la ligne.
 * @param {any} line  Ligne du parc, ou null.
 * @returns {string}
 */
function lineDetail(e, line) {
  const j = journal();
  const key = digitsOf(e.csi);
  const owners = j.lineOwners || {};
  const ownerOf = owners[key] ? String(owners[key]).toLowerCase() : '';

  // Faits du mois sur cette ligne, resumes par personne.
  const events = (j.events || []).filter((ev) => digitsOf(ev.csi) === key);
  const perPerson = new Map();
  if (events.length) {
    const sum = summarize(events, { lineOwners: owners });
    for (const a of sum.agents) perPerson.set(String(a.email).toLowerCase(), a);
  }

  // Equipe de la ligne (annuaire Keyyo / configuration), puis les personnes
  // vues dans le journal mais absentes de l'equipe.
  /** @type {Map<string, {email: string, name: string}>} */
  const people = new Map();
  for (const m of (line && Array.isArray(line.team) ? line.team : [])) {
    const email = m && m.email ? String(m.email).toLowerCase() : '';
    if (!email || people.has(email)) continue;
    people.set(email, { email, name: m.name ? String(m.name) : nameOfEmail(email) });
  }
  for (const email of perPerson.keys()) {
    if (!people.has(email)) people.set(email, { email, name: nameOfEmail(email) });
  }

  const shared = !(e.person && e.person.email) && !!(line && line.shared);
  const scope = j.month ? fmtMonth(j.month) : 'ce mois-ci';

  if (!people.size) {
    return html`<div class="line-detail">
      ${raw(empty('Aucun collaborateur rattaché', 'Aucune adresse n’est associée à cette ligne dans l’annuaire Keyyo ni dans l’Administration, et personne n’y a agi depuis l’application ce mois-ci.'))}
    </div>`;
  }

  const list = Array.from(people.values());
  list.sort((a, b) => {
    const sa = perPerson.get(a.email); const sb = perPerson.get(b.email);
    return ((sb ? sb.taken + sb.dialed : 0) - (sa ? sa.taken + sa.dialed : 0)) || a.name.localeCompare(b.name, 'fr');
  });

  let rowsHtml = '';
  for (const p of list) {
    const a = perPerson.get(p.email) || null;
    const isOwner = ownerOf === p.email;
    const taken = a ? a.taken : 0;
    const missed = a ? a.missed : 0;
    const dialed = a ? a.dialed : 0;
    const rate = isOwner && (taken + missed) > 0 ? (taken / (taken + missed)) * 100 : null;
    const ring = a && a.ringCount ? Math.round(a.ringTotal / a.ringCount) : 0;
    rowsHtml += html`<div class="line-agent">
      <button class="cell-id" type="button" data-person-open="${p.email}" title="Ouvrir la fiche de ${p.name} dans la vue Attribution">
        ${raw(avatar(p.name, { size: 'sm', photo: photoUrl(p.email, 48) }))}
        <div class="cell-id-body">
          <div class="cell-id-name">${p.name}</div>
          <div class="cell-id-sub">${p.email}${isOwner ? ' · titulaire de la ligne' : ''}</div>
        </div>
      </button>
      <div class="line-agent-stats">
        <div class="line-agent-stat"><span class="line-agent-value">${fmtInt(taken)}</span><span class="line-agent-label">pris</span></div>
        <div class="line-agent-stat"><span class="line-agent-value">${isOwner ? fmtInt(missed) : '—'}</span><span class="line-agent-label">manqués</span></div>
        <div class="line-agent-stat"><span class="line-agent-value">${fmtInt(dialed)}</span><span class="line-agent-label">émis</span></div>
        <div class="line-agent-stat"><span class="line-agent-value">${rate == null ? '—' : fmtPct(rate, 0)}</span><span class="line-agent-label">réponse</span></div>
        <div class="line-agent-stat"><span class="line-agent-value">${ring ? fmtDurationShort(ring) : '—'}</span><span class="line-agent-label">sonnerie</span></div>
      </div>
    </div>`;
  }

  const note = shared
    ? 'Ligne partagée : Keyyo ne dit pas qui décroche. Les chiffres viennent des actions faites dans l’application (' + scope + ') ; les manqués et le taux ne se calculent que pour une titulaire unique.'
    : 'D’après le journal d’attribution (' + scope + ').';

  return html`<div class="line-detail">
    <div class="line-detail-head">
      <span class="strong">${fmtInt(list.length)} ${pluralize(list.length, 'collaborateur rattaché', 'collaborateurs rattachés')}</span>
      ${raw(tag(shared ? 'ligne partagée' : 'ligne personnelle', shared ? 'in' : 'ok'))}
      <span class="toolbar-spacer"></span>
      <button class="btn btn--sm btn--ghost" type="button" data-csi="${e.csi}">Filtrer sur cette ligne</button>
      <button class="btn btn--sm btn--ghost" type="button" data-goto="agents">Vue Attribution</button>
    </div>
    <div class="line-agents">${raw(rowsHtml)}</div>
    <p class="faint line-detail-note">${note}</p>
  </div>`;
}

/**
 * Ton de la barre de taux. Sans entrant, aucun ton : la barre reste neutre
 * plutot que de peindre un echec qui n'a pas ete mesure.
 * @param {number} rate
 * @param {number} incoming
 * @returns {'out'|'missed'|'ok'|undefined}
 */
function rateTone(rate, incoming) {
  if (!incoming) return undefined;
  if (rate >= RATE_GOOD) return 'ok';
  if (rate < RATE_BAD) return 'missed';
  return undefined;
}

// -----------------------------------------------------------------------------
//  Interactions
// -----------------------------------------------------------------------------

/**
 * Cable la vue, UNE SEULE FOIS par racine. Tout passe par delegation : le
 * contenu peut etre reconstruit a chaque rendu sans rien recabler.
 * @param {HTMLElement} root
 */
function wire(root) {
  if (_wiredRoots.has(root)) return;
  _wiredRoots.add(root);

  // Filtre de ligne : classement, detail d'une ligne, et bouton de remise a
  // zero (`data-csi` vide) partagent le meme point d'entree.
  on(root, 'click', '[data-csi]', (ev, el) => {
    const csi = el.getAttribute('data-csi');
    if (csi === null) return;
    setFilter({ csi: csi });
  });

  // Depliage d'une ligne : qui y travaille. Rendu local, sans passer par le
  // store — l'etat deplie survit aux collectes de fond.
  on(root, 'click', '[data-line-toggle]', (ev, el) => {
    const key = digitsOf(el.getAttribute('data-line-toggle'));
    if (!key) return;
    if (_openLines.has(key)) _openLines.delete(key); else _openLines.add(key);
    render(root);
  });

  // Fiche d'une personne : la vue Attribution l'ouvre.
  on(root, 'click', '[data-person-open]', (ev, el) => {
    const email = el.getAttribute('data-person-open') || '';
    if (!email) return;
    showPerson(email);
    setFilter({ page: 'agents' });
    if (location.hash !== '#/agents') location.hash = '#/agents';
  });

  // Pas de gestionnaire `[data-goto]` ici : app/main.js en pose un sur le
  // document, qui passe par `router.go`. En doubler un a ce niveau ecrivait un
  // fragment sans barre oblique (`#diagnostics` au lieu de `#/diagnostics`),
  // ce que le routeur normalisait ensuite — d'ou une seconde entree
  // d'historique et un rendu de plus a chaque clic.

  // Fiche correspondant : la page signale l'intention, main.js ouvre la modale.
  on(root, 'click', '[data-peer]', (ev, el) => {
    const number = el.getAttribute('data-peer');
    if (!number) return;
    document.dispatchEvent(new CustomEvent('keyyo:drill', { detail: { number: number } }));
  });

  // Indicateur depliable : `ui.kpi` pose `aria-expanded`, c'est la page qui
  // bascule les deux etats au clic.
  on(root, 'click', '.kpi', (ev, el) => {
    if (!el.hasAttribute('aria-expanded')) return;
    const open = el.getAttribute('aria-expanded') === 'true';
    el.setAttribute('aria-expanded', open ? 'false' : 'true');
    el.classList.toggle('is-open', !open);
  });

  on(root, 'change', '#gran-select', (ev, el) => {
    setFilter({ granularity: el.value });
  });
}

// -----------------------------------------------------------------------------
//  Calculs propres a la vue
// -----------------------------------------------------------------------------

/**
 * Indicateurs de la fenetre PRECEDENTE, de meme longueur que la periode
 * courante et immediatement anterieure, avec les MEMES filtres de ligne et de
 * sens. Le store ne memoise que la fenetre courante : ce filtrage est refait
 * ici sur `getRows()`.
 * @returns {any|null} sortie de `stats()`, ou `null` si la fenetre est indefinie.
 */
function previousStats() {
  const from = state.from;
  const to = state.to;
  if (!from || !to) return null;

  const days = daysBetween(from, to) + 1;
  const prevTo = shiftDays(from, -1);
  const prevFrom = shiftDays(from, -days);
  if (!prevFrom || !prevTo) return null;

  // Le filtre de ligne peut arriver sous une autre forme que le CSI porte par
  // les lignes d'appel : on le ramene une fois a la forme du parc, hors boucle.
  let csi = state.csi ? String(state.csi) : '';
  if (csi) {
    const line = lineByCsi(csi);
    if (line && line.csi) csi = String(line.csi);
  }

  const all = getRows();
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const row = all[i];
    const date = row[F.date];
    if (date < prevFrom || date > prevTo) continue;
    if (csi && String(row[F.csi]) !== csi) continue;
    if (state.dir === 'in' && !isIncoming(row)) continue;
    if (state.dir === 'out' && !isOutgoing(row)) continue;
    if (state.dir === 'missed' && !isMissed(row)) continue;
    out.push(row);
  }
  return stats(out);
}

/** @returns {string} libelle de la periode courante, ou chaine vide. */
function periodLabel() {
  if (!state.from || !state.to) return 'Toute la période';
  return 'Du ' + fmtDate(state.from) + ' au ' + fmtDate(state.to);
}

/**
 * Part d'un sous-ensemble, en pourcentage de 0 a 100 (jamais NaN).
 * @param {number} part
 * @param {number} total
 * @returns {number}
 */
function pctOf(part, total) {
  const t = Number(total) || 0;
  if (!t) return 0;
  return (Number(part) || 0) / t * 100;
}

/**
 * Decale une date calendaire `YYYY-MM-DD`. L'ancrage a midi UTC immunise le
 * calcul contre les changements d'heure : un decalage de 24 h y reste un jour.
 * @param {string} iso
 * @param {number} days  negatif vers le passe.
 * @returns {string} chaine vide si la date est illisible.
 */
function shiftDays(iso, days) {
  const anchor = Date.parse(String(iso) + 'T12:00:00Z');
  if (!Number.isFinite(anchor)) return '';
  return new Date(anchor + days * 864e5).toISOString().slice(0, 10);
}

/**
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {number} nombre de jours entre deux dates calendaires (>= 0).
 */
function daysBetween(fromIso, toIso) {
  const a = Date.parse(String(fromIso) + 'T12:00:00Z');
  const b = Date.parse(String(toIso) + 'T12:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 864e5));
}

/**
 * Lundi de la semaine d'une date calendaire, meme convention que le store
 * (index 0 = lundi).
 * @param {string} iso
 * @returns {string} chaine vide si la date est illisible.
 */
function mondayOf(iso) {
  const anchor = Date.parse(String(iso) + 'T12:00:00Z');
  if (!Number.isFinite(anchor)) return '';
  const weekday = (new Date(anchor).getUTCDay() + 6) % 7;
  return shiftDays(iso, -weekday);
}
