// =============================================================================
//  app/main.js — Amorcage et coquille de l'application.
//
//  Seul module a connaitre a la fois le routeur, le store, les alertes et les
//  sept pages. Il ne calcule AUCUNE statistique metier : il branche les
//  commandes de index.html sur le store, tient a jour la coquille (pastille
//  d'etat, bandeau d'avertissement, barre de periode, pastille du menu, pied de
//  la barre laterale, bloc de compte), ouvre la fiche correspondant, puis
//  delegue le contenu de chaque vue au module de page correspondant.
//
//  UN SEUL RENDU PAR CHANGEMENT D'ETAT. Le store notifie a chaque filtre
//  modifie et a chaque collecte ; un clic sur un preset en declenche deux coup
//  sur coup (le preset, puis les dates qu'il calcule). Les notifications sont
//  donc regroupees dans une frame d'animation : la vue active n'est
//  reconstruite qu'une fois.
//
//  UNE SEULE VUE RENDUE. Les six autres sections gardent leur DOM precedent,
//  invisible (`.page` sans `.is-active`). Changer de vue ne recalcule que la
//  vue demandee ; revenir en arriere reaffiche immediatement l'ancien rendu,
//  que le rendu suivant remet a jour.
//
//  LE SONDAGE NE PARLE PAS PLUS FORT QUE L'UTILISATEUR. Le rafraichissement
//  automatique est suspendu quand l'onglet est masque (aucun trafic pour un
//  ecran que personne ne regarde) et ne repasse jamais l'interface en
//  « chargement » : c'est le store qui conserve les donnees precedentes.
// =============================================================================

import * as router from './router.js';
import * as alerts from './alerts.js';
import {
  state, setFilter, subscribe, load, status,
  getRows, filtered, getLines, lineByCsi, labelOf, callbackAnalysis,
} from './store.js';
import { qs, qsa, on, html, raw, mount } from './dom.js';
import {
  fmtInt, fmtDate, fmtTime, fmtDuration, fmtDurationShort,
  fmtRelative, fmtClock, fmtPct, pluralize,
} from './format.js';
import { notice, tag, empty } from './ui.js';
import { F, isMissed, isIncoming } from '../shared/schema.js';
import { toE164, formatNumber, numberKind } from '../shared/phone.js';
import { initialsOf, formatCsi } from '../shared/identity.js';

import * as pageMonitoring from './pages/monitoring.js';
import * as pageCalls from './pages/calls.js';
import * as pageMissed from './pages/missed.js';
import * as pagePeers from './pages/peers.js';
import * as pagePeople from './pages/people.js';
import * as pageLines from './pages/lines.js';
import * as pageDiagnostics from './pages/diagnostics.js';

// -----------------------------------------------------------------------------
//  Constantes
// -----------------------------------------------------------------------------

/**
 * Periode du sondage de fond, en millisecondes. Les CDR Keyyo ne sont pas en
 * temps reel (quelques minutes de latence cote operateur) : descendre sous la
 * minute multiplierait les requetes sans rien afficher plus tot.
 */
const POLL_MS = 60000;

/**
 * Periode de rafraichissement de la SEULE pastille d'etat. « il y a 4 min »
 * doit vieillir a l'ecran meme quand aucune collecte n'arrive ; repeindre une
 * pastille ne coute rien, reconstruire une vue si.
 */
const LIVE_TICK_MS = 30000;

/** Nombre d'appels listes dans la fiche correspondant. */
const DRILL_HISTORY_MAX = 60;

/**
 * Delai avant de reposer `hidden` sur le voile de la fiche. Laisse finir la
 * transition d'opacite de components.css, qui dure `--dur` (200 ms).
 */
const DRILL_CLOSE_MS = 260;

/**
 * Rendu de chaque vue, par identifiant de route. Les cles sont EXACTEMENT les
 * `id` de `router.ROUTES`, qui sont aussi les suffixes des `id` de section de
 * index.html.
 * @type {Record<string, (root: HTMLElement) => void>}
 */
const PAGES = {
  monitoring: pageMonitoring.render,
  calls: pageCalls.render,
  missed: pageMissed.render,
  peers: pagePeers.render,
  people: pagePeople.render,
  lines: pageLines.render,
  diagnostics: pageDiagnostics.render,
};

