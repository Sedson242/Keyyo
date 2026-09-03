// =============================================================================
//  app/pages/diagnostics.js — LE DIAGNOSTIC.
//
//  La seule page qui parle de l'outil lui-meme et non des appels. Son contrat
//  moral : dire ce qui va mal, et dire comment le reparer. Elle n'arrondit
//  rien, elle ne cache pas une collecte partielle derriere un graphique
//  flatteur, et chaque manque affiche porte a cote de lui l'action qui le
//  corrige (relancer un mois, coller une variable d'environnement, rejouer une
//  collecte complete).
//
//  C'est aussi la SEULE page autorisee a appeler app/api.js : elle supervise
//  l'API, elle doit donc pouvoir l'interroger sans passer par le store. Le
//  resultat de /api/health est garde dans une variable de MODULE, jamais
//  ecrase par un rechargement en cours : pendant une nouvelle sonde, l'ancien
//  verdict reste a l'ecran (marque comme date) plutot que de laisser un vide.
//
//  DEUX RAPPELS DE VERITE METIER, repris dans les libelles affiches :
//    - L'API Keyyo ne fournit AUCUN indicateur de decroche. `quantity` en
//      unite `second` EST la duree, et un appel manque est un ENTRANT de duree
//      nulle. La page le dit ainsi, sans pretendre a mieux.
//    - Les releves non vocaux (SMS, data) sont ecartes a la normalisation. Ce
//      sont des rejets LEGITIMES : les confondre avec une perte d'appels
//      declencherait une alerte pour rien.
//
//  SECURITE : aucun JSON n'est affiche sans passer par `maskSecrets`, qui
//  remplace la valeur de toute cle nommee token, secret, key, password ou
//  authorization. Le masquage est recursif et s'applique au diagnostic du
//  store comme au detail de chaque controle.
// =============================================================================

import { html, raw, mount, on, qs, icon } from '../dom.js';
import {
  card, sectionHead, table, tag, avatar, meter, notice, empty, skeleton, toolbar,
} from '../ui.js';
import {
  fmtInt, fmtPct, fmtDate, fmtMonth, fmtRelative, fmtDuration, pluralize,
} from '../format.js';
import { status, getLines, getRows, byDay, load } from '../store.js';
import { getHealth } from '../api.js';

// -----------------------------------------------------------------------------
//  Etat de module
//
//  La page est rappelee a chaque notification du store : tout ce qui doit
//  survivre a un redessin (verdict des controles, bloc replie, message de
//  copie) vit donc ici, et pas dans le DOM.
// -----------------------------------------------------------------------------

/** @type {HTMLElement|null} Section montee, pour les redessins declenches par la page. */
let _root = null;

/** @type {any} Derniere reponse /api/health EXPLOITABLE. Jamais effacee par un echec. */
let _health = null;

/** @type {string} Horodatage ISO de cette reponse. */
let _healthAt = '';

/** @type {string} Message de la derniere tentative en echec, '' si la derniere a reussi. */
let _healthError = '';

/** Vrai quand la reponse affichee provient d'un controle approfondi (deep). */
let _healthDeep = false;

/** Sonde /api/health en cours : on n'en lance pas deux, et les boutons se desactivent. */
let _busy = false;

/** Premiere sonde deja lancee : le rendu initial la declenche une seule fois. */
let _probed = false;

/** Collecte complete en cours (load({ full: true })). */
let _syncing = false;

/** Bloc « Detail brut » deplie. */
let _rawOpen = false;

/** Retour visible de la derniere tentative de copie. */
let _copyMsg = '';

/**
 * Racines deja cablees. `mount` remplace le contenu de la section mais PAS la
 * section elle-meme : sans cette garde, chaque rendu empilerait un ecouteur de
 * plus sur la meme racine.
 * @type {WeakSet<object>}
 */
const _wired = new WeakSet();

/** Cles dont la valeur ne doit JAMAIS s'afficher. */
const SECRET_KEY = /token|secret|key|password|authorization/i;

/** Remplacement affiche a la place d'un secret. */
const MASK = '••• masqué •••';

/** Profondeur maximale de masquage : borne le cout sur une structure imprevue. */
const MASK_MAX_DEPTH = 12;

/** Longueur maximale du detail d'un controle affiche en cellule de tableau. */
const DETAIL_MAX = 300;

/** Forme d'un mois `AAAA-MM` : sert aussi a valider un parametre de lien. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Prefixe des rejets LEGITIMES : un releve non vocal n'est pas un appel perdu. */
const EXPECTED_DROP = /non\s*vocale/i;

// -----------------------------------------------------------------------------
//  Point d'entree
// -----------------------------------------------------------------------------

/**
 * Rend la page. Idempotente : appelee a chaque changement d'etat du store.
 * @param {HTMLElement} root  section.page[data-page="diagnostics"]
 * @returns {void}
 */
export function render(root) {
  if (!root) return;
  _root = root;

  mount(root, view(status()));
  wire(root);

  // La premiere sonde part APRES le premier rendu : la page s'affiche tout de
  // suite (avec son ossature de chargement) au lieu d'attendre le reseau.
  if (!_probed) {
    _probed = true;
    probe(false, false);
  }
}

/**
 * Redessin declenche par la page elle-meme (sonde terminee, bloc deplie).
 * Le store notifie les changements de DONNEES ; l'etat local, lui, n'a pas
 * d'abonnes.
 */
function repaint() {
  if (_root && _root.isConnected) render(_root);
}

// -----------------------------------------------------------------------------
//  Interactions
// -----------------------------------------------------------------------------

