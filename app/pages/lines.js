// =============================================================================
//  app/pages/lines.js — Vue « Lignes Keyyo » : l'INVENTAIRE TECHNIQUE du compte.
//
//  Toutes les autres vues racontent l'usage. Celle-ci raconte le PARC : ce que
//  Keyyo declare (lignes, offres, statuts, options, postes internes), qu'il y
//  ait eu des appels ou non. C'est ce decalage qui l'interesse : une ligne
//  declaree, en service, et pourtant muette sur trois mois est un signal — soit
//  personne ne s'en sert, soit la collecte n'a pas tout ramene pour elle. La
//  page dit les deux hypotheses et donne le moyen de trancher (bloc
//  « Couverture de la collecte »).
//
//  Trois conventions du projet, appliquees ici :
//
//   1. Rendu par chaines. Tout fragment se construit avec le gabarit `html` de
//      dom.js, qui echappe ce qu'on interpole. Une brique de ui.js ou charts.js
//      renvoie une CHAINE : elle doit donc etre remise dans un gabarit via
//      `raw()`, sinon son balisage s'afficherait en texte. Chaque `raw()` de ce
//      fichier porte sur du balisage produit par notre propre code.
//
//   2. Aucun appel reseau. La page lit le store, jamais app/api.js. Les seules
//      URL qu'elle manipule sont des liens que l'UTILISATEUR ouvre lui-meme
//      (/api/sync, /api/health) : la vue ne declenche aucune collecte.
//
//   3. Delegation depuis la racine. `render` est rappelee a chaque changement
//      d'etat et remonte tout le contenu ; les ecouteurs, eux, sont poses UNE
//      SEULE FOIS sur la section (voir `wire`).
// =============================================================================

import { html, raw, mount, on } from '../dom.js';
import { fmtInt, fmtDate, fmtMonth, fmtRelative, pluralize } from '../format.js';
import { card, sectionHead, kpi, table, tag, avatar, split, empty, notice, skeleton } from '../ui.js';
import { barChart, attachChartTips } from '../charts.js';
import { state, status, getLines, getRows, filtered, byLine, byMonth, stats, setFilter, lineByCsi } from '../store.js';
import { toE164 } from '../../shared/phone.js';
import { formatCsi, isPhoneCsi } from '../../shared/identity.js';

// -----------------------------------------------------------------------------
//  Constantes de la vue
// -----------------------------------------------------------------------------

/**
 * Traduction des statuts de ligne renvoyes par l'API Manager. Un statut absent
 * de cette table s'affiche TEL QUEL en ton neutre : une valeur inconnue est une
 * information (l'API a evolue), la masquer serait mentir sur l'etat du parc.
 */
const STATUS_MAP = {
  in_service: { label: 'En service', tone: 'ok' },
  suspended: { label: 'Suspendue', tone: 'missed' },
  setup_pending: { label: "En cours d'installation", tone: 'neutral' },
  cancelled: { label: 'Résiliée', tone: 'missed' },
  cancellation_pending: { label: 'Résiliation en cours', tone: 'in' },
};

/** Au-dela, l'histogramme des lignes devient illisible. */
const MAX_BARS = 24;

/** Options commerciales affichees en etiquettes avant le compteur « +N ». */
const MAX_OPTION_TAGS = 4;

/** Lignes muettes nommees dans le bandeau avant le « et N autres ». */
const MAX_SILENT_NAMED = 6;

/**
 * Un mois plein qui tombe sous cette fraction du meilleur mois plein est
 * signale comme anormalement creux. Seuil volontairement bas : mieux vaut ne
 * rien dire qu'alerter sur une simple baisse d'activite.
 */
const THIN_RATIO = 0.35;

/** Racines deja cablees : voir `wire`. */
const _wired = new WeakSet();

// -----------------------------------------------------------------------------
//  Outils
// -----------------------------------------------------------------------------