/** Libelles des sens de `state.dir`, pour le resume de la barre de periode. */
const DIR_LABELS = {
  in: 'entrants seulement',
  out: 'sortants seulement',
  missed: 'manqués seulement',
};

/** Nature d'un numero, en francais. Cles : sorties de `numberKind`. */
const KIND_LABELS = {
  anonymous: 'Appelant masqué',
  internal: 'Poste interne',
  mobile: 'Mobile',
  fixe: 'Fixe',
  special: 'Numéro spécial',
  international: 'International',
  inconnu: 'Numéro inconnu',
};

// -----------------------------------------------------------------------------
//  Etat interne de la coquille
// -----------------------------------------------------------------------------

/** Identifiant de la frame de rendu en attente, ou 0. */
let _frame = 0;

/** Identifiant du sondage de fond, ou 0 quand il est suspendu. */
let _poll = 0;

/** Horodatage du dernier `load()` DEMANDE (pas forcement abouti). */
let _lastLoadAt = 0;

/** Vrai pendant un rafraichissement demande explicitement par l'utilisateur. */
let _refreshing = false;

/**
 * Signature des options du filtre de ligne. Reconstruire le `<select>` a chaque
 * rendu refermerait la liste deroulante sous le doigt de l'utilisateur : on ne
 * le refait que quand le parc de lignes a reellement change.
 */
let _lineOptionsKey = '';

/** Correspondant affiche dans la fiche, ou '' quand la fiche est fermee. */
let _drillNumber = '';

/** Element qui avait le focus avant l'ouverture de la fiche. */
let _drillReturnFocus = /** @type {HTMLElement|null} */ (null);

/** Fermeture differee de la fiche, le temps de la transition. */
let _drillCloseTimer = 0;

/**
 * Nombre de rappels en attente, memoise par identite du tableau filtre.
 * `filtered()` etant lui-meme memoise, la meme periode rend le meme tableau :
 * la pastille du menu ne relance donc pas l'analyse a chaque rendu.
 * @type {WeakMap<object, number>}
 */
const _pendingCache = new WeakMap();

// -----------------------------------------------------------------------------
//  Ordonnancement du rendu
// -----------------------------------------------------------------------------

/**
 * Demande un rendu a la prochaine frame. Plusieurs appels dans la meme frame
 * n'en produisent qu'un seul.
 */
function scheduleRender() {
  if (_frame) return;
  _frame = requestAnimationFrame(renderNow);
}

/** Repeint la coquille, puis la seule vue active. */
function renderNow() {
  _frame = 0;

  const st = status();

  paintLive(st);
  paintGlobalNotice(st);
  paintPeriodBar();
  paintNavBadge();
  paintStoreStatus(st);
  paintAccount(st);

  // Les alertes travaillent sur TOUT l'historique connu : un manque n'est pas
  // moins nouveau parce que l'ecran regarde une autre periode. `check` se
  // protege lui-meme des appels repetes sur le meme tableau.
  //
  // MAIS PAS AVANT LA PREMIERE COLLECTE. `alerts.check` retient, a son premier
  // appel, tous les manques qu'il voit, et n'annonce rien : c'est ce qui evite
  // une rafale de notifications sur trois mois d'historique. Lui passer le
  // tableau vide du rendu de chargement consommerait cet apprentissage a vide,
  // et la vraie collecte, arrivant ensuite, serait entierement annoncee.
  if (st.kind !== 'loading' && st.kind !== 'error') alerts.check(getRows());

  // Une fiche ouverte pendant une collecte de fond doit refleter les nouveaux
  // appels du correspondant, sans se refermer sous les yeux de l'utilisateur.
  if (_drillNumber) paintDrill(_drillNumber);

  const id = router.current();
  const root = /** @type {HTMLElement|null} */ (qs('#page-' + id));
  const render = PAGES[id];

  if (!root) {
    console.error('[main] section « #page-' + id + ' » absente de index.html : rien a rendre.');
    return;
  }
  if (typeof render !== 'function') {
    console.error('[main] aucun module de rendu pour la vue « ' + id + ' ».');
    return;
  }

  try {
    render(root);
  } catch (err) {
    // Une page qui plante ne doit pas laisser une section vide sans explication.
    console.error('[main] le rendu de la vue « ' + id + ' » a echoue :', err);
    mount(root, notice({
      tone: 'error',
      title: 'Cette vue n\'a pas pu s\'afficher.',
      body: html`Le détail technique est dans la console du navigateur. Les autres
        vues restent utilisables, et la page Diagnostic indique l'état de la
        collecte. Message : ${messageOf(err)}`,
    }));
  }
}

