// =============================================================================
//  app/pages/calls.js — Le journal des appels.
//
//  La vue de detail exhaustive : celle qu'on ouvre pour repondre a « que s'est
//  il passe exactement ? ». Elle n'agrege presque rien, elle EXPOSE les lignes,
//  une par appel, avec de quoi les retrouver (recherche) et de quoi les sortir
//  de l'outil (export CSV).
//
//  TROIS CONTRAINTES ONT DICTE LA STRUCTURE DE CE FICHIER :
//
//   1. LE VOLUME. Trois mois d'appels sur une dizaine de lignes representent
//      plusieurs milliers d'enregistrements. On ne pose donc jamais des
//      milliers de <tr> dans le document : la pagination est cote client, cent
//      lignes par page, et seule la tranche courante est rendue.
//
//   2. LE FOCUS DU CHAMP DE RECHERCHE. C'est le point delicat de la page. Un
//      rendu complet (`mount`) recree le champ, donc detruit l'element qui
//      porte le focus et le curseur : taper « sed » perdrait le focus apres le
//      « s ». D'ou deux mesures distinctes, decrites en detail sur
//      `refreshTable` et `captureFocus` :
//        - la recherche est TEMPORISEE (~200 ms) et ne rafraichit QUE le
//          tableau, jamais la barre d'outils ;
//        - si un rendu complet survient quand meme (le sondage de fond du
//          store notifie toutes les 60 s), le focus et le curseur sont
//          restitues apres le montage.
//
//   3. LES ECOUTEURS NE DOIVENT PAS S'ACCUMULER. `render(root)` est rappelee a
//      chaque changement d'etat, mais `mount` remplace le CONTENU de `root`,
//      pas `root` lui-meme : un `on(root, ...)` pose a chaque rendu
//      s'empilerait. La delegation est donc cablee UNE SEULE FOIS par element
//      de section (garde `_wired`), ce qui rend `render` idempotente.
//
//  VERITE METIER RAPPELEE A L'UTILISATEUR : l'API Keyyo ne fournit aucun
//  indicateur de decroche. La duree facturee EST le seul signal, et un appel
//  manque se DEDUIT — c'est un entrant de duree nulle. Les explications des
//  quatre indicateurs (champ `why`) le disent explicitement, sans pretendre a
//  une precision que la source n'a pas.
// =============================================================================

import { html, raw, mount, qs, on, icon } from '../dom.js';
import {
  fmtInt, fmtPct, fmtDate, fmtTime, fmtDuration, fmtDurationShort, fmtHms, pluralize,
} from '../format.js';
import {
  card, sectionHead, kpi, table, tag, toolbar, empty, notice, skeleton,
} from '../ui.js';
import { state, filtered, stats, status, lineByCsi, nameOf, labelOf } from '../store.js';
import { F } from '../../shared/schema.js';
import { formatNumber, toE164 } from '../../shared/phone.js';

// -----------------------------------------------------------------------------
//  Reglages
// -----------------------------------------------------------------------------

/** Lignes par page. Cent tient dans un ecran defilable sans peser au rendu. */
const PAGE_SIZE = 100;

/** Attente apres la derniere frappe avant de refiltrer, en millisecondes. */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * Delai avant liberation de l'URL d'objet du CSV. La revoquer dans la foulee du
 * clic annule le telechargement sur certains navigateurs : on laisse le temps
 * a la requete de partir.
 */
const REVOKE_DELAY_MS = 1000;

const SEARCH_ID = 'calls-search';
const EXPORT_ID = 'calls-export';
const PREV_ID = 'calls-prev';
const NEXT_ID = 'calls-next';

/** Colonnes du journal. `cls` et `align` viennent du contrat de `ui.table`. */
const COLUMNS = [
  { key: 'date', label: 'Date', cls: 'shrink' },
  { key: 'time', label: 'Heure', cls: 'shrink' },
  { key: 'caller', label: 'Appelant' },
  { key: 'callee', label: 'Appelé' },
  { key: 'dir', label: 'Sens', cls: 'shrink' },
  { key: 'line', label: 'Ligne', cls: 'shrink' },
  { key: 'person', label: 'Collaborateur', cls: 'shrink' },
  { key: 'duration', label: 'Durée', align: 'right' },
  { key: 'state', label: 'État', cls: 'shrink' },
];

