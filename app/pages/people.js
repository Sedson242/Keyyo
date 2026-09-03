// =============================================================================
//  app/pages/people.js — Vue « Collaborateurs ».
//
//  C'est la vue qui rend visible la fonctionnalite demandee par le client : le
//  rapprochement LIGNE KEYYO -> PERSONNE -> PRENOM, deduit de l'adresse email.
//  Elle doit donc etre utile au quotidien (activite par personne) ET
//  verifiable : chaque carte dit d'ou vient le prenom affiche, sur quel indice,
//  et avec quelle confiance. Rien n'est devine en silence.
//
//  DEUX PARTIS PRIS A CONNAITRE :
//
//  1. Le perimetre de cette vue est LA PERIODE SEULE. Les filtres « ligne » et
//     « sens » de la barre de periode sont volontairement ignores ici : la page
//     compare les collaborateurs entre eux, et un filtre sur une seule ligne
//     afficherait une grille de zeros pour tous les autres. Les lignes d'appel
//     sont donc bornees a [state.from, state.to] par cette page, et non par
//     store.filtered(). Le sous-titre le dit a l'utilisateur.
//
//  2. Un APPEL MANQUE est un ENTRANT DE DUREE NULLE. L'API Keyyo ne fournit
//     aucun indicateur de decroche : « Entrants traites » vaut donc
//     entrants - manques, et le taux de reponse ne porte que sur les entrants.
//     Les explications des indicateurs (`why`) le disent sans pretendre a une
//     precision que la source n'a pas.
// =============================================================================

import { html, raw, mount, on, icon } from '../dom.js';
import { fmtInt, fmtPct, fmtHms, fmtDate, pluralize } from '../format.js';
import { sectionHead, card, notice, empty, skeleton, table, tag, avatar, meter, kpi } from '../ui.js';
import { barChart, attachChartTips } from '../charts.js';
import { state, status, getRows, getLines, byLine, stats, setFilter } from '../store.js';
import { F } from '../../shared/schema.js';
import { formatCsi } from '../../shared/identity.js';

// -----------------------------------------------------------------------------
//  Traduction des sources de rapprochement
// -----------------------------------------------------------------------------

/**
 * Libelle francais court de chaque regle de shared/identity.js. Les noms
 * techniques (`directory_short_number`) ne veulent rien dire pour la personne
 * qui exploite l'outil : elle doit lire d'ou vient le prenom.
 */
const SOURCE_LABELS = {
  override: 'réglage manuel',
  directory_number: "numéro de l'annuaire Keyyo",
  directory_short_number: 'numéro abrégé',
  directory_name: "nom de l'annuaire",
  email_account_name: 'compte de messagerie Keyyo',
  line_name: 'nom du terminal, sans adresse',
};

/** En dessous de ce seuil, le rapprochement est trop faible pour etre tu. */
const WEAK_CONFIDENCE = 0.6;

/**
 * @param {any} person
 * @returns {string} libelle de la source, jamais vide.
 */
function sourceLabel(person) {
  if (!person) return 'aucun rapprochement';
  const key = String(person.source == null ? '' : person.source);
  return SOURCE_LABELS[key] || (key ? key : 'source inconnue');
}

/**
 * Ton de l'etiquette de source. `ui.tag` ne connait pas de ton « warn » : dans
 * cette palette, c'est `missed` qui porte l'alerte. Un rapprochement faible
 * (confiance < 0,6) ou absent se voit donc en rouge, un rapprochement solide en
 * vert, et l'entre-deux dans le ton d'accent.
 * @param {any} person
 * @returns {'ok'|'in'|'missed'}
 */
function sourceTone(person) {
  if (!person) return 'missed';
  const c = confidenceOf(person);
  if (c < WEAK_CONFIDENCE) return 'missed';
  if (c >= 0.8) return 'ok';
  return 'in';
}

/** @param {any} person @returns {number} confiance bornee a [0, 1]. */
function confidenceOf(person) {
  const c = person ? Number(person.confidence) : 0;
  if (!isFinite(c) || c <= 0) return 0;
  return c > 1 ? 1 : c;
}

/**
 * Prenom a afficher. Le prenom est la demande du client ; a defaut on prend le
 * libelle complet de la personne, et seulement en dernier recours on dit
 * clairement que la ligne n'est associee a personne.
 * @param {any} person
 * @returns {string}
 */
