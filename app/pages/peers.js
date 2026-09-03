// =============================================================================
//  app/pages/peers.js — Les correspondants : qui appelle et qui est appele.
//
//  Cette vue regarde l'activite depuis l'EXTERIEUR : une ligne par numero
//  distinct vu sur la periode, quelle que soit la ligne Keyyo concernee. C'est
//  la seule vue qui repond a « qui nous appelle le plus, et qui laissons-nous
//  sonner ».
//
//  Trois partis pris a connaitre avant de lire le code :
//
//   1. LES INDICATEURS SUIVENT LA RECHERCHE. Ils sont calcules sur la liste
//      REELLEMENT affichee (periode + filtres du bandeau + recherche), pas sur
//      un total global : un chiffre en tete de page qui ne correspond pas au
//      tableau juste en dessous est un chiffre qu'on finit par ne plus croire.
//      Le detail du calcul est dit dans le `why` de chaque indicateur.
//
//   2. UN APPEL MANQUE EST UN ENTRANT DE DUREE NULLE. L'API Keyyo n'expose
//      aucun indicateur de decroche : le manque en est deduit. On l'ecrit tel
//      quel a l'utilisateur, sans pretendre a une precision que la source n'a
//      pas.
//
//   3. LES CORRESPONDANTS INTERNES SONT SIGNALES. Un poste court, ou un numero
//      qui est lui-meme une ligne du compte, n'est pas un client : c'est un
//      collegue. Personne ne le voit autrement, d'ou l'etiquette « Interne ».
//
//  Etat local du module (recherche, tri, page courante) : il survit aux
//  re-rendus declenches par le store, ce qui est indispensable pour que la
//  saisie en cours ne soit pas effacee par un rafraichissement de fond.
// =============================================================================

import { html, raw, mount, qs, qsa, on, icon } from '../dom.js';
import { fmtInt, fmtHms, fmtDate, fmtRelative, pluralize } from '../format.js';
import { card, sectionHead, kpi, table, tag, avatar, empty, notice, skeleton, toolbar } from '../ui.js';
import { barChart, attachChartTips } from '../charts.js';
import { state, filtered, byPeer, getLines, status } from '../store.js';
import { toE164, numberKind, formatNumber } from '../../shared/phone.js';

/** Lignes par page. Au-dela, le navigateur peine et l'oeil decroche. */
const PAGE_SIZE = 60;

/** Temporisation de la recherche, en millisecondes. */
const SEARCH_DELAY = 220;

/** Nombre de correspondants dans l'histogramme de tete. */
const TOP_COUNT = 10;

/** Longueur maximale d'un libelle d'axe (voir le commentaire de topChart). */
const LABEL_MAX = 14;

/** Cles de tri reconnues. Une valeur inconnue retombe sur 'calls'. */
const SORTS = ['calls', 'duration', 'missed', 'last'];

/** Traduction des types de numero renvoyes par numberKind. */
const KIND_LABELS = {
  mobile: 'Mobile',
  fixe: 'Fixe',
  international: 'International',
  special: 'Numéro spécial',
  internal: 'Poste interne',
  anonymous: 'Masqué',
  inconnu: 'Numéro inconnu',
};

// -----------------------------------------------------------------------------
//  Etat local de la vue
// -----------------------------------------------------------------------------

/** Texte de recherche saisi, tel quel. */
let _query = '';

/** Critere de tri courant. */
let _sort = 'calls';

/** Page courante, 0 pour la premiere. */
let _pageIndex = 0;

/**
 * Signature des criteres qui changent le CONTENU de la liste. Des qu'elle
 * bouge, la pagination repart de la premiere page : rester en page 4 apres
 * avoir filtre sur trois correspondants afficherait un tableau vide.
 */
let _listKey = '';

/** Minuteur de la recherche temporisee. */
let _timer = 0;

/**
 * Indices des indicateurs dont l'explication est depliee. On memorise l'INDICE
 * dans la grille, car ui.kpi ne pose aucun identifiant : c'est ce qui permet de
 * garder l'explication ouverte a travers un re-rendu.
 * @type {Set<number>}
 */
const _openKpi = new Set();