/** @param {unknown} v @returns {string} chiffres seuls, forme de comparaison des CSI. */
function digitsOf(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

/**
 * Libelle et ton d'un statut de ligne.
 * @param {unknown} value
 * @returns {{label: string, tone: string}}
 */
function statusOf(value) {
  const key = String(value == null ? '' : value).trim();
  if (!key) return { label: 'Statut non renseigné', tone: 'neutral' };
  // hasOwnProperty : `key` vient de l'API, et une cle comme « constructor »
  // remonterait un objet du prototype au lieu d'un libelle.
  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, key)) return STATUS_MAP[key];
  return { label: key, tone: 'neutral' };
}

/** @param {any} line @returns {boolean} */
function isInService(line) {
  return String(line && line.status ? line.status : '') === 'in_service';
}

/**
 * Activite par ligne, indexee par CSI en chiffres seuls : le CSI du parc et
 * celui porte par les lignes d'appel n'ont pas toujours la meme ponctuation.
 * @param {any[][]} rows
 * @returns {Map<string, any>}
 */
function callsIndex(rows) {
  const list = byLine(rows);
  const map = new Map();
  for (let i = 0; i < list.length; i++) {
    const key = digitsOf(list[i].csi);
    if (key && !map.has(key)) map.set(key, list[i]);
  }
  return map;
}

/** @param {Map<string, any>} index @param {any} line @returns {any|null} */
function entryFor(index, line) {
  if (!line) return null;
  return index.get(digitsOf(line.csi))
    || index.get(digitsOf(line.formattedCsi))
    || null;
}

/**
 * Ligne actuellement isolee par le filtre de periode, ou `null`.
 * @returns {any|null}
 */
function selectedLine() {
  if (!state.csi) return null;
  const hit = lineByCsi(state.csi);
  if (hit) return hit;
  // Filtre pose sur une ligne absente du parc : on l'annonce quand meme, sinon
  // les compteurs paraitraient anormalement bas sans raison visible.
  return { csi: String(state.csi), label: formatCsi(state.csi) };
}

/** @returns {string} periode affichee, en clair. */
function periodLabel() {
  if (!state.from || !state.to) return 'Toute la période collectée';
  return fmtDate(state.from) + ' → ' + fmtDate(state.to);
}

/** @param {number} n @returns {string} « 12 appels », « 1 appel ». */
function callCount(n) {
  return fmtInt(n) + ' ' + pluralize(n, 'appel', 'appels');
}

// -----------------------------------------------------------------------------
//  Bandeaux d'etat
// -----------------------------------------------------------------------------

/**
 * Bandeau de collecte. Le message vient de l'API : il passe donc par le
 * gabarit `html` avant d'entrer dans `notice.body`, qui insere du HTML brut.
 * @param {any} st  Retour de `status()`.
 * @returns {string}
 */
function collectBanner(st) {
  if (st.kind === 'error') {
    const message = st.warning || 'La dernière requête vers /api/calls a échoué.';
    return notice({
      tone: 'error',
      title: 'Collecte indisponible.',
      body: html`${message} L’inventaire ci-dessous reste celui du dernier chargement réussi : il peut être plus ancien que la réalité du parc.`,
    });
  }
  if (st.kind === 'warn' && st.warning) {
    return notice({ tone: 'warn', title: 'Collecte partielle.', body: html`${st.warning}` });
  }
  return '';
}

/**
 * Aucune ligne dans le parc : c'est presque toujours un probleme de perimetre
 * de jeton, pas un compte vide. On dit quoi verifier, dans l'ordre.
 * @returns {string}
 */
function noLinesNotice() {
  return notice({
    tone: 'warn',
    title: 'Aucune ligne Keyyo détectée.',
    body: html`L’API n’a renvoyé aucun service <code>UCaaSVoIPAccount</code> pour ce compte.
      Vérifiez dans l’ordre : le compte visé par le jeton, puis sa portée de lecture
      (<code>full_access_read_only</code> est nécessaire pour lister les services).
      La page <a class="link" href="/api/health?deep=1" target="_blank" rel="noopener">/api/health?deep=1</a>
      indique laquelle des requêtes Keyyo répond et laquelle est refusée.`,
  });
}

/**
 * Filtre de ligne actif : tous les compteurs « sur la période » ne portent
 * alors que cette ligne. On le dit avant que l'utilisateur ne lise des zeros.
 * @param {any|null} selected
 * @returns {string}
 */
