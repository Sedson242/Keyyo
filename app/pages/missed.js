// =============================================================================
//  app/pages/missed.js — Les appels manques.
//
//  C'est la vue a plus forte valeur metier : un appel manque non rappele est un
//  client perdu. Tout y est donc organise autour d'UNE action — rappeler — et
//  chaque chiffre affiche explique comment il a ete obtenu, parce que la source
//  est un proxy et non une mesure.
//
//  VERITE METIER, a redire ici car toute la page en decoule : l'API Keyyo
//  Manager 1.0 ne fournit AUCUN indicateur de decroche. Un CallDetailRecord
//  porte `quantity` avec son `unit` ; quand `unit` vaut `second`, `quantity` EST
//  la duree. Le decroche s'en deduit, donc UN APPEL MANQUE EST UN ENTRANT DE
//  DUREE NULLE. Un appel decroche puis raccroche dans la meme seconde serait
//  compte comme manque : la page le dit dans le champ `why` du premier
//  indicateur plutot que de laisser croire a une precision qui n'existe pas.
//
//  Rendu : cette page n'appelle ni `fetch` ni app/api.js. Elle lit le store,
//  ecrit son contenu en un seul `mount`, et cable ses interactions par
//  delegation depuis `root`. `render` est rappelee a chaque changement d'etat,
//  elle est donc idempotente.
// =============================================================================

import { html, raw, mount, on, qsa, h, icon } from '../dom.js';
import {
  WEEKDAYS, fmtInt, fmtPct, fmtDate, fmtDayShort, fmtTime, fmtHms, pluralize,
} from '../format.js';
import {
  card, sectionHead, kpi, split, empty, notice, skeleton, avatar,
} from '../ui.js';
import { barChart, areaChart, attachChartTips } from '../charts.js';
import {
  state, status, filtered, stats, callbackAnalysis,
  byHour, byWeekday, byDay, byLine, lineByCsi, labelOf, nameOf,
} from '../store.js';
import { isMissed } from '../../shared/schema.js';

// -----------------------------------------------------------------------------
//  Constantes de la vue
// -----------------------------------------------------------------------------

/**
 * Nombre de lignes rendues par colonne. Sur trois mois, la liste des numeros a
 * rappeler peut compter plusieurs centaines d'entrees : au-dela de ce seuil on
 * annonce le reste en clair et on renvoie vers l'export CSV, qui lui est
 * complet. Une liste de 800 lignes dans un conteneur de 460 px de haut n'aide
 * personne et alourdit chaque rendu.
 */
const MAX_ROWS = 50;

/** Nombre de lignes Keyyo detaillees dans la repartition par ligne. */
const MAX_LINE_ROWS = 8;

/**
 * Numero effectivement composable. `peer` est deja normalise en E.164 par
 * shared/cdr.js, mais ce numero finit dans un `href` : on n'y laisse passer
 * qu'une forme de numero, jamais autre chose.
 */
const DIALABLE = /^\+?[0-9]{2,20}$/;

/**
 * Racines deja cablees. Remplacer `innerHTML` ne retire PAS les ecouteurs poses
 * sur `root` lui-meme : sans cette garde, chaque rendu empilerait un jeu
 * supplementaire de gestionnaires. Un WeakSet laisse le GC faire son travail si
 * la section disparait.
 * @type {WeakSet<object>}
 */
const wiredRoots = new WeakSet();

/**
 * Indices des indicateurs dont l'explication est depliee. Le sondage de
 * main.js redessine la page toutes les 60 s : sans cette memoire, une
 * explication ouverte se refermerait toute seule sous les yeux du lecteur.
 * @type {Set<number>}
 */
const openWhy = new Set();

// -----------------------------------------------------------------------------
//  Rendu
// -----------------------------------------------------------------------------

/**
 * @param {HTMLElement} root Section de page (`section.page[data-page="missed"]`).
 * @returns {void}
 */