/**
 * Delegation depuis la racine : un seul ecouteur, quel que soit le nombre de
 * boutons redessines.
 * @param {HTMLElement} root
 */
function wire(root) {
  if (_wired.has(root)) return;
  _wired.add(root);

  on(root, 'click', '[data-act]', (ev, el) => {
    const act = el.getAttribute('data-act');
    if (act === 'check') probe(false, true);
    else if (act === 'deep') probe(true, true);
    else if (act === 'raw') { _rawOpen = !_rawOpen; repaint(); }
    else if (act === 'copy') copyEnvLine();
    else if (act === 'full') fullCollect();
  });
}

/**
 * Interroge /api/health.
 *
 * `deep` demande la sonde reelle de releve d'appels, que `getHealth` relaie en
 * `?deep=1`. La page VERIFIE malgre tout dans la reponse qu'une sonde
 * approfondie a bien eu lieu, et le signale sinon : mieux vaut dire qu'on n'a
 * pas pu verifier que laisser croire a un controle qui n'a pas eu lieu.
 *
 * UN ECHEC N'EST PAS UN SILENCE. /api/health repond 503 EN PORTANT son
 * diagnostic : jeton refuse, aucune ligne detectee, releves tous ecartes —
 * c'est-a-dire exactement les situations pour lesquelles cette page existe.
 * `app/api.js` range cette charge utile dans `err.body` ; la jeter afficherait
 * « contrôles indisponibles » au moment precis ou la reponse dit quoi reparer.
 *
 * @param {boolean} deep
 * @param {boolean} force  Vrai pour un clic explicite : on contourne le cache.
 */
function probe(deep, force) {
  if (_busy) return;
  _busy = true;
  repaint();

  getHealth({ force: !!force, deep: !!deep })
    .then((payload) => {
      if (payload && typeof payload === 'object') {
        _health = payload;
        _healthAt = new Date().toISOString();
        _healthError = '';
        _healthDeep = !!deep;
      } else {
        // Une reponse vide n'efface pas le verdict precedent : elle s'ajoute
        // comme erreur, et l'ancien resultat reste lisible et date.
        _healthError = 'Réponse de /api/health inexploitable : aucun objet JSON reçu.';
      }
    })
    .catch((err) => {
      // Une reponse d'erreur qui porte quand meme ses controles est la reponse
      // la plus utile que cette page puisse recevoir : on la garde et on
      // l'affiche. Le bandeau « Verdict daté » dira que la tentative a echoue.
      const body = err && err.body;
      if (body && typeof body === 'object' && Array.isArray(body.checks)) {
        _health = body;
        _healthAt = new Date().toISOString();
        _healthDeep = !!deep;
      }
      _healthError = messageOf(err);
      console.warn('[diagnostics] /api/health a echoue :', err);
    })
    .then(() => {
      _busy = false;
      repaint();
    });
}

/**
 * Relance une collecte complete des trois mois, apres confirmation explicite :
 * l'operation interroge toutes les lignes mois par mois et peut durer une
 * minute. Elle passe par le store, jamais par app/api.js.
 */
function fullCollect() {
  if (_syncing) return;

  const ok = window.confirm(
    'Relancer une collecte complète des trois derniers mois ?\n\n'
    + "L'opération interroge chaque ligne, mois par mois et sens par sens : elle peut durer "
    + 'plusieurs dizaines de secondes et solliciter fortement l’API Keyyo.\n\n'
    + 'Les appels déjà archivés sont conservés : rien ne sera perdu.',
  );
  if (!ok) return;

  _syncing = true;
  repaint();

  load({ full: true, force: true })
    .catch((err) => { console.error('[diagnostics] collecte complete en echec :', err); })
    .then(() => {
      _syncing = false;
      repaint();
      // Les controles decrivent l'etat de la chaine : apres une collecte, ils
      // sont perimes.
      probe(false, true);
    });
}

/**
 * Copie la ligne KEYYO_LINE_EMAILS.
 *
 * `navigator.clipboard` est absent hors contexte securise et peut refuser
 * l'ecriture sans lever d'erreur exploitable : le repli selectionne le texte
 * pour que Ctrl+C fonctionne. Dans les deux cas l'utilisateur voit ce qui
 * s'est passe.
 */
function copyEnvLine() {
  const text = envLine();
  if (!text) return;

  const nav = window.navigator;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      nav.clipboard.writeText(text).then(
        () => { sayCopy('Ligne copiée dans le presse-papiers.'); },
        (err) => {
          console.warn('[diagnostics] presse-papiers refuse :', err);
          selectEnvLine();
        },
      );
      return;
    } catch (err) {
      console.warn('[diagnostics] presse-papiers indisponible :', err);
    }
  }
  selectEnvLine();
}

/** Repli : selectionne la ligne a l'ecran, l'utilisateur termine au clavier. */
function selectEnvLine() {
  const node = _root ? qs('[data-copy-text]', _root) : null;
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;

  if (node && selection && typeof document.createRange === 'function') {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
      sayCopy('Copie automatique refusée par le navigateur : la ligne est sélectionnée, appuyez sur Ctrl+C.');
      return;
    } catch (err) {
      console.warn('[diagnostics] selection de repli impossible :', err);
    }
  }
  sayCopy('Copie automatique impossible : sélectionnez la ligne à la main pour la copier.');
}

/**
 * Affiche le retour de copie SANS redessiner : un rendu complet effacerait la
 * selection de repli et ferait sauter le focus du bouton.
 * @param {string} message
 */
function sayCopy(message) {
  _copyMsg = message;
  const out = _root ? qs('[data-copy-msg]', _root) : null;
  if (out) out.textContent = message;
}