function filterNotice(selected) {
  if (selected) {
    return notice({
      tone: 'info',
      title: 'Filtre de ligne actif.',
      body: html`La colonne « Appels sur la période », l’histogramme et la répartition ne comptent
        que la ligne <strong>${selected.label}</strong> — les autres lignes apparaissent donc à zéro.
        <button class="link" type="button" data-line-clear="1">Afficher toutes les lignes</button>`,
    });
  }

  // Le filtre de SENS fausse tout autant les compteurs de cette vue : une ligne
  // qui n'emet que des sortants tombe a zero sous « entrants seulement ». Le
  // dire, plutot que de laisser lire un parc a moitie eteint.
  const dirs = { in: 'entrants', out: 'sortants', missed: 'manqués' };
  if (dirs[state.dir]) {
    return notice({
      tone: 'info',
      title: 'Filtre de sens actif.',
      body: html`La colonne « Appels sur la période », l’histogramme et la répartition ne comptent
        que les appels ${dirs[state.dir]} : une ligne peut donc apparaître à zéro alors qu’elle
        travaille dans l’autre sens. Choisissez « Entrants et sortants » dans le bandeau du haut
        pour voir le parc entier.`,
    });
  }
  return '';
}

/**
 * Lignes declarees sans aucun appel : le signal central de cette vue.
 * Masque quand un filtre de ligne est actif, ou il n'aurait aucun sens.
 * @param {any[]} lines
 * @param {Map<string, any>} index
 * @param {any|null} selected
 * @returns {string}
 */
function silentNotice(lines, index, selected) {
  // `index` est construit sur `filtered()`, qui applique AUSSI le filtre de
  // sens. Avec « entrants seulement », une ligne exclusivement sortante
  // paraitrait muette alors qu'elle travaille : on se tait plutot que
  // d'accuser a tort. Le filtre de ligne, lui, rendait deja l'alerte absurde.
  if (selected || state.dir) return '';

  const names = [];
  for (let i = 0; i < lines.length; i++) {
    const entry = entryFor(index, lines[i]);
    if (!entry || !entry.total) names.push(String(lines[i].label || lines[i].csi || '—'));
  }
  if (!names.length) return '';

  const shown = names.slice(0, MAX_SILENT_NAMED);
  const rest = names.length - shown.length;
  const list = shown.join(', ') + (rest > 0 ? ' et ' + fmtInt(rest) + ' ' + pluralize(rest, 'autre', 'autres') : '');
  const title = fmtInt(names.length) + ' '
    + pluralize(names.length, 'ligne déclarée', 'lignes déclarées')
    + ' sans aucun appel sur la période.';

  return notice({
    tone: 'warn',
    title,
    body: html`${list}. Deux explications possibles, et une seule façon de trancher :
      le poste ne sert pas, ou la collecte n’a pas ramené ses appels. Le bloc
      « Couverture de la collecte », en bas de page, montre le volume archivé mois par mois.`,
  });
}

// -----------------------------------------------------------------------------
//  Indicateurs
// -----------------------------------------------------------------------------

/**
 * Les trois indicateurs de tete. Chacun porte son `why` : le clic revele
 * comment le chiffre est obtenu (bascule cablee dans `wire`).
 * @param {any[]} lines
 * @param {Map<string, any>} index
 * @returns {string}
 */
function kpiRow(lines, index) {
  let inService = 0;
  let withCalls = 0;
  for (let i = 0; i < lines.length; i++) {
    if (isInService(lines[i])) inService++;
    const entry = entryFor(index, lines[i]);
    if (entry && entry.total > 0) withCalls++;
  }
  const silent = lines.length - withCalls;

  const first = kpi({
    label: 'Lignes suivies',
    value: fmtInt(lines.length),
    foot: 'Parc déclaré par Keyyo, usage mis à part',
    why: 'Toutes les lignes de type UCaaSVoIPAccount rattachées au compte, complétées par les lignes'
      + ' rencontrées dans les relevés d’appels mais absentes de la liste des services.',
  });

  const second = kpi({
    label: 'Lignes en service',
    value: fmtInt(inService),
    tone: 'ok',
    foot: fmtInt(lines.length - inService) + ' hors service ou en cours',
    why: 'Lignes dont le statut Keyyo vaut in_service. Les lignes suspendues, en cours'
      + ' d’installation, en cours de résiliation ou résiliées en sont exclues.',
  });

  const third = kpi({
    label: 'Lignes avec appels sur la période',
    value: fmtInt(withCalls),
    tone: silent > 0 ? 'missed' : 'ok',
    foot: silent > 0
      ? fmtInt(silent) + ' ' + pluralize(silent, 'ligne muette', 'lignes muettes') + ' sur la période'
      : 'Toutes les lignes du parc ont servi',
    why: 'Lignes portant au moins un appel sur la période affichée. L’écart avec le parc déclaré'
      + ' désigne des postes inutilisés — ou une collecte incomplète pour ces lignes.',
  });

  return first + second + third;
}