/**
 * Largeur minimale du tableau. Neuf colonnes dont deux cellules d'identite :
 * en dessous, les noms se replient et la lecture devient penible. Au-dela,
 * `.table-wrap` defile horizontalement.
 */
const TABLE_MIN_WIDTH = 1080;

/** En-tetes du fichier CSV, dans l'ordre exact des champs produits. */
const CSV_COLUMNS = [
  'Date', 'Heure', 'Appelant', 'Nom_appelant', 'Appele', 'Nom_appele', 'Sens',
  'CSI', 'Collaborateur', 'Email', 'Duree_s', 'Decroche', 'Cout',
];

// -----------------------------------------------------------------------------
//  Etat du module
//
//  Il ne contient que ce qui appartient VRAIMENT a la vue et n'a pas de sens
//  ailleurs : la page affichee et le texte cherche. Periode, ligne et sens sont
//  dans le store, ils sont partages avec la barre de periode.
// -----------------------------------------------------------------------------

/** Index de la page affichee, 0 = premiere. */
let _pageIndex = 0;

/** Texte de recherche courant. Survit aux rendus, donc au sondage de fond. */
let _search = '';

/** Identifiant du temporisateur de recherche, 0 quand aucun n'est arme. */
let _searchTimer = 0;

/**
 * Signature des filtres du store au dernier rendu. Quand elle change, la
 * pagination repart de la premiere page : sinon, passer de « 3 mois » a
 * « 7 jours » en etant page 12 afficherait un tableau vide sans rien expliquer.
 */
let _lastFilterKey = '';

/** Sections dont la delegation d'evenements est deja cablee. */
const _wired = new WeakSet();

/**
 * Vue derivee (tri + index de recherche), memoisee par IDENTITE du tableau
 * rendu par `filtered()`.
 *
 * `filtered()` memoise son resultat : le meme jeu de filtres sur le meme jeu de
 * donnees renvoie le MEME tableau, et un changement de donnees en renvoie un
 * nouveau. Cette WeakMap suit donc exactement le cycle de vie des donnees, sans
 * cache a vider a la main, et le GC recupere les entrees devenues inutiles.
 * @type {WeakMap<object, {rows: any[][], text: string[], digits: string[]}>}
 */
const _viewCache = new WeakMap();

// -----------------------------------------------------------------------------
//  Rendu principal
// -----------------------------------------------------------------------------

/**
 * Ecrit la vue dans sa section. Idempotente : appelable a chaque notification
 * du store sans effet cumulatif.
 * @param {HTMLElement} root  L'element `section.page[data-page="calls"]`.
 * @returns {void}
 */
export function render(root) {
  if (!root) return;
  wire(root);

  const st = status();

  // Un changement de periode, de ligne ou de sens invalide la pagination.
  const key = filterKey();
  if (key !== _lastFilterKey) {
    _lastFilterKey = key;
    _pageIndex = 0;
  }

  // -- Etat 1 : chargement, et rien a montrer en attendant. -------------------
  if (st.kind === 'loading' && st.empty) {
    mount(root, loadingHtml());
    return;
  }

  const head = headNotice(st);
  const rows = filtered();

  // -- Etat 2 : aucun appel sur la periode et les filtres choisis. ------------
  if (!rows.length) {
    mount(root, html`${raw(head)}${raw(card({ body: raw(emptyBody(st)) }))}`);
    return;
  }

  // -- Etat 3 : le journal. ---------------------------------------------------
  const shown = selectRows(buildView(rows), needleOf(_search));
  clampPage(shown.length);

  const focus = captureFocus();
  mount(root, html`
    ${raw(head)}
    ${raw(toolbarHtml())}
    ${raw(kpiGridHtml(rows))}
    ${raw(sectionHead('Détail des appels', periodLabel()))}
    ${raw(card({ flush: true, body: raw(tableHtml(shown)) }))}
  `);
  restoreFocus(root, focus);
}

// -----------------------------------------------------------------------------
//  Etats de bordure : chargement, collecte partielle, aucune donnee
// -----------------------------------------------------------------------------

/**
 * Ossature de chargement. Les formes grises sont `aria-hidden` : c'est le
 * sous-titre de section qui annonce l'attente a voix haute.
 * @returns {string}
 */