// -----------------------------------------------------------------------------
//  Vue
// -----------------------------------------------------------------------------

/**
 * @param {any} st  resultat de `status()`
 * @returns {string} HTML de la page.
 */
function view(st) {
  const blocks = [
    actionsBar(st),
    banner(st),
    overview(st),
    collectErrors(st),
    checksSection(),
    identitySection(st),
    coverageSection(st),
    dropSection(st),
    rawSection(st),
  ];
  return html`<div class="diag">${blocks.map(raw)}</div>`;
}

/** Barre d'actions : les trois boutons de reparation, et la fraicheur affichee. */
function actionsBar(st) {
  const checkLabel = _busy ? 'Contrôles en cours…' : 'Relancer les contrôles';
  const fullLabel = _syncing ? 'Collecte en cours…' : 'Relancer une collecte complète';
  const busyAttr = _busy ? ' disabled' : '';

  return toolbar([
    html`<button class="btn btn--sm" type="button" data-act="check"${raw(busyAttr)}>${raw(icon('refresh'))}${checkLabel}</button>`,
    html`<button class="btn btn--sm" type="button" data-act="deep"${raw(busyAttr)}>${raw(icon('diagnostics'))}Contrôle approfondi</button>`,
    html`<button class="btn btn--sm btn--primary" type="button" data-act="full"${raw(_syncing ? ' disabled' : '')}>${raw(icon('download'))}${fullLabel}</button>`,
    '<span class="toolbar-spacer"></span>',
    html`<span class="faint">${freshness(st)}</span>`,
  ]);
}

/** @returns {string} anciennete des controles et des donnees, en clair. */
function freshness(st) {
  const checks = _healthAt ? fmtRelative(_healthAt) : (_busy ? 'en cours…' : 'jamais');
  const data = st && st.at ? fmtRelative(st.at) : '—';
  return 'Contrôles : ' + checks + ' · Données : ' + data;
}

/**
 * Bandeau d'etat general. Le ton suit `status().kind` ; le corps reprend
 * l'avertissement de l'API puis le champ `hint` de /api/health, car ce sont
 * les deux seules phrases ecrites par le serveur qui disent quoi faire.
 */
function banner(st) {
  const kind = String(st && st.kind ? st.kind : '');
  const parts = [];

  if (st && st.warning) parts.push(html`<p>${st.warning}</p>`);

  const hint = _health && typeof _health.hint === 'string' ? _health.hint : '';
  if (hint) parts.push(html`<p>${hint}</p>`);

  const apiStatus = _health && _health.status ? String(_health.status) : '';
  if (apiStatus && apiStatus !== 'ok') {
    parts.push(html`<p>La route <code>/api/health</code> se déclare en état « ${apiStatus} ».</p>`);
  }
  if (_healthError) {
    parts.push(html`<p>Dernière tentative de contrôle en échec : ${_healthError}</p>`);
  }

  let tone = 'info';
  let title = 'État en cours d’évaluation.';
  if (kind === 'ok') {
    tone = 'ok';
    title = 'Chaîne de collecte opérationnelle.';
    if (!parts.length) parts.push(html`<span>Appels, lignes et annuaire ont tous répondu sur la dernière collecte.</span>`);
  } else if (kind === 'warn') {
    tone = 'warn';
    title = 'Collecte partielle.';
    if (!parts.length) parts.push(html`<span>Une source n’a pas répondu ou la période est incomplète : le détail est ci-dessous.</span>`);
  } else if (kind === 'error') {
    tone = 'error';
    title = 'Collecte en échec.';
    if (!parts.length) parts.push(html`<span>L’API n’a rien renvoyé pour les appels. Les chiffres affichés ailleurs peuvent être périmés.</span>`);
  } else {
    if (!parts.length) parts.push(html`<span>Première lecture des trois derniers mois…</span>`);
  }

  return notice({ tone, title, body: parts.map(raw) });
}

/** Grille de faits bruts : ce que l'outil detient reellement en memoire. */
function overview(st) {
  const meta = (st && st.meta) || {};
  const store = (st && st.store) || null;
  const calls = st && st.diag && st.diag.calls ? st.diag.calls : null;
  const total = Number(meta.n) || 0;
  const loading = String(st && st.kind) === 'loading';

  if (loading && !total) {
    return card({
      title: 'État de la collecte',
      sub: 'Lecture des trois derniers mois en cours.',
      body: skeleton('block'),
    });
  }

  const lines = getLines();
  const withTraffic = Array.isArray(meta.csis) ? meta.csis.length : 0;
  const period = meta.min && meta.max ? fmtDate(meta.min) + ' → ' + fmtDate(meta.max) : '—';
  const span = Number(meta.days) || 0;
  const dropped = calls ? Number(calls.dropped) || 0 : 0;
  const rawSeen = calls ? Number(calls.rawSeen) || 0 : 0;

  const cells = [
    diagCell('Appels chargés', fmtInt(total)),
    diagCell('Période couverte', period),
    diagCell(
      'Jours avec appels',
      span ? fmtInt(daysWithCalls(meta)) + ' sur ' + fmtInt(span) : '—',
    ),
    diagCell(
      'Lignes suivies',
      lines.length
        ? fmtInt(lines.length) + ' · ' + fmtInt(withTraffic) + ' avec trafic'
        : '—',
    ),
    diagCell('Archive', store ? (store.enabled ? 'Activée' : 'Désactivée') : 'Inconnue'),
    diagCell('Total archivé', store ? fmtInt(store.total) : '—'),
    diagCell(
      'Dernière sauvegarde',
      store && store.lastSavedAt ? fmtRelative(store.lastSavedAt) : 'Jamais',
    ),
    diagCell('Durée de la dernière collecte', calls ? msText(calls.elapsedMs) : '—'),
    diagCell('Enregistrements bruts vus', calls ? fmtInt(rawSeen) : '—'),
    diagCell('Gardés', calls ? fmtInt(calls.kept) : '—'),
    diagCell(
      'Écartés',
      calls ? fmtInt(dropped) + (rawSeen ? ' · ' + fmtPct((dropped / rawSeen) * 100, 1) : '') : '—',
    ),
  ];

  // Aucune donnee sur la periode : on le dit dans la carte, avec l'action qui
  // la remplit, plutot que d'afficher une grille de zeros sans commentaire.
  const none = !total && !loading
    ? empty(
      'Aucun appel chargé',
      'Lancez « Relancer une collecte complète », ou remplissez un seul mois depuis la couverture mensuelle ci-dessous.',
    )
    : '';

  return card({
    title: 'État de la collecte',
    sub: 'Un appel manqué est un entrant de durée nulle : l’API Keyyo ne fournit aucun indicateur de décroché.',
    body: html`<div class="diag-grid">${cells.map(raw)}</div>${raw(none)}`,
  });
}