export function render(root) {
  if (!root) return;

  const st = status();

  // 1. Chargement : le store ne passe en `loading` que sans donnee affichable.
  if (st.kind === 'loading') {
    mount(root, loadingView());
    return;
  }

  const head = noticeFor(st);
  const rows = filtered();

  // 2. Aucune donnee sur la periode. On donne une piste concrete, pas un constat.
  if (!rows.length) {
    mount(root, html`${raw(head)}
      ${raw(sectionHead('Appels manqués', 'Aucun appel sur la période et les filtres choisis'))}
      ${raw(card({
        body: raw(empty(
          'Rien à rappeler sur cette période',
          'Élargissez la période avec « 3 mois » ou « Tout », retirez le filtre de ligne, puis rafraîchissez. Si la liste reste vide, la page Diagnostic indique le jeton utilisé et les lignes détectées.',
        )),
      }))}`);
    wire(root);
    return;
  }

  // 3. Vue complete.
  const missedRows = rows.filter(isMissed);
  const s = stats(rows);
  const cb = callbackAnalysis(rows);
  const pending = cb.pending;
  const done = cb.done;

  mount(root, html`${raw(head)}
    ${raw(kpiGrid(s, pending, done))}
    ${raw(sectionHead(
      'Rappels',
      pendingSummary(pending),
      raw(exportButton(pending.length)),
    ))}
    ${raw(callbackColumns(pending, done))}
    ${raw(sectionHead(
      'Quand et où perd-on des appels ?',
      'Sur les ' + fmtInt(missedRows.length) + ' ' + pluralize(missedRows.length, 'appel manqué', 'appels manqués') + ' de la période',
    ))}
    ${raw(analysisGrid(missedRows))}
    ${raw(sectionHead(
      'Évolution',
      'Taux de réponse de la période : ' + fmtPct(s.answerRate, 1),
    ))}
    ${raw(trendCard(rows))}`);

  restoreWhy(root);
  attachChartTips(root);
  wire(root);
}

// -----------------------------------------------------------------------------
//  Etats de chargement et d'erreur
// -----------------------------------------------------------------------------

/** Ossature d'attente : elle reserve la place des blocs a venir. */
function loadingView() {
  return html`${raw(sectionHead('Appels manqués', 'Collecte des appels en cours…'))}
    <div class="kpi-grid">
      ${raw(skeleton('card'))}${raw(skeleton('card'))}${raw(skeleton('card'))}${raw(skeleton('card'))}
    </div>
    <div class="callback-cols">
      ${raw(skeleton('card'))}${raw(skeleton('card'))}
    </div>`;
}

/**
 * Bandeau de collecte. Le message vient du store (donc de l'API) : il est
 * compose avec le gabarit `html` avant d'etre passe en `body`, que `notice`
 * insere tel quel.
 * @param {{kind: string, warning: string}} st
 * @returns {string}
 */
function noticeFor(st) {
  const message = st && st.warning ? String(st.warning) : '';

  if (st && st.kind === 'error') {
    return notice({
      tone: 'error',
      title: 'Collecte interrompue.',
      body: html`${message || "La collecte des appels n'a pas abouti."} Les chiffres ci-dessous peuvent être plus anciens : rafraîchissez, puis consultez la page Diagnostic.`,
    });
  }
  if (message) {
    return notice({ tone: 'warn', title: 'Collecte partielle.', body: html`${message}` });
  }
  return '';
}

// -----------------------------------------------------------------------------
//  Indicateurs
// -----------------------------------------------------------------------------

/**
 * Les quatre indicateurs de tete. Chacun porte l'explication de son calcul :
 * ces chiffres declenchent des rappels, ils doivent etre discutables.
 * @param {any} s      Sortie de `stats(rows)`.
 * @param {any[]} pending
 * @param {any[]} done
 * @returns {string}
 */