function personName(person) {
  if (person) {
    const first = String(person.firstName == null ? '' : person.firstName).trim();
    if (first) return first;
    const display = String(person.displayName == null ? '' : person.displayName).trim();
    if (display) return display;
  }
  return 'Ligne non associée';
}

/** @param {any} person @returns {string} email rattache, ou l'absence dite en clair. */
function personMail(person) {
  const mail = person ? String(person.email == null ? '' : person.email).trim() : '';
  return mail || 'aucun email rattaché';
}

// -----------------------------------------------------------------------------
//  Donnees de la vue
// -----------------------------------------------------------------------------

/**
 * Lignes d'appel de la PERIODE, tous sens et toutes lignes confondus (voir
 * l'en-tete du fichier). Bornes incluses, sur le champ `date` deja exprime en
 * heure locale d'affichage.
 * @returns {any[][]}
 */
function rowsInPeriod() {
  const all = getRows();
  const from = state.from;
  const to = state.to;
  if (!from && !to) return all;

  const out = [];
  for (let i = 0; i < all.length; i++) {
    const date = all[i][F.date];
    if (from && date < from) continue;
    if (to && date > to) continue;
    out.push(all[i]);
  }
  return out;
}

/** @param {unknown} v @returns {string} chiffres seuls : forme de comparaison des CSI. */
function digitsOf(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

/**
 * Index des agregats de `byLine` par CSI en chiffres : le CSI porte par une
 * ligne du parc et celui porte par un appel ne sont pas toujours ecrits de la
 * meme facon.
 * @param {any[]} entries
 * @returns {Map<string, any>}
 */
function indexByCsi(entries) {
  const map = new Map();
  for (let i = 0; i < entries.length; i++) {
    const key = digitsOf(entries[i].csi);
    if (key && !map.has(key)) map.set(key, entries[i]);
  }
  return map;
}

/** Agregat vide : une ligne sans aucun appel sur la periode existe quand meme. */
function emptyEntry(csi) {
  return { csi: String(csi || ''), total: 0, in: 0, out: 0, missed: 0, answered: 0, answerRate: 0, seconds: 0 };
}

/**
 * Rassemble, pour chaque ligne du parc, son identite et son activite.
 * @returns {any[]}
 */
function buildPeople() {
  const lines = getLines();
  const activity = indexByCsi(byLine(rowsInPeriod()));

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || {};
    const entry = activity.get(digitsOf(line.csi)) || emptyEntry(line.csi);
    const person = line.person || null;
    out.push({
      line,
      person,
      csi: String(line.csi || ''),
      number: line.formattedCsi ? String(line.formattedCsi) : formatCsi(line.csi),
      name: personName(person),
      mail: personMail(person),
      label: person && person.displayName ? String(person.displayName) : String(line.label || formatCsi(line.csi)),
      total: entry.total,
      in: entry.in,
      out: entry.out,
      missed: entry.missed,
      handled: Math.max(0, entry.in - entry.missed),
      rate: entry.answerRate,
      seconds: entry.seconds,
    });
  }

  // Les plus actifs d'abord : c'est l'ordre utile au quotidien. A activite
  // egale (souvent zero), l'ordre alphabetique rend la grille previsible.
  out.sort((a, b) => (b.total - a.total) || String(a.name).localeCompare(String(b.name), 'fr'));
  return out;
}

/**
 * Ton de la barre de taux de reponse : la couleur ne dit rien de plus que le
 * chiffre, elle le rend seulement lisible d'un coup d'oeil. Sans aucun entrant
 * il n'y a pas de taux : la barre reste neutre plutot que rouge a zero, qui se
 * lirait comme un mauvais resultat.
 * @param {any} p
 * @returns {'ok'|'missed'|undefined}
 */
function rateTone(p) {
  if (!p.in) return undefined;
  if (p.rate >= 85) return 'ok';
  if (p.rate < 60) return 'missed';
  return undefined;
}

// -----------------------------------------------------------------------------
//  Fragments
// -----------------------------------------------------------------------------