/** @returns {string} une cellule de la grille de diagnostic. */
function diagCell(label, value) {
  return html`<div class="diag-cell">
    <div class="diag-cell-label">${label}</div>
    <div class="diag-cell-value">${value}</div>
  </div>`;
}

/**
 * Nombre de jours de la periode qui portent au moins un appel. Calcule depuis
 * la serie continue du store : `meta.days` mesure l'ETENDUE, pas l'occupation,
 * et confondre les deux surestimerait la couverture.
 */
function daysWithCalls(meta) {
  const rows = getRows();
  if (!rows.length || !meta.min || !meta.max) return 0;
  const series = byDay(rows, { from: String(meta.min), to: String(meta.max) });
  let n = 0;
  for (let i = 0; i < series.length; i++) {
    if (Number(series[i].value) > 0) n++;
  }
  return n;
}

/**
 * Erreurs et avertissements remontes par la collecte elle-meme. Section
 * affichee UNIQUEMENT quand il y a quelque chose a montrer : une carte vide
 * « aucune erreur » n'apprendrait rien.
 */
function collectErrors(st) {
  const calls = st && st.diag && st.diag.calls ? st.diag.calls : null;
  if (!calls) return '';

  const errors = Array.isArray(calls.errors) ? calls.errors : [];
  const warnings = Array.isArray(calls.warnings) ? calls.warnings : [];
  const partial = st.diag && Array.isArray(st.diag.partial) ? st.diag.partial : [];
  if (!errors.length && !warnings.length && !partial.length) return '';

  const rows = [];
  for (let i = 0; i < errors.length; i++) {
    const e = errors[i] || {};
    const scope = e.scope ? String(e.scope) : 'inconnue';
    const where = e.csi ? scope + ' · ' + String(e.csi) : scope;
    rows.push([
      html`<span class="mono">${where}</span>`,
      raw(tag('Erreur', 'missed')),
      html`<span>${e.message || 'cause inconnue'}</span>`,
    ]);
  }
  for (let i = 0; i < warnings.length; i++) {
    rows.push([
      html`<span class="mono">collecte</span>`,
      raw(tag('Avertissement', 'in')),
      html`<span>${warnings[i]}</span>`,
    ]);
  }
  for (let i = 0; i < partial.length; i++) {
    rows.push([
      html`<span class="mono">sources</span>`,
      raw(tag('Partiel', 'in')),
      html`<span>${partial[i]}</span>`,
    ]);
  }

  const head = sectionHead(
    'Incidents de la dernière collecte',
    fmtInt(rows.length) + ' ' + pluralize(rows.length, 'incident', 'incidents') + ' remonté'
      + (rows.length > 1 ? 's' : '') + ' par le serveur.',
  );
  const body = table({
    columns: [
      { key: 'scope', label: 'Portée', cls: 'shrink' },
      { key: 'level', label: 'Nature', cls: 'shrink' },
      { key: 'message', label: 'Message' },
    ],
    rows,
  });
  return html`<div>${raw(head)}${raw(card({ flush: true, body }))}</div>`;
}