function kpiGrid(s, pending, done) {
  // Un groupe en attente peut porter plusieurs manques : on distingue le nombre
  // de NUMEROS a rappeler (des taches) du nombre d'appels concernes.
  let pendingCalls = 0;
  for (let i = 0; i < pending.length; i++) pendingCalls += Number(pending[i].count) || 0;

  const delays = [];
  for (let i = 0; i < done.length; i++) {
    const d = callbackDelay(done[i]);
    if (d != null) delays.push(d);
  }

  const tracked = pending.length + done.length;
  const rate = tracked ? (done.length / tracked) * 100 : 0;

  const first = kpi({
    label: 'Appels manqués',
    value: fmtInt(s.missed),
    foot: 'sur ' + fmtInt(s.in) + ' ' + pluralize(s.in, 'appel entrant', 'appels entrants'),
    tone: 'missed',
    why: "Un appel manqué est un appel ENTRANT de durée nulle. L'API Keyyo Manager ne fournit aucun indicateur de décroché : elle renvoie une quantité et son unité, et quand l'unité est la seconde cette quantité est la durée. Le décroché s'en déduit, il n'est pas mesuré. Conséquence assumée : un appel décroché puis raccroché dans la même seconde est compté ici comme manqué.",
  });

  const second = kpi({
    label: 'Numéros à rappeler',
    value: fmtInt(pending.length),
    foot: fmtInt(pendingCalls) + ' ' + pluralize(pendingCalls, 'appel concerné', 'appels concernés'),
    tone: 'missed',
    why: "Les appels manqués sont regroupés par correspondant, car on rappelle une personne et non un appel : trois appels manqués du même numéro forment une seule tâche. Un groupe reste en attente tant qu'aucun appel sortant vers ce numéro n'est parti après son dernier manqué. Les appelants masqués sont exclus : ils ne peuvent pas être rappelés.",
  });

  const third = kpi({
    label: 'Déjà rappelés',
    value: fmtInt(done.length),
    foot: delays.length
      ? 'délai médian ' + fmtHms(medianOf(delays))
      : 'aucun délai mesurable',
    tone: 'ok',
    why: "Un correspondant est considéré rappelé dès qu'un appel sortant vers son numéro part strictement après son dernier appel manqué. Le rappel peut venir de n'importe quelle ligne du parc : si un collègue a rappelé, l'affaire est traitée. Le rapprochement se fait sur le numéro normalisé, un entrant vu en +33 et un sortant composé en 06 sont donc bien le même correspondant.",
  });

  const fourth = kpi({
    label: 'Taux de rappel',
    value: fmtPct(rate, 1),
    foot: fmtInt(done.length) + ' rappelés sur ' + fmtInt(tracked) + ' ' + pluralize(tracked, 'numéro', 'numéros'),
    why: "Numéros rappelés divisé par numéros ayant appelé sans être décrochés, sur la période et les filtres courants. 100 % signifie qu'aucun correspondant n'attend un rappel. L'indicateur ne dit rien de la qualité du rappel : seulement qu'un appel sortant est parti vers ce numéro après le dernier manqué.",
  });

  return html`<div class="kpi-grid">${raw(first)}${raw(second)}${raw(third)}${raw(fourth)}</div>`;
}

// -----------------------------------------------------------------------------
//  Colonnes de rappel
// -----------------------------------------------------------------------------

/**
 * @param {any[]} pending
 * @returns {string} Sous-titre de la section Rappels.
 */
function pendingSummary(pending) {
  if (!pending.length) return 'Aucun correspondant n’attend de rappel sur cette période.';
  return fmtInt(pending.length) + ' ' + pluralize(pending.length, 'numéro en attente', 'numéros en attente')
    + ', du plus récent au plus ancien';
}

/**
 * Les deux colonnes « A rappeler » et « Deja rappeles ».
 * @param {any[]} pending
 * @param {any[]} done
 * @returns {string}
 */
function callbackColumns(pending, done) {
  const left = card({
    cls: 'callback-col',
    title: 'À rappeler',
    sub: 'Aucun appel sortant vers ces numéros depuis leur dernier appel manqué.',
    body: raw(rowList(pending, false, empty(
      'Rien en attente',
      'Tous les correspondants non décrochés de la période ont été rappelés.',
    ))),
  });

  const right = card({
    cls: 'callback-col callback-col--done',
    title: 'Déjà rappelés',
    sub: 'Délai mesuré entre le dernier appel manqué et l’appel sortant qui a suivi.',
    body: raw(rowList(done, true, empty(
      'Aucun rappel sur la période',
      'Un rappel est un appel sortant vers un numéro non décroché, parti après son dernier manqué.',
    ))),
  });

  return html`<div class="callback-cols">${raw(left)}${raw(right)}</div>`;
}

/**
 * Liste de lignes de rappel, tronquee a `MAX_ROWS`.
 * @param {any[]} entries
 * @param {boolean} isDone  Colonne « deja rappeles » : on affiche le delai.
 * @param {string} emptyHtml  Etat vide, HTML deja sur.
 * @returns {string}
 */