function loadingHtml() {
  const cards = skeleton('card') + skeleton('card') + skeleton('card') + skeleton('card');
  return html`
    <div class="kpi-grid">${raw(cards)}</div>
    ${raw(sectionHead('Détail des appels', 'Collecte des appels en cours…'))}
    ${raw(card({ body: raw(skeleton('block')) }))}
  `;
}

/**
 * Bandeau d'etat de la collecte.
 *
 * `notice.body` est traite comme du HTML deja sur : le message vient du store,
 * donc de l'API, et se compose OBLIGATOIREMENT avec le gabarit `html`.
 * @param {{kind: string, warning: string}} st  Retour de `status()`.
 * @returns {string} chaine vide quand la collecte est saine.
 */
function headNotice(st) {
  if (st.kind === 'error') {
    return notice({
      tone: 'error',
      title: 'Collecte interrompue.',
      body: html`${st.warning || 'La dernière collecte des appels a échoué.'} Le journal ci-dessous peut être incomplet ou dater d’avant l’incident.`,
    });
  }
  if (st.kind === 'warn' && st.warning) {
    return notice({ tone: 'warn', title: 'Collecte partielle.', body: html`${st.warning}` });
  }
  return '';
}

/**
 * Etat vide. Deux causes bien differentes, donc deux pistes d'action
 * differentes : la periode est trop etroite, ou la base est vide.
 * @param {{empty: boolean}} st
 * @returns {string}
 */
function emptyBody(st) {
  if (st.empty) {
    return empty(
      'Aucun appel collecté',
      'La base ne contient encore aucun appel. Lancez un rafraîchissement avec le bouton en haut à droite, puis ouvrez la page Diagnostic pour vérifier le jeton, le périmètre de lecture et les lignes détectées.',
    );
  }
  return empty(
    'Aucun appel sur cette période',
    'Élargissez la période avec « 3 mois » ou « Tout » dans la barre du haut, ou remettez les filtres de ligne et de sens sur « toutes » et « entrants et sortants ».',
  );
}

// -----------------------------------------------------------------------------
//  Barre d'outils
// -----------------------------------------------------------------------------

/**
 * Champ de recherche et export CSV.
 *
 * La valeur du champ est repeuplee depuis `_search` : un rendu complet recree
 * l'element, et sans cela le texte cherche disparaitrait de l'ecran alors que
 * le tableau reste filtre — l'utilisateur ne comprendrait plus ce qu'il voit.
 * @returns {string}
 */
function toolbarHtml() {
  const search = html`<div class="field field--grow">
    ${raw(icon('search'))}
    <label class="sr-only" for="${SEARCH_ID}">Rechercher dans le journal</label>
    <input id="${SEARCH_ID}" type="search" autocomplete="off" spellcheck="false"
      placeholder="Numéro, nom, collaborateur ou CSI…" value="${_search}">
  </div>`;

  const exportBtn = html`<button class="btn" id="${EXPORT_ID}" type="button">
    ${raw(icon('download'))}Exporter en CSV
  </button>`;

  return toolbar([search, '<span class="toolbar-spacer"></span>', exportBtn]);
}

// -----------------------------------------------------------------------------
//  Indicateurs
// -----------------------------------------------------------------------------

/**
 * Les quatre indicateurs de tete.
 *
 * Ils portent sur la PERIODE ET LES FILTRES, jamais sur la recherche : celle-ci
 * n'affine que le tableau, et un chiffre qui bougerait a chaque frappe sans que
 * l'explication du calcul suive serait plus trompeur qu'utile. Le pied du
 * tableau, lui, dit combien de lignes correspondent a la recherche.
 * @param {any[][]} rows  Lignes retenues par la periode et les filtres.
 * @returns {string}
 */