/** Tableau des controles de /api/health. */
function checksSection() {
  const head = sectionHead(
    'Contrôles',
    'Chaque sonde de /api/health, son verdict et son temps de réponse.',
    apiStatusTag(),
  );

  if (!_health) {
    const body = _busy
      ? skeleton('block')
      : notice({
        tone: 'error',
        title: 'Contrôles indisponibles.',
        body: html`<span>${_healthError || 'La route /api/health n’a pas encore répondu.'}</span> <span>Utilisez « Relancer les contrôles » ; si l’échec persiste, la fonction n’est probablement pas déployée.</span>`,
      });
    return html`<div>${raw(head)}${raw(card({ body }))}</div>`;
  }

  const checks = Array.isArray(_health.checks) ? _health.checks : [];
  const rows = [];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i] || {};
    const level = String(c.level || '');
    const detail = detailText(c.detail);
    const message = detail
      ? html`<div>${c.message || '—'}</div><div class="faint mono">${detail}</div>`
      : html`<div>${c.message || '—'}</div>`;

    rows.push([
      html`<div>${c.label || c.id || 'contrôle sans nom'}</div>`,
      raw(tag(levelLabel(level), levelTone(level))),
      message,
      html`<span>${msText(c.elapsedMs)}</span>`,
    ]);
  }

  const foot = html`<span>${fmtInt(checks.length)} ${pluralize(checks.length, 'contrôle', 'contrôles')} · exécutés en ${msText(_health.elapsedMs)}${_healthDeep ? ' · sonde approfondie' : ''}</span>
    <span class="faint">Schéma ${_health.schemaVersion == null ? '—' : String(_health.schemaVersion)}</span>`;

  const body = checks.length
    ? table({
      columns: [
        { key: 'label', label: 'Contrôle', cls: 'strong' },
        { key: 'level', label: 'Résultat', cls: 'shrink' },
        { key: 'message', label: 'Message' },
        { key: 'elapsed', label: 'Temps', align: 'right', cls: 'shrink' },
      ],
      rows,
      foot,
    })
    : empty(
      'Aucun contrôle renvoyé',
      'La route a répondu sans liste de contrôles : vérifiez la version déployée de /api/health.',
    );

  const after = [];
  // Un rechargement en echec ne doit pas effacer le verdict precedent : on le
  // garde a l'ecran et on dit clairement qu'il est date.
  if (_healthError) {
    after.push(notice({
      tone: 'warn',
      title: 'Verdict daté.',
      body: html`<span>La dernière tentative a échoué (${_healthError}). Les contrôles ci-dessus datent de ${_healthAt ? fmtRelative(_healthAt) : 'la dernière réponse connue'}.</span>`,
    }));
  }
  // Honnetete sur le controle approfondi : s'il n'a laisse aucune trace dans la
  // reponse, on ne laisse pas croire qu'il a eu lieu.
  if (_healthDeep && !hasDeepEvidence(_health)) {
    after.push(notice({
      tone: 'warn',
      title: 'Sonde approfondie non confirmée.',
      body: html`<span>Le contrôle approfondi a été demandé, mais la réponse ne porte aucune trace de sonde de relève d’appels (ni champ <code>deep</code>, ni contrôle correspondant). La route l’a peut-être ignoré : traitez le résultat ci-dessus comme un contrôle standard.</span>`,
    }));
  }

  return html`<div>${raw(head)}${raw(card({ flush: true, body }))}${after.map(raw)}</div>`;
}

/** @returns {string} etiquette d'etat de l'API, posee dans l'en-tete des controles. */
function apiStatusTag() {
  if (!_health) return '';
  const s = String(_health.status || '');
  if (s === 'ok') return tag('API en ordre', 'ok');
  if (s === 'empty') return tag('Aucune donnée', 'in');
  if (s === 'warn') return tag('Avertissement', 'in');
  if (s === 'error') return tag('Erreur', 'missed');
  return tag(s || 'état inconnu', 'neutral');
}

/** @param {string} level @returns {'ok'|'in'|'missed'|'neutral'} */
function levelTone(level) {
  if (level === 'ok') return 'ok';
  if (level === 'warn') return 'in';
  if (level === 'error') return 'missed';
  return 'neutral';
}

/** @param {string} level @returns {string} */
function levelLabel(level) {
  if (level === 'ok') return 'OK';
  if (level === 'warn') return 'Avertissement';
  if (level === 'error') return 'Erreur';
  return level || 'inconnu';
}

/**
 * Trace d'une sonde approfondie dans la reponse : un champ `deep` vrai, ou un
 * controle dont l'identifiant la nomme.
 * @param {any} health
 * @returns {boolean}
 */
function hasDeepEvidence(health) {
  if (!health || typeof health !== 'object') return false;
  if (health.deep) return true;
  const checks = Array.isArray(health.checks) ? health.checks : [];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i] || {};
    const text = String(c.id || '') + ' ' + String(c.label || '');
    if (/deep|approfond/i.test(text)) return true;
  }
  return false;
}

/**
 * Rapprochement ligne -> personne, ligne par ligne, avec sa source, sa
 * confiance et son indice. Puis la boucle de reparation : la variable
 * d'environnement a coller pour les lignes restees sans adresse.
 */
function identitySection(st) {
  const lines = getLines();
  const head = sectionHead(
    'Rapprochement des identités',
    'L’API Keyyo ne relie pas une ligne à une personne : chaque association est déduite, et affiche sur quoi elle repose.',
  );

  if (!lines.length) {
    const body = String(st && st.kind) === 'loading'
      ? skeleton('block')
      : empty(
        'Aucune ligne Keyyo détectée',
        'Vérifiez que le jeton porte sur le bon compte et que le scope full_access_read_only est accordé, puis relancez les contrôles.',
      );
    return html`<div>${raw(head)}${raw(card({ body }))}</div>`;
  }

  const reasons = unresolvedReasons(st);
  const rows = [];
  const unresolved = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || {};
    const person = line.person || null;
    const csi = String(line.csi || '');
    const resolved = !!(person && person.email);
    if (!resolved) unresolved.push(line);

    const confidence = person ? Number(person.confidence) : NaN;
    const evidence = person && person.evidence
      ? String(person.evidence)
      : (reasons.get(digitsOf(csi)) || 'aucun candidat : ni contact d’annuaire au bon numéro, ni nom de ligne exploitable');

    rows.push([
      html`<div class="cell-id">
        ${raw(avatar(line.label, { size: 'sm', tone: resolved ? null : 'missed' }))}
        <div class="cell-id-body">
          <div class="cell-id-name">${line.label || '—'}</div>
          <div class="cell-id-sub mono">${line.formattedCsi || csi || '—'}</div>
        </div>
      </div>`,
      raw(person
        ? tag(sourceLabel(person.source), confidenceTone(confidence))
        : tag('aucune', 'missed')),
      html`<span>${isFinite(confidence) ? fmtPct(confidence * 100, 0) : '—'}</span>`,
      html`<span>${evidence}</span>`,
    ]);
  }

  const foot = html`<span>${fmtInt(lines.length)} ${pluralize(lines.length, 'ligne', 'lignes')} · ${fmtInt(unresolved.length)} sans adresse e-mail</span>`;
  const body = table({
    columns: [
      { key: 'line', label: 'Ligne', cls: 'strong' },
      { key: 'source', label: 'Source', cls: 'shrink' },
      { key: 'confidence', label: 'Confiance', align: 'right', cls: 'shrink' },
      { key: 'evidence', label: 'Indice' },
    ],
    rows,
    foot,
  });

  const repair = unresolved.length ? envBlock(unresolved.length) : '';
  return html`<div>${raw(head)}${raw(card({ flush: true, body }))}${raw(repair)}</div>`;
}