/** Sous-titre de la vue : dit le perimetre exact, filtres compris. */
function periodSub() {
  const from = state.from ? fmtDate(state.from) : '—';
  const to = state.to ? fmtDate(state.to) : '—';
  return 'Rapprochement ligne → personne, du ' + from + ' au ' + to
    + ' — toutes les lignes et les deux sens, quels que soient les filtres de la barre de période.';
}

/** Etat de chargement : on reserve la place de la grille pour eviter un saut. */
function loadingView() {
  return html`${raw(sectionHead('Collaborateurs', 'Chargement du rapprochement des lignes…'))}
    ${raw(skeleton('text'))}
    <div class="people">
      ${raw(skeleton('card'))}${raw(skeleton('card'))}${raw(skeleton('card'))}
    </div>
    ${raw(skeleton('card'))}`;
}

/**
 * Bandeau d'etat du rapprochement. C'est le premier chiffre qu'on vient
 * verifier : combien de lignes portent un nom, et sur combien au total.
 * @param {any[]} people
 * @returns {string}
 */
function matchNotice(people) {
  const total = people.length;
  let withPerson = 0;
  let withMail = 0;
  let weak = 0;
  for (let i = 0; i < people.length; i++) {
    if (!people[i].person) continue;
    withPerson++;
    if (people[i].person.email) withMail++;
    if (confidenceOf(people[i].person) < WEAK_CONFIDENCE) weak++;
  }

  const clean = total > 0 && withPerson === total && weak === 0;
  const missing = total - withPerson;

  const counts = html`<strong>${fmtInt(withPerson)}</strong> ${pluralize(withPerson, 'ligne', 'lignes')}
    ${pluralize(withPerson, 'associée', 'associées')} à une personne sur ${fmtInt(total)},
    dont ${fmtInt(withMail)} avec une adresse e-mail rattachée.`;

  const detail = clean
    ? html` Le prénom affiché est déduit de l'adresse e-mail de la ligne (annuaire Keyyo ou compte mail).`
    : html` ${missing > 0
      ? fmtInt(missing) + ' ' + pluralize(missing, 'ligne reste', 'lignes restent') + ' sans personne identifiée.'
      : ''}${weak > 0
      ? ' ' + fmtInt(weak) + ' ' + pluralize(weak, 'rapprochement', 'rapprochements')
        + ' ' + pluralize(weak, 'est jugé', 'sont jugés') + ' faible' + (weak > 1 ? 's' : '')
        + ' (confiance inférieure à 60 %).'
      : ''} Le réglage <code>KEYYO_LINE_EMAILS</code> permet d'associer une ligne à une adresse à la main.`;

  const link = clean
    ? ''
    : html` <button class="link" type="button" data-goto="diagnostics">Voir la page Diagnostic</button>`;

  return notice({
    tone: clean ? 'ok' : 'warn',
    title: clean ? 'Rapprochement complet.' : 'Rapprochement partiel.',
    body: html`${raw(counts)}${raw(detail)}${raw(link)}`,
  });
}

/**
 * Trois indicateurs depliables. Le `why` explique le calcul : c'est la seule
 * facon d'assumer qu'un « manque » est une deduction, pas une donnee de l'API.
 * @param {any[]} people
 * @param {any} totals sortie de store.stats
 * @returns {string}
 */
function kpiRow(people, totals) {
  let withPerson = 0;
  for (let i = 0; i < people.length; i++) if (people[i].person) withPerson++;

  const cards = [
    kpi({
      label: 'Lignes rapprochées',
      value: fmtInt(withPerson) + ' / ' + fmtInt(people.length),
      foot: 'Lignes VoIP du parc Keyyo',
      why: "Chaque ligne est rapprochée d'une personne en croisant l'annuaire Keyyo, "
        + 'les comptes e-mail et le nom de la ligne. Le prénom vient de l\'adresse e-mail '
        + 'quand elle est connue ; sinon la ligne reste affichée sous son numéro.',
      tone: withPerson === people.length ? 'ok' : 'missed',
    }),
    kpi({
      label: 'Appels sur la période',
      value: fmtInt(totals.total),
      foot: fmtInt(totals.in) + ' entrants · ' + fmtInt(totals.out) + ' sortants',
      why: 'Tous les appels de la période, toutes les lignes et les deux sens confondus. '
        + 'Les filtres « ligne » et « sens » de la barre de période ne s\'appliquent pas à cette vue, '
        + 'qui sert à comparer les collaborateurs entre eux.',
      tone: 'in',
    }),
    kpi({
      label: 'Taux de réponse global',
      value: fmtPct(totals.answerRate, 1),
      foot: fmtInt(totals.missed) + ' ' + pluralize(totals.missed, 'appel manqué', 'appels manqués'),
      why: "L'API Keyyo ne fournit aucun indicateur de décroché : un appel manqué est un appel "
        + 'entrant de durée nulle. Le taux affiché est donc (entrants − manqués) ÷ entrants, '
        + 'calculé sur les seuls appels entrants.',
      tone: 'ok',
    }),
  ];

  return html`<div class="kpi-grid">${cards.map((c) => raw(c))}</div>`;
}