function kpiGridHtml(rows) {
  const s = stats(rows);

  const total = kpi({
    label: 'Appels',
    value: fmtInt(s.total),
    foot: fmtInt(s.in) + ' ' + pluralize(s.in, 'entrant', 'entrants')
      + ' · ' + fmtInt(s.out) + ' ' + pluralize(s.out, 'sortant', 'sortants'),
    why: 'Nombre d’enregistrements d’appel retenus par la période, la ligne et le sens choisis dans la barre du haut. La recherche du journal n’entre pas dans ce total.',
  });

  const answered = kpi({
    label: 'Décrochés',
    value: fmtInt(s.answered),
    tone: 'ok',
    foot: 'Taux de réponse des entrants : ' + fmtPct(s.answerRate, 1),
    why: 'Un appel est compté décroché quand sa durée facturée dépasse zéro seconde, entrants et sortants confondus. Le taux affiché juste au-dessus ne porte, lui, que sur les entrants : entrants décrochés divisés par entrants.',
  });

  const missed = kpi({
    label: 'Manqués',
    value: fmtInt(s.missed),
    tone: 'missed',
    foot: 'sur ' + fmtInt(s.in) + ' ' + pluralize(s.in, 'entrant', 'entrants'),
    why: 'L’API Keyyo ne fournit aucun indicateur de décroché : un appel manqué est donc déduit, c’est un appel entrant dont la durée facturée est nulle. Un appel décroché puis raccroché dans la même seconde serait compté ici, et un sortant sans réponse ne l’est jamais.',
  });

  const duration = kpi({
    label: 'Durée cumulée',
    value: fmtHms(s.totalDuration),
    foot: 'Moyenne ' + fmtDuration(s.avgDuration) + ' par appel décroché',
    why: 'Somme des durées facturées de tous les appels retenus, entrants et sortants. Les appels non décrochés y comptent pour zéro seconde. La moyenne et la médiane, elles, ne portent que sur les appels décrochés, sinon les zéros les écraseraient.',
  });

  return html`<div class="kpi-grid">${raw(total)}${raw(answered)}${raw(missed)}${raw(duration)}</div>`;
}

/**
 * Bornes de la periode, en sous-titre de section.
 * @returns {string}
 */
function periodLabel() {
  const from = state.from ? fmtDate(state.from) : '';
  const to = state.to ? fmtDate(state.to) : '';
  const range = from && to ? 'Du ' + from + ' au ' + to : 'Toute la période collectée';
  return range + ' · ' + fmtInt(PAGE_SIZE) + ' appels par page';
}

// -----------------------------------------------------------------------------
//  Tableau
// -----------------------------------------------------------------------------

/**
 * Le tableau complet, tranche courante seulement.
 * @param {any[][]} shown  Toutes les lignes retenues (periode, filtres, recherche).
 * @returns {string}
 */
function tableHtml(shown) {
  const start = _pageIndex * PAGE_SIZE;
  const slice = shown.slice(start, start + PAGE_SIZE);

  const rows = [];
  for (let i = 0; i < slice.length; i++) rows.push(cellsOf(slice[i]));

  return table({
    columns: COLUMNS,
    rows,
    foot: footHtml(shown.length),
    minWidth: TABLE_MIN_WIDTH,
  });
}

/**
 * Cellules d'une ligne d'appel. Chaque cellule est une chaine HTML DEJA SURE,
 * construite avec le gabarit `html` : les noms viennent de l'annuaire Keyyo et
 * ne sont pas de confiance.
 * @param {any[]} row
 * @returns {string[]}
 */
function cellsOf(row) {
  const csi = String(row[F.csi] == null ? '' : row[F.csi]);
  const line = lineByCsi(csi);
  const incoming = row[F.dir] === 0;
  const isAnswered = row[F.answered] === 1;

  return [
    html`<span class="nowrap">${fmtDate(row[F.date])}</span>`,
    html`<span class="tnum nowrap">${fmtTime(row[F.hour], row[F.minute])}</span>`,
    peerCell(row[F.caller]),
    peerCell(row[F.callee]),
    tag(incoming ? 'Entrant' : 'Sortant', incoming ? 'in' : 'out'),
    html`<span class="tnum nowrap">${formatNumber(csi)}</span>`,
    html`<div class="truncate">${line ? line.label : '—'}</div>`,
    html`<span class="tnum">${fmtDurationShort(Number(row[F.seconds]) || 0)}</span>`,
    stateCell(incoming, isAnswered),
  ];
}

/**
 * Cellule de numero : le NOM quand l'annuaire le resout, le numero formate en
 * sous-ligne, le tout actionnable.
 *
 * L'action est un <button> DANS la cellule et non un <tr> cliquable : `ui.table`
 * ne permet pas d'attribut sur un <tr>, et c'est de toute facon le seul moyen
 * d'atteindre l'action au clavier.
 * @param {unknown} number
 * @returns {string}
 */