// -----------------------------------------------------------------------------
//  Coquille — pastille d'etat
// -----------------------------------------------------------------------------

/**
 * Pastille de fraicheur, en haut a droite. Quatre etats seulement, dans le
 * vocabulaire de l'utilisateur : chargement, a jour, collecte partielle,
 * indisponible.
 * @param {ReturnType<typeof status>} st
 */
function paintLive(st) {
  const pill = qs('#live');
  const text = qs('#live-text');
  if (!pill || !text) return;

  let cls = '';
  let label = '';
  let title = '';

  if (_refreshing || st.kind === 'loading') {
    cls = 'is-loading';
    label = 'Chargement…';
    title = 'Collecte en cours auprès de l\'API Keyyo.';
  } else if (st.kind === 'error') {
    cls = 'is-error';
    label = 'Indisponible';
    title = 'La dernière collecte a échoué. Les données affichées peuvent être plus anciennes.';
  } else if (st.kind === 'warn') {
    cls = 'is-warn';
    label = st.empty ? 'Aucun appel' : 'Collecte partielle';
    title = st.warning || 'La collecte est incomplète.';
  } else {
    label = st.at ? fmtRelative(st.at) : 'À jour';
    title = st.at ? 'Dernière collecte à ' + fmtClock(st.at) + '.' : 'Données à jour.';
  }

  pill.classList.toggle('is-loading', cls === 'is-loading');
  pill.classList.toggle('is-warn', cls === 'is-warn');
  pill.classList.toggle('is-error', cls === 'is-error');
  text.textContent = label;
  pill.setAttribute('title', title);
}

// -----------------------------------------------------------------------------
//  Coquille — bandeau d'avertissement
// -----------------------------------------------------------------------------

/**
 * Bandeau global. Il ne dit QUE ce que le store signale : une collecte
 * partielle, une archive absente, une source qui n'a pas repondu. Aucun
 * bandeau quand tout va bien — un avertissement permanent ne serait plus lu.
 * @param {ReturnType<typeof status>} st
 */
function paintGlobalNotice(st) {
  const host = qs('#global-notice');
  if (!host) return;

  if (st.kind === 'loading' || !st.warning) {
    // Ne pas repasser par `mount` quand il n'y a rien a retirer : on evite une
    // ecriture DOM par rendu sur le cas le plus courant.
    if (host.innerHTML !== '') mount(host, '');
    return;
  }

  const tone = st.kind === 'error' ? 'error' : 'warn';
  const title = st.kind === 'error' ? 'Collecte indisponible.' : 'Collecte partielle.';
  // Proposer le diagnostic depuis le diagnostic n'aurait aucun sens.
  const link = router.current() === 'diagnostics'
    ? ''
    : html`<button class="btn btn--ghost btn--sm" type="button" data-goto="diagnostics">Ouvrir le diagnostic</button>`;

  mount(host, notice({
    tone,
    title,
    body: html`${st.warning} ${raw(link)}`,
  }));
}

// -----------------------------------------------------------------------------
//  Coquille — barre de periode
// -----------------------------------------------------------------------------

/** Met les commandes de periode et de filtres en accord avec `state`. */
function paintPeriodBar() {
  const presets = qsa('.periodbar [data-preset]');
  for (let i = 0; i < presets.length; i++) {
    const el = presets[i];
    el.classList.toggle('is-active', String(el.getAttribute('data-preset')) === String(state.preset));
  }

  const from = /** @type {HTMLInputElement|null} */ (qs('#date-from'));
  const to = /** @type {HTMLInputElement|null} */ (qs('#date-to'));
  // On n'ecrit que si la valeur differe : reecrire un `<input type="date">`
  // pendant une saisie replacerait le curseur au debut du champ.
  if (from && from.value !== state.from) from.value = state.from;
  if (to && to.value !== state.to) to.value = state.to;

  paintLineSelect();

  const dir = /** @type {HTMLSelectElement|null} */ (qs('#filter-dir'));
  if (dir && dir.value !== state.dir) dir.value = state.dir;

  paintPeriodInfo();
}