function rowList(entries, isDone, emptyHtml) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return emptyHtml;

  const shown = list.slice(0, MAX_ROWS);
  const rest = list.length - shown.length;

  const rows = [];
  for (let i = 0; i < shown.length; i++) rows.push(raw(callbackRow(shown[i], isDone)));

  const more = rest > 0
    ? html`<p class="muted">${fmtInt(rest)} ${pluralize(rest, 'autre numéro', 'autres numéros')} non ${pluralize(rest, 'affiché', 'affichés')}${isDone ? '' : ' — l’export CSV contient la liste complète'}.</p>`
    : '';

  return html`<div class="callback-list">${rows}</div>${raw(more)}`;
}

/**
 * Une ligne de rappel.
 *
 * La ligne est un `div` et non un `button` : elle contient deux commandes
 * distinctes — ouvrir la fiche du correspondant, et le composer. Un `button`
 * ne peut pas contenir de lien, et imbriquer deux zones cliquables rendrait le
 * lien `tel:` inatteignable au clavier. Le nom porte donc l'action de detail,
 * l'icone de telephone porte le rappel.
 *
 * @param {any} entry Entree de `callbackAnalysis`.
 * @param {boolean} isDone
 * @returns {string}
 */
function callbackRow(entry, isDone) {
  const line = lineByCsi(entry.csi);
  const lineName = line && line.label ? line.label : labelOf(entry.csi);
  const when = fmtDate(entry.lastDate) + ' à ' + fmtTime(entry.lastHour, entry.lastMinute);

  // Le compteur visible est repris en clair dans la meta : seul, « 3 » ne dit
  // rien a un lecteur d'ecran.
  const count = fmtInt(entry.count) + ' ' + pluralize(entry.count, 'appel manqué', 'appels manqués');

  let meta;
  if (isDone) {
    const delay = callbackDelay(entry);
    meta = (delay == null ? 'Rappelé' : 'Rappelé après ' + fmtHms(delay))
      + ' · ' + count + ' · dernier le ' + when + ' · ligne ' + lineName;
  } else {
    meta = count + ' · dernière tentative le ' + when + ' · ligne ' + lineName;
  }

  return html`<div class="callback-row">
    ${raw(avatar(entry.label, { tone: isDone ? 'out' : 'missed' }))}
    <div class="grow">
      <button class="callback-name link" type="button" data-drill="${entry.number}">${entry.label}</button>
      <div class="callback-meta">${meta}</div>
    </div>
    <div class="row">
      <span class="callback-count" aria-hidden="true">${fmtInt(entry.count)}</span>
      ${raw(telLink(entry))}
    </div>
  </div>`;
}

/**
 * Lien de composition directe, pour un softphone ou un mobile.
 * @param {any} entry
 * @returns {string} chaine vide si le numero n'est pas composable.
 */
function telLink(entry) {
  const number = String(entry && entry.number ? entry.number : '');
  if (!DIALABLE.test(number)) return '';
  return html`<a class="btn btn--icon" href="tel:${number}" title="Rappeler" aria-label="Rappeler ${entry.label}">${raw(icon('phone'))}</a>`;
}

// -----------------------------------------------------------------------------
//  Analyses : quand et ou perd-on des appels ?
// -----------------------------------------------------------------------------

/**
 * @param {any[][]} missedRows Uniquement les appels manques de la periode.
 * @returns {string}
 */
function analysisGrid(missedRows) {
  const total = missedRows.length;

  // Par heure : 24 categories, l'heure locale de debut d'appel.
  const hours = byHour(missedRows);
  const hourData = [];
  for (let i = 0; i < hours.length; i++) {
    hourData.push({ label: String(i) + ' h', value: hours[i] });
  }

  // Par jour de semaine : WEEKDAYS et byWeekday partagent l'index 0 = lundi.
  const weekdays = byWeekday(missedRows);
  const weekdayData = [];
  for (let i = 0; i < weekdays.length; i++) {
    weekdayData.push({
      label: WEEKDAYS[i],
      value: weekdays[i],
      hint: total ? fmtPct((weekdays[i] / total) * 100, 0) + ' du total' : '',
    });
  }

  const hourCard = card({
    title: 'Par heure',
    sub: 'Heure locale du début de l’appel.',
    body: raw(barChart({ data: hourData, height: 200, format: fmtInt })),
  });

  const weekdayCard = card({
    title: 'Par jour de semaine',
    sub: 'Cumul sur toute la période, pas une moyenne.',
    body: raw(barChart({ data: weekdayData, height: 200, format: fmtInt })),
  });

  return html`<div class="grid-3">
    ${raw(hourCard)}${raw(weekdayCard)}${raw(lineCard(missedRows, total))}
  </div>`;
}