function peerCell(number) {
  const key = toE164(number);
  const pretty = formatNumber(number);
  const name = nameOf(number);

  // Appelant masque ou colonne vide : il n'y a aucune fiche a ouvrir, on rend
  // un libelle inerte plutot qu'un bouton sans effet.
  if (!key || key === 'anonymous') {
    return html`<div class="cell-id"><div class="cell-id-body"><div class="cell-id-name">${pretty}</div></div></div>`;
  }

  const sub = name ? html`<div class="cell-id-sub">${pretty}</div>` : '';
  return html`<button class="cell-id" type="button" data-drill="${key}" title="Ouvrir la fiche du correspondant">
    <div class="cell-id-body">
      <div class="cell-id-name">${name || pretty}</div>
      ${raw(sub)}
    </div>
  </button>`;
}

/**
 * Etat d'un appel.
 *
 * Trois cas et non deux, parce que la definition metier du manque est stricte :
 * un manque est un ENTRANT de duree nulle. Teinter en rouge un sortant reste
 * sans reponse laisserait croire a un client qu'on a rate, ce qui est faux —
 * il prend donc un ton neutre.
 * @param {boolean} incoming
 * @param {boolean} isAnswered
 * @returns {string}
 */
function stateCell(incoming, isAnswered) {
  if (isAnswered) return tag('Décroché', 'ok');
  if (incoming) return tag('Manqué', 'missed');
  return tag('Sans réponse', 'neutral');
}

/**
 * Pied du tableau : bornes affichees, total, et pagination.
 * @param {number} total  Nombre de lignes retenues, toutes pages confondues.
 * @returns {string}
 */
function footHtml(total) {
  const pages = pageCount(total);
  const page = Math.min(Math.max(_pageIndex, 0), pages - 1);
  const first = total ? page * PAGE_SIZE + 1 : 0;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);

  const count = fmtInt(total) + ' ' + pluralize(total, 'appel', 'appels');
  const scope = _search
    ? count + ' ' + pluralize(total, 'correspond', 'correspondent') + ' à la recherche'
    : count + ' sur la période et les filtres choisis';

  const left = total
    ? html`<span>Affichage ${fmtInt(first)}–${fmtInt(last)} · ${scope}</span>`
    : html`<span>${scope}</span>`;

  const pager = html`<span class="row">
    <button class="btn btn--sm" id="${PREV_ID}" type="button"${raw(page <= 0 ? ' disabled' : '')}>Précédent</button>
    <span class="nowrap">Page ${fmtInt(page + 1)} sur ${fmtInt(pages)}</span>
    <button class="btn btn--sm" id="${NEXT_ID}" type="button"${raw(page >= pages - 1 ? ' disabled' : '')}>Suivant</button>
  </span>`;

  return left + pager;
}

/** @param {number} total @returns {number} nombre de pages, au moins 1. */
function pageCount(total) {
  return total > 0 ? Math.ceil(total / PAGE_SIZE) : 1;
}

/**
 * Ramene `_pageIndex` dans les bornes du jeu affiche. Appele avant chaque
 * rendu du tableau : une recherche qui reduit le total de 3000 a 12 lignes
 * doit sortir de la page 12 toute seule.
 * @param {number} total
 */
function clampPage(total) {
  const max = pageCount(total) - 1;
  if (_pageIndex > max) _pageIndex = max;
  if (_pageIndex < 0) _pageIndex = 0;
}

// -----------------------------------------------------------------------------
//  Rafraichissement partiel — le coeur du confort de frappe
// -----------------------------------------------------------------------------

/**
 * Reconstruit UNIQUEMENT le tableau et son pied, en place.
 *
 * POURQUOI ne pas rappeler `render(root)` : `mount` remplace tout le contenu de
 * la section, donc recree le champ de recherche. Le champ perdrait le focus et
 * le curseur a chaque frappe, et l'utilisateur ne pourrait pas ecrire deux
 * lettres de suite. Ici on ne remplace que le contenu de la carte du tableau —
 * la barre d'outils, le champ et les indicateurs ne sont jamais touches.
 *
 * Le selecteur `.card--flush` designe la carte du tableau : c'est la seule
 * carte sans rembourrage de la page, et c'est `ui.card({ flush: true })` qui
 * pose cette classe. On repasse par `ui.table` plutot que de rebatir un
 * <tbody> a la main, pour ne pas dupliquer le balisage du noyau.
 *
 * @param {HTMLElement} root
 * @returns {boolean} faux si la page n'est pas dans l'etat « journal ».
 */