/**
 * Carte d'un collaborateur. Actionnable par un bouton PLACE DANS la carte
 * plutot qu'en rendant la carte entiere cliquable : le focus clavier reste
 * atteignable et le libelle du bouton dit ce que le clic va faire.
 * @param {any} p
 * @returns {string}
 */
function personCard(p) {
  const person = p.person;
  const conf = confidenceOf(person);
  const evidence = person && person.evidence ? String(person.evidence) : '';
  const poste = p.line.shortNumber ? String(p.line.shortNumber) : '';

  const stat = (value, label) => html`<div class="person-stat">
    <div class="person-stat-value">${value}</div>
    <div class="person-stat-label">${label}</div>
  </div>`;

  return html`<article class="person">
    <div class="person-head">
      ${raw(avatar(p.label, { size: 'lg', tone: person ? undefined : 'missed' }))}
      <div class="grow">
        <div class="person-name truncate">${p.name}</div>
        <div class="person-mail">${p.mail}</div>
        <div class="person-mail">${p.number}${poste ? ' · poste ' + poste : ''}</div>
      </div>
    </div>

    <div class="person-stats">
      ${raw(stat(fmtInt(p.handled), 'Entrants traités'))}
      ${raw(stat(fmtInt(p.out), 'Sortants émis'))}
      ${raw(stat(fmtInt(p.missed), 'Manqués'))}
    </div>

    <div>
      <div class="row row--between">
        <span class="person-stat-label">Taux de réponse</span>
        <span class="person-stat-value">${p.in > 0 ? fmtPct(p.rate, 0) : '—'}</span>
      </div>
      ${raw(meter(p.rate, rateTone(p)))}
    </div>

    <div class="person-source">
      ${raw(tag(sourceLabel(person), sourceTone(person)))}
      <span class="truncate" title="${evidence}">${evidence || 'aucun indice de rapprochement'}</span>
      <span class="nowrap">confiance ${person ? fmtPct(conf * 100, 0) : '—'}</span>
    </div>

    <button class="btn btn--sm btn--ghost" type="button" data-line-csi="${p.csi}"
      title="Filtrer l'application sur cette ligne et ouvrir le monitoring">
      ${raw(icon('monitoring'))}Voir l'activité de ${p.name}
    </button>
  </article>`;
}

/**
 * Tableau comparatif de toutes les lignes. Chaque cellule est une chaine HTML
 * deja sure, construite avec le gabarit `html`.
 * @param {any[]} people
 * @returns {string}
 */