/** Remplit le filtre de ligne, seulement quand le parc a change. */
function paintLineSelect() {
  const select = /** @type {HTMLSelectElement|null} */ (qs('#filter-line'));
  if (!select) return;

  const lines = getLines();
  const key = lines.map((l) => String(l.csi) + '\u0000' + String(l.label)).join('\u0001');

  if (key !== _lineOptionsKey) {
    _lineOptionsKey = key;
    let out = '<option value="">Toutes les lignes</option>';
    for (let i = 0; i < lines.length; i++) {
      out += html`<option value="${lines[i].csi}">${lines[i].label}</option>`;
    }
    select.innerHTML = out;
  }

  // Un CSI venu d'ailleurs (clic sur une carte de ligne, fragment d'URL) n'a
  // pas forcement la forme exacte portee par l'option : on selectionne la ligne
  // reconnue par le store plutot que la chaine brute.
  const line = state.csi ? lineByCsi(state.csi) : null;
  const wanted = line && line.csi ? String(line.csi) : (state.csi ? String(state.csi) : '');
  if (select.value !== wanted) select.value = wanted;
}

/** Resume, a droite de la barre : combien d'appels, sur quelle fenetre. */
function paintPeriodInfo() {
  const host = qs('#period-info');
  if (!host) return;

  const st = status();
  if (st.kind === 'loading') { host.textContent = ''; return; }

  const rows = filtered();
  const parts = [fmtInt(rows.length) + ' ' + pluralize(rows.length, 'appel', 'appels')];
  if (state.from && state.to) parts.push('du ' + fmtDate(state.from) + ' au ' + fmtDate(state.to));

  const line = state.csi ? lineByCsi(state.csi) : null;
  if (line) parts.push(String(line.label));
  if (DIR_LABELS[state.dir]) parts.push(DIR_LABELS[state.dir]);

  host.textContent = parts.join(' · ');
}

// -----------------------------------------------------------------------------
//  Coquille — pastille du menu, pied de barre laterale, bloc de compte
// -----------------------------------------------------------------------------

/**
 * Pastille de « Appels manqués ». Elle compte les correspondants QUI RESTENT A
 * RAPPELER, pas les appels manques : c'est le nombre de choses a faire, et
 * trois manques du meme numero ne forment qu'une seule tache.
 */
function paintNavBadge() {
  const badge = qs('#nav-badge-missed');
  if (!badge) return;

  const rows = filtered();
  let pending = _pendingCache.get(rows);
  if (pending === undefined) {
    pending = callbackAnalysis(rows).pending.length;
    _pendingCache.set(rows, pending);
  }

  if (pending > 0) {
    badge.textContent = fmtInt(pending);
    badge.hidden = false;
    badge.setAttribute(
      'title',
      fmtInt(pending) + ' ' + pluralize(pending, 'correspondant à rappeler', 'correspondants à rappeler')
        + ' sur la période affichée',
    );
  } else {
    badge.hidden = true;
    badge.textContent = '0';
    badge.removeAttribute('title');
  }
}

/**
 * Pied de la barre laterale : etat de l'archive Blob. Le mode direct (sans
 * jeton Blob) fonctionne, mais oublie les appels que Keyyo ne renvoie plus —
 * cela doit se lire, pas se deviner.
 * @param {ReturnType<typeof status>} st
 */
function paintStoreStatus(st) {
  const host = qs('#store-status');
  if (!host) return;

  const store = st.store;
  if (!store) {
    host.textContent = st.kind === 'loading' ? 'Base : —' : 'Base : état inconnu';
    host.removeAttribute('title');
    return;
  }

  if (!store.enabled) {
    host.textContent = 'Base : mode direct (sans mémoire)';
    host.setAttribute(
      'title',
      'Aucun jeton Vercel Blob configuré : les appels sont relus chez Keyyo à chaque '
      + 'collecte, et ceux sortis de sa fenêtre glissante sont perdus.',
    );
    return;
  }

  const total = Number(store.total) || 0;
  let label = 'Base : ' + fmtInt(total) + ' ' + pluralize(total, 'appel', 'appels');
  if (store.lastSavedAt) label += ' · ' + fmtRelative(store.lastSavedAt);
  host.textContent = label;

  const missing = Array.isArray(store.missingMonths) ? store.missingMonths : [];
  host.setAttribute(
    'title',
    missing.length
      ? 'Archive active. Mois encore incomplets : ' + missing.join(', ') + '.'
      : 'Archive active. Les appels sont conservés même quand Keyyo ne les renvoie plus.',
  );
}