/**
 * Sections deja cablees. `mount` remplace le CONTENU de la section, pas la
 * section elle-meme : les ecouteurs poses par `wire` vivent sur cette section
 * et survivent donc a chaque rendu. Sans cette garde, un rendu de plus poserait
 * un jeu d'ecouteurs de plus, et un seul clic finirait par declencher dix fois
 * le meme traitement. Meme mecanique que dans les six autres vues.
 * @type {WeakSet<object>}
 */
const _wired = new WeakSet();

// -----------------------------------------------------------------------------
//  Outils de texte et de recherche
// -----------------------------------------------------------------------------

/**
 * Forme de comparaison d'un texte : minuscules, sans accents. Un utilisateur
 * qui tape « ferre » doit trouver « Ferré ».
 * @param {unknown} v
 * @returns {string}
 */
function fold(v) {
  const s = String(v === null || v === undefined ? '' : v).toLowerCase();
  // normalize existe partout ou les modules ES existent ; la garde couvre le
  // cas d'un moteur exotique plutot que de faire tomber le rendu.
  if (typeof s.normalize !== 'function') return s;
  // Plage des diacritiques combinants, ecrite en sequences d'echappement : un
  // caractere combinant litteral dans le source est invisible et se perd au
  // premier reformatage.
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** @param {unknown} v @returns {string} chiffres seuls d'une chaine. */
function digitsOf(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
}

/**
 * Libelle francais du type d'un numero.
 * @param {unknown} number
 * @returns {string}
 */
function kindLabel(number) {
  const kind = numberKind(number);
  return KIND_LABELS[kind] || KIND_LABELS.inconnu;
}

/**
 * Tronque un libelle pour un axe de graphique, en coupant si possible sur une
 * limite de mot : « Boulangerie Martin » vaut mieux que « Boulangerie Mar… ».
 * Le libelle complet reste lisible dans l'info-bulle.
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
function shorten(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const base = space >= Math.floor(max / 2) ? cut.slice(0, space) : cut;
  return base.replace(/[\s.,;:-]+$/, '') + '…';
}

// -----------------------------------------------------------------------------
//  Correspondants internes
// -----------------------------------------------------------------------------

/**
 * Numeros du compte, en forme canonique. Un correspondant qui s'y trouve est
 * un collegue : c'est une ligne Keyyo du parc, vue depuis une autre ligne.
 *
 * Toutes les formes connues d'une ligne sont indexees (CSI, CSI formate, numero
 * presente, poste court) car le CDR peut porter n'importe laquelle des quatre.
 * @returns {Set<string>}
 */
function accountNumbers() {
  const lines = getLines();
  /** @type {Set<string>} */
  const out = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || {};
    const keys = [
      line.e164,
      toE164(line.csi),
      toE164(line.formattedCsi),
      toE164(line.presentedNumber),
      toE164(line.shortNumber),
    ];
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (key && key !== 'anonymous') out.add(String(key));
    }
  }
  return out;
}

/**
 * Un correspondant est interne s'il est joint sur un poste court, ou si son
 * numero est une ligne du compte.
 * @param {any} peer
 * @param {Set<string>} own
 * @returns {boolean}
 */
function isInternal(peer, own) {
  const key = toE164(peer.number);
  if (!key || key === 'anonymous') return false;
  if (numberKind(peer.number) === 'internal') return true;
  return own.has(key);
}

// -----------------------------------------------------------------------------
//  Preparation des donnees
// -----------------------------------------------------------------------------

/**
 * Decore les correspondants de tout ce que le rendu et la recherche demandent,
 * une seule fois par rendu : resoudre le type de numero ou replier un nom dans
 * un comparateur de tri le referait des milliers de fois.
 * @param {any[]} peers  sortie de byPeer
 * @param {Set<string>} own
 * @returns {any[]}
 */