function refreshTable(root) {
  const holder = qs('.card--flush', root);
  if (!holder) return false;

  const shown = currentRows();
  clampPage(shown.length);

  // Le defilement horizontal appartient a l'utilisateur : on le restitue apres
  // remplacement, sinon le tableau saute a gauche a chaque frappe.
  const before = qs('.table-wrap', root);
  const scrollLeft = before ? before.scrollLeft : 0;

  holder.innerHTML = tableHtml(shown);

  const after = qs('.table-wrap', root);
  if (after && scrollLeft) after.scrollLeft = scrollLeft;
  return true;
}

/**
 * Note le focus et le curseur du champ de recherche AVANT un rendu complet.
 * Le sondage de fond du store notifie toutes les soixante secondes : sans
 * cela, il couperait la frappe en cours une fois par minute.
 * @returns {{start: number|null, end: number|null}|null}
 */
function captureFocus() {
  const el = /** @type {any} */ (document.activeElement);
  if (!el || el.id !== SEARCH_ID) return null;
  try {
    return { start: el.selectionStart, end: el.selectionEnd };
  } catch (err) {
    // Certains navigateurs refusent la selection sur un input type=search :
    // on rendra alors le focus sans repositionner le curseur.
    return { start: null, end: null };
  }
}

/**
 * Restitue le focus note par `captureFocus`.
 * @param {HTMLElement} root
 * @param {{start: number|null, end: number|null}|null} snap
 */
function restoreFocus(root, snap) {
  if (!snap) return;
  const el = /** @type {any} */ (qs('#' + SEARCH_ID, root));
  if (!el) return;
  el.focus();
  if (snap.start == null) return;
  try {
    el.setSelectionRange(snap.start, snap.end);
  } catch (err) { /* sans effet : le focus seul suffit */ }
}

// -----------------------------------------------------------------------------
//  Selection des lignes : tri, index de recherche, filtrage
// -----------------------------------------------------------------------------

/** @returns {string} signature des filtres du store. */
function filterKey() {
  return state.from + '|' + state.to + '|' + state.csi + '|' + state.dir;
}

/** @returns {any[][]} lignes retenues par la periode, les filtres ET la recherche. */
function currentRows() {
  return selectRows(buildView(filtered()), needleOf(_search));
}

/**
 * Trie les lignes du plus recent au plus ancien et construit l'index de
 * recherche, une fois par jeu de donnees (voir `_viewCache`).
 *
 * L'index est fait de deux chaines par ligne, pretes a un `indexOf` :
 *   - `text`   : noms resolus, numeros formates, CSI, prenom du collaborateur ;
 *   - `digits` : les chiffres seuls des numeros, pour qu'une recherche tapee en
 *                national (`02 53 …`) retrouve un numero stocke en E.164.
 * Les construire ici plutot qu'a chaque frappe evite de reformater plusieurs
 * milliers de numeros toutes les 200 ms.
 *
 * @param {any[][]} rows
 * @returns {{rows: any[][], text: string[], digits: string[]}}
 */
function buildView(rows) {
  const cached = _viewCache.get(rows);
  if (cached) return cached;

  const sorted = rows.slice().sort(byRecentFirst);
  const n = sorted.length;
  const text = new Array(n);
  const digits = new Array(n);

  for (let i = 0; i < n; i++) {
    const row = sorted[i];
    const caller = row[F.caller];
    const callee = row[F.callee];
    const csi = String(row[F.csi] == null ? '' : row[F.csi]);
    const line = lineByCsi(csi);

    text[i] = [
      labelOf(caller),
      labelOf(callee),
      formatNumber(caller),
      formatNumber(callee),
      csi,
      line ? line.label : '',
    ].join(' ').toLowerCase();

    // L'espace comme separateur empeche un faux positif a cheval sur deux
    // numeros (fin de l'appelant + debut de l'appele).
    digits[i] = [caller, callee, csi].join(' ').replace(/[^0-9]+/g, ' ');
  }

  const view = { rows: sorted, text, digits };
  _viewCache.set(rows, view);
  return view;
}