/**
 * Bloc de compte, en haut a droite. Il ne porte pas d'identite d'utilisateur :
 * l'outil lit UN compte Keyyo, pas une session par personne. On y met donc ce
 * qui renseigne vraiment — la taille du parc et la profondeur des donnees.
 * @param {ReturnType<typeof status>} st
 */
function paintAccount(st) {
  const sub = qs('#account-sub');
  if (!sub) return;

  if (st.kind === 'loading') { sub.textContent = 'Chargement…'; return; }

  const lines = getLines();
  const meta = st.meta || {};
  const nLines = lines.length;
  const nCalls = Number(meta.n) || 0;

  const parts = [fmtInt(nLines) + ' ' + pluralize(nLines, 'ligne', 'lignes')];
  if (nCalls) parts.push(fmtInt(nCalls) + ' ' + pluralize(nCalls, 'appel', 'appels'));
  if (meta.min) parts.push('depuis le ' + fmtDate(meta.min));

  sub.textContent = parts.join(' · ');
}

// -----------------------------------------------------------------------------
//  Fiche correspondant
// -----------------------------------------------------------------------------

/**
 * Tous les appels connus avec un correspondant, du plus recent au plus ancien.
 *
 * Volontairement pris sur TOUT l'historique (`getRows`) et non sur la periode
 * affichee : on ouvre cette fiche pour decider s'il faut rappeler quelqu'un, et
 * « on s'est parle il y a six semaines » est justement le renseignement utile.
 *
 * @param {string} number correspondant, en E.164 ou sous une forme equivalente.
 * @returns {any[][]}
 */
function rowsForPeer(number) {
  const wanted = String(number == null ? '' : number);
  const canonical = toE164(wanted);
  const out = [];
  const all = getRows();
  for (let i = 0; i < all.length; i++) {
    const peer = String(all[i][F.peer] || '');
    if (peer === wanted || (canonical && peer === canonical)) out.push(all[i]);
  }
  out.sort((a, b) => (Number(b[F.ts]) || 0) - (Number(a[F.ts]) || 0));
  return out;
}

/**
 * Un carreau de la grille d'indicateurs de la fiche.
 * @param {string} label
 * @param {string} value
 * @returns {string}
 */
function drillStat(label, value) {
  return html`<div class="drill-stat">
    <div class="drill-stat-value">${value}</div>
    <div class="drill-stat-label">${label}</div>
  </div>`;
}

/**
 * Corps de la fiche : les indicateurs, puis l'historique des echanges.
 *
 * La colonne de l'heure porte `drill-hide-sm` : sous 560 px, pages.css passe la
 * ligne a trois colonnes et c'est cette colonne-la qui doit disparaitre.
 *
 * @param {any[][]} rows appels du correspondant, du plus recent au plus ancien.
 * @returns {string}
 */