function decorate(peers, own) {
  const out = [];
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i];
    const internal = isInternal(peer, own);
    out.push({
      peer,
      internal,
      // Nom resolu : le numero passe en sous-ligne. Sinon le libelle EST le
      // numero, et la sous-ligne dit de quel type de numero il s'agit.
      sub: peer.name ? formatNumber(peer.number) : kindLabel(peer.number),
      search: fold(peer.label) + ' ' + fold(peer.number),
      // DEUX formes de chiffres, et c'est necessaire : `peer.number` est en
      // E.164 (`+33253359565` -> `33253359565`), alors qu'on cherche un numero
      // tel qu'on le compose ou qu'on le lit sur une carte de visite
      // (`0253359565`). Sans la forme nationale, taper « 0253 » ne trouverait
      // rien — ce que la documentation de `applySearch` promet pourtant.
      digits: digitsOf(peer.number) + ' ' + digitsOf(formatNumber(peer.number)),
    });
  }
  return out;
}

/**
 * Filtre par la recherche. Le texte est cherche dans le nom ET dans le numero ;
 * si la saisie contient des chiffres, ils sont aussi cherches dans le numero
 * debarrasse de sa mise en forme (« 0253 » trouve « 02 53 35 95 65 »).
 * @param {any[]} list
 * @param {string} query
 * @returns {any[]}
 */
function applySearch(list, query) {
  const text = fold(query).trim();
  if (!text) return list;
  const digits = digitsOf(query);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item.search.indexOf(text) >= 0) { out.push(item); continue; }
    if (digits && item.digits.indexOf(digits) >= 0) out.push(item);
  }
  return out;
}

/**
 * Tri. Le second critere est toujours stable et parlant (le volume, puis la
 * fraicheur) pour qu'un ex aequo ne saute pas d'un rendu a l'autre.
 * @param {any[]} list
 * @param {string} key
 * @returns {any[]}
 */
function applySort(list, key) {
  const out = list.slice();
  if (key === 'duration') {
    out.sort((a, b) => (b.peer.seconds - a.peer.seconds) || (b.peer.total - a.peer.total));
  } else if (key === 'missed') {
    out.sort((a, b) => (b.peer.missed - a.peer.missed) || (b.peer.total - a.peer.total));
  } else if (key === 'last') {
    out.sort((a, b) => (b.peer.lastTs - a.peer.lastTs) || (b.peer.total - a.peer.total));
  } else {
    out.sort((a, b) => (b.peer.total - a.peer.total) || (b.peer.lastTs - a.peer.lastTs));
  }
  return out;
}

// -----------------------------------------------------------------------------
//  Fragments de rendu
// -----------------------------------------------------------------------------

/**
 * Barre d'outils : recherche a gauche, tri a droite.
 * Le chevron des `select-pill` de index.html est pose avec une taille en ligne ;
 * aucune classe du contrat ne dimensionne un svg dans `.select-pill`, donc on
 * s'en passe plutot que d'ecrire une valeur visuelle en dur.
 * @returns {string}
 */
function toolbarHtml() {
  const options = [
    { value: 'calls', label: "Nombre d'appels" },
    { value: 'duration', label: 'Durée cumulée' },
    { value: 'missed', label: 'Appels manqués' },
    { value: 'last', label: 'Dernier appel' },
  ];

  let opts = '';
  for (let i = 0; i < options.length; i++) {
    const selected = options[i].value === _sort ? ' selected' : '';
    opts += html`<option value="${options[i].value}"${raw(selected)}>${options[i].label}</option>`;
  }

  const search = html`<div class="field field--grow">
    ${raw(icon('search'))}
    <label class="sr-only" for="peers-search">Rechercher un correspondant</label>
    <input type="search" id="peers-search" value="${_query}" placeholder="Nom ou numéro…" autocomplete="off">
  </div>`;

  const sort = html`<div class="select-pill">
    <label class="sr-only" for="peers-sort">Trier les correspondants</label>
    <select id="peers-sort">${raw(opts)}</select>
  </div>`;

  return toolbar([raw(search), raw('<span class="toolbar-spacer"></span>'), raw(sort)]);
}

/**
 * Les trois indicateurs, calcules sur la liste affichee.
 * @param {any[]} list      liste apres recherche
 * @param {boolean} searching
 * @returns {string}
 */