/**
 * Ordre du journal : le plus recent d'abord, avec une departage stable sur
 * l'identifiant. Sans ce departage, deux appels de meme horodatage pourraient
 * changer de place d'un rendu a l'autre selon l'implementation du tri.
 * @param {any[]} a
 * @param {any[]} b
 * @returns {number}
 */
function byRecentFirst(a, b) {
  const delta = (Number(b[F.ts]) || 0) - (Number(a[F.ts]) || 0);
  if (delta) return delta;
  const ida = String(a[F.id] == null ? '' : a[F.id]);
  const idb = String(b[F.id] == null ? '' : b[F.id]);
  if (ida === idb) return 0;
  return ida < idb ? 1 : -1;
}

/**
 * Prepare le motif de recherche.
 *
 * En plus du texte brut, on derive des variantes en chiffres seuls, parce qu'un
 * numero saisi comme on le compose (`02 53 35 95 65`) doit retrouver la forme
 * stockee (`+33253359565`) :
 *   - les chiffres tels quels ;
 *   - sans le zero de tete, qui disparait en E.164 ;
 *   - la forme E.164 quand `toE164` sait la calculer.
 *
 * @param {string} search
 * @returns {{text: string, digits: string[]}|null} `null` si rien n'est cherche.
 */
function needleOf(search) {
  const q = String(search == null ? '' : search).trim().toLowerCase();
  if (!q) return null;

  /** @type {string[]} */
  const digits = [];
  const plain = q.replace(/[^0-9]/g, '');
  // En dessous de deux chiffres, une variante numerique ramenerait la moitie du
  // journal : on laisse alors la recherche textuelle faire son travail.
  if (plain.length >= 2) {
    pushUnique(digits, plain);
    pushUnique(digits, plain.replace(/^0+/, ''));
    pushUnique(digits, toE164(q).replace(/[^0-9]/g, ''));
  }
  return { text: q, digits };
}

/** @param {string[]} list @param {string} value */
function pushUnique(list, value) {
  if (value && list.indexOf(value) < 0) list.push(value);
}

/**
 * Applique la recherche a une vue.
 * @param {{rows: any[][], text: string[], digits: string[]}} view
 * @param {{text: string, digits: string[]}|null} needle
 * @returns {any[][]} le tableau de la vue lui-meme quand rien n'est cherche.
 */