function drillBody(rows) {
  if (!rows.length) {
    return empty(
      'Aucun appel avec ce correspondant',
      'Il n\'apparaît pas dans les données collectées. Élargissez la période, ou vérifiez la page Diagnostic.',
    );
  }

  let inCount = 0;
  let outCount = 0;
  let missedCount = 0;
  let seconds = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    seconds += Number(row[F.seconds]) || 0;
    if (isIncoming(row)) {
      inCount++;
      if (isMissed(row)) missedCount++;
    } else {
      outCount++;
    }
  }
  // Taux de reponse des ENTRANTS, comme partout ailleurs dans l'outil : un
  // sortant sans reponse n'est pas un appel qu'on a rate.
  const rate = inCount ? ((inCount - missedCount) / inCount) * 100 : 0;

  const statsHtml = ''
    + drillStat('appels', fmtInt(rows.length))
    + drillStat('entrants', fmtInt(inCount))
    + drillStat('sortants', fmtInt(outCount))
    + drillStat('manqués', fmtInt(missedCount))
    + drillStat('décrochés', inCount ? fmtPct(rate, 0) : '—')
    + drillStat('au téléphone', fmtDuration(seconds));

  const shown = rows.slice(0, DRILL_HISTORY_MAX);
  let history = '';
  for (let i = 0; i < shown.length; i++) {
    const row = shown[i];
    const missed = isMissed(row);
    const label = missed ? 'Manqué' : (isIncoming(row) ? 'Entrant' : 'Sortant');
    const tone = missed ? 'missed' : (isIncoming(row) ? 'in' : 'out');
    const line = lineByCsi(row[F.csi]);
    const lineLabel = line ? String(line.label) : formatCsi(row[F.csi]);

    history += html`<div class="drill-row">
      <span class="faint">${fmtDate(row[F.date])}</span>
      <span class="drill-hide-sm faint">${fmtTime(row[F.hour], row[F.minute])}</span>
      <span class="grow">${raw(tag(label, tone))} <span class="faint">${lineLabel}</span></span>
      <span>${row[F.answered] === 1 ? fmtDurationShort(row[F.seconds]) : '—'}</span>
    </div>`;
  }

  const hidden = rows.length - shown.length;
  const foot = hidden > 0
    ? html`<p class="faint" style="margin-top: 10px; font: var(--t-micro)">Les
        ${fmtInt(DRILL_HISTORY_MAX)} échanges les plus récents sont affichés ;
        ${fmtInt(hidden)} plus anciens ne le sont pas.</p>`
    : '';

  return html`<div class="drill-stats">${raw(statsHtml)}</div>
    <div class="drill-history">${raw(history)}</div>
    ${raw(foot)}`;
}

/**
 * Ecrit l'en-tete et le corps de la fiche pour un correspondant.
 * Separee de l'ouverture : c'est elle que le rendu rappelle quand une collecte
 * de fond arrive alors que la fiche est deja ouverte.
 * @param {string} number
 */
function paintDrill(number) {
  const rows = rowsForPeer(number);
  const label = labelOf(number);

  const avatarEl = qs('#modal-avatar');
  if (avatarEl) avatarEl.textContent = initialsOf(label);

  const titleEl = qs('#modal-title');
  if (titleEl) titleEl.textContent = label;

  const subEl = qs('#modal-sub');
  if (subEl) {
    const parts = [KIND_LABELS[numberKind(number)] || KIND_LABELS.inconnu];
    // Quand un nom a ete resolu, il occupe le titre : il faut alors montrer le
    // numero, sinon la fiche ne dit plus qui on rappelle.
    const pretty = formatNumber(number);
    if (pretty && pretty !== label) parts.push(pretty);
    if (rows.length) parts.push('dernier échange le ' + fmtDate(rows[0][F.date]));
    subEl.textContent = parts.join(' · ');
  }

  const content = qs('#modal-content');
  if (content) mount(content, drillBody(rows));
}

/**
 * Ouvre la fiche d'un correspondant.
 *
 * Le voile porte `hidden` dans index.html : il faut le retirer AVANT d'ajouter
 * `is-open`, puis forcer un calcul de style, sinon le navigateur passe de
 * « pas de boite » a « boite opaque » sans etat intermediaire et la transition
 * ne joue pas. Meme mecanique que le tiroir de navigation du routeur.
 *
 * @param {string} number
 */
function openDrill(number) {
  const key = String(number == null ? '' : number);
  if (!key) return;

  const scrim = qs('#modal-scrim');
  if (!scrim) return;

  if (_drillCloseTimer) { clearTimeout(_drillCloseTimer); _drillCloseTimer = 0; }

  _drillNumber = key;
  paintDrill(key);

  // On ne retient le focus a rendre que la premiere fois : ouvrir une fiche
  // depuis une fiche deja ouverte ne doit pas renvoyer dans la modale.
  if (!_drillReturnFocus) {
    const active = /** @type {any} */ (document.activeElement);
    _drillReturnFocus = active && active !== document.body ? active : null;
  }

  scrim.hidden = false;
  void /** @type {HTMLElement} */ (scrim).offsetWidth;
  scrim.classList.add('is-open');

  const close = /** @type {HTMLElement|null} */ (qs('#modal-close'));
  if (close && typeof close.focus === 'function') close.focus();
}