// -----------------------------------------------------------------------------
//  Tableau du parc
// -----------------------------------------------------------------------------

/**
 * Cellule « Numéro ». Le numero d'une ligne est aussi un correspondant possible
 * (appels internes) : on ouvre sa fiche via l'evenement `keyyo:drill`.
 * @param {unknown} value  `formattedCsi` sinon `csi`.
 * @returns {string}
 */
function numberCell(value) {
  // Un CSI n'est pas toujours un numero : un poste Keyyo Phone s'identifie par
  // `rqepz@kphone`. On l'affiche alors tel quel, et sans lien — il n'y a pas de
  // fiche correspondant a ouvrir pour un identifiant de terminal.
  const shown = formatCsi(value);
  const key = isPhoneCsi(value) ? toE164(value) : '';
  if (!key || key === 'anonymous') return html`<span class="nowrap mono">${shown}</span>`;
  return html`<button class="link nowrap" type="button" data-drill="${key}"
    title="Ouvrir la fiche de ce numéro">${shown}</button>`;
}

/**
 * Cellule « Options » : les options commerciales de la ligne, en etiquettes.
 * @param {unknown} options
 * @returns {string}
 */
function optionsCell(options) {
  const list = [];
  if (Array.isArray(options)) {
    for (let i = 0; i < options.length; i++) {
      const label = String(options[i] == null ? '' : options[i]).trim();
      if (label) list.push(label);
    }
  }
  if (!list.length) return html`<span class="muted">—</span>`;

  let tags = '';
  const shown = list.slice(0, MAX_OPTION_TAGS);
  for (let i = 0; i < shown.length; i++) tags += tag(shown[i], 'neutral');
  const rest = list.length - shown.length;
  if (rest > 0) tags += html`<span class="muted nowrap">+${rest}</span>`;

  return html`<div class="row row--wrap">${raw(tags)}</div>`;
}

/**
 * Cellule « Collaborateur » : l'identite resolue cote serveur, avec l'indice
 * qui l'a produite (email connu, ou nom de la regle de rapprochement).
 * @param {any} line
 * @returns {string}
 */
function personCell(line) {
  const person = line && line.person ? line.person : null;
  if (!person || !person.displayName) {
    return html`<span class="muted nowrap">Non rapproché</span>`;
  }
  const sub = person.email
    ? String(person.email)
    : 'rapproché par ' + String(person.source || 'règle non précisée');

  return html`<div class="cell-id">
    ${raw(avatar(person.displayName, { size: 'sm' }))}
    <div class="cell-id-body">
      <div class="cell-id-name">${person.displayName}</div>
      <div class="cell-id-sub truncate">${sub}</div>
    </div>
  </div>`;
}

/**
 * Cellule « Appels sur la période ». Le bouton porte le compteur : c'est le
 * seul moyen de rendre la ligne actionnable, `ui.table` ne posant rien sur le
 * <tr> — et un bouton reste atteignable au clavier.
 * @param {any} line
 * @param {number} count
 * @param {boolean} isSelected
 * @returns {string}
 */
function callsCell(line, count, isSelected) {
  const csi = String(line && line.csi ? line.csi : '');
  if (!csi) return html`<span class="tnum">${fmtInt(count)}</span>`;
  const action = isSelected
    ? 'Retirer le filtre sur cette ligne'
    : 'Filtrer la période sur cette ligne';

  return html`<button class="btn btn--sm" type="button" data-line-select="${csi}"
    aria-pressed="${isSelected ? 'true' : 'false'}" title="${action}"
    ><span class="sr-only">${action} — </span>${fmtInt(count)}</button>`;
}