function kpisHtml(list, searching) {
  let inc = 0, outg = 0, missed = 0, internal = 0;
  for (let i = 0; i < list.length; i++) {
    inc += list[i].peer.in;
    outg += list[i].peer.out;
    missed += list[i].peer.missed;
    if (list[i].internal) internal++;
  }

  // Quand une recherche est active, on le dit sous chaque chiffre : sinon
  // l'ecart avec les totaux des autres vues serait inexplicable.
  const scope = searching ? 'Recherche en cours : périmètre restreint.' : '';

  const distinct = kpi({
    label: 'Correspondants distincts',
    value: fmtInt(list.length),
    foot: internal
      ? 'dont ' + fmtInt(internal) + ' ' + pluralize(internal, 'interne', 'internes')
      : (scope || 'Sur la période et les filtres choisis'),
    why: "Un correspondant est un numéro distinct vu sur la période, tous sens confondus. "
      + "Les appelants masqués sont regroupés en une seule entrée « Masqué » : l'API ne permet pas de les distinguer les uns des autres. "
      + "Un correspondant est compté interne quand il est joint sur un poste court, ou quand son numéro est l'une des lignes du compte."
      + (searching ? ' Le total ne porte que sur les correspondants retenus par la recherche.' : ''),
  });

  const incoming = kpi({
    label: 'Appels entrants reçus',
    value: fmtInt(inc),
    tone: 'in',
    foot: missed
      ? fmtInt(missed) + ' ' + pluralize(missed, 'manqué', 'manqués')
      : (scope || 'Aucun appel manqué'),
    why: "Somme des appels entrants des correspondants listés. "
      + "Un appel manqué est un entrant que personne n'a décroché : l'API Keyyo ne fournit aucun indicateur de décroché, il se déduit d'une durée nulle. "
      + "Les entrants manqués sont donc comptés ici comme les autres."
      + (searching ? ' Le total ne porte que sur les correspondants retenus par la recherche.' : ''),
  });

  const outgoing = kpi({
    label: 'Appels sortants émis',
    value: fmtInt(outg),
    tone: 'out',
    foot: scope || 'Appels composés depuis les lignes du compte',
    why: "Somme des appels sortants vers les correspondants listés, depuis toutes les lignes du compte retenues par les filtres. "
      + "Un appel sans numéro exploitable n'a pas de correspondant : il n'apparaît dans aucun de ces trois chiffres."
      + (searching ? ' Le total ne porte que sur les correspondants retenus par la recherche.' : ''),
  });

  return html`<div class="kpi-grid">${raw(distinct)}${raw(incoming)}${raw(outgoing)}</div>`;
}

/**
 * Histogramme des dix correspondants les plus appeles.
 *
 * ORIENTATION : charts.barChart ne trace que des barres VERTICALES — il n'a pas
 * d'option horizontale, et une liste horizontale se ferait avec ui.rankRow, pas
 * avec un graphique. Le choix impose est donc le vertical, et un nom
 * d'entreprise sous une barre de quelques pixels de large deborde forcement sur
 * ses voisins : les libelles sont tronques a LABEL_MAX caracteres, le nom
 * complet etant porte par l'info-bulle (et par son aria-label).
 *
 * @param {any[]} list  liste apres recherche
 * @returns {string}
 */
function topChart(list) {
  // Toujours par volume d'appels, quel que soit le tri du tableau : c'est ce
  // que le titre du bloc annonce, et un « top 10 » qui change de definition
  // avec un selecteur situe ailleurs serait illisible.
  const byVolume = applySort(list, 'calls').slice(0, TOP_COUNT);

  const data = [];
  for (let i = 0; i < byVolume.length; i++) {
    const item = byVolume[i];
    const label = shorten(item.peer.label, LABEL_MAX);
    const full = String(item.peer.label);
    const parts = [];
    if (label !== full) parts.push(full);
    if (item.internal) parts.push('interne');
    parts.push(fmtInt(item.peer.in) + ' entrants, ' + fmtInt(item.peer.out) + ' sortants');
    data.push({ label, value: item.peer.total, hint: parts.join(' · ') });
  }

  return barChart({
    data,
    height: 240,
    format: (v) => fmtInt(v),
  });
}

/**
 * Une ligne du tableau : tableau de cellules HTML deja sures.
 * @param {any} item
 * @param {number} now  horloge de reference, pour fmtRelative
 * @returns {string[]}
 */