/**
 * Repartition des manques par ligne Keyyo.
 * @param {any[][]} missedRows
 * @param {number} total
 * @returns {string}
 */
function lineCard(missedRows, total) {
  const lines = byLine(missedRows).slice();
  lines.sort((a, b) => b.missed - a.missed);

  const kept = [];
  for (let i = 0; i < lines.length && kept.length < MAX_LINE_ROWS; i++) {
    if (lines[i].missed > 0) kept.push(lines[i]);
  }

  let body;
  if (!kept.length) {
    body = raw(empty('Aucun manqué à répartir', 'Aucune ligne du parc n’a d’appel entrant non décroché sur la période.'));
  } else {
    const bars = [];
    for (let i = 0; i < kept.length; i++) {
      bars.push(raw(split({
        label: kept[i].label,
        value: fmtInt(kept[i].missed) + ' ' + pluralize(kept[i].missed, 'manqué', 'manqués'),
        pct: total ? (kept[i].missed / total) * 100 : 0,
        tone: 'missed',
      })));
    }
    body = html`<div class="splits">${bars}</div>`;
  }

  return card({
    title: 'Par ligne Keyyo',
    sub: 'Part du total des appels manqués de la période.',
    body: raw(body),
  });
}

/**
 * Evolution journaliere : entrants et manques superposes. C'est l'ecart entre
 * les deux courbes qui dit si la situation se degrade.
 * @param {any[][]} rows
 * @returns {string}
 */
function trendCard(rows) {
  // byDay porte `in` et `missed` par point : le taux de reponse d'un jour se
  // deduit de ces deux nombres, il n'existe pas de champ « answered » ici.
  const days = byDay(rows, { from: state.from, to: state.to });

  const inPoints = [];
  const missedPoints = [];
  for (let i = 0; i < days.length; i++) {
    const label = fmtDayShort(days[i].label);
    inPoints.push({ label, value: days[i].in });
    missedPoints.push({ label, value: days[i].missed });
  }

  const chart = areaChart({
    series: [
      { name: 'Entrants', color: 'var(--in)', points: inPoints },
      { name: 'Manqués', color: 'var(--missed)', points: missedPoints },
    ],
    height: 260,
    format: fmtInt,
  });

  return card({
    title: 'Entrants et manqués, jour par jour',
    sub: 'Un jour sans appel apparaît à zéro : la courbe ne saute jamais un trou.',
    body: raw(chart),
  });
}

// -----------------------------------------------------------------------------
//  Interactions
// -----------------------------------------------------------------------------

/**
 * Cablage par delegation, UNE SEULE FOIS par racine (voir `wiredRoots`).
 * @param {HTMLElement} root
 */
function wire(root) {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);

  // Explication d'un indicateur : c'est la page qui bascule `is-open` et
  // `aria-expanded`, ui.kpi ne cable rien.
  on(root, 'click', '.kpi', function (ev, el) {
    const all = qsa('.kpi', root);
    const index = all.indexOf(el);
    const isOpen = el.classList.toggle('is-open');
    el.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (index < 0) return;
    if (isOpen) openWhy.add(index); else openWhy.delete(index);
  });

  // Fiche du correspondant : c'est app/main.js qui ouvre la modale.
  on(root, 'click', '[data-drill]', function (ev, el) {
    const number = el.getAttribute('data-drill');
    if (!number) return;
    document.dispatchEvent(new CustomEvent('keyyo:drill', { detail: { number } }));
  });

  on(root, 'click', '[data-export]', function () {
    exportPending();
  });
}

/**
 * Reapplique les explications depliees apres un rendu. Les indicateurs sont en
 * nombre et en ordre fixes, leur position sert donc de cle.
 * @param {HTMLElement} root
 */
function restoreWhy(root) {
  if (!openWhy.size) return;
  const all = qsa('.kpi', root);
  for (let i = 0; i < all.length; i++) {
    if (!openWhy.has(i)) continue;
    all[i].classList.add('is-open');
    all[i].setAttribute('aria-expanded', 'true');
  }
}