/**
 * Le tableau principal : une ligne Keyyo par rangee.
 * @param {any[]} lines
 * @param {Map<string, any>} index
 * @param {any|null} selected
 * @returns {string}
 */
function linesTable(lines, index, selected) {
  const selectedKey = selected ? digitsOf(selected.csi) : '';
  const rows = [];
  let inService = 0;
  let totalCalls = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const entry = entryFor(index, line);
    const count = entry ? entry.total : 0;
    const st = statusOf(line.status);
    if (isInService(line)) inService++;
    totalCalls += count;

    rows.push([
      html`<span class="mono">${line.csi ? line.csi : '—'}</span>`,
      numberCell(line.formattedCsi || line.csi),
      html`${line.name ? line.name : '—'}`,
      html`<span class="mono">${line.shortNumber ? line.shortNumber : '—'}</span>`,
      html`${line.offerName ? line.offerName : '—'}`,
      tag(st.label, st.tone),
      optionsCell(line.options),
      personCell(line),
      callsCell(line, count, !!selectedKey && selectedKey === digitsOf(line.csi)),
    ]);
  }

  const foot = html`<span>${fmtInt(lines.length) + ' ' + pluralize(lines.length, 'ligne', 'lignes')}
      · ${fmtInt(inService)} en service</span>
    <span>${callCount(totalCalls)} sur la période affichée</span>`;

  return table({
    minWidth: 1240,
    foot: raw(foot),
    columns: [
      { key: 'csi', label: 'CSI', cls: 'shrink' },
      { key: 'number', label: 'Numéro' },
      { key: 'name', label: 'Nom de ligne' },
      { key: 'short', label: 'Poste interne', cls: 'shrink' },
      { key: 'offer', label: 'Offre' },
      { key: 'status', label: 'Statut', cls: 'shrink' },
      { key: 'options', label: 'Options' },
      { key: 'person', label: 'Collaborateur' },
      { key: 'calls', label: 'Appels sur la période', align: 'right' },
    ],
    rows,
  });
}

// -----------------------------------------------------------------------------
//  Activite par ligne
// -----------------------------------------------------------------------------

/**
 * Histogramme des appels par ligne, la plus chargee d'abord.
 * @param {any[][]} rows
 * @returns {string}
 */
function activityChart(rows) {
  const list = byLine(rows);
  if (!list.length) {
    return empty('Aucun appel à répartir', 'Aucune ligne du parc ne porte d’appel sur cette période.');
  }

  const data = [];
  const limit = Math.min(list.length, MAX_BARS);
  for (let i = 0; i < limit; i++) {
    const entry = list[i];
    data.push({
      label: entry.label,
      value: entry.total,
      hint: fmtInt(entry.missed) + ' ' + pluralize(entry.missed, 'manqué', 'manqués'),
    });
  }

  const more = list.length - limit;
  const note = more > 0
    ? html`<p class="muted">${fmtInt(more) + ' ' + pluralize(more, 'ligne', 'lignes')} de moindre volume ne sont pas représentées ici ; le tableau ci-dessus les liste toutes.</p>`
    : '';

  return html`${raw(barChart({ data, height: 260, format: fmtInt }))}${raw(note)}`;
}

/**
 * Repartition des appels de la selection courante.
 *
 * Les trois parts forment une vraie partition du total : un appel manque EST un
 * entrant non decroche, on ne peut donc pas aligner « entrants », « sortants »
 * et « manques » sans compter deux fois. On separe donc les entrants decroches
 * des entrants manques.
 * @param {any} s  Retour de `stats()`.
 * @returns {string}
 */