function rowCells(item, now) {
  const peer = item.peer;

  // L'etiquette « Interne » est posee APRES le bloc nom/numero : dans .cell-id
  // (une boite flexible), elle reste alignee sans tronquer le nom.
  const badge = item.internal ? tag('Interne', 'ok') : '';

  const identity = html`<div class="cell-id">
    ${raw(avatar(peer.label, { size: 'sm', tone: item.internal ? 'out' : undefined }))}
    <div class="cell-id-body">
      <div class="cell-id-name">${peer.label}</div>
      <div class="cell-id-sub">${item.sub}</div>
    </div>
    ${raw(badge)}
  </div>`;

  // Un zero n'est pas une information au meme titre qu'un manque : il s'efface.
  const missed = peer.missed
    ? html`${fmtInt(peer.missed)}`
    : html`<span class="faint">0</span>`;

  const last = html`<div class="nowrap">${fmtDate(peer.lastDate)}</div>
    <div class="faint">${fmtRelative(peer.lastTs, now)}</div>`;

  const open = html`<button class="btn btn--ghost btn--sm" type="button"
    data-drill="${peer.number}" aria-label="Ouvrir la fiche de ${peer.label}">Fiche</button>`;

  return [
    identity,
    html`${fmtInt(peer.total)}`,
    html`${fmtInt(peer.in)}`,
    html`${fmtInt(peer.out)}`,
    missed,
    html`${fmtHms(peer.seconds)}`,
    last,
    open,
  ];
}

/**
 * Pied du tableau : position dans la liste et pagination.
 * @param {number} start   index de la premiere ligne affichee
 * @param {number} shown   nombre de lignes affichees
 * @param {number} total   taille de la liste complete
 * @param {number} pages   nombre de pages
 * @returns {string}
 */
function footHtml(start, shown, total, pages) {
  const first = shown ? start + 1 : 0;
  const range = fmtInt(first) + '–' + fmtInt(start + shown);
  const atStart = _pageIndex <= 0;
  const atEnd = _pageIndex >= pages - 1;

  return html`<span>${range} sur ${fmtInt(total)} ${pluralize(total, 'correspondant', 'correspondants')}</span>
    <span class="row">
      <button class="btn btn--sm" type="button" data-step="prev"${raw(atStart ? ' disabled' : '')}>Précédent</button>
      <span class="nowrap muted">Page ${fmtInt(_pageIndex + 1)} sur ${fmtInt(pages)}</span>
      <button class="btn btn--sm" type="button" data-step="next"${raw(atEnd ? ' disabled' : '')}>Suivant</button>
    </span>`;
}

/**
 * Le tableau complet, ou un etat vide quand la recherche ne rend rien.
 * @param {any[]} list
 * @param {boolean} searching
 * @returns {string}
 */
function tableHtml(list, searching) {
  if (!list.length) {
    return searching
      ? empty('Aucun correspondant ne correspond à la recherche', 'Videz le champ de recherche, ou essayez seulement les premiers chiffres du numéro.')
      : empty('Aucun correspondant sur la période', 'Élargissez la période dans le bandeau du haut, ou retirez le filtre de ligne et de sens.');
  }

  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (_pageIndex > pages - 1) _pageIndex = pages - 1;
  if (_pageIndex < 0) _pageIndex = 0;

  const start = _pageIndex * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);
  const now = Date.now();

  const rows = [];
  for (let i = 0; i < slice.length; i++) rows.push(rowCells(slice[i], now));

  return table({
    columns: [
      { key: 'peer', label: 'Correspondant' },
      { key: 'total', label: 'Appels', align: 'right', cls: 'strong' },
      { key: 'in', label: 'Entrants', align: 'right' },
      { key: 'out', label: 'Sortants', align: 'right' },
      { key: 'missed', label: 'Manqués', align: 'right' },
      { key: 'seconds', label: 'Durée cumulée', align: 'right' },
      { key: 'last', label: 'Dernier appel', cls: 'shrink' },
      { key: 'open', label: 'Fiche', cls: 'shrink' },
    ],
    rows,
    minWidth: 960,
    foot: raw(footHtml(start, slice.length, list.length, pages)),
  });
}

/**
 * Bandeaux d'etat de la collecte. Ils comptent particulierement ici : sans
 * annuaire, cette page n'affiche que des numeros.
 * @param {any} st  sortie de status()
 * @returns {string}
 */