/**
 * @param {number} count Nombre de numeros en attente.
 * @returns {string} Bouton d'export, desactive quand il n'y a rien a exporter.
 */
function exportButton(count) {
  const disabled = count > 0 ? '' : ' disabled';
  return html`<button class="btn btn--sm" type="button" data-export="pending"${raw(disabled)}>${raw(icon('download'))}Exporter les numéros à rappeler</button>`;
}

// -----------------------------------------------------------------------------
//  Export CSV
// -----------------------------------------------------------------------------

/** En-tetes du fichier, dans l'ordre des colonnes ecrites. */
const CSV_HEADERS = [
  'Numéro',
  'Nom',
  'Appels manqués',
  'Dernier appel manqué',
  'Heure',
  'Ligne Keyyo',
];

/**
 * Cellule CSV.
 *
 * Deux precautions : les caracteres de structure (point-virgule, guillemet,
 * saut de ligne) imposent des guillemets doubles, et une valeur commencant par
 * `=`, `+`, `-` ou `@` est interpretee comme une FORMULE par les tableurs. Un
 * numero en E.164 commence justement par `+` : l'apostrophe le neutralise sans
 * changer ce que la cellule affiche ni ce qu'on en recopie.
 * @param {unknown} value
 * @returns {string}
 */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@]/.test(text) ? "'" + text : text;
  if (/[";\r\n]/.test(guarded)) return '"' + guarded.replace(/"/g, '""') + '"';
  return guarded;
}

/**
 * Telecharge les numeros a rappeler.
 *
 * Memes regles de format que la page Journal : separateur point-virgule (le
 * tableur francais l'attend), BOM UTF-8 en tete (sans lui Excel lit les accents
 * de travers), fins de ligne CRLF, et liberation de l'URL de l'objet.
 *
 * La liste est recalculee AU CLIC, sur les filtres du moment : le gestionnaire
 * est cable une seule fois et ne doit rien capturer d'un rendu passe.
 */
function exportPending() {
  const pending = callbackAnalysis(filtered()).pending;
  if (!pending.length) return;

  const lines = [];
  const header = [];
  for (let i = 0; i < CSV_HEADERS.length; i++) header.push(csvCell(CSV_HEADERS[i]));
  lines.push(header.join(';'));

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    const line = lineByCsi(entry.csi);
    lines.push([
      csvCell(entry.number),
      csvCell(nameOf(entry.number) || ''),
      csvCell(entry.count),
      csvCell(fmtDate(entry.lastDate)),
      csvCell(fmtTime(entry.lastHour, entry.lastMinute)),
      csvCell(line && line.label ? line.label : labelOf(entry.csi)),
    ].join(';'));
  }

  // BOM ecrit en sequence d'echappement : un U+FEFF litteral est invisible dans
  // le source et se ferait supprimer au premier reformatage du fichier.
  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  const name = 'appels-a-rappeler-' + (state.from || 'debut') + '_' + (state.to || 'fin') + '.csv';

  let url = '';
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: name, rel: 'noopener' });
    // Un lien detache n'est pas suivi par tous les moteurs : on l'attache le
    // temps du clic, puis on le retire.
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (err) {
    console.error('[missed] export CSV impossible :', err);
  } finally {
    // Revocation differee : revoquer dans la meme tache que le clic annulerait
    // parfois un telechargement qui n'a pas encore demarre.
    if (url) window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }
}

// -----------------------------------------------------------------------------
//  Outils locaux
// -----------------------------------------------------------------------------

/**
 * Delai de rappel, en secondes : du DERNIER appel manque du groupe a l'appel
 * sortant qui l'a solde.
 * @param {any} entry
 * @returns {number|null} `null` quand le delai n'est pas mesurable.
 */
function callbackDelay(entry) {
  const missedAt = Number(entry && entry.lastTs) || 0;
  const backAt = Number(entry && entry.calledBackTs) || 0;
  if (!missedAt || !backAt || backAt <= missedAt) return null;
  return backAt - missedAt;
}

/**
 * Mediane arrondie. Elle resiste mieux que la moyenne a un rappel oublie
 * pendant trois semaines, qui ecraserait toute lecture.
 * @param {number[]} values
 * @returns {number} 0 si la liste est vide.
 */
function medianOf(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