function splitBlock(s) {
  const answeredIn = Math.max(0, s.in - s.missed);
  const total = s.total;
  const parts = [
    { label: 'Entrants décrochés', value: answeredIn, tone: 'ok' },
    { label: 'Sortants', value: s.out, tone: 'out' },
    { label: 'Entrants manqués', value: s.missed, tone: 'missed' },
  ];

  let bars = '';
  for (let i = 0; i < parts.length; i++) {
    bars += split({
      label: parts[i].label,
      value: callCount(parts[i].value),
      pct: total > 0 ? (parts[i].value / total) * 100 : 0,
      tone: parts[i].tone,
    });
  }

  return html`<div class="stack">
    <div class="splits">${raw(bars)}</div>
    <p class="muted">Les trois parts additionnées font le total des appels. Un appel manqué est un
      entrant de durée nulle : l’API Keyyo ne fournit aucun indicateur de décroché, c’est la durée
      qui en tient lieu.</p>
  </div>`;
}

/**
 * Le bloc « Activite par ligne » : histogramme a gauche, repartition a droite.
 * @param {any[][]} rows
 * @param {any|null} selected
 * @returns {string}
 */
function activitySection(rows, selected) {
  const head = sectionHead('Activité par ligne', periodLabel());

  if (!rows.length) {
    const body = empty(
      'Aucun appel sur la période sélectionnée',
      'Élargissez la période (« 3 mois » ou « Tout »), retirez le filtre de ligne, ou complétez un mois manquant depuis « Couverture de la collecte » ci-dessous.',
    );
    return html`${raw(head)}${raw(card({ body: raw(body) }))}`;
  }

  const s = stats(rows);
  const scope = selected ? String(selected.label) : 'Toutes les lignes';

  const left = card({
    title: 'Appels par ligne',
    sub: 'Volume total sur la période, la ligne la plus chargée en premier',
    body: raw(activityChart(rows)),
  });
  const right = card({
    title: 'Répartition',
    sub: scope + ' · ' + callCount(s.total),
    body: raw(splitBlock(s)),
  });

  return html`${raw(head)}<div class="grid-split">${raw(left)}${raw(right)}</div>`;
}

// -----------------------------------------------------------------------------
//  Couverture de la collecte
// -----------------------------------------------------------------------------

/**
 * Mois a rendre compte, du plus recent au plus ancien.
 *
 * L'union de `meta.months` (les mois qui portent des appels) et de
 * `store.missingMonths` (les mois attendus qu'aucun appel ne couvre) est
 * exhaustive : le serveur calcule le second comme « mois attendus moins mois
 * couverts ». Un mois totalement absent apparait donc bien dans la liste.
 * @param {any} st
 * @returns {string[]}
 */
function coverageMonths(st) {
  const meta = st.meta && Array.isArray(st.meta.months) ? st.meta.months : [];
  const missing = st.store && Array.isArray(st.store.missingMonths) ? st.store.missingMonths : [];
  const seen = new Set();
  const out = [];

  for (let i = 0; i < meta.length; i++) pushMonth(out, seen, meta[i]);
  for (let i = 0; i < missing.length; i++) pushMonth(out, seen, missing[i]);

  out.sort();
  out.reverse();                                  // le plus recent d'abord
  return out;
}

/** @param {string[]} out @param {Set<string>} seen @param {unknown} value */
function pushMonth(out, seen, value) {
  const ym = String(value == null ? '' : value).trim();
  // Le mois finit dans une URL et dans un libelle : on n'accepte que la forme
  // exacte AAAA-MM, jamais ce que l'API a bien voulu envoyer.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym) || seen.has(ym)) return;
  seen.add(ym);
  out.push(ym);
}

/**
 * Nombre d'appels ARCHIVES par mois. On compte sur toutes les lignes brutes,
 * hors filtres : la couverture decrit la base, pas la selection en cours.
 * @returns {Map<string, number>}
 */
function monthCounts() {
  const points = byMonth(getRows());
  const map = new Map();
  for (let i = 0; i < points.length; i++) map.set(points[i].label, points[i].value);
  return map;
}

/**
 * Le bloc « Couverture de la collecte » : ce qui garantit que les trois mois
 * sont bien la. Chaque mois manquant ou creux porte le lien qui le remplit.
 * @param {any} st
 * @returns {string}
 */