function noticesHtml(st) {
  if (st.kind === 'error') {
    return notice({
      tone: 'error',
      title: 'Collecte interrompue.',
      body: html`${st.warning || "La dernière collecte des appels n'a pas abouti. Les correspondants affichés peuvent être incomplets ou plus anciens."}`,
    });
  }
  if (st.kind === 'warn' && st.warning) {
    return notice({
      tone: 'warn',
      title: 'Collecte partielle.',
      body: html`${st.warning}`,
    });
  }
  return '';
}

/** Ossature de chargement : on reserve la place des trois blocs de la page. */
function loadingHtml() {
  return html`<div class="stack">
    ${raw(skeleton('title'))}
    <div class="kpi-grid">${raw(skeleton('card'))}${raw(skeleton('card'))}${raw(skeleton('card'))}</div>
    ${raw(skeleton('card'))}
    ${raw(skeleton('card'))}
    <p class="sr-only" role="status">Chargement des correspondants…</p>
  </div>`;
}

// -----------------------------------------------------------------------------
//  Interactions
// -----------------------------------------------------------------------------

/**
 * Reporte sur le DOM l'etat deplie des indicateurs. ui.kpi rend `aria-expanded`
 * a faux : c'est la page qui bascule la classe ET l'attribut, comme prevu au
 * contrat.
 * @param {HTMLElement} root
 */