function selectRows(view, needle) {
  if (!needle) return view.rows;

  const out = [];
  for (let i = 0; i < view.rows.length; i++) {
    if (view.text[i].indexOf(needle.text) >= 0) { out.push(view.rows[i]); continue; }
    const hay = view.digits[i];
    for (let k = 0; k < needle.digits.length; k++) {
      if (hay.indexOf(needle.digits[k]) >= 0) { out.push(view.rows[i]); break; }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
//  Interactions
// -----------------------------------------------------------------------------

/**
 * Cable la delegation, UNE SEULE FOIS par section.
 *
 * `mount` remplace le contenu de `root`, pas `root` : un `on(root, ...)` pose a
 * chaque rendu s'ajouterait aux precedents, et un clic finirait par declencher
 * dix fois le meme traitement. La garde `_wired` supprime le probleme a la
 * source, et la delegation continue de fonctionner sur des elements recrees.
 * @param {HTMLElement} root
 */
function wire(root) {
  if (_wired.has(root)) return;
  _wired.add(root);

  // -- Recherche temporisee. --------------------------------------------------
  // On ne refiltre qu'apres une pause de frappe, et on ne rafraichit QUE le
  // tableau : voir refreshTable pour la raison.
  on(root, 'input', '#' + SEARCH_ID, (ev, el) => {
    const value = String(el.value == null ? '' : el.value);
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      _searchTimer = 0;
      if (value === _search) return;
      _search = value;
      _pageIndex = 0;              // nouvelle recherche : on repart de la page 1
      refreshTable(root);
    }, SEARCH_DEBOUNCE_MS);
  });

  // Entree : l'utilisateur a fini, inutile de lui faire attendre la temporisation.
  on(root, 'keydown', '#' + SEARCH_ID, (ev, el) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = 0; }
    const value = String(el.value == null ? '' : el.value);
    if (value !== _search) { _search = value; _pageIndex = 0; }
    refreshTable(root);
  });

  // -- Pagination. -----------------------------------------------------------
  // Les bornes sont garanties par clampPage, appele avant chaque rendu du
  // tableau : les boutons n'ont pas a savoir combien il y a de pages.
  on(root, 'click', '#' + PREV_ID, () => {
    if (_pageIndex <= 0) return;
    _pageIndex--;
    refreshTable(root);
  });
  on(root, 'click', '#' + NEXT_ID, () => {
    _pageIndex++;
    refreshTable(root);
  });

  // -- Export. ---------------------------------------------------------------
  on(root, 'click', '#' + EXPORT_ID, () => { exportCsv(); });

  // -- Explication d'un indicateur. -----------------------------------------
  // `ui.kpi` pose aria-expanded="false" ; c'est a la page de basculer la classe
  // ET l'attribut, le noyau ne cable rien.
  on(root, 'click', '.kpi', (ev, el) => {
    if (!el.hasAttribute('aria-expanded')) return;   // indicateur sans explication
    const open = el.classList.toggle('is-open');
    el.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // -- Fiche correspondant. --------------------------------------------------
  // La page ne connait pas la modale : elle annonce l'intention, app/main.js
  // ouvre la fiche.
  on(root, 'click', '[data-drill]', (ev, el) => {
    const number = el.getAttribute('data-drill');
    if (!number) return;
    document.dispatchEvent(new CustomEvent('keyyo:drill', { detail: { number } }));
  });
}

// -----------------------------------------------------------------------------
//  Export CSV
// -----------------------------------------------------------------------------

/**
 * Exporte TOUTES les lignes retenues, et pas seulement la page affichee : un
 * export qui s'arreterait a cent lignes serait un piege silencieux.
 *
 * Format pense pour Excel en francais : separateur point-virgule, virgule
 * decimale, et BOM UTF-8 en tete — sans lui, Excel lit le fichier en Latin-1
 * et « Décroché » devient « DÃ©crochÃ© ».
 */
function exportCsv() {
  const rows = currentRows();
  if (!rows.length) return;

  const lines = [CSV_COLUMNS.map(csvField).join(';')];
  for (let i = 0; i < rows.length; i++) lines.push(csvRow(rows[i]));

  const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = csvName();
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Une URL d'objet retient son blob en memoire jusqu'a revocation : sur trois
  // mois d'appels cela represente plusieurs mega-octets qu'il faut rendre.
  setTimeout(() => { URL.revokeObjectURL(url); }, REVOKE_DELAY_MS);
}

/**
 * Une ligne du CSV.
 * @param {any[]} row
 * @returns {string}
 */
function csvRow(row) {
  const csi = String(row[F.csi] == null ? '' : row[F.csi]);
  const line = lineByCsi(csi);
  const person = line && line.person ? line.person : null;
  const incoming = row[F.dir] === 0;

  return [
    row[F.date] || '',
    fmtTime(row[F.hour], row[F.minute]),
    row[F.caller] || '',
    nameOf(row[F.caller]) || '',
    row[F.callee] || '',
    nameOf(row[F.callee]) || '',
    incoming ? 'Entrant' : 'Sortant',
    csi,
    line ? line.label : '',
    person && person.email ? person.email : '',
    String(Number(row[F.seconds]) || 0),
    row[F.answered] === 1 ? 'oui' : 'non',
    csvNumber(row[F.cost]),
  ].map(csvField).join(';');
}

/**
 * Champ CSV : toujours entre guillemets, guillemets internes doubles. Tout
 * encadrer met a l'abri du point-virgule et du retour a la ligne qu'un nom
 * d'annuaire peut contenir.
 * @param {unknown} v
 * @returns {string}
 */
function csvField(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Nombre en notation francaise pour le cout facture. Le champ est facultatif
 * cote Keyyo : absent, il reste vide plutot que de valoir zero, qui serait un
 * mensonge.
 * @param {unknown} v
 * @returns {string}
 */
function csvNumber(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!isFinite(n)) return '';
  return String(n).replace('.', ',');
}

/**
 * Nom du fichier : prefixe et bornes de la periode.
 * @returns {string}
 */
function csvName() {
  return 'appels_' + slug(state.from || 'debut') + '_' + slug(state.to || 'fin') + '.csv';
}

/** @param {unknown} s @returns {string} fragment sur pour un nom de fichier. */
function slug(s) {
  return String(s == null ? '' : s).replace(/[^0-9a-zA-Z-]/g, '');
}