function coverageSection(st) {
  const months = coverageMonths(st);
  const head = sectionHead('Couverture de la collecte', coverageSub(st));
  const storeOff = st.store && st.store.enabled === false
    ? notice({
      tone: 'warn',
      title: 'Archivage désactivé.',
      body: html`Sans base, seule la fenêtre ramenée en direct par Keyyo est disponible : l’historique
        des trois mois ne peut pas être garanti. Renseignez le stockage de l’archive, puis relancez
        <a class="link" href="/api/sync?full=1" target="_blank" rel="noopener">/api/sync?full=1</a>.`,
    })
    : '';

  if (!months.length) {
    const body = empty(
      'Couverture inconnue',
      'Aucun mois collecté n’est connu. Lancez une première synchronisation, puis rechargez cette page.',
    );
    return html`${raw(head)}${raw(storeOff)}${raw(card({ body: raw(body) }))}`;
  }

  const counts = monthCounts();
  const missing = new Set();
  if (st.store && Array.isArray(st.store.missingMonths)) {
    for (let i = 0; i < st.store.missingMonths.length; i++) {
      missing.add(String(st.store.missingMonths[i]));
    }
  }

  // Mois de bord : le plus recent est encore en cours, le plus ancien commence
  // au milieu du mois (fenetre de 92 jours). Leur volume est bas par
  // construction : on ne les compare pas aux mois pleins, et ils ne servent pas
  // de reference.
  let reference = 0;
  for (let i = 1; i < months.length - 1; i++) {
    const value = counts.get(months[i]) || 0;
    if (value > reference) reference = value;
  }

  const rows = [];
  let covered = 0;
  let flagged = 0;

  for (let i = 0; i < months.length; i++) {
    const ym = months[i];
    const count = counts.get(ym) || 0;
    const partial = i === 0 || i === months.length - 1;
    const isMissing = count === 0 || missing.has(ym);
    const isThin = !isMissing && !partial && reference > 0 && count < reference * THIN_RATIO;
    if (!isMissing) covered++;
    if (isMissing || isThin) flagged++;

    let state_ = tag('Couvert', 'ok');
    if (isMissing) state_ = tag('Aucun appel archivé', 'missed');
    else if (isThin) state_ = tag('Volume anormalement bas', 'in');

    const sub = ym + (partial ? ' · mois partiel' : '');
    const action = isMissing || isThin
      ? html`<a class="link nowrap" href="/api/sync?month=${ym}" target="_blank" rel="noopener"
          title="Lance la collecte de ce mois dans un nouvel onglet">Compléter ce mois</a>`
      : html`<span class="muted">—</span>`;

    rows.push([
      html`${fmtMonth(ym) || ym}<div class="muted mono">${sub}</div>`,
      html`<span class="tnum">${fmtInt(count)}</span>`,
      state_,
      action,
    ]);
  }

  const foot = html`<span>${fmtInt(covered)} ${pluralize(covered, 'mois couvert', 'mois couverts')}
      sur ${fmtInt(months.length)} attendus · périmètre visé : les 92 derniers jours</span>
    <span>${flagged > 0
      ? 'Ouvrez le lien du mois concerné, puis rafraîchissez.'
      : 'Les trois derniers mois sont archivés.'}</span>`;

  const body = table({
    minWidth: 620,
    foot: raw(foot),
    columns: [
      { key: 'month', label: 'Mois', cls: 'strong' },
      { key: 'count', label: 'Appels archivés', align: 'right' },
      { key: 'state', label: 'État', cls: 'shrink' },
      { key: 'action', label: 'Action', cls: 'shrink' },
    ],
    rows,
  });

  return html`${raw(head)}${raw(storeOff)}${raw(card({ flush: true, body: raw(body) }))}`;
}

/** @param {any} st @returns {string} sous-titre du bloc de couverture. */
function coverageSub(st) {
  const parts = [];
  if (st.at) parts.push('dernière mise à jour ' + fmtRelative(st.at));
  const total = st.store && Number(st.store.total) >= 0 ? Number(st.store.total) : null;
  if (total != null) {
    parts.push(fmtInt(total) + ' ' + pluralize(total, 'appel archivé', 'appels archivés'));
  }
  const saved = st.store && st.store.lastSavedAt ? st.store.lastSavedAt : '';
  if (saved) parts.push('base écrite ' + fmtRelative(saved));
  return parts.join(' · ');
}

// -----------------------------------------------------------------------------
//  Chargement
// -----------------------------------------------------------------------------