function comparisonTable(people) {
  const columns = [
    { key: 'person', label: 'Collaborateur' },
    { key: 'mail', label: 'Email' },
    { key: 'csi', label: 'CSI', cls: 'nowrap' },
    { key: 'name', label: 'Nom de ligne' },
    { key: 'short', label: 'Poste', cls: 'shrink' },
    { key: 'calls', label: 'Appels', align: 'right' },
    { key: 'rate', label: 'Taux de réponse', align: 'right' },
    { key: 'seconds', label: 'Durée cumulée', align: 'right' },
    { key: 'source', label: 'Source du rapprochement' },
  ];

  const rows = people.map((p) => {
    const person = p.person;
    const sub = person && person.displayName && person.displayName !== p.name
      ? String(person.displayName)
      : String(p.line.label || '');

    return [
      html`<div class="cell-id">
        ${raw(avatar(p.label, { tone: person ? undefined : 'missed' }))}
        <div class="cell-id-body">
          <div class="cell-id-name">${p.name}</div>
          <div class="cell-id-sub">${sub}</div>
        </div>
      </div>`,
      person && person.email
        ? html`${person.email}`
        : html`<span class="faint">aucun email rattaché</span>`,
      html`${p.number}`,
      p.line.name ? html`${p.line.name}` : html`<span class="faint">—</span>`,
      p.line.shortNumber ? html`${p.line.shortNumber}` : html`<span class="faint">—</span>`,
      html`${fmtInt(p.total)}`,
      html`<div class="row">
        <span class="nowrap">${p.in > 0 ? fmtPct(p.rate, 0) : '—'}</span>
        ${raw(meter(p.rate, rateTone(p)))}
      </div>`,
      html`${fmtHms(p.seconds)}`,
      html`<div class="row">
        ${raw(tag(sourceLabel(person), sourceTone(person)))}
        <span class="faint nowrap">${person ? fmtPct(confidenceOf(person) * 100, 0) : '—'}</span>
      </div>`,
    ];
  });

  let called = 0;
  for (let i = 0; i < people.length; i++) if (people[i].total > 0) called++;

  const foot = html`<span>${fmtInt(people.length)} ${pluralize(people.length, 'ligne VoIP', 'lignes VoIP')} —
      ${fmtInt(called)} ${pluralize(called, 'a', 'ont')} eu de l'activité sur la période.</span>
    <span class="faint">Un appel manqué est un entrant de durée nulle : l'API Keyyo ne fournit pas d'indicateur de décroché.</span>`;

  return table({ columns: columns, rows: rows, foot: raw(foot), minWidth: 1160 });
}

/**
 * Les deux histogrammes : volume traite par collaborateur, puis taux de
 * reponse par collaborateur.
 * @param {any[]} people
 * @returns {string}
 */
function charts(people) {
  const volume = people
    .filter((p) => p.total > 0)
    .map((p) => ({
      label: p.name,
      value: p.total,
      hint: p.number + ' · ' + fmtInt(p.handled) + ' ' + pluralize(p.handled, 'entrant traité', 'entrants traités'),
    }));

  // Une ligne sans aucun entrant n'a pas de taux de reponse : l'afficher a
  // 0 % serait un chiffre faux et credible. On l'ecarte du graphique.
  const rates = people
    .filter((p) => p.in > 0)
    .map((p) => ({
      label: p.name,
      value: Math.round(p.rate * 10) / 10,
      hint: fmtInt(p.in - p.missed) + ' / ' + fmtInt(p.in) + ' entrants décrochés',
    }))
    .sort((a, b) => b.value - a.value);

  const volumeBody = volume.length
    ? barChart({ data: volume, height: 240, format: (v) => fmtInt(v) })
    : empty('Aucun appel à répartir', 'Aucune ligne n\'a enregistré d\'appel sur la période choisie.');

  const rateBody = rates.length
    ? barChart({ data: rates, height: 240, maxTicks: 5, format: (v) => fmtPct(v, 0) })
    : empty('Aucun appel entrant', 'Le taux de réponse ne se calcule que sur les appels entrants.');

  return html`<div class="grid-2">
    ${raw(card({
      title: 'Appels traités par collaborateur',
      sub: 'Nombre total d\'appels, entrants et sortants confondus.',
      body: raw(volumeBody),
    }))}
    ${raw(card({
      title: 'Taux de réponse par collaborateur',
      sub: 'Entrants décrochés ÷ entrants, sur les lignes ayant reçu au moins un appel.',
      body: raw(rateBody),
    }))}
  </div>`;
}

// -----------------------------------------------------------------------------
//  Interactions
// -----------------------------------------------------------------------------

/**
 * Racines deja cablees. `mount` remplace les enfants de la section mais PAS les
 * ecouteurs poses sur la section elle-meme : sans cette memoire, chaque rendu
 * empilerait un jeu d'ecouteurs supplementaire. Les gestionnaires ne capturent
 * aucune donnee de rendu, un seul cablage suffit donc pour toute la duree de
 * vie de la page.
 * @type {WeakSet<object>}
 */
const wiredRoots = new WeakSet();

/**
 * Change de vue. Le routeur lit le fragment d'URL ; on met aussi `state.page`
 * a jour pour que le store et l'URL ne divergent pas.
 * @param {string} page
 */