/**
 * Bloc a copier-coller : la ligne KEYYO_LINE_EMAILS complete. C'est la seule
 * reparation possible quand aucune source d'identite ne suffit.
 * @param {number} count  Nombre de lignes non resolues.
 */
function envBlock(count) {
  const line = envLine();
  if (!line) return '';

  const body = html`<div class="diag-copy">
    <p class="muted">${fmtInt(count)} ${pluralize(count, 'ligne', 'lignes')} sans adresse e-mail rattachée. Collez cette ligne dans les variables d’environnement Vercel (Settings → Environment Variables), remplacez chaque gabarit « prenom.nom@… » par la vraie adresse, puis redéployez.</p>
    <code data-copy-text>${line}</code>
    <div class="row row--wrap">
      <button class="btn btn--sm" type="button" data-act="copy">${raw(icon('download'))}Copier</button>
      <span class="faint" data-copy-msg>${_copyMsg}</span>
    </div>
  </div>`;

  return card({ title: 'Corriger les identités', body });
}

/**
 * Ligne KEYYO_LINE_EMAILS. On prefere la suggestion du serveur (elle connait
 * le domaine reellement utilise) et on la reconstruit seulement si /api/team
 * n'a pas repondu.
 * @returns {string}
 */
function envLine() {
  const st = status();
  const team = st && st.diag && st.diag.team ? st.diag.team : null;
  const suggested = team && typeof team.suggestion === 'string' ? team.suggestion.trim() : '';
  if (suggested) return suggested;

  const lines = getLines();
  if (!lines.length) return '';

  const domain = guessDomain(lines);
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || {};
    const csi = String(line.csi || '');
    if (!csi) continue;
    const email = line.person && line.person.email ? String(line.person.email) : '';
    pairs.push(csi + '=' + (email || 'prenom.nom@' + domain));
  }
  return pairs.length ? 'KEYYO_LINE_EMAILS=' + pairs.join(',') : '';
}

/**
 * Domaine le plus represente parmi les adresses connues : proposer un domaine
 * faux ferait recopier une erreur.
 * @param {any[]} lines
 * @returns {string}
 */
function guessDomain(lines) {
  /** @type {Map<string, number>} */
  const tally = new Map();
  for (let i = 0; i < lines.length; i++) {
    const person = lines[i] && lines[i].person;
    const email = person && person.email ? String(person.email) : '';
    const at = email.lastIndexOf('@');
    if (at <= 0) continue;
    const domain = email.slice(at + 1).toLowerCase();
    if (domain) tally.set(domain, (tally.get(domain) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const entry of tally) {
    if (entry[1] > bestCount) { best = entry[0]; bestCount = entry[1]; }
  }
  return best || 'exemple.fr';
}

/**
 * Raisons de non-resolution renvoyees par /api/team, indexees par CSI en
 * chiffres seuls (les formes varient d'une source a l'autre).
 * @param {any} st
 * @returns {Map<string, string>}
 */
function unresolvedReasons(st) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const team = st && st.diag && st.diag.team ? st.diag.team : null;
  const list = team && Array.isArray(team.unresolved) ? team.unresolved : [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item) continue;
    const key = digitsOf(item.csi);
    if (key && item.reason) map.set(key, String(item.reason));
  }
  return map;
}

/** @param {string} source @returns {string} nom lisible de la regle de rapprochement. */
function sourceLabel(source) {
  const s = String(source || '');
  if (s === 'override') return 'Réglage manuel';
  if (s === 'directory_number') return 'Annuaire (numéro)';
  if (s === 'directory_short_number') return 'Annuaire (numéro abrégé)';
  if (s === 'directory_name') return 'Annuaire (nom approché)';
  if (s === 'email_account_name') return 'Compte e-mail (nom approché)';
  if (s === 'line_name') return 'Nom de la ligne';
  return s || 'inconnue';
}

/** @param {number} confidence 0 a 1 @returns {'ok'|'in'|'missed'} */
function confidenceTone(confidence) {
  const c = Number(confidence);
  if (!isFinite(c)) return 'missed';
  if (c >= 0.9) return 'ok';
  if (c >= 0.6) return 'in';
  return 'missed';
}

/**
 * Couverture mensuelle : ce qui est collecte, ce qui manque, et le lien qui
 * remplit un mois. Le perimetre vise est de trois mois.
 */