/** Ferme la fiche et rend le focus a l'element qui l'avait ouverte. */
function closeDrill() {
  if (!_drillNumber) return;
  _drillNumber = '';

  const scrim = qs('#modal-scrim');
  if (scrim) {
    scrim.classList.remove('is-open');
    // `hidden` n'est repose qu'apres la transition d'opacite : le poser tout de
    // suite ferait disparaitre la fiche d'un coup. Si l'utilisateur rouvre une
    // fiche entre-temps, `openDrill` annule ce minuteur.
    _drillCloseTimer = setTimeout(function () {
      _drillCloseTimer = 0;
      if (!_drillNumber) scrim.hidden = true;
    }, DRILL_CLOSE_MS);
  }

  // Le bouton qui avait ouvert la fiche vit dans le DOM d'une page, que le
  // sondage de fond remplace toutes les 60 s : il a donc de bonnes chances
  // d'avoir disparu. Sans repli, le focus retomberait sur <body> et la
  // navigation au clavier repartirait du haut du document.
  const back = _drillReturnFocus;
  _drillReturnFocus = null;
  const alive = back && typeof back.focus === 'function'
    && document.contains(back) && back.offsetParent !== null;
  const target = alive ? back : qs('#page-' + router.current());
  if (target && typeof target.focus === 'function') {
    // Une section n'est pas focalisable par defaut : on la rend cible de
    // programme seulement, sans l'inserer dans l'ordre de tabulation.
    if (target !== back) target.setAttribute('tabindex', '-1');
    target.focus();
  }
}

// -----------------------------------------------------------------------------
//  Cablage de la coquille
// -----------------------------------------------------------------------------

/** Cable, une fois pour toutes, les commandes statiques de index.html. */
function wireShell() {
  // -- Barre de periode ---------------------------------------------------
  const bar = qs('#periodbar');
  if (bar) {
    on(bar, 'click', '[data-preset]', function (ev, el) {
      const preset = el.getAttribute('data-preset') || '';
      // `preset` seul, sans `from`/`to` : le store recalcule la fenetre et la
      // laisse « vivante » (elle suivra la derniere date connue des donnees).
      setFilter({ preset: preset === 'all' ? 'all' : Number(preset) });
    });

    on(bar, 'change', '#date-from', function (ev, el) {
      setFilter({ from: /** @type {any} */ (el).value });
    });
    on(bar, 'change', '#date-to', function (ev, el) {
      setFilter({ to: /** @type {any} */ (el).value });
    });
    on(bar, 'change', '#filter-line', function (ev, el) {
      setFilter({ csi: /** @type {any} */ (el).value });
    });
    on(bar, 'change', '#filter-dir', function (ev, el) {
      setFilter({ dir: /** @type {any} */ (el).value });
    });
  }

  // -- Rafraichissement manuel --------------------------------------------
  const refresh = qs('#btn-refresh');
  if (refresh) on(refresh, 'click', function () { manualRefresh(); });

  // -- Renvoi vers une autre vue (bouton du bandeau global) ---------------
  on(document, 'click', '[data-goto]', function (ev, el) {
    const target = el.getAttribute('data-goto') || '';
    if (target) router.go(target);
  });

  // -- Fiche correspondant ------------------------------------------------
  // Les pages ne connaissent que l'evenement : c'est ici, et seulement ici,
  // que la modale de index.html est manipulee.
  document.addEventListener('keyyo:drill', function (ev) {
    const detail = /** @type {any} */ (ev).detail || {};
    openDrill(String(detail.number == null ? '' : detail.number));
  });

  const close = qs('#modal-close');
  if (close) on(close, 'click', function () { closeDrill(); });

  const scrim = qs('#modal-scrim');
  if (scrim) {
    on(scrim, 'click', function (ev) {
      // Un clic DANS la fiche ne doit pas la fermer : seul le voile lui-meme.
      if (/** @type {any} */ (ev).target === scrim) closeDrill();
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && _drillNumber) closeDrill();
  });
}