/** @returns {string} ossature d'attente, avec l'attente annoncee en texte. */
function loadingView() {
  return html`<div class="stack stack--lg">
    <p class="muted" role="status">Chargement de l’inventaire des lignes Keyyo…</p>
    <div class="kpi-grid">${raw(skeleton('card'))}${raw(skeleton('card'))}${raw(skeleton('card'))}</div>
    ${raw(skeleton('title'))}
    ${raw(card({ body: raw(skeleton('block')) }))}
  </div>`;
}

// -----------------------------------------------------------------------------
//  Cablage
// -----------------------------------------------------------------------------

/**
 * Pose les ecouteurs delegues, UNE SEULE FOIS par racine.
 *
 * `mount` remplace le contenu de la section, pas la section elle-meme : les
 * ecouteurs poses sur la racine survivent donc a chaque rendu. Sans ce garde,
 * `render` en empilerait un jeu de plus a chaque changement d'etat, et un clic
 * sur un indicateur basculerait son etat autant de fois qu'il y a eu de rendus.
 *
 * Aucun de ces gestionnaires ne capture de donnee de rendu : ils relisent le
 * store et le DOM au moment du clic.
 * @param {HTMLElement} root
 */
function wire(root) {
  if (_wired.has(root)) return;
  _wired.add(root);

  // Indicateur : le clic revele l'explication du calcul. C'est la page qui
  // bascule la classe ET aria-expanded, ui.kpi ne cable rien.
  on(root, 'click', '.kpi[aria-expanded]', (ev, el) => {
    const open = el.getAttribute('aria-expanded') === 'true';
    el.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (open) el.classList.remove('is-open');
    else el.classList.add('is-open');
  });

  // Compteur d'appels d'une ligne : bascule le filtre de periode sur elle.
  on(root, 'click', '[data-line-select]', (ev, el) => {
    const csi = el.getAttribute('data-line-select') || '';
    if (!csi) return;
    const current = lineByCsi(state.csi);
    const same = current && digitsOf(current.csi) === digitsOf(csi);
    setFilter({ csi: same ? '' : csi });
  });

  on(root, 'click', '[data-line-clear]', () => {
    setFilter({ csi: '' });
  });

  // Fiche correspondant : c'est app/main.js qui ouvre la modale.
  on(root, 'click', '[data-drill]', (ev, el) => {
    const number = el.getAttribute('data-drill') || '';
    if (!number) return;
    document.dispatchEvent(new CustomEvent('keyyo:drill', { detail: { number } }));
  });
}

// -----------------------------------------------------------------------------
//  Rendu
// -----------------------------------------------------------------------------

/**
 * Dessine la vue dans sa section. Idempotente : appelee a chaque changement
 * d'etat, elle reconstruit tout le contenu et ne cable rien de nouveau.
 * @param {HTMLElement} root  `section.page[data-page="lines"]`
 * @returns {void}
 */
export function render(root) {
  const st = status();

  if (st.kind === 'loading') {
    mount(root, loadingView());
    return;
  }

  const banner = collectBanner(st);
  const lines = getLines();

  // Parc vide : l'inventaire n'a rien a montrer, mais la couverture de la
  // collecte reste utile — c'est elle qui dit si le probleme vient du jeton ou
  // de la synchronisation.
  if (!lines.length) {
    mount(root, html`<div class="stack stack--lg">
      ${raw(banner)}
      ${raw(noLinesNotice())}
      ${raw(coverageSection(st))}
    </div>`);
    wire(root);
    return;
  }

  const rows = filtered();
  const index = callsIndex(rows);
  const selected = selectedLine();

  mount(root, html`<div class="stack stack--lg">
    ${raw(banner)}
    ${raw(filterNotice(selected))}
    ${raw(silentNotice(lines, index, selected))}

    <div class="kpi-grid">${raw(kpiRow(lines, index))}</div>

    ${raw(sectionHead('Inventaire des lignes', 'Ce que Keyyo déclare, indépendamment de l’usage'))}
    ${raw(card({ flush: true, body: raw(linesTable(lines, index, selected)) }))}

    ${raw(activitySection(rows, selected))}
    ${raw(coverageSection(st))}
  </div>`);

  attachChartTips(root);
  wire(root);
}