function applyKpiState(root) {
  const list = qsa('.kpi', root);
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (el.getAttribute('aria-expanded') === null) continue;   // rien a deplier
    const open = _openKpi.has(i);
    el.classList.toggle('is-open', open);
    el.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

/**
 * Photographie du champ qui a le focus avant un re-rendu. Sans cela, taper dans
 * la recherche perdrait le focus et le curseur au premier re-rendu — le defaut
 * qui rend une recherche temporisee inutilisable.
 * @param {HTMLElement} root
 * @returns {{id: string, start: number|null, end: number|null}|null}
 */
function captureFocus(root) {
  const el = document.activeElement;
  if (!el || el === document.body || !root.contains(el)) return null;
  const id = el.id;
  if (!id) return null;
  const snap = { id, start: null, end: null };
  // selectionStart leve sur certains types de champ (date, number) : la lecture
  // est donc gardee, le focus seul sera restaure.
  try {
    snap.start = /** @type {any} */ (el).selectionStart;
    snap.end = /** @type {any} */ (el).selectionEnd;
  } catch (err) { /* champ sans notion de selection */ }
  return snap;
}

/**
 * Rend le focus (et la position du curseur) au champ photographie.
 * @param {HTMLElement} root
 * @param {{id: string, start: number|null, end: number|null}|null} snap
 */
function restoreFocus(root, snap) {
  if (!snap || !snap.id) return;
  // Les identifiants sont ecrits par ce module : pas de selecteur venu de
  // l'exterieur, donc rien a echapper ici.
  const el = qs('#' + snap.id, root);
  if (!el) return;
  try { el.focus(); } catch (err) { return; }
  if (snap.start === null || snap.start === undefined) return;
  if (typeof (/** @type {any} */ (el).setSelectionRange) !== 'function') return;
  try {
    /** @type {any} */ (el).setSelectionRange(snap.start, snap.end);
  } catch (err) { /* type de champ qui refuse la selection */ }
}

/**
 * Cablage par delegation depuis `root`, UNE SEULE FOIS par section.
 *
 * Les ecouteurs sont poses sur `root`, qui n'est jamais remplace — seul son
 * contenu l'est. Ils survivent donc a tous les rendus suivants, et les reposer
 * les empilerait. C'est le role de `_wired`.
 * @param {HTMLElement} root
 */
function wire(root) {
  if (_wired.has(root)) return;
  _wired.add(root);

  on(root, 'input', '#peers-search', function (ev, el) {
    // La valeur est retenue TOUT DE SUITE : un rafraichissement de fond qui
    // tombe pendant la temporisation doit re-rendre avec la saisie en cours.
    _query = /** @type {any} */ (el).value;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(function () {
      _timer = 0;
      render(root);
    }, SEARCH_DELAY);
  });

  on(root, 'change', '#peers-sort', function (ev, el) {
    const value = String(/** @type {any} */ (el).value || '');
    _sort = SORTS.indexOf(value) >= 0 ? value : 'calls';
    render(root);
  });

  on(root, 'click', '[data-step]', function (ev, el) {
    const step = el.getAttribute('data-step');
    _pageIndex = step === 'prev' ? _pageIndex - 1 : _pageIndex + 1;
    if (_pageIndex < 0) _pageIndex = 0;
    render(root);
    // Le tableau vient d'etre remplace : on ramene la lecture sur son en-tete,
    // sinon on reste au bas de la page precedente.
    const head = qs('.table-wrap', root);
    if (head && typeof head.scrollIntoView === 'function') {
      head.scrollIntoView({ block: 'nearest' });
    }
  });

  on(root, 'click', '[data-drill]', function (ev, el) {
    const number = el.getAttribute('data-drill');
    if (!number) return;
    // C'est app/main.js qui ouvre la modale : la page ne connait que l'evenement.
    document.dispatchEvent(new CustomEvent('keyyo:drill', { detail: { number } }));
  });

  on(root, 'click', '.kpi', function (ev, el) {
    if (el.getAttribute('aria-expanded') === null) return;
    const list = qsa('.kpi', root);
    const i = list.indexOf(/** @type {HTMLElement} */ (el));
    if (i < 0) return;
    if (_openKpi.has(i)) _openKpi.delete(i); else _openKpi.add(i);
    applyKpiState(root);
  });
}

// -----------------------------------------------------------------------------
//  Rendu
// -----------------------------------------------------------------------------

/**
 * Rend la vue Correspondants dans sa section.
 * Idempotente : appelee a chaque changement d'etat du store.
 * @param {HTMLElement} root  section.page[data-page="peers"]
 */
export function render(root) {
  if (!root) return;

  const st = status();
  if (st.kind === 'loading') {
    mount(root, loadingHtml());
    return;
  }

  const rows = filtered();
  const own = accountNumbers();
  const all = decorate(byPeer(rows), own);

  const searching = fold(_query).trim() !== '' || digitsOf(_query) !== '';
  const matched = applySearch(all, _query);
  const list = applySort(matched, _sort);

  // Remise a zero de la pagination des que la liste change de nature. La page
  // courante, elle, ne fait pas partie de la signature : elle survit au
  // rafraichissement de fond.
  const key = [state.from, state.to, state.csi, state.dir, fold(_query).trim(), _sort].join('|');
  if (key !== _listKey) {
    _listKey = key;
    _pageIndex = 0;
  }

  const notices = noticesHtml(st);

  // Aucun appel du tout sur la periode : la barre d'outils n'aurait rien a
  // filtrer, on va droit a l'etat vide et a la piste d'action.
  if (!rows.length) {
    mount(root, html`${raw(notices)}
      ${raw(card({
        body: raw(empty(
          'Aucun appel sur la période',
          'Élargissez la période dans le bandeau du haut, retirez le filtre de ligne et de sens, ou vérifiez la page Diagnostic : jeton, périmètre de lecture et lignes détectées.',
        )),
      }))}`);
    return;
  }

  const chartSub = 'Les ' + fmtInt(Math.min(TOP_COUNT, list.length)) + ' correspondants les plus appelés, par nombre d\'appels'
    + (searching ? ', dans le périmètre de la recherche' : '') + '.';

  const snap = captureFocus(root);

  mount(root, html`${raw(notices)}
    ${raw(toolbarHtml())}
    <div class="stack">
      ${raw(kpisHtml(matched, searching))}
      ${raw(card({
        title: 'Top ' + TOP_COUNT + ' correspondants',
        sub: chartSub,
        body: raw(topChart(matched)),
      }))}
      <div>
        ${raw(sectionHead(
          'Tous les correspondants',
          fmtInt(list.length) + ' ' + pluralize(list.length, 'correspondant distinct', 'correspondants distincts')
            + ' — ' + PAGE_SIZE + ' par page',
        ))}
        ${raw(card({ flush: true, body: raw(tableHtml(list, searching)) }))}
      </div>
    </div>`);

  wire(root);
  applyKpiState(root);
  attachChartTips(root);
  restoreFocus(root, snap);
}