/** Rafraichissement demande par l'utilisateur : force le cache, et se voit. */
function manualRefresh() {
  if (_refreshing) return;
  const btn = /** @type {HTMLButtonElement|null} */ (qs('#btn-refresh'));

  _refreshing = true;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  paintLive(status());

  _lastLoadAt = Date.now();
  load({ force: true })
    .catch(function (err) {
      console.error('[main] le rafraichissement a echoue :', err);
      alerts.toast({
        title: 'Rafraîchissement impossible',
        sub: messageOf(err),
        tone: 'error',
      });
    })
    .finally(function () {
      _refreshing = false;
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
      scheduleRender();
    });
}

// -----------------------------------------------------------------------------
//  Sondage de fond
// -----------------------------------------------------------------------------

/** Une collecte de fond, silencieuse. */
function tick() {
  if (document.hidden) return;
  _lastLoadAt = Date.now();
  load().catch(function (err) {
    // Le store a deja consigne l'echec dans son statut, que la coquille
    // affichera au prochain rendu : inutile d'interrompre l'utilisateur.
    console.warn('[main] collecte de fond sans succes :', err);
  });
}

function startPoll() {
  stopPoll();
  if (document.hidden) return;
  _poll = setInterval(tick, POLL_MS);
}

function stopPoll() {
  if (_poll) { clearInterval(_poll); _poll = 0; }
}

/**
 * Retour de l'onglet au premier plan : on rattrape tout de suite le temps passe
 * en arriere-plan, puis on relance le sondage. Sans ce rattrapage, l'ecran
 * afficherait des donnees vieilles de plusieurs heures pendant une minute
 * entiere.
 */
function onVisibility() {
  if (document.hidden) { stopPoll(); return; }
  if (Date.now() - _lastLoadAt >= POLL_MS) tick();
  else scheduleRender();          // au minimum, rafraichir « il y a X min »
  startPoll();
}

// -----------------------------------------------------------------------------
//  Divers
// -----------------------------------------------------------------------------

/** @param {unknown} err @returns {string} message lisible, jamais vide. */
function messageOf(err) {
  if (!err) return 'erreur inconnue';
  const msg = /** @type {any} */ (err).message;
  return typeof msg === 'string' && msg ? msg : String(err);
}

// -----------------------------------------------------------------------------
//  Amorcage
// -----------------------------------------------------------------------------

/**
 * Sequence d'amorcage, dans cet ordre :
 *
 *  1. les alertes, pour que les preferences (son, notifications) soient
 *     restaurees avant tout rendu et que les interrupteurs ne clignotent pas ;
 *  2. la coquille, pour qu'un clic pendant le premier chargement soit deja pris ;
 *  3. le routeur, qui applique la vue portee par l'URL et la fait rendre en
 *     etat « chargement » ;
 *  4. l'abonnement au store, puis la premiere collecte ;
 *  5. le sondage de fond et le vieillissement de la pastille d'etat.
 */
export function boot() {
  alerts.init();
  wireShell();

  router.start(function (id) {
    // Les pages lisent la vue courante dans `state.page` (people.js s'en sert
    // pour revenir en arriere) : le store doit la connaitre.
    setFilter({ page: id });
    scheduleRender();
  });

  subscribe(scheduleRender);

  document.addEventListener('visibilitychange', onVisibility);

  // Vieillissement de la seule pastille : « il y a 4 min » doit avancer sans
  // reconstruire la vue.
  setInterval(function () {
    if (!document.hidden) paintLive(status());
  }, LIVE_TICK_MS);

  _lastLoadAt = Date.now();
  load().catch(function (err) {
    console.error('[main] la premiere collecte a echoue :', err);
  });

  startPoll();
}

// Le script est charge en module : il s'execute apres l'analyse du document,
// `defer` etant implicite. La coquille de index.html est donc deja en place.
//
// L'amorcage est conditionne a la PRESENCE DE LA COQUILLE. Hors de index.html
// (selftest.html, qui importe ce module pour verifier qu'il se charge), il n'y
// a ni section a rendre ni barre a cabler : demarrer n'y produirait que des
// erreurs de console et une collecte inutile aupres de l'API.
if (qs('#page-monitoring')) {
  boot();
} else {
  console.info('[main] coquille absente : amorcage ignore. Appeler boot() explicitement si besoin.');
}