function goTo(page) {
  setFilter({ page: page });
  const target = '#/' + page;
  if (location.hash !== target) location.hash = target;
}

/** @param {Element} root */
function wire(root) {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);

  // Une carte : on filtre l'application sur la ligne, puis on va au monitoring.
  on(root, 'click', '[data-line-csi]', (ev, el) => {
    const csi = el.getAttribute('data-line-csi') || '';
    setFilter({ csi: csi, page: 'monitoring' });
    const target = '#/monitoring';
    if (location.hash !== target) location.hash = target;
  });

  // Renvoi vers une autre vue (bandeau de rapprochement partiel).
  on(root, 'click', '[data-goto]', (ev, el) => {
    const page = el.getAttribute('data-goto') || '';
    if (page) goTo(page);
  });

  // Depliage de l'explication d'un indicateur : c'est la page qui bascule la
  // classe ET l'attribut, `ui.kpi` ne cable rien.
  on(root, 'click', '.kpi', (ev, el) => {
    if (!el.hasAttribute('aria-expanded')) return;
    const open = el.getAttribute('aria-expanded') === 'true';
    el.setAttribute('aria-expanded', open ? 'false' : 'true');
    el.classList.toggle('is-open', !open);
  });
}

// -----------------------------------------------------------------------------
//  Rendu
// -----------------------------------------------------------------------------

/**
 * Rend la vue « Collaborateurs ». Rappelee a chaque changement d'etat, donc
 * idempotente : tout le contenu est reconstruit, les interactions restent
 * cablees par delegation depuis la section.
 * @param {HTMLElement} root section.page[data-page="people"]
 * @returns {void}
 */
export function render(root) {
  if (!root) return;
  wire(root);

  const st = status();
  if (st.kind === 'loading') {
    mount(root, loadingView());
    return;
  }

  const parts = [];
  parts.push(sectionHead('Collaborateurs', periodSub()));

  // Erreur de collecte : on le dit avant tout chiffre, car les donnees
  // affichees peuvent etre plus anciennes que la periode demandee.
  if (st.kind === 'error') {
    parts.push(notice({
      tone: 'error',
      title: 'Collecte indisponible.',
      body: html`${st.warning || "La dernière collecte des appels a échoué. Les chiffres ci-dessous peuvent être incomplets ; réessayez avec le bouton Rafraîchir, puis consultez la page Diagnostic."}`,
    }));
  } else if (st.warning) {
    parts.push(notice({ tone: 'warn', title: 'Collecte partielle.', body: html`${st.warning}` }));
  }

  const people = buildPeople();

  // Aucune ligne VoIP : ce n'est pas un manque de donnees d'appel, c'est le
  // parc lui-meme qui est vide. La piste d'action n'est donc pas la meme.
  if (!people.length) {
    parts.push(card({
      body: raw(empty(
        'Aucune ligne Keyyo détectée',
        "Le compte interrogé ne renvoie aucune ligne VoIP. Vérifiez sur la page Diagnostic que le jeton porte sur le bon compte et que le périmètre de lecture est accordé.",
      )),
    }));
    mount(root, html`${parts.map((p) => raw(p))}`);
    return;
  }

  const rows = rowsInPeriod();
  const totals = stats(rows);

  parts.push(matchNotice(people));
  parts.push(kpiRow(people, totals));

  if (!rows.length) {
    // Le rapprochement reste affiche : il est verifiable sans aucun appel.
    parts.push(card({
      body: raw(empty(
        'Aucun appel sur la période',
        'Élargissez la période avec le préréglage « Tout », ou lancez une collecte avec le bouton Rafraîchir. La page Diagnostic indique les mois déjà collectés.',
      )),
    }));
  }

  parts.push(html`<div class="people">${people.map((p) => raw(personCard(p)))}</div>`);

  parts.push(sectionHead(
    'Comparatif des lignes',
    'Une ligne par poste VoIP, avec la source exacte du rapprochement.',
  ));
  parts.push(card({ flush: true, body: raw(comparisonTable(people)) }));

  if (rows.length) {
    parts.push(sectionHead('Répartition par collaborateur'));
    parts.push(charts(people));
  }

  mount(root, html`${parts.map((p) => raw(p))}`);
  attachChartTips(root);
}