function coverageSection(st) {
  const coverage = st && st.diag && st.diag.coverage && typeof st.diag.coverage === 'object'
    ? st.diag.coverage
    : {};
  const store = (st && st.store) || null;
  const missing = store && Array.isArray(store.missingMonths) ? store.missingMonths : [];

  /** @type {Set<string>} */
  const months = new Set();
  const covered = Object.keys(coverage);
  for (let i = 0; i < covered.length; i++) {
    if (MONTH_RE.test(covered[i])) months.add(covered[i]);
  }
  for (let i = 0; i < missing.length; i++) {
    const ym = String(missing[i]);
    if (MONTH_RE.test(ym)) months.add(ym);
  }
  const ordered = Array.from(months).sort().reverse();

  const head = sectionHead(
    'Couverture mensuelle',
    'Périmètre visé : les trois derniers mois. Un mois manquant se remplit sans toucher aux autres.',
  );

  if (!ordered.length) {
    const body = String(st && st.kind) === 'loading'
      ? skeleton('block')
      : empty(
        'Aucun mois collecté',
        'Lancez « Relancer une collecte complète » pour balayer les trois derniers mois.',
      );
    return html`<div>${raw(head)}${raw(card({ body }))}</div>`;
  }

  /** @type {Set<string>} */
  const missingSet = new Set();
  for (let i = 0; i < missing.length; i++) missingSet.add(String(missing[i]));

  const rows = [];
  for (let i = 0; i < ordered.length; i++) {
    const ym = ordered[i];
    const entry = coverage[ym] && typeof coverage[ym] === 'object' ? coverage[ym] : null;
    const count = entry ? Number(entry.count) || 0 : 0;
    const isMissing = missingSet.has(ym) || !entry;

    let state;
    if (isMissing) state = tag('manquant', 'missed');
    else if (!count) state = tag('vide', 'in');
    else state = tag('collecté', 'ok');

    rows.push([
      html`<div>${fmtMonth(ym) || ym}</div><div class="faint mono">${ym}</div>`,
      raw(state),
      html`<span>${entry ? fmtInt(count) : '—'}</span>`,
      html`<span>${entry && entry.syncedAt ? fmtRelative(entry.syncedAt) : '—'}</span>`,
      html`<a class="link" href="/api/sync?month=${ym}" target="_blank" rel="noopener noreferrer">Collecter ce mois</a>`,
    ]);
  }

  const foot = missing.length
    ? html`<span>${fmtInt(missing.length)} ${pluralize(missing.length, 'mois manquant', 'mois manquants')} : la synchronisation planifiée les complétera, ou utilisez les liens ci-dessus pour ne pas attendre.</span>`
    : html`<span>Les trois derniers mois sont couverts.</span>`;

  const body = table({
    columns: [
      { key: 'month', label: 'Mois', cls: 'strong' },
      { key: 'state', label: 'État', cls: 'shrink' },
      { key: 'count', label: 'Appels', align: 'right', cls: 'shrink' },
      { key: 'synced', label: 'Dernière synchro', cls: 'shrink' },
      { key: 'action', label: 'Action', cls: 'shrink' },
    ],
    rows,
    foot,
  });

  return html`<div>${raw(head)}${raw(card({ flush: true, body }))}</div>`;
}

/**
 * Rejets a la normalisation. Un taux de rejet non nul signifie qu'on perd des
 * appels, et on le dit — mais les releves non vocaux (SMS, data) ne sont PAS
 * des appels : les compter comme une perte declencherait une fausse alerte.
 */
function dropSection(st) {
  const calls = st && st.diag && st.diag.calls ? st.diag.calls : null;
  if (!calls) return '';

  const dropped = Number(calls.dropped) || 0;
  const rawSeen = Number(calls.rawSeen) || 0;
  const head = sectionHead(
    'Rejets à la normalisation',
    'Enregistrements bruts vus chez Keyyo mais non convertis en appels.',
  );

  if (dropped <= 0) {
    return html`<div>${raw(head)}${raw(card({
      body: notice({
        tone: 'ok',
        title: 'Aucun rejet.',
        body: html`<span>Les ${fmtInt(rawSeen)} ${pluralize(rawSeen, 'enregistrement', 'enregistrements')} du dernier relevé ont tous été convertis en appels.</span>`,
      }),
    }))}</div>`;
  }

  const reasons = calls.dropReasons && typeof calls.dropReasons === 'object' ? calls.dropReasons : {};
  const keys = Object.keys(reasons);
  const entries = [];
  let expected = 0;
  let unexpected = 0;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const n = Number(reasons[key]) || 0;
    const ok = EXPECTED_DROP.test(key);
    if (ok) expected += n; else unexpected += n;
    entries.push({ key, n, ok });
  }
  entries.sort((a, b) => b.n - a.n);

  const rows = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const pct = rawSeen ? (e.n / rawSeen) * 100 : 0;
    rows.push([
      html`<span>${e.key}</span>`,
      raw(e.ok ? tag('attendu', 'ok') : tag('perte', 'missed')),
      html`<span>${fmtInt(e.n)}</span>`,
      html`<span>${rawSeen ? fmtPct(pct, 1) : '—'}</span>`,
      raw(meter(pct, e.ok ? 'ok' : 'missed')),
    ]);
  }

  const body = table({
    columns: [
      { key: 'reason', label: 'Raison', cls: 'strong' },
      { key: 'kind', label: 'Nature', cls: 'shrink' },
      { key: 'count', label: 'Nombre', align: 'right', cls: 'shrink' },
      { key: 'share', label: 'Part du brut', align: 'right', cls: 'shrink' },
      { key: 'bar', label: '' },
    ],
    rows,
    foot: html`<span>${fmtInt(dropped)} ${pluralize(dropped, 'rejet', 'rejets')} sur ${fmtInt(rawSeen)} ${pluralize(rawSeen, 'enregistrement', 'enregistrements')} bruts</span>`,
  });

  const verdict = unexpected > 0
    ? notice({
      tone: 'error',
      title: 'Des appels sont perdus.',
      body: html`<span>${fmtInt(unexpected)} ${pluralize(unexpected, 'enregistrement', 'enregistrements')} ${pluralize(unexpected, 'rejeté', 'rejetés')} pour une raison qui n’est pas attendue${rawSeen ? html`, soit ${fmtPct((unexpected / rawSeen) * 100, 1)} du brut` : ''} : autant d’appels absents de tous les chiffres affichés. Les raisons ci-dessus nomment la cause ; relancez une collecte complète après correction.</span>`,
    })
    : notice({
      tone: 'ok',
      title: 'Rejets tous légitimes.',
      body: html`<span>Les ${fmtInt(expected)} ${pluralize(expected, 'rejet', 'rejets')} sont des relevés non vocaux (SMS, data) : ils portent un compte d’unités et non une durée, donc les garder les ferait passer pour des appels non décrochés.</span>`,
    });

  return html`<div>${raw(head)}${raw(card({ flush: true, body }))}${raw(verdict)}</div>`;
}

/** Detail brut, replie : utile pour un rapport, encombrant a l'ecran. */
function rawSection(st) {
  const action = html`<button class="btn btn--sm" type="button" data-act="raw" aria-expanded="${_rawOpen ? 'true' : 'false'}">${raw(icon('chevron'))}${_rawOpen ? 'Masquer' : 'Afficher'}</button>`;

  let body = '';
  if (_rawOpen) {
    const blob = {
      status: st ? { kind: st.kind, at: st.at, empty: st.empty, warning: st.warning } : null,
      meta: st ? maskSecrets(st.meta) : null,
      store: st ? maskSecrets(st.store) : null,
      diag: st ? maskSecrets(st.diag) : null,
      health: maskSecrets(_health),
      healthError: _healthError || null,
      healthAt: _healthAt || null,
    };
    body = html`<pre class="diag-pre" tabindex="0">${jsonText(blob, 2)}</pre>`;
  }

  return card({
    title: 'Détail brut',
    sub: 'Diagnostic intégral, valeurs sensibles masquées.',
    action,
    body,
  });
}

// -----------------------------------------------------------------------------
//  Masquage et serialisation
// -----------------------------------------------------------------------------

/**
 * Copie masquee d'une valeur : la valeur de toute cle dont le NOM contient
 * token, secret, key, password ou authorization est remplacee.
 *
 * Le filtre est volontairement large (il attrape `apiKey` comme
 * `Authorization`) : afficher un secret est irreversible, masquer un champ
 * anodin ne coute qu'une ligne de JSON.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function maskSecrets(value) {
  return maskAt(value, 0, new Set());
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {Set<object>} seen  Chemin courant, pour couper les cycles.
 * @returns {unknown}
 */
function maskAt(value, depth, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MASK_MAX_DEPTH) return '… profondeur maximale atteinte';
  if (seen.has(/** @type {object} */ (value))) return '… référence circulaire';

  seen.add(/** @type {object} */ (value));
  let out;
  if (Array.isArray(value)) {
    out = [];
    for (let i = 0; i < value.length; i++) out.push(maskAt(value[i], depth + 1, seen));
  } else {
    out = {};
    const keys = Object.keys(/** @type {object} */ (value));
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      out[key] = SECRET_KEY.test(key)
        ? MASK
        : maskAt(/** @type {any} */ (value)[key], depth + 1, seen);
    }
  }
  // Retire du chemin apres descente : deux references vers le meme objet ne
  // sont pas un cycle, et doivent etre masquees toutes les deux.
  seen.delete(/** @type {object} */ (value));
  return out;
}

/**
 * Detail d'un controle, masque puis raccourci pour tenir dans une cellule.
 * @param {unknown} detail
 * @returns {string}
 */
function detailText(detail) {
  if (detail === null || detail === undefined || detail === '') return '';
  const masked = maskSecrets(detail);
  const text = typeof masked === 'string' ? masked : jsonText(masked, 0);
  if (!text) return '';
  return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX) + ' …' : text;
}

/**
 * JSON lisible, sans jamais jeter : une structure imprevue ne doit pas vider
 * la page de diagnostic, c'est precisement celle qu'on consulte quand tout va
 * mal.
 * @param {unknown} value
 * @param {number} indent
 * @returns {string}
 */
function jsonText(value, indent) {
  try {
    const text = JSON.stringify(value, null, indent);
    return typeof text === 'string' ? text : '';
  } catch (err) {
    console.warn('[diagnostics] serialisation JSON impossible :', err);
    return 'Contenu non sérialisable en JSON.';
  }
}

// -----------------------------------------------------------------------------
//  Petits outils
// -----------------------------------------------------------------------------

/**
 * Duree en millisecondes, telle que la renvoie l'API. En dessous de la seconde
 * on garde les millisecondes : c'est l'echelle utile pour un temps de reponse.
 * @param {unknown} ms
 * @returns {string}
 */
function msText(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1000) return fmtInt(n) + ' ms';
  return fmtDuration(Math.round(n / 1000));
}

/** @param {unknown} v @returns {string} chiffres seuls : forme de comparaison des CSI. */
function digitsOf(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

/**
 * Message d'erreur exploitable. `ApiError` porte le code HTTP : le dire evite
 * le « echec du chargement » qui n'aide personne.
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  if (!err) return 'cause inconnue';
  const any = /** @type {any} */ (err);
  if (any.status) return 'HTTP ' + any.status + ' — ' + (any.message || 'erreur');
  return String(any.message || any);
}
