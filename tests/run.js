// =============================================================================
//  tests/run.js — Verification du noyau, dans le navigateur, sans outillage.
//
//  POURQUOI CE FICHIER PLUTOT QU'UNE SUITE DE TESTS CLASSIQUE : le projet est
//  en zero-build (voir docs/ARCHITECTURE.md). Il n'y a ni bundler, ni
//  installation de dependances, donc pas de lanceur de tests. Le harnais tient
//  ici, en une centaine de lignes, et s'execute dans le meme moteur que
//  l'application : ce qui passe ici passe pour de vrai.
//
//  COMMENT L'EXECUTER : ouvrir `/selftest.html` sur le deploiement. Les modules
//  ES exigent une origine HTTP — un double-clic sur le fichier (`file://`) est
//  refuse par le navigateur, ce n'est pas un bug de la page.
//
//  CE QUI EST COUVERT :
//    1. le CONTRAT : chaque module se charge et exporte ce que
//       docs/ARCHITECTURE.md declare. C'est ce controle qui attrape une erreur
//       de syntaxe, un import casse ou un export disparu ;
//    2. le NOYAU PUR (`shared/`) : numeros, dates, schema, normalisation CDR,
//       identites — la ou une erreur fausse des chiffres credibles ;
//    3. les FONCTIONS PURES DU FRONT : mise en forme francaise, echappement
//       HTML, agregations du store (dont l'analyse des rappels), et un passage
//       de fumee sur les graphiques et les briques d'interface.
//
//  CE QUI N'EST PAS COUVERT : tout ce qui exige le reseau ou la coquille de
//  index.html (collecte, rendu des sept vues, alertes). La page Diagnostic de
//  l'application couvre ce terrain-la, en conditions reelles.
// =============================================================================

// -----------------------------------------------------------------------------
//  Harnais
// -----------------------------------------------------------------------------

/** @type {Array<{suite: string, name: string, ok: boolean, skipped: boolean, detail: string}>} */
const RESULTS = [];

let _suite = '(sans groupe)';

/** @param {string} name @param {() => void} fn */
function suite(name, fn) {
  _suite = name;
  try {
    fn();
  } catch (err) {
    // Un groupe qui explose hors d'un test (montage de donnees rate) doit se
    // voir comme un echec, pas disparaitre.
    RESULTS.push({ suite: name, name: '(montage du groupe)', ok: false, skipped: false, detail: errText(err) });
  }
}

/** @param {string} name @param {() => void} fn */
function test(name, fn) {
  try {
    fn();
    RESULTS.push({ suite: _suite, name, ok: true, skipped: false, detail: '' });
  } catch (err) {
    RESULTS.push({ suite: _suite, name, ok: false, skipped: false, detail: errText(err) });
  }
}

/** @param {string} name @param {string} why */
function skip(name, why) {
  RESULTS.push({ suite: _suite, name, ok: false, skipped: true, detail: why });
}

/** Echec explicite. @param {string} msg */
function fail(msg) {
  throw new Error(msg);
}

/** @param {unknown} cond @param {string} msg */
function ok(cond, msg) {
  if (!cond) fail(msg || 'condition fausse');
}

/** Egalite stricte, avec les deux valeurs dans le message. */
function eq(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    fail((msg ? msg + ' — ' : '') + 'attendu ' + show(expected) + ', obtenu ' + show(actual));
  }
}

/** Egalite structurelle, via JSON. Suffisant pour des donnees plates. */
function eqDeep(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail((msg ? msg + ' — ' : '') + 'attendu ' + b + ', obtenu ' + a);
}

/** Egalite numerique a epsilon pres. */
function close(actual, expected, eps, msg) {
  const e = eps == null ? 1e-9 : eps;
  if (!(Math.abs(Number(actual) - Number(expected)) <= e)) {
    fail((msg ? msg + ' — ' : '') + 'attendu ' + expected + ' +/- ' + e + ', obtenu ' + actual);
  }
}

/** La chaine contient le fragment. */
function has(hay, needle, msg) {
  if (String(hay).indexOf(needle) < 0) {
    fail((msg ? msg + ' — ' : '') + 'fragment absent : ' + show(needle) + ' dans ' + show(clip(hay)));
  }
}

/** La chaine NE contient PAS le fragment (controle d'echappement). */
function lacks(hay, needle, msg) {
  if (String(hay).indexOf(needle) >= 0) {
    fail((msg ? msg + ' — ' : '') + 'fragment interdit present : ' + show(needle) + ' dans ' + show(clip(hay)));
  }
}

/** L'appel doit lever. */
function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch (err) { threw = true; }
  if (!threw) fail(msg || 'un appel qui devait lever ne leve pas');
}

/**
 * Ramene toutes les espaces (y compris insecables et fines) a une espace
 * ordinaire. La mise en forme francaise en emploie plusieurs sortes : comparer
 * les octets exacts rendrait les tests illisibles et fragiles.
 * @param {unknown} s
 */
function ws(s) {
  return String(s).replace(/[\s   ]+/g, ' ').trim();
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v); } catch (err) { return String(v); }
}

function clip(s) {
  const t = String(s);
  return t.length > 160 ? t.slice(0, 160) + '…' : t;
}

function errText(err) {
  if (!err) return 'erreur inconnue';
  const name = err.name ? err.name + ' : ' : '';
  return name + (err.message || String(err));
}

// -----------------------------------------------------------------------------
//  1. Contrat — chaque module se charge et exporte ce qui est declare
// -----------------------------------------------------------------------------

/**
 * Le contrat de docs/ARCHITECTURE.md, transcrit. Toute divergence entre cette
 * liste et le code est un bug de l'un des deux : c'est exactement ce qu'on
 * veut voir echouer.
 */
const CONTRACT = [
  ['../shared/phone.js', ['DEFAULT_CC', 'toE164', 'isAnonymous', 'isShortNumber', 'formatNumber', 'numberKind', 'indexByNumber']],
  ['../shared/time.js', ['DEFAULT_TZ', 'safeTz', 'parseTimestamp', 'isPlausibleDate', 'localParts', 'toKeyyoDate', 'isoDaysAgo', 'todayIso', 'monthSlices', 'nextDay', 'daysBetween']],
  ['../shared/schema.js', ['SCHEMA_VERSION', 'FIELDS', 'F', 'ROW_LENGTH', 'isMissed', 'isIncoming', 'isOutgoing', 'rowKey', 'toObject', 'fromObject', 'isValidRow']],
  ['../shared/cdr.js', ['normalizeCdr', 'extractRecords', 'nextLink']],
  ['../shared/identity.js', ['capitalizeName', 'normalizeName', 'nameTokens', 'isEmail', 'nameFromEmail', 'firstNameFromEmail', 'nameSimilarity', 'NAME_MATCH_THRESHOLD', 'resolveLineIdentities', 'lineTeams', 'lineLabel', 'initialsOf', 'parseLineEmails', 'isPhoneCsi', 'formatCsi']],
  ['../shared/roles.js', ['ROLE_DIRECTION', 'ROLE_AGENT', 'ROLES', 'POLICY', 'parseEmailList', 'roleFromClaims', 'allowedRoles', 'canAccess', 'isDirection', 'roleLabel']],
  ['../shared/journal.js', ['EVENT_TYPES', 'JOURNAL_VERSION', 'DIR_IN', 'DIR_OUT', 'eventId', 'normalizeEvent', 'isValidEvent', 'mergeEvents', 'monthOf', 'summarize']],

  ['../app/format.js', ['fmtInt', 'fmtPct', 'fmtDuration', 'fmtDurationShort', 'fmtHms', 'fmtDate', 'fmtDateLong', 'fmtDayShort', 'fmtTime', 'fmtMonth', 'fmtClock', 'fmtRelative', 'WEEKDAYS', 'pluralize']],
  ['../app/dom.js', ['esc', 'h', 'html', 'raw', 'mount', 'qs', 'qsa', 'on', 'icon']],
  ['../app/charts.js', ['barChart', 'areaChart', 'donutChart', 'heatmap', 'sparkline', 'attachChartTips']],
  ['../app/ui.js', ['card', 'sectionHead', 'kpi', 'statbar', 'table', 'tag', 'avatar', 'avatarStack', 'meter', 'split', 'rankRow', 'empty', 'notice', 'skeleton', 'toolbar']],
  ['../app/api.js', ['getCalls', 'getTeam', 'getDirectory', 'getHealth', 'getMe', 'getProfile', 'postCtiToken', 'postEvents', 'getEvents', 'postSync', 'ApiError']],
  ['../app/session.js', ['LOGIN_URL', 'LOGOUT_URL', 'resolve', 'current', 'isDirection', 'roleLabel', 'loginUrl', 'forget']],
  ['../app/journal.js', ['subscribe', 'record', 'flush', 'status', 'month', 'init']],
  ['../app/cti.js', ['subscribe', 'snapshot', 'start', 'stop', 'chooseLine', 'enablePlugin', 'autoAnswer', 'setAutoAnswer', 'dial', 'answer', 'reject', 'hangup', 'transfer', 'claim']],
  ['../app/callbar.js', ['init', 'setColleagues', 'setLabelOf']],
  // agent.js ne s'amorce que si #agent-root est present : importable ici.
  ['../app/agent.js', ['boot']],
  ['../app/store.js', ['state', 'setFilter', 'subscribe', 'getRows', 'filtered', 'getLines', 'lineByCsi', 'nameOf', 'labelOf', 'stats', 'byDay', 'byMonth', 'byHour', 'byWeekday', 'heatMatrix', 'byLine', 'byPeer', 'callbackAnalysis', 'trend', 'load', 'status', 'journal', 'loadJournal']],
  ['../app/router.js', ['ROUTES', 'start', 'go', 'current']],
  ['../app/alerts.js', ['init', 'check', 'toast', 'renderCenter', 'unreadCount', 'markAllRead']],

  ['../app/pages/monitoring.js', ['render']],
  ['../app/pages/calls.js', ['render']],
  ['../app/pages/missed.js', ['render']],
  ['../app/pages/peers.js', ['render']],
  ['../app/pages/people.js', ['render']],
  ['../app/pages/agents.js', ['render']],
  ['../app/pages/lines.js', ['render']],
  ['../app/pages/diagnostics.js', ['render']],

  // main.js ne s'amorce que si la coquille de index.html est presente : il est
  // donc importable ici sans declencher de collecte.
  ['../app/main.js', ['boot']],
];

/** @type {Record<string, any>} espaces de noms charges, par chemin. */
const NS = {};

_suite = 'Contrat des modules';
for (const [path, names] of CONTRACT) {
  let mod = null;
  let loadError = '';
  try {
    mod = await import(path);
    NS[path] = mod;
  } catch (err) {
    loadError = errText(err);
  }

  if (loadError) {
    RESULTS.push({ suite: _suite, name: path + ' se charge', ok: false, skipped: false, detail: loadError });
    continue;
  }
  RESULTS.push({ suite: _suite, name: path + ' se charge', ok: true, skipped: false, detail: '' });

  const missing = names.filter((n) => mod[n] === undefined);
  RESULTS.push({
    suite: _suite,
    name: path + ' exporte les ' + names.length + ' symboles du contrat',
    ok: missing.length === 0,
    skipped: false,
    detail: missing.length ? 'manquants : ' + missing.join(', ') : '',
  });
}

const phone = NS['../shared/phone.js'];
const time = NS['../shared/time.js'];
const schema = NS['../shared/schema.js'];
const cdr = NS['../shared/cdr.js'];
const identity = NS['../shared/identity.js'];
const roles = NS['../shared/roles.js'];
const journalMod = NS['../shared/journal.js'];
const sessionMod = NS['../app/session.js'];
const ctiMod = NS['../app/cti.js'];
const format = NS['../app/format.js'];
const dom = NS['../app/dom.js'];
const charts = NS['../app/charts.js'];
const ui = NS['../app/ui.js'];
const store = NS['../app/store.js'];
const router = NS['../app/router.js'];

/** Saute un groupe entier quand son module ne s'est pas charge. */
function need(mod, name, label) {
  if (mod) return true;
  _suite = name;
  skip('(groupe entier)', 'module non charge : ' + label);
  return false;
}

// -----------------------------------------------------------------------------
//  2. shared/phone.js
// -----------------------------------------------------------------------------

if (need(phone, 'shared/phone.js', 'shared/phone.js')) suite('shared/phone.js', () => {
  const { toE164, isAnonymous, isShortNumber, formatNumber, numberKind, indexByNumber } = phone;

  test('les quatre ecritures d’un meme fixe donnent la meme cle', () => {
    const expected = '+33253359565';
    eq(toE164('02 53 35 95 65'), expected, 'national espace');
    eq(toE164('+33 2 53 35 95 65'), expected, 'international espace');
    eq(toE164('0033253359565'), expected, 'prefixe 00');
    eq(toE164('33253359565'), expected, 'sans prefixe');
    eq(toE164('02.53.35.95.65'), expected, 'points');
    // Zero de transit : la notation la plus repandue dans un carnet d'adresses.
    // Sans son retrait, le meme poste produirait deux cles differentes et le
    // rapprochement avec l'annuaire echouerait sur l'une des deux.
    eq(toE164('+33 (0)2 53 35 95 65'), expected, 'zero de transit entre parentheses');
    eq(toE164('0033 (0)2 53 35 95 65'), expected, 'zero de transit derriere 00');
  });

  test('le retrait du zero de transit ne touche pas les numeros etrangers', () => {
    // Le NSN italien commence legitimement par 0 : l'indicatif n'etant pas +33,
    // la regle ne s'applique pas.
    eq(toE164('+39 02 1234 5678'), '+390212345678');
    eq(toE164('+44 20 7123 4567'), '+442071234567');
  });

  test('toE164 est idempotente', () => {
    for (const n of ['02 53 35 95 65', '+33612345678', 'anonymous', '101', '']) {
      eq(toE164(toE164(n)), toE164(n), 'sur ' + show(n));
    }
  });

  test('appelant masque : toutes les variantes tombent sur anonymous', () => {
    for (const n of ['anonymous', 'ANONYME', 'Restricted', 'unknown', 'private', 'masque']) {
      eq(toE164(n), 'anonymous', 'sur ' + show(n));
    }
    eq(isAnonymous('ANONYME'), true);
    eq(isAnonymous('+33612345678'), false);
  });

  test('entrees inexploitables : chaine vide, jamais une exception', () => {
    eq(toE164(null), '');
    eq(toE164(undefined), '');
    eq(toE164(''), '');
    eq(toE164('   '), '');
    eq(toE164('abc'), '');
    eq(toE164('+'), '');
    eq(toE164('+12345'), '', 'moins de 6 chiffres : hors plage E.164');
    eq(toE164('+1234567890123456'), '', 'plus de 15 chiffres : hors plage E.164');
  });

  test('les postes internes restent tels quels, sans faux indicatif', () => {
    eq(toE164('101'), '101');
    eq(toE164('4242'), '4242');
    eq(isShortNumber('101'), true);
    eq(isShortNumber('+33253359565'), false);
    eq(isShortNumber('anonymous'), false);
  });

  test('formatNumber rend un numero lisible ou un repere explicite', () => {
    eq(formatNumber('+33253359565'), '02 53 35 95 65');
    eq(formatNumber('0612345678'), '06 12 34 56 78');
    eq(formatNumber('anonymous'), 'Masqué');
    eq(formatNumber(''), '—');
    eq(formatNumber('101'), '101');
    eq(formatNumber('+34931234567'), '+34 93 12 34 56 7', 'international : paires apres l’indicatif');
  });

  test('numberKind distingue les six natures de numero', () => {
    eq(numberKind('+33612345678'), 'mobile');
    eq(numberKind('+33712345678'), 'mobile');
    eq(numberKind('+33253359565'), 'fixe');
    eq(numberKind('+33805123456'), 'special');
    eq(numberKind('+442071234567'), 'international');
    eq(numberKind('101'), 'internal');
    eq(numberKind('anonymous'), 'anonymous');
    eq(numberKind(''), 'inconnu');
  });

  test('indexByNumber normalise les cles et garde la premiere valeur', () => {
    const idx = indexByNumber([
      ['02 53 35 95 65', 'Accueil'],
      ['+33253359565', 'Doublon ignore'],
      ['anonymous', 'Masque'],
      ['+33612345678', ''],
      ['', 'Sans numero'],
    ]);
    eq(idx['+33253359565'], 'Accueil', 'la premiere source gagne');
    eq(idx.anonymous, undefined, 'un masque n’entre pas dans l’index');
    eq(idx['+33612345678'], undefined, 'une valeur vide n’entre pas dans l’index');
    eq(Object.keys(idx).length, 1);
  });
});

// -----------------------------------------------------------------------------
//  3. shared/time.js
// -----------------------------------------------------------------------------

if (need(time, 'shared/time.js', 'shared/time.js')) suite('shared/time.js', () => {
  const { safeTz, parseTimestamp, isPlausibleDate, localParts, toKeyyoDate, monthSlices, nextDay, daysBetween, DEFAULT_TZ } = time;

  test('safeTz nettoie le format POSIX et retombe sur Paris', () => {
    eq(safeTz(':UTC'), 'UTC', 'deux-points de tete retire');
    eq(safeTz(''), DEFAULT_TZ);
    eq(safeTz(null), DEFAULT_TZ);
    eq(safeTz('Pas/Un/Fuseau'), DEFAULT_TZ, 'fuseau invalide : repli, pas d’exception');
    eq(safeTz('Europe/Paris'), 'Europe/Paris');
  });

  test('parseTimestamp accepte secondes, millisecondes et chaines', () => {
    eq(parseTimestamp(1756900000).getTime(), 1756900000000, 'unix en secondes');
    eq(parseTimestamp('1756900000').getTime(), 1756900000000, 'unix en secondes, en chaine');
    eq(parseTimestamp(1756900000000).getTime(), 1756900000000, 'unix en millisecondes');
    ok(parseTimestamp('2026-09-03 14:05:00') instanceof Date, 'espace au lieu de T');
    eq(parseTimestamp(''), null);
    eq(parseTimestamp(null), null);
    eq(parseTimestamp('pas une date'), null);
  });

  test('isPlausibleDate rejette ce qui n’est pas une date d’appel', () => {
    const now = Date.UTC(2026, 8, 3);
    eq(isPlausibleDate(new Date(Date.UTC(1999, 0, 1)), now), false, 'avant 2000');
    eq(isPlausibleDate(new Date(now + 10 * 864e5), now), false, 'plus de 2 jours dans le futur');
    eq(isPlausibleDate(new Date(now - 864e5), now), true);
    eq(isPlausibleDate(null, now), false);
  });

  test('localParts lit l’heure de Paris, pas celle du navigateur', () => {
    // 3 septembre 2026, 12:00 UTC = 14:00 a Paris (heure d’ete).
    const p = localParts(new Date(Date.UTC(2026, 8, 3, 12, 0, 0)), 'Europe/Paris');
    eq(p.date, '2026-09-03');
    eq(p.hour, 14);
    eq(p.minute, 0);
    eq(p.ym, '2026-09');
    eq(p.weekday, 3, '0 = lundi, donc jeudi = 3');
  });

  test('localParts en hiver applique le bon decalage', () => {
    // 15 janvier 2026, 12:00 UTC = 13:00 a Paris (heure d’hiver).
    const p = localParts(new Date(Date.UTC(2026, 0, 15, 12, 0, 0)), 'Europe/Paris');
    eq(p.date, '2026-01-15');
    eq(p.hour, 13);
  });

  test('toKeyyoDate produit le format attendu par l’API', () => {
    eq(toKeyyoDate(new Date(Date.UTC(2026, 8, 3, 12, 0, 0)), 'Europe/Paris'), '2026-09-03 14:00');
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(toKeyyoDate(new Date(), 'Europe/Paris')), 'forme generale');
  });

  test('nextDay franchit mois, annee et annee bissextile', () => {
    eq(nextDay('2026-09-03'), '2026-09-04');
    eq(nextDay('2026-02-28'), '2026-03-01', '2026 n’est pas bissextile');
    eq(nextDay('2024-02-28'), '2024-02-29', '2024 est bissextile');
    eq(nextDay('2026-12-31'), '2027-01-01');
  });

  // Non-regression. Un decalage calcule en millisecondes puis relu en heure
  // murale rate sa cible les jours de bascule d'heure, qui font 23 h ou 25 h :
  // pres de minuit, l'erreur devient un jour entier.
  test('isoDaysAgo reste juste au passage a l’heure d’hiver', () => {
    const { isoDaysAgo, todayIso } = time;
    // 25 octobre 2026, 22:30 UTC = 23:30 a Paris, apres la bascule du jour meme.
    const nuitDeBascule = Date.UTC(2026, 9, 25, 22, 30);
    eq(todayIso(nuitDeBascule, 'Europe/Paris'), '2026-10-25', 'point de depart');
    eq(isoDaysAgo(1, nuitDeBascule, 'Europe/Paris'), '2026-10-24', 'la veille, pas le jour meme');
    eq(isoDaysAgo(0, nuitDeBascule, 'Europe/Paris'), '2026-10-25');
    eq(isoDaysAgo(-1, nuitDeBascule, 'Europe/Paris'), '2026-10-26', 'un decalage negatif avance');
    // Bascule de printemps : le 29 mars 2026, la nuit ne fait que 23 h.
    const nuitDePrintemps = Date.UTC(2026, 2, 29, 0, 30);
    eq(isoDaysAgo(1, nuitDePrintemps, 'Europe/Paris'), '2026-03-28');
  });

  test('daysBetween compte les jours et ne descend jamais sous zero', () => {
    eq(daysBetween('2026-09-01', '2026-09-03'), 2);
    eq(daysBetween('2026-09-03', '2026-09-03'), 0);
    eq(daysBetween('2026-09-03', '2026-09-01'), 0, 'bornes inversees');
    eq(daysBetween('pas', 'une date'), 0);
  });

  test('monthSlices pave la periode sans trou ni recouvrement', () => {
    const s = monthSlices('2026-07-15', '2026-09-03');
    eq(s.length, 3);
    eq(s[0].month, '2026-09', 'le plus recent d’abord');
    eq(s[0].from, '2026-09-01');
    eq(s[0].to, '2026-09-04', 'borne de fin EXCLUSIVE : lendemain du dernier jour');
    eq(s[2].month, '2026-07');
    eq(s[2].from, '2026-07-15', 'le premier mois demarre a la date demandee');

    // Remis dans l’ordre chronologique, la fin de chaque tranche doit etre le
    // debut de la suivante : c’est ce qui garantit qu’aucun appel n’est saute.
    const chrono = s.slice().reverse();
    for (let i = 1; i < chrono.length; i++) {
      eq(chrono[i].from, chrono[i - 1].to, 'jointure entre ' + chrono[i - 1].month + ' et ' + chrono[i].month);
    }
  });

  test('monthSlices sur un seul jour, et sur des bornes inversees', () => {
    const one = monthSlices('2026-09-03', '2026-09-03');
    eq(one.length, 1);
    eq(one[0].from, '2026-09-03');
    eq(one[0].to, '2026-09-04');
    eqDeep(monthSlices('2026-09-03', '2026-09-01'), [], 'bornes inversees : aucune tranche');
    eqDeep(monthSlices('', ''), []);
  });
});

// -----------------------------------------------------------------------------
//  4. shared/schema.js
// -----------------------------------------------------------------------------

if (need(schema, 'shared/schema.js', 'shared/schema.js')) suite('shared/schema.js', () => {
  const { FIELDS, F, ROW_LENGTH, SCHEMA_VERSION, isMissed, isIncoming, isOutgoing, rowKey, toObject, fromObject, isValidRow } = schema;

  test('le format positionnel est fige', () => {
    eq(ROW_LENGTH, FIELDS.length);
    eq(FIELDS.length, 15);
    eq(SCHEMA_VERSION, 3);
    eq(F.id, 0);
    eq(F.ts, 1);
    eq(F.dir, 5);
    eq(F.peer, 8);
    eq(F.seconds, 9);
    eq(F.answered, 10);
    eq(F.destName, 14);
  });

  test('un appel manque est un entrant non decroche, et rien d’autre', () => {
    const mk = (dir, answered) => fromObject({ dir, answered });
    eq(isMissed(mk(0, 0)), true, 'entrant non decroche');
    eq(isMissed(mk(0, 1)), false, 'entrant decroche');
    eq(isMissed(mk(1, 0)), false, 'sortant sans reponse : ce n’est pas un manque');
    eq(isMissed(mk(1, 1)), false);
    eq(isIncoming(mk(0, 0)), true);
    eq(isOutgoing(mk(1, 0)), true);
  });

  test('rowKey exclut la duree, pour qu’un appel en cours soit remplace', () => {
    const a = fromObject({ id: 'abc', ts: 1000, dir: 0, caller: '+33612345678', callee: '+33253359565', csi: '33253359565', seconds: 12 });
    const b = fromObject({ id: 'abc', ts: 1000, dir: 0, caller: '+33612345678', callee: '+33253359565', csi: '33253359565', seconds: 170 });
    eq(rowKey(a), rowKey(b), 'meme appel, duree differente : meme cle');
    eq(rowKey(a), 'id:abc');

    const noId = fromObject({ id: '', ts: 1000, dir: 0, caller: '+33612345678', callee: '+33253359565', csi: '33253359565' });
    eq(rowKey(noId), '1000|0|+33612345678|+33253359565|33253359565', 'repli sans call_id');
  });

  test('toObject et fromObject font l’aller-retour', () => {
    const obj = {
      id: 'x1', ts: 1756900000, date: '2026-09-03', hour: 14, minute: 5, dir: 1,
      caller: '+33253359565', callee: '+33612345678', peer: '+33612345678',
      seconds: 170, answered: 1, csi: '33253359565', unit: 'second', cost: 0.12,
      destName: 'Mobile France',
    };
    eqDeep(toObject(fromObject(obj)), obj);
    eq(fromObject(obj).length, ROW_LENGTH);
  });

  test('isValidRow refuse ce qui casserait un rendu', () => {
    const good = fromObject({ ts: 1756900000, date: '2026-09-03', dir: 0 });
    eq(isValidRow(good), true);
    eq(isValidRow(good.slice(0, 10)), false, 'trop courte');
    eq(isValidRow(fromObject({ ts: 'hier', date: '2026-09-03', dir: 0 })), false, 'horodatage non numerique');
    eq(isValidRow(fromObject({ ts: 1, date: '03/09/2026', dir: 0 })), false, 'date au mauvais format');
    eq(isValidRow(fromObject({ ts: 1, date: '2026-09-03', dir: 2 })), false, 'sens inconnu');
    eq(isValidRow(null), false);
    eq(isValidRow('pas une ligne'), false);
  });
});

// -----------------------------------------------------------------------------
//  5. shared/cdr.js
// -----------------------------------------------------------------------------

if (need(cdr, 'shared/cdr.js', 'shared/cdr.js')) suite('shared/cdr.js', () => {
  const { normalizeCdr, extractRecords, nextLink } = cdr;
  const F = schema.F;

  const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
  const TS = 1756900000;                       // horodatage plausible avant NOW
  const CSI = '33253359565';
  const ctx = (direction, extra) => Object.assign({ direction, csi: CSI, tz: 'Europe/Paris', now: NOW }, extra || {});

  test('un sortant abouti donne une ligne complete', () => {
    const row = normalizeCdr({
      call_id: 'c1', start_time: TS, caller: '+33253359565', callee: '0612345678',
      quantity: 170, unit: 'second', cost: '0.12', destination_name: 'Mobile France',
    }, ctx('out'));

    ok(row, 'la ligne ne doit pas etre rejetee');
    eq(schema.isValidRow(row), true, 'la ligne respecte le schema');
    eq(row[F.dir], 1);
    eq(row[F.caller], '+33253359565');
    eq(row[F.callee], '+33612345678', 'l’appele est normalise en E.164');
    eq(row[F.peer], '+33612345678', 'sur un sortant, le correspondant est l’appele');
    eq(row[F.seconds], 170);
    eq(row[F.answered], 1);
    eq(row[F.cost], 0.12);
    eq(row[F.csi], CSI);
    eq(row[F.id], 'c1');
    eq(row[F.date], time.localParts(new Date(TS * 1000), 'Europe/Paris').date, 'date en heure de Paris');
  });

  test('un entrant sans champ caller retombe sur actual_caller', () => {
    const row = normalizeCdr({
      call_id: 'c2', start_time: TS, caller: null, actual_caller: '0612345678',
      quantity: 0, unit: 'second',
    }, ctx('in'));

    ok(row, 'la ligne ne doit pas etre rejetee');
    eq(row[F.dir], 0);
    eq(row[F.caller], '+33612345678', 'le vrai appelant vient de actual_caller');
    eq(row[F.callee], '+33253359565', 'l’appele est reconstitue depuis le CSI');
    eq(row[F.peer], '+33612345678', 'sur un entrant, le correspondant est l’appelant');
    eq(row[F.answered], 0, 'duree nulle : non decroche');
    eq(schema.isMissed(row), true);
  });

  test('le decroche se deduit de la duree, et seulement en secondes', () => {
    const answered = normalizeCdr({ start_time: TS, caller: '0612345678', quantity: 1, unit: 'second' }, ctx('in'));
    eq(answered[F.answered], 1, 'une seconde suffit');

    const sms = normalizeCdr({ start_time: TS, caller: '0612345678', quantity: 3, unit: 'sms' }, ctx('in'));
    eq(sms[F.seconds], 0, 'un compte de SMS n’est pas une duree');
    eq(sms[F.answered], 0);
    eq(sms[F.unit], 'sms');

    const negative = normalizeCdr({ start_time: TS, caller: '0612345678', quantity: -5, unit: 'second' }, ctx('in'));
    eq(negative[F.seconds], 0, 'une duree negative est ramenee a zero');
  });

  test('les enregistrements inexploitables sont rejetes ET expliques', () => {
    const drops = [];
    const onDrop = (raw, reason) => drops.push(reason);

    eq(normalizeCdr(null, ctx('in', { onDrop })), null, 'entree nulle');
    eq(normalizeCdr('texte', ctx('in', { onDrop })), null, 'entree non-objet');
    eq(normalizeCdr({ caller: '0612345678' }, ctx('in', { onDrop })), null, 'aucun horodatage');
    eq(normalizeCdr({ start_time: 100, caller: '0612345678' }, ctx('in', { onDrop })), null, 'horodatage anterieur a 2000');

    eq(drops.length, 4, 'chaque rejet est notifie');
    ok(drops.every((d) => typeof d === 'string' && d.length > 0), 'chaque rejet porte un motif');
  });

  test('extractRecords depile toutes les formes de reponse HAL', () => {
    eq(extractRecords({ _embedded: { CallDetailRecord: [{ a: 1 }, { a: 2 }] } }).length, 2, 'cas nominal');
    eq(extractRecords({ _embedded: { group: { CallDetailRecord: [{ a: 1 }] } } }).length, 1, 'imbrique d’un cran');
    eq(extractRecords([{ a: 1 }, { a: 2 }, { a: 3 }]).length, 3, 'tableau nu');
    eq(extractRecords({ items: [{ a: 1 }] }).length, 1, 'nom de groupe alternatif');
    eqDeep(extractRecords({}), []);
    eqDeep(extractRecords(null), []);
    eqDeep(extractRecords('texte'), []);
  });

  test('nextLink suit la pagination quand elle existe', () => {
    eq(nextLink({ _links: { next: { href: '/x?offset=100' } } }), '/x?offset=100');
    eq(nextLink({ _links: {} }), null);
    eq(nextLink({}), null);
    eq(nextLink(null), null);
  });
});

// -----------------------------------------------------------------------------
//  6. shared/identity.js
// -----------------------------------------------------------------------------

if (need(identity, 'shared/identity.js', 'shared/identity.js')) suite('shared/identity.js', () => {
  const { capitalizeName, normalizeName, nameTokens, isEmail, nameFromEmail, firstNameFromEmail,
    nameSimilarity, NAME_MATCH_THRESHOLD, resolveLineIdentities, lineLabel, initialsOf, parseLineEmails } = identity;

  test('capitalizeName respecte traits d’union et apostrophes', () => {
    eq(capitalizeName('jean-pierre'), 'Jean-Pierre');
    eq(capitalizeName("o'brien"), "O'Brien");
    eq(capitalizeName('DUPONT'), 'Dupont');
    eq(capitalizeName(''), '');
  });

  test('normalizeName retire accents et ponctuation', () => {
    eq(normalizeName('Stéphane SEDSON'), 'stephane sedson');
    eq(normalizeName('  Marie-Ange  '), 'marie ange');
    eq(normalizeName(null), '');
  });

  test('nameTokens ecarte les particules et les initiales', () => {
    eqDeep(nameTokens('Ligne de Stéphane'), ['ligne', 'stephane']);
    eqDeep(nameTokens('P. Dupont'), ['dupont'], 'une initiale n’est pas un jeton');
    eqDeep(nameTokens(''), []);
  });

  test('isEmail accepte une adresse exploitable, et elle seule', () => {
    eq(isEmail('marie.dupont@exemple.fr'), true);
    eq(isEmail('a@b'), false, 'pas de domaine de premier niveau');
    eq(isEmail('deux mots@exemple.fr'), false);
    eq(isEmail(''), false);
    eq(isEmail(null), false);
  });

  test('nameFromEmail ne devine que ce qui est deductible', () => {
    eqDeep(nameFromEmail('stephane.sedson@x.fr'), { first: 'Stephane', last: 'Sedson', local: 'stephane.sedson' });
    eq(nameFromEmail('jean-pierre.durand@x.fr').first, 'Jean-Pierre');
    eq(nameFromEmail('p.lecorre@x.fr').first, null, 'une initiale n’est pas un prenom');
    eq(nameFromEmail('p.lecorre@x.fr').last, 'Lecorre');
    eq(nameFromEmail('contact@x.fr').first, null, 'boite fonctionnelle');
    eq(nameFromEmail('plecorre@x.fr').first, null, 'aucun separateur : on ne devine pas');
    eq(firstNameFromEmail('marie.dupont@x.fr'), 'Marie');
    eq(firstNameFromEmail('pas une adresse'), null);
  });

  test('nameSimilarity est symetrique, bornee, et insensible a l’ordre', () => {
    eq(nameSimilarity('Marie Dupont', 'Marie Dupont'), 1, 'identiques');
    eq(nameSimilarity('Marie Dupont', 'Dupont Marie'), 1, 'ordre inverse');
    eq(nameSimilarity('Marie Dupont', 'Paul Bernard'), 0, 'rien en commun');
    eq(nameSimilarity('', 'Marie'), 0);
    eq(nameSimilarity('Stéphane Sedson', 'Stephane Sedson'), 1, 'les accents ne comptent pas');

    const ab = nameSimilarity('Marie Dupont', 'Marie Durand');
    eq(ab, nameSimilarity('Marie Durand', 'Marie Dupont'), 'symetrie');
    ok(ab > 0 && ab < 1, 'un seul jeton commun : score intermediaire, obtenu ' + ab);
    ok(NAME_MATCH_THRESHOLD > 0 && NAME_MATCH_THRESHOLD < 1, 'le seuil est une proportion');
  });

  // Un CSI n'est pas toujours un numero : Keyyo lui donne la forme de ce qu'il
  // identifie. La console d'administration l'affiche dans sa colonne
  // « Identifiant », et l'outil doit en faire autant.
  test('formatCsi distingue un numero d’un identifiant de terminal', () => {
    const { isPhoneCsi, formatCsi } = identity;

    eq(isPhoneCsi('33253359565'), true);
    eq(isPhoneCsi('+33 2 53 35 95 65'), true);
    eq(isPhoneCsi('101'), true);
    eq(isPhoneCsi('rqepz@kphone'), false, 'identifiant de terminal Keyyo Phone');
    eq(isPhoneCsi('x37jb@kphone'), false, 'des chiffres au milieu n’en font pas un numero');
    eq(isPhoneCsi('pmarley@keyyomail.com'), false, 'CSI d’un compte de messagerie');
    eq(isPhoneCsi(''), false);

    eq(formatCsi('33253359565'), '02 53 35 95 65', 'un numero reste mis en forme');
    eq(formatCsi('101'), '101');
    // Le piege : `x37jb@kphone` contient « 3 » et « 7 ». Passe a formatNumber,
    // il ressortirait en poste court « 37 » et l'identifiant disparaitrait.
    eq(formatCsi('x37jb@kphone'), 'x37jb@kphone');
    eq(formatCsi('rqepz@kphone'), 'rqepz@kphone');
    eq(formatCsi('pmarley@keyyomail.com'), 'pmarley@keyyomail.com');
    eq(formatCsi(''), '—');
    eq(formatCsi(null), '—');
  });

  test('initialsOf donne une pastille lisible en toute circonstance', () => {
    eq(initialsOf('Marie Dupont'), 'MD');
    eq(initialsOf('Accueil'), 'A');
    eq(initialsOf(''), '?');
    eq(initialsOf(null), '?');
  });

  test('lineLabel prefere le prenom, puis le nom de ligne, puis le numero', () => {
    eq(lineLabel({ person: { firstName: 'Marie' }, name: 'Poste 101' }), 'Marie');
    eq(lineLabel({ person: { displayName: 'Marie Dupont' }, name: 'Poste 101' }), 'Marie Dupont');
    eq(lineLabel({ name: 'Accueil' }), 'Accueil');
    eq(lineLabel({ formattedCsi: '02 53 35 95 65' }), '02 53 35 95 65');
    eq(lineLabel({ csi: '33253359565' }), '33253359565');
    eq(lineLabel(null), '—');
  });

  test('parseLineEmails lit les deux formats de reglage', () => {
    eqDeep(
      parseLineEmails('33253359561=marie.dupont@x.fr;33253359562=paul.bernard@x.fr'),
      { 33253359561: 'marie.dupont@x.fr', 33253359562: 'paul.bernard@x.fr' },
      'format simple',
    );
    eqDeep(
      parseLineEmails('{"33253359561":"marie.dupont@x.fr"}'),
      { 33253359561: 'marie.dupont@x.fr' },
      'format JSON',
    );
    // La cle est le CSI reduit a ses chiffres, TEL QU'ECRIT : aucune
    // conversion en E.164 n'a lieu ici. C'est donc le CSI de la ligne qu'il
    // faut coller dans le reglage, pas un numero national.
    eqDeep(parseLineEmails('33 253 359 561 = MARIE.DUPONT@X.FR'), { 33253359561: 'marie.dupont@x.fr' },
      'espaces et casse melangee');
    eqDeep(parseLineEmails('33253359561=pas-une-adresse'), {}, 'une adresse invalide est ignoree');
    eqDeep(parseLineEmails(''), {});
    eqDeep(parseLineEmails(null), {});
  });

  // La console d'administration Keyyo affiche, en face de chaque terminal
  // Keyyo Phone, le NOM DE LA PERSONNE. C'est desormais la source principale :
  // l'API n'expose ni l'inventaire des terminaux ni leur identifiant
  // `xxxxx@kphone`, et un relevé d'appel ne nomme aucun terminal.
  // NON-REGRESSION, tiree d'un compte reel. Les lignes y sont nommees d'apres
  // un SITE (« BIOS ABE », « BIOS TNR »), et il existe des boites de messagerie
  // portant EXACTEMENT le meme libelle, sans adresse exploitable. Un nom
  // identique a 100 % ne designe donc personne. Faire passer cette ressemblance
  // devant l'annuaire remplacait « Jessica Henin », avec son adresse, par
  // « BIOS ABE » sans adresse.
  test('un nom de site identique a 100 % n’evince pas l’identite de l’annuaire', () => {
    const out = resolveLineIdentities({
      voipLines: [
        { csi: '33253359565', formattedCsi: '+33253359565', name: 'BIOS ABE', shortNumber: '9565' },
      ],
      // Boite nommee comme la ligne, sans adresse : le piege.
      emailAccounts: [{ csi: 'BIOS ABE', name: 'BIOS ABE' }],
      directoryContacts: [
        { email: 'jessica.henin@bios-expertise.com', firstName: 'Jessica', lastName: 'Henin', numbers: ['+33253359565'], speedNumbers: [] },
      ],
      overrides: {},
    });

    eq(out[0].person.source, 'directory_number', 'l’egalite de numero l’emporte sur la ressemblance de nom');
    eq(out[0].person.email, 'jessica.henin@bios-expertise.com');
    eq(out[0].person.firstName, 'Jessica');
    eq(lineLabel(out[0]), 'Jessica');
    // Et surtout : aucun collaborateur « Bios Abe » n'a ete invente.
    ok(!out[0].candidates.some((c) => c.source === 'line_name'),
      'le dernier recours ne se declenche pas quand une identite existe deja');
  });

  // LE CAS REEL DE CE COMPTE : trois lignes, cinquante-six personnes. Chacune a
  // son terminal Keyyo Phone (`c8um2@kphone`), mais un relevé d'appel ne nomme
  // aucun terminal. Designer un titulaire serait attribuer a une personne les
  // appels de toute son equipe.
  test('une ligne partagee n’a pas de titulaire, elle a une equipe', () => {
    const equipe = [
      { email: 'stephane.sedson@bios-expertise.com', firstName: 'Stéphane', lastName: 'Sedson', numbers: ['+33253359565'], speedNumbers: [] },
      { email: 'marcel.razafi@bios-expertise.com', firstName: 'Marcel', lastName: 'Razafi', numbers: ['+33253359565'], speedNumbers: [] },
      { email: 'jessica.henin@bios-expertise.com', firstName: 'Jessica', lastName: 'Henin', numbers: ['+33253359565'], speedNumbers: [] },
    ];
    const out = resolveLineIdentities({
      voipLines: [{ csi: '33253359565', formattedCsi: '+33253359565', name: 'BIOS ABE', shortNumber: '9565' }],
      directoryContacts: equipe,
      emailAccounts: [],
      overrides: {},
    });

    eq(out[0].shared, true, 'la ligne est reconnue comme partagee');
    eq(out[0].team.length, 3, 'les trois personnes sont conservees');
    eq(out[0].person, null, 'aucun titulaire n’est designe arbitrairement');
    eq(lineLabel(out[0]), 'BIOS ABE', 'la ligne s’affiche sous son propre nom');
    // Le premier de la liste ne doit surtout pas devenir « le » collaborateur.
    ok(!out[0].candidates.some((c) => c.source === 'directory_number'),
      'aucun candidat par numero quand plusieurs personnes partagent le numero');
    eq(out[0].team[0].email, 'stephane.sedson@bios-expertise.com');
  });

  test('une ligne a titulaire unique reste attribuee', () => {
    const out = resolveLineIdentities({
      voipLines: [{ csi: '33253359570', formattedCsi: '+33253359570', name: 'BIOS SUD', shortNumber: '9570' }],
      directoryContacts: [
        { email: 'seule.personne@exemple.fr', firstName: 'Seule', lastName: 'Personne', numbers: ['+33253359570'], speedNumbers: [] },
      ],
      emailAccounts: [],
      overrides: {},
    });
    eq(out[0].shared, false);
    eq(out[0].person.source, 'directory_number');
    eq(out[0].person.email, 'seule.personne@exemple.fr');
  });

  test('une identite avec adresse l’emporte sur une identite sans adresse', () => {
    const out = resolveLineIdentities({
      voipLines: [{ csi: '33253359566', formattedCsi: '+33253359566', name: 'Atelier Nord', shortNumber: '9566' }],
      // Ressemblance parfaite, mais aucune adresse derriere.
      emailAccounts: [{ csi: 'Atelier Nord', name: 'Atelier Nord' }],
      // Ressemblance nulle, mais une vraie personne joignable sur le poste.
      directoryContacts: [
        { email: 'marc.leroy@exemple.fr', firstName: 'Marc', lastName: 'Leroy', numbers: [], speedNumbers: ['9566'] },
      ],
      overrides: {},
    });
    eq(out[0].person.email, 'marc.leroy@exemple.fr', 'une personne joignable passe devant un libelle sans adresse');
    eq(out[0].person.source, 'directory_short_number');
  });

  test('sans annuaire, le nom du terminal va chercher l’adresse du compte de messagerie', () => {
    const out = resolveLineIdentities({
      voipLines: [{ csi: '33253359561', formattedCsi: '+33253359561', name: 'Sonia Rakoto', shortNumber: '101' }],
      emailAccounts: [
        { csi: 'sonia.rakoto@exemple.fr', email: 'sonia.rakoto@exemple.fr', firstName: 'Sonia', lastName: 'Rakoto' },
      ],
      directoryContacts: [],
      overrides: {},
    });
    eq(out[0].person.source, 'email_account_name');
    eq(out[0].person.email, 'sonia.rakoto@exemple.fr');
    eq(out[0].person.firstName, 'Sonia');
  });

  test('un terminal nomme comme un service ne fabrique aucune personne', () => {
    const out = resolveLineIdentities({
      voipLines: [
        { csi: '33253359560', formattedCsi: '02 53 35 95 60', name: 'Accueil', shortNumber: '100' },
        { csi: '33253359569', formattedCsi: '02 53 35 95 69', name: 'Poste 101', shortNumber: '109' },
        { csi: '33253359568', formattedCsi: '02 53 35 95 68', name: 'Ligne fax', shortNumber: '108' },
      ],
      emailAccounts: [],
      directoryContacts: [],
      overrides: {},
    });
    for (const line of out) {
      ok(!line.person, 'aucune personne inventee pour « ' + line.name + ' »');
    }
  });

  test('sans aucune source d’adresse, le nom du terminal reste affiche', () => {
    const out = resolveLineIdentities({
      voipLines: [{ csi: '33253359562', formattedCsi: '02 53 35 95 62', name: 'Sandy Rarivo-PC', shortNumber: '102' }],
      emailAccounts: [],
      directoryContacts: [],
      overrides: {},
    });
    eq(out[0].person.source, 'line_name');
    eq(out[0].person.email, null, 'aucune adresse n’est inventee');
    eq(out[0].person.firstName, 'Sandy');
    eq(lineLabel(out[0]), 'Sandy');
  });

  test('resolveLineIdentities rapproche une ligne de son contact d’annuaire', () => {
    const out = resolveLineIdentities({
      voipLines: [
        { csi: '33253359561', formattedCsi: '02 53 35 95 61', name: 'Poste 101', shortNumber: '101' },
        { csi: '33253359560', formattedCsi: '02 53 35 95 60', name: 'Accueil', shortNumber: '100' },
      ],
      directoryContacts: [
        { email: 'marie.dupont@x.fr', firstName: 'Marie', lastName: 'Dupont', numbers: ['02 53 35 95 61'], speedNumbers: ['101'] },
      ],
      emailAccounts: [],
      overrides: {},
    });

    eq(out.length, 2, 'toutes les lignes sont rendues, resolues ou non');
    const resolved = out.find((l) => l.csi === '33253359561');
    ok(resolved.person, 'la ligne est resolue');
    // Un seul contact sur ce numero : la ligne a bien un titulaire, et
    // l'egalite de numero est la regle la plus forte apres le reglage manuel.
    eq(resolved.person.source, 'directory_number');
    eq(resolved.shared, false, 'une seule personne : la ligne n’est pas partagee');
    eq(resolved.person.firstName, 'Marie');
    ok(resolved.person.evidence && resolved.person.evidence.length > 0, 'le rapprochement porte son indice');
    ok(resolved.person.confidence > 0.5, 'confiance elevee sur un numero exact');

    const unresolved = out.find((l) => l.csi === '33253359560');
    ok(!unresolved.person || !unresolved.person.email, 'la ligne sans contact reste non resolue, pas devinee');
  });

  test('un reglage manuel l’emporte sur toute deduction', () => {
    const out = resolveLineIdentities({
      voipLines: [{ csi: '33253359561', formattedCsi: '02 53 35 95 61', name: 'Poste 101', shortNumber: '101' }],
      directoryContacts: [
        { email: 'marie.dupont@x.fr', firstName: 'Marie', lastName: 'Dupont', numbers: ['02 53 35 95 61'], speedNumbers: ['101'] },
      ],
      overrides: { 33253359561: 'paul.bernard@x.fr' },
    });
    eq(out[0].person.source, 'override');
    eq(out[0].person.email, 'paul.bernard@x.fr');
  });
});

// -----------------------------------------------------------------------------
//  6 bis. shared/roles.js — la politique d'acces refuse par defaut
// -----------------------------------------------------------------------------

if (need(roles, 'shared/roles.js', 'shared/roles.js')) suite('shared/roles.js', () => {
  const {
    ROLE_DIRECTION, ROLE_AGENT, ROLES, POLICY, parseEmailList, roleFromClaims,
    allowedRoles, canAccess, isDirection, roleLabel,
  } = roles;

  test('deux roles, la direction d’abord', () => {
    eqDeep(Array.from(ROLES), [ROLE_DIRECTION, ROLE_AGENT]);
    eq(ROLE_DIRECTION, 'direction');
    eq(ROLE_AGENT, 'agent');
  });

  test('parseEmailList tolere tous les separateurs et ecarte ce qui n’est pas une adresse', () => {
    eqDeep(parseEmailList(' A@x.fr, b@y.com;c@z.org\nbad  d@e.io '), ['a@x.fr', 'b@y.com', 'c@z.org', 'd@e.io']);
    eqDeep(parseEmailList(''), []);
    eqDeep(parseEmailList(null), []);
    eqDeep(parseEmailList('a@x.fr,a@x.fr,A@X.FR'), ['a@x.fr'], 'sans doublon, insensible a la casse');
  });

  test('le claim roles d’Entra donne le role, quelle que soit la casse', () => {
    eq(roleFromClaims({ roles: ['Direction'] }), 'direction');
    eq(roleFromClaims({ roles: ['DIRECTION'] }), 'direction');
    eq(roleFromClaims({ roles: 'direction' }), 'direction', 'une chaine seule est toleree');
    eq(roleFromClaims({ roles: ['Agent'] }), 'agent');
    eq(roleFromClaims({ roles: ['Agent', 'Direction'] }), 'direction', 'le plus eleve gagne');
    eq(roleFromClaims({ roles: ['Inconnu'] }), 'agent', 'un app role inconnu ne donne rien');
  });

  test('sans app role, toute personne connectee est agent', () => {
    eq(roleFromClaims({}), 'agent');
    eq(roleFromClaims(null), 'agent');
    eq(roleFromClaims({ email: 'x@y.fr' }), 'agent');
  });

  test('la liste AUTH_DIRECTION_EMAILS promeut, sur email comme sur preferred_username', () => {
    const opts = { directionEmails: parseEmailList('boss@bios.fr') };
    eq(roleFromClaims({ email: 'Boss@BIOS.fr' }, opts), 'direction');
    eq(roleFromClaims({ preferred_username: 'boss@bios.fr' }, opts), 'direction');
    eq(roleFromClaims({ roles: ['Agent'], email: 'boss@bios.fr' }, opts), 'direction', 'la liste l’emporte sur un app role Agent');
    eq(roleFromClaims({ email: 'autre@bios.fr' }, opts), 'agent');
  });

  test('la politique refuse par defaut : route inconnue, role inconnu, role vide', () => {
    eq(canAccess('/api/inexistante', 'direction'), false);
    eq(canAccess('/api/calls', 'inconnu'), false);
    eq(canAccess('/api/calls', ''), false);
    eq(canAccess('/api/calls', null), false);
    eq(canAccess('', 'direction'), false);
    eqDeep(Array.from(allowedRoles('/api/inexistante')), []);
  });

  test('la supervision est reservee a la direction, l’annuaire ouvert aux agents', () => {
    eq(canAccess('/api/calls', 'direction'), true);
    eq(canAccess('/api/calls', 'agent'), false);
    eq(canAccess('/api/team', 'agent'), false);
    eq(canAccess('/api/health', 'agent'), false);
    eq(canAccess('/api/sync', 'agent'), false);
    eq(canAccess('/api/directory', 'agent'), true);
    eq(canAccess('/api/directory', 'direction'), true);
  });

  test('la query est ignoree pour retrouver la route', () => {
    eq(canAccess('/api/calls?force=1', 'direction'), true);
    eq(canAccess('/api/team?inventory=1', 'agent'), false);
  });

  test('toute route de la politique est fermee a un role hors liste', () => {
    for (const route of Object.keys(POLICY)) {
      eq(canAccess(route, 'visiteur'), false, route);
      ok(POLICY[route].length > 0, route + ' autorise au moins un role');
    }
  });

  test('libelles et predicat', () => {
    eq(isDirection('direction'), true);
    eq(isDirection('agent'), false);
    eq(isDirection(undefined), false);
    eq(roleLabel('direction'), 'Direction');
    eq(roleLabel('agent'), 'Agent');
    eq(roleLabel('x'), 'Sans rôle');
  });
});

// -----------------------------------------------------------------------------
//  6 bis-2. shared/journal.js — le journal d'attribution
// -----------------------------------------------------------------------------

if (need(journalMod, 'shared/journal.js', 'shared/journal.js')) suite('shared/journal.js', () => {
  const { normalizeEvent, eventId, isValidEvent, mergeEvents, monthOf, summarize, EVENT_TYPES } = journalMod;
  const NOW = 1_800_000_000;   // 2027-01-15, secondes
  const ctx = { email: 'Agent@Bios.fr', now: NOW };

  test('l’adresse vient TOUJOURS du contexte, jamais de l’evenement', () => {
    const e = normalizeEvent({ type: 'dial', to: '06 12 34 56 78', email: 'autre@bios.fr', csi: '33253359565' }, ctx);
    ok(e, 'evenement accepte');
    eq(e.email, 'agent@bios.fr');
    eq(e.to, '0612345678');
    eq(e.ts, NOW, 'sans ts : maintenant');
    eq(e.dir, '', 'sens absent -> vide');
  });

  test('les types inconnus et les faits incomplets sont rejetes', () => {
    eq(normalizeEvent({ type: 'peek', callref: 'x' }, ctx), null);
    eq(normalizeEvent({ type: 'observed', csi: '33253359565' }, ctx), null, 'observe sans callref');
    eq(normalizeEvent({ type: 'answer' }, ctx), null, 'answer sans callref');
    eq(normalizeEvent({ type: 'dial' }, ctx), null, 'dial sans numero');
    eq(normalizeEvent({ type: 'dial', to: '0612345678' }, { email: '', now: NOW }), null, 'sans adresse');
    eq(normalizeEvent(null, ctx), null);
    eq(EVENT_TYPES.length, 6);
  });

  test('un horodatage aberrant est ramene a maintenant, un horodatage en ms est converti', () => {
    const far = normalizeEvent({ type: 'dial', to: '0612345678', ts: 100 }, ctx);
    eq(far.ts, NOW);
    const ms = normalizeEvent({ type: 'dial', to: '0612345678', ts: (NOW - 60) * 1000 }, ctx);
    eq(ms.ts, NOW - 60);
  });

  test('l’identifiant est stable : deux navigateurs qui observent le meme appel produisent le meme', () => {
    const a = normalizeEvent({ type: 'observed', csi: '33253359565', callref: 'c1', dir: 'in', peer: '+33612345678', ring: 12, answered: true }, ctx);
    const b = normalizeEvent({ type: 'observed', csi: '33253359565', callref: 'c1', dir: 'in', peer: '+33612345678', ring: 12, answered: true }, { email: 'collegue@bios.fr', now: NOW });
    eq(a.id, b.id);
    eq(eventId(a), 'observed:33253359565:c1');
    const x = normalizeEvent({ type: 'answer', csi: '33253359565', callref: 'c1' }, ctx);
    const y = normalizeEvent({ type: 'answer', csi: '33253359565', callref: 'c1' }, { email: 'collegue@bios.fr', now: NOW });
    ok(x.id !== y.id, 'une action est nominative : un identifiant par personne');
  });

  test('mergeEvents deduplique par identifiant, premier vu gagne, ordre chronologique', () => {
    const a = normalizeEvent({ type: 'observed', csi: '1', callref: 'c1', ts: NOW - 10, ring: 5 }, ctx);
    const a2 = normalizeEvent({ type: 'observed', csi: '1', callref: 'c1', ts: NOW - 10, ring: 99 }, ctx);
    const b = normalizeEvent({ type: 'dial', to: '0612345678', ts: NOW - 20 }, ctx);
    const merged = mergeEvents([a], [a2, b]);
    eq(merged.length, 2);
    eq(merged[0].type, 'dial', 'le plus ancien d’abord');
    eq(merged[1].ring, 5, 'la premiere version est conservee');
    eqDeep(mergeEvents([{ type: 'dial' }], null), [], 'les invalides sont ecartes');
    ok(isValidEvent(a) && !isValidEvent({ type: 'dial' }));
  });

  test('monthOf partitionne en UTC', () => {
    eq(monthOf(NOW), '2027-01');
    eq(monthOf(1_700_000_000), '2023-11');
  });

  test('summarize compte par personne et dit ce qu’il ne sait pas', () => {
    const me = 'agent@bios.fr';
    const other = 'collegue@bios.fr';
    const ev = [
      // Appel c1 : entrant, decroche par moi depuis l'application apres 8 s.
      normalizeEvent({ type: 'observed', csi: '1', callref: 'c1', dir: 'in', peer: '+33611111111', ring: 8, duration: 120, answered: true, ts: NOW - 500 }, { email: other, now: NOW }),
      normalizeEvent({ type: 'answer', csi: '1', callref: 'c1', dir: 'in', peer: '+33611111111', ring: 8, ts: NOW - 490 }, { email: me, now: NOW }),
      // Meme appel declare pris ensuite : ne compte qu'une fois.
      normalizeEvent({ type: 'claim', csi: '1', callref: 'c1', dir: 'in', peer: '+33611111111', ring: 8, duration: 120, answered: true, ts: NOW - 300 }, { email: me, now: NOW }),
      // Appel c2 : entrant decroche par quelqu'un, personne ne l'a declare.
      normalizeEvent({ type: 'observed', csi: '1', callref: 'c2', dir: 'in', peer: '+33622222222', ring: 20, duration: 30, answered: true, ts: NOW - 400 }, { email: me, now: NOW }),
      // Appel c3 : manque apres 25 s.
      normalizeEvent({ type: 'observed', csi: '1', callref: 'c3', dir: 'in', peer: '+33633333333', ring: 25, duration: 0, answered: false, ts: NOW - 200 }, { email: me, now: NOW }),
      // Deux appels emis par moi, un par un collegue.
      normalizeEvent({ type: 'dial', to: '0644444444', ts: NOW - 150 }, { email: me, now: NOW }),
      normalizeEvent({ type: 'dial', to: '0644444444', ts: NOW - 140 }, { email: me, now: NOW }),
      normalizeEvent({ type: 'dial', to: '0655555555', ts: NOW - 130 }, { email: other, now: NOW }),
      // Un transfert est une action nominative : il porte sur c1, deja attribue.
      normalizeEvent({ type: 'transfer', csi: '1', callref: 'c1', to: '4012', ts: NOW - 100 }, { email: other, now: NOW }),
    ];
    const s = summarize(ev);
    eq(s.agents.length, 2);
    const mine = s.agents.find((a) => a.email === me);
    eq(mine.taken, 1, 'answer + claim du meme appel = 1 pris');
    eq(mine.answered, 1);
    eq(mine.claimed, 1);
    eq(mine.dialed, 2);
    eq(mine.ringCount, 1);
    eq(mine.ringTotal, 8);
    eq(mine.talkTotal, 120, 'la duree vient de l’observation');
    eqDeep(mine.callees, [{ to: '0644444444', count: 2 }]);
    const his = s.agents.find((a) => a.email === other);
    eq(his.transferred, 1);
    eq(his.dialed, 1);

    eq(s.calls.observed, 3);
    eq(s.calls.answered, 2);
    eq(s.calls.missed, 1);
    eq(s.calls.attributed, 1, 'c1 a une action nominative');
    eq(s.calls.unattributed, 1, 'c2 a ete decroche par on ne sait qui — et c’est dit');
    eq(s.calls.ringAnsweredTotal, 28);
    eq(s.calls.ringAnsweredCount, 2);
    eq(s.calls.ringMissedTotal, 25);
    eq(s.period.min, NOW - 500);
    eq(s.period.max, NOW - 100);

    const only = summarize(ev, { email: me });
    eq(only.agents.length, 1);
    eq(only.agents[0].email, me);
    eq(only.calls.observed, 3, 'les observations restent globales');
  });
});

// -----------------------------------------------------------------------------
//  6 ter. app/session.js — sans reseau, on ne teste que le pur
// -----------------------------------------------------------------------------

if (need(sessionMod, 'app/session.js', 'app/session.js')) suite('app/session.js', () => {
  const { LOGIN_URL, LOGOUT_URL, loginUrl, current, isDirection, forget } = sessionMod;

  test('les adresses de connexion et de deconnexion passent par /api/auth', () => {
    has(LOGIN_URL, '/api/auth?action=login');
    has(LOGOUT_URL, '/api/auth?action=logout');
  });

  test('loginUrl transporte la page de retour, encodee, et rien pour la racine', () => {
    eq(loginUrl('/'), LOGIN_URL);
    eq(loginUrl('/#/calls'), LOGIN_URL + '&next=' + encodeURIComponent('/#/calls'));
    has(loginUrl(), '/api/auth?action=login', 'sans argument : l’URL courante');
  });

  test('avant toute resolution, personne n’est connecte', () => {
    forget();
    eq(current().state, 'anonymous');
    eq(current().user, null);
    eq(isDirection(), false);
  });
});

// -----------------------------------------------------------------------------
//  6 quater. app/cti.js — l'instantane a vide, sans ouvrir de session
// -----------------------------------------------------------------------------

if (need(ctiMod, 'app/cti.js', 'app/cti.js')) suite('app/cti.js', () => {
  const { snapshot, claim, dial } = ctiMod;

  test('a vide : ligne fermee, aucun appel, rien de connecte', () => {
    const s = snapshot();
    eq(s.status, 'idle');
    eq(s.connected, false);
    eq(s.active, 0);
    eqDeep(s.calls, []);
  });

  test('une action sans session est refusee net, sans toucher au reseau', () => {
    throws(() => claim('inconnu'), 'declarer un appel inconnu');
    const p = dial('0612345678');
    ok(p && typeof p.then === 'function', 'dial rend une promesse');
    // Elle est rejetee (ligne fermee) : on l'absorbe pour ne pas polluer la console.
    p.catch(() => {});
  });
});

// -----------------------------------------------------------------------------
//  6 quinquies. shared/identity.js#lineTeams — l'equipe d'une ligne, avec numeros
// -----------------------------------------------------------------------------

if (need(identity, 'shared/identity.js (lineTeams)', 'shared/identity.js')) suite('shared/identity.js (lineTeams)', () => {
  const { lineTeams } = identity;

  test('les contacts qui portent le numero de la ligne forment son equipe, avec leurs postes', () => {
    const lines = [{ csi: '33253359565', name: 'BIOS ABE' }, { csi: '33175433361', name: 'BIOS TNR' }];
    const contacts = [
      { firstName: 'Sonia', lastName: 'RAKOTO', email: 'Sonia@bios.fr', numbers: ['02 53 35 95 65'], speedNumbers: ['4012'] },
      { firstName: 'Paul', lastName: 'ANDRIA', email: '', numbers: ['0253359565', '06 11 22 33 44'], speedNumbers: [] },
      { firstName: 'Client', lastName: 'EXTERNE', email: 'x@client.fr', numbers: ['0699999999'], speedNumbers: [] },
    ];
    const teams = lineTeams(lines, contacts);
    eq(teams.length, 2);
    eq(teams[0].csi, '33253359565');
    eq(teams[0].members.length, 2, 'deux contacts portent le numero de la ligne ABE');
    eq(teams[0].members[0].name, 'Sonia RAKOTO');
    eq(teams[0].members[0].email, 'sonia@bios.fr');
    eqDeep(teams[0].members[0].speedNumbers, ['4012']);
    eqDeep(teams[0].members[1].numbers, ['+33253359565', '+33611223344']);
    eq(teams[0].members[1].email, null);
    eq(teams[1].members.length, 0, 'personne sur TNR');
  });

  test('sans contact ni ligne, rien ne casse', () => {
    eqDeep(lineTeams([], []), []);
    eq(lineTeams([{ csi: '1' }], null)[0].members.length, 0);
  });
});

// -----------------------------------------------------------------------------
//  7. app/format.js
// -----------------------------------------------------------------------------

if (need(format, 'app/format.js', 'app/format.js')) suite('app/format.js', () => {
  const { fmtInt, fmtPct, fmtDuration, fmtDurationShort, fmtHms, fmtDate, fmtDateLong,
    fmtDayShort, fmtTime, fmtMonth, fmtClock, fmtRelative, WEEKDAYS, pluralize } = format;

  test('fmtInt groupe les milliers a la francaise', () => {
    eq(ws(fmtInt(12480)), '12 480');
    eq(ws(fmtInt(0)), '0');
    eq(ws(fmtInt(1234567)), '1 234 567');
    // Le signe negatif d'Intl varie selon la version d'ICU : on verifie les
    // chiffres et le groupement, pas la forme exacte du moins.
    eq(ws(fmtInt(-1500)).replace(/[^\d ]/g, ''), '1 500');
    eq(fmtInt('pas un nombre'), '—');
    eq(fmtInt(null), '—');
  });

  test('fmtPct met une virgule et une espace avant le signe', () => {
    eq(ws(fmtPct(63.888, 2)), '63,89 %');
    eq(ws(fmtPct(100)), '100 %', 'pas de decimales inutiles');
    eq(ws(fmtPct(0)), '0 %');
    eq(fmtPct(null), '—');
  });

  test('pluralize suit la regle francaise : 0 et 1 au singulier', () => {
    eq(pluralize(0, 'appel', 'appels'), 'appel');
    eq(pluralize(1, 'appel', 'appels'), 'appel');
    eq(pluralize(2, 'appel', 'appels'), 'appels');
    eq(pluralize(12, 'appel'), 'appels', 'pluriel deduit');
  });

  test('les durees se lisent a l’echelle ou on les regarde', () => {
    eq(ws(fmtDuration(0)), '0 s');
    eq(ws(fmtDuration(42)), '42 s');
    eq(ws(fmtDuration(252)), '4 min 12 s');
    eq(ws(fmtDuration(240)), '4 min', 'pas de « 0 s » superflu');
    eq(ws(fmtDuration(3900)), '1 h 05', 'au-dela d’une heure, plus de secondes');
    eq(fmtDuration(-1), '—');
    eq(fmtDuration(null), '—');

    eq(fmtDurationShort(42), '42s');
    eq(fmtDurationShort(252), '4m12');
    eq(fmtDurationShort(3900), '1h05');

    eq(ws(fmtHms(45600)), '12 h 40');
    eq(ws(fmtHms(2400)), '40 min');
    eq(ws(fmtHms(12)), '12 s');
  });

  test('les dates calendaires sont lues sans decalage de fuseau', () => {
    eq(fmtDate('2026-09-03'), '03/09/2026');
    eq(fmtDate('2026-01-01'), '01/01/2026', 'un 1er janvier ne doit pas reculer au 31 decembre');
    eq(fmtDate('pas une date'), '—');
    eq(fmtDate('2026-02-31'), '—', 'date rebouclee : refusee');

    has(fmtDateLong('2026-09-03'), '2026');
    has(fmtDateLong('2026-09-03'), '3');
    eq(fmtDayShort('pas une date'), '', 'sur un axe, une chaine vide plutot qu’un faux repere');
    has(fmtMonth('2026-09'), '2026');
  });

  test('fmtTime lit les colonnes hour et minute du schema', () => {
    eq(fmtTime(14, 5), '14:05');
    eq(fmtTime(0, 0), '00:00');
    eq(fmtTime(9), '09:00', 'minute par defaut');
    eq(fmtTime(25, 0), '—', 'heure hors plage');
    eq(fmtTime(12, 99), '—', 'minute hors plage');
    eq(fmtTime(null), '—');
  });

  test('fmtRelative franchit ses seuils dans le bon ordre', () => {
    const now = Date.UTC(2026, 8, 3, 12, 0, 0);
    const ago = (sec) => fmtRelative(new Date(now - sec * 1000), now);
    eq(ago(5), "à l'instant");
    eq(ws(ago(250)), 'il y a 4 min');
    eq(ws(ago(3 * 3600)), 'il y a 3 h');
    eq(ago(30 * 3600), 'hier');
    ok(/\d{2}\/\d{2}\/\d{4}/.test(ago(10 * 86400)), 'au-dela de deux jours : la date');
    eq(fmtRelative('pas une date'), '—');
    eq(ago(-60), "à l'instant", 'horloge en avance : jamais de duree negative');
  });

  test('fmtClock accepte les trois formes d’instant', () => {
    ok(/^\d{2}:\d{2}:\d{2}$/.test(fmtClock(new Date())), 'objet Date');
    ok(/^\d{2}:\d{2}:\d{2}$/.test(fmtClock(1756900000)), 'unix en secondes');
    ok(/^\d{2}:\d{2}:\d{2}$/.test(fmtClock('2026-09-03T14:05:31Z')), 'chaine ISO');
    eq(fmtClock('pas une date'), '—');
  });

  test('WEEKDAYS commence le lundi, comme l’indice de localParts', () => {
    eq(WEEKDAYS.length, 7);
    eq(WEEKDAYS[0], 'Lun');
    eq(WEEKDAYS[6], 'Dim');
  });
});

// -----------------------------------------------------------------------------
//  8. app/dom.js — l'echappement est une barriere de securite
// -----------------------------------------------------------------------------

if (need(dom, 'app/dom.js', 'app/dom.js')) suite('app/dom.js', () => {
  const { esc, html, raw, h, mount, qs, qsa, on, icon } = dom;

  test('esc neutralise les cinq caracteres dangereux', () => {
    eq(esc('<b>'), '&lt;b&gt;');
    eq(esc('a & b'), 'a &amp; b');
    eq(esc('"double"'), '&quot;double&quot;');
    eq(esc("'simple'"), '&#39;simple&#39;');
    eq(esc(null), '');
    eq(esc(undefined), '');
    eq(esc(0), '0', 'zero n’est pas vide');
  });

  test('html echappe toute valeur interpolee', () => {
    eq(html`<p>${'<script>alert(1)</script>'}</p>`, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    eq(html`<a title="${'x" onclick="evil()'}">t</a>`, '<a title="x&quot; onclick=&quot;evil()">t</a>',
      'une valeur ne peut pas sortir de son attribut');
    eq(html`<p>${null}</p>`, '<p></p>');
    eq(html`<p>${0}</p>`, '<p>0</p>');
  });

  test('raw laisse passer le balisage que nous produisons', () => {
    eq(html`<p>${raw('<b>gras</b>')}</p>`, '<p><b>gras</b></p>');
    eq(html`<p>${raw(null)}</p>`, '<p></p>');
  });

  test('html refuse d’etre appele comme une fonction ordinaire', () => {
    throws(() => html('<b>' + 'donnee' + '</b>'), 'un appel non balise doit lever');
  });

  test('h construit un element avec ses attributs', () => {
    const el = h('div', { class: 'a b', 'data-x': '1' }, 'texte');
    eq(el.tagName, 'DIV');
    eq(el.className, 'a b');
    eq(el.getAttribute('data-x'), '1');
    eq(el.textContent, 'texte');
    eq(h('span', ['a', 'b']).textContent, 'ab', 'un tableau en 2e position, ce sont des enfants');
  });

  test('mount ecrit dans la cible et la rend, qs et qsa la relisent', () => {
    const host = document.createElement('div');
    const back = mount(host, '<p class="x">un</p><p class="x">deux</p>');
    eq(back, host, 'mount rend la cible, pour enchainer');
    eq(qsa('.x', host).length, 2);
    eq(qs('.x', host).textContent, 'un');
    mount(host, '');
    eq(qsa('.x', host).length, 0);
  });

  test('mount leve sur une cible absente plutot que d’ecrire dans le vide', () => {
    throws(() => mount('#cible-qui-n-existe-pas', '<p>x</p>'));
  });

  test('on delegue depuis la racine et ignore ce qui est hors du sous-arbre', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      mount(host, '<button class="cible" data-v="7">clic</button><span class="autre"></span>');
      let seen = 0;
      let value = '';
      on(host, 'click', '.cible', (ev, el) => { seen++; value = el.getAttribute('data-v'); });

      qs('.cible', host).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      eq(seen, 1, 'le clic sur la cible declenche');
      eq(value, '7', 'l’element rapproche est passe au gestionnaire');

      qs('.autre', host).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      eq(seen, 1, 'un clic ailleurs ne declenche pas');

      // Le contenu est remplace : la delegation doit survivre.
      mount(host, '<button class="cible" data-v="9">clic</button>');
      qs('.cible', host).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      eq(seen, 2, 'la delegation survit au remplacement du contenu');
      eq(value, '9');
    } finally {
      host.remove();
    }
  });

  test('icon ne reference que des symboles, jamais une valeur brute', () => {
    has(icon('phone'), '#i-phone');
    has(icon('phone', 'grand'), 'class="grand"');
    eq(icon(''), '');
    lacks(icon('phone"><script>'), '<script', 'le nom est filtre avant d’entrer dans href');
  });
});

// -----------------------------------------------------------------------------
//  9. app/store.js — les agregations, dont l'analyse des rappels
// -----------------------------------------------------------------------------

if (need(store && schema, 'app/store.js', 'app/store.js ou shared/schema.js')) suite('app/store.js', () => {
  const { stats, byDay, byMonth, byHour, byWeekday, heatMatrix, byLine, byPeer, callbackAnalysis, trend } = store;

  /** Fabrique une ligne d'appel complete a partir de quelques champs. */
  function row(o) {
    return schema.fromObject({
      id: o.id || '',
      ts: o.ts == null ? 1756900000 : o.ts,
      date: o.date || '2026-09-03',
      hour: o.hour == null ? 10 : o.hour,
      minute: o.minute == null ? 0 : o.minute,
      dir: o.dir,
      caller: o.caller || '',
      callee: o.callee || '',
      peer: o.peer || '',
      seconds: o.seconds == null ? 0 : o.seconds,
      answered: o.answered == null ? (o.seconds > 0 ? 1 : 0) : o.answered,
      csi: o.csi || '33253359560',
      unit: 'second',
      cost: null,
      destName: '',
    });
  }

  // Jeu de reference : 4 entrants (3 decroches, 1 manque) et 3 sortants
  // (2 aboutis, 1 sans reponse). Durees choisies pour que moyenne et mediane
  // different, sinon le test ne distinguerait pas les deux calculs.
  const SAMPLE = [
    row({ dir: 0, peer: '+33611111111', seconds: 60, date: '2026-09-01', hour: 9 }),
    row({ dir: 0, peer: '+33622222222', seconds: 120, date: '2026-09-02', hour: 10 }),
    row({ dir: 0, peer: '+33633333333', seconds: 180, date: '2026-09-03', hour: 11 }),
    row({ dir: 0, peer: '+33644444444', seconds: 0, date: '2026-09-03', hour: 11 }),
    row({ dir: 1, peer: '+33611111111', seconds: 240, date: '2026-09-03', hour: 14, csi: '33253359561' }),
    row({ dir: 1, peer: '+33655555555', seconds: 0, date: '2026-09-03', hour: 15, csi: '33253359561' }),
    row({ dir: 1, peer: '+33666666666', seconds: 30, date: '2026-09-03', hour: 16, csi: '33253359561' }),
  ];

  test('stats compte le taux de reponse sur les ENTRANTS seulement', () => {
    const s = stats(SAMPLE);
    eq(s.total, 7);
    eq(s.in, 4);
    eq(s.out, 3);
    eq(s.missed, 1);
    eq(s.answered, 5, 'decroches tous sens confondus');
    close(s.answerRate, 75, 1e-9, '3 entrants decroches sur 4');
    eq(s.totalDuration, 630);
    close(s.avgDuration, 126, 1e-9, 'moyenne des seuls decroches');
    eq(s.medianDuration, 120, 'mediane des seuls decroches');
    eq(s.uniquePeers, 6);
  });

  test('stats ne rend jamais NaN sur un jeu vide', () => {
    const s = stats([]);
    eq(s.total, 0);
    eq(s.answerRate, 0);
    eq(s.avgDuration, 0);
    ok(Number.isFinite(s.answerRate) && Number.isFinite(s.avgDuration), 'aucune valeur non finie');
  });

  test('les series sont CONTINUES : un jour sans appel reste un point', () => {
    const days = byDay(SAMPLE, { from: '2026-09-01', to: '2026-09-05' });
    eq(days.length, 5, 'cinq jours demandes, cinq points rendus');
    eq(days[0].label, '2026-09-01');
    eq(days[4].label, '2026-09-05');
    eq(days[4].value, 0, 'un jour sans appel vaut zero, il n’est pas saute');
    eq(days.reduce((n, d) => n + d.value, 0), SAMPLE.length, 'aucun appel perdu');
    eq(days[0].in, 1);
    eq(days[2].missed, 1);
    eqDeep(byDay([]), [], 'aucun appel : aucune serie');
  });

  test('byMonth agrege sans perdre d’appel', () => {
    const months = byMonth(SAMPLE, { from: '2026-09-01', to: '2026-09-05' });
    eq(months.length, 1);
    eq(months[0].label, '2026-09');
    eq(months[0].value, SAMPLE.length);
  });

  test('byHour et byWeekday ont toujours leur taille fixe', () => {
    const hours = byHour(SAMPLE);
    eq(hours.length, 24);
    eq(hours.reduce((a, b) => a + b, 0), SAMPLE.length);
    eq(hours[11], 2, 'deux appels a 11 h');

    const week = byWeekday(SAMPLE);
    eq(week.length, 7);
    eq(week.reduce((a, b) => a + b, 0), SAMPLE.length);

    eq(byHour([]).length, 24, 'un jeu vide rend quand meme 24 cases');
    eq(byWeekday([]).length, 7);
  });

  test('heatMatrix est une grille 7 x 24 complete', () => {
    const m = heatMatrix(SAMPLE);
    eq(m.length, 7);
    for (let d = 0; d < 7; d++) eq(m[d].length, 24, 'ligne ' + d);
    let sum = 0;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) sum += m[d][h];
    eq(sum, SAMPLE.length, 'aucun appel perdu dans la grille');
  });

  test('byLine et byPeer regroupent et classent par volume', () => {
    const lines = byLine(SAMPLE);
    eq(lines.length, 2, 'deux CSI distincts');
    const total = lines.reduce((n, l) => n + l.total, 0);
    eq(total, SAMPLE.length);

    const peers = byPeer(SAMPLE);
    eq(peers.length, 6, 'six correspondants distincts');
    eq(peers[0].number, '+33611111111', 'le plus appele en tete');
    eq(peers[0].total, 2);
    eq(peers[0].in, 1);
    eq(peers[0].out, 1);
    ok(peers[0].label, 'chaque correspondant porte un libelle affichable');
    for (let i = 1; i < peers.length; i++) {
      ok(peers[i - 1].total >= peers[i].total, 'classement decroissant a l’indice ' + i);
    }
  });

  test('un manque suivi d’un sortant vers le meme numero est solde', () => {
    const rows = [
      row({ dir: 0, peer: '+33611111111', seconds: 0, ts: 1000 }),
      row({ dir: 1, peer: '+33611111111', seconds: 90, ts: 2000 }),
    ];
    const { pending, done } = callbackAnalysis(rows);
    eq(pending.length, 0, 'plus rien a rappeler');
    eq(done.length, 1);
    eq(done[0].number, '+33611111111');
    eq(done[0].calledBackTs, 2000);
  });

  test('un manque sans rappel reste en attente', () => {
    const rows = [row({ dir: 0, peer: '+33622222222', seconds: 0, ts: 3000 })];
    const { pending, done } = callbackAnalysis(rows);
    eq(pending.length, 1);
    eq(done.length, 0);
    eq(pending[0].count, 1);
    eq(pending[0].calledBackTs, null);
  });

  test('un rappel ANTERIEUR au dernier manque ne solde rien', () => {
    // Manque a 1000, rappel a 1500, nouveau manque a 2000 : la personne a
    // rappele depuis, l’affaire est rouverte.
    const rows = [
      row({ dir: 0, peer: '+33633333333', seconds: 0, ts: 1000 }),
      row({ dir: 1, peer: '+33633333333', seconds: 60, ts: 1500 }),
      row({ dir: 0, peer: '+33633333333', seconds: 0, ts: 2000 }),
    ];
    const { pending, done } = callbackAnalysis(rows);
    eq(pending.length, 1, 'le dernier manque n’est pas rappele');
    eq(done.length, 0);
    eq(pending[0].count, 1, 'seul le manque posterieur au dernier sortant compte');
  });

  test('un sortant a la seconde exacte du manque n’est pas un rappel', () => {
    const rows = [
      row({ dir: 0, peer: '+33644444444', seconds: 0, ts: 5000 }),
      row({ dir: 1, peer: '+33644444444', seconds: 60, ts: 5000 }),
    ];
    const { pending } = callbackAnalysis(rows);
    eq(pending.length, 1, 'comparaison strictement posterieure : appel concurrent, pas rappel');
  });

  test('les appelants masques sont exclus : on ne peut pas les rappeler', () => {
    const rows = [
      row({ dir: 0, peer: 'anonymous', seconds: 0, ts: 6000 }),
      row({ dir: 0, peer: '', seconds: 0, ts: 6100 }),
    ];
    const { pending, done } = callbackAnalysis(rows);
    eq(pending.length, 0);
    eq(done.length, 0);
  });

  test('trois manques du meme numero forment UNE tache', () => {
    const rows = [
      row({ dir: 0, peer: '+33655555555', seconds: 0, ts: 7000 }),
      row({ dir: 0, peer: '+33655555555', seconds: 0, ts: 7100 }),
      row({ dir: 0, peer: '+33655555555', seconds: 0, ts: 7200 }),
    ];
    const { pending } = callbackAnalysis(rows);
    eq(pending.length, 1, 'une entree, pas trois');
    eq(pending[0].count, 3, 'mais elle en compte trois');
    eq(pending[0].lastTs, 7200, 'et pointe le plus recent');
  });

  test('trend rend une serie non vide pour chaque granularite', () => {
    for (const unit of ['day', 'week', 'month']) {
      const t = trend(SAMPLE, unit);
      ok(Array.isArray(t), 'tableau pour ' + unit);
      ok(t.length > 0, 'serie non vide pour ' + unit);
      ok(t.every((p) => typeof p.label === 'string' && Number.isFinite(p.value)),
        'chaque point porte un libelle et une valeur finie, pour ' + unit);
    }
  });
});

// -----------------------------------------------------------------------------
//  10. app/charts.js — passage de fumee : aucune ne doit lever
// -----------------------------------------------------------------------------

if (need(charts, 'app/charts.js', 'app/charts.js')) suite('app/charts.js', () => {
  const { barChart, areaChart, donutChart, heatmap, sparkline } = charts;

  const bars = [{ label: 'Lun', value: 12 }, { label: 'Mar', value: 30 }, { label: 'Mer', value: 0 }];

  test('barChart rend un SVG, avec ou sans donnees', () => {
    has(barChart({ data: bars }), '<svg');
    ok(typeof barChart({ data: [] }) === 'string', 'un jeu vide ne leve pas');
    ok(typeof barChart({}) === 'string', 'aucune option ne leve pas');
  });

  test('areaChart rend un SVG pour une et plusieurs series', () => {
    const one = areaChart({ series: [{ name: 'Entrants', color: 'var(--in)', points: [{ label: 'a', value: 1 }, { label: 'b', value: 4 }] }] });
    has(one, '<svg');
    const two = areaChart({
      series: [
        { name: 'Entrants', points: [{ label: 'a', value: 1 }, { label: 'b', value: 4 }] },
        { name: 'Sortants', points: [{ label: 'a', value: 3 }, { label: 'b', value: 2 }] },
      ],
    });
    has(two, '<svg');
    ok(typeof areaChart({ series: [] }) === 'string');
  });

  test('donutChart supporte le cas d’une seule part et le total nul', () => {
    has(donutChart({ slices: [{ label: 'a', value: 3 }, { label: 'b', value: 1 }] }), '<svg');
    ok(typeof donutChart({ slices: [{ label: 'a', value: 0 }] }) === 'string', 'total nul : pas de division par zero');
    ok(typeof donutChart({ slices: [] }) === 'string');
  });

  // heatmap est la SEULE des cinq a ne pas rendre de SVG : 168 rectangles
  // couteraient plus cher qu'une grille CSS. On verifie donc ses classes.
  test('heatmap rend une grille CSS 7 x 24, et un etat vide quand tout est a zero', () => {
    const vide = Array.from({ length: 7 }, () => new Array(24).fill(0));
    has(heatmap({ matrix: vide }), 'empty-title', 'aucune activite : etat vide annonce');

    const une = Array.from({ length: 7 }, () => new Array(24).fill(0));
    une[2][14] = 9;
    const out = heatmap({ matrix: une });
    has(out, 'class="heat"');
    has(out, 'heat-cell');
    // 7 x 24 cases, ni une de plus ni une de moins.
    eq((out.match(/heat-cell/g) || []).length, 168, 'la grille est complete');
    ok(typeof heatmap({}) === 'string');
  });

  test('sparkline supporte une valeur unique et une serie plate', () => {
    has(sparkline({ values: [1, 5, 3, 9] }), '<svg');
    ok(typeof sparkline({ values: [4] }) === 'string', 'une seule valeur');
    ok(typeof sparkline({ values: [2, 2, 2] }) === 'string', 'serie plate : pas de division par zero');
    ok(typeof sparkline({ values: [] }) === 'string');
  });

  test('les libelles de graphique sont echappes', () => {
    const out = barChart({ data: [{ label: '<script>alert(1)</script>', value: 1 }] });
    lacks(out, '<script>', 'un libelle ne peut pas injecter de balise');
  });

  // Non-regression. Un histogramme peut rendre un SVG parfaitement valide et
  // pourtant ne tracer AUCUNE barre : c'est arrive, la hauteur etant calculee
  // a partir d'un identifiant non declare, donc a partir de NaN. Verifier la
  // presence de <svg> ne suffit pas, il faut verifier qu'il y a du dessin.
  test('barChart trace reellement des barres et gradue son axe', () => {
    const out = barChart({ data: [{ label: 'a', value: 10 }, { label: 'b', value: 4 }] });
    has(out, 'style="fill:', 'au moins une barre est peinte');

    const marques = out.match(/class="axis-value"[^>]*>([^<]*)</g) || [];
    const valeurs = marques.map((s) => s.slice(s.lastIndexOf('>') + 1, -1));
    eq(valeurs.length, 5, 'cinq graduations sur l’axe des ordonnees');
    ok(valeurs.some((v) => v !== '0'), 'l’axe n’est pas entierement a zero, obtenu ' + JSON.stringify(valeurs));
  });

  // Non-regression. `data-tip` est relu par attachChartTips puis pose en
  // innerHTML. Le parseur ayant deja decode l'attribut une fois, la valeur doit
  // y etre DOUBLEMENT echappee : un simple `&lt;` s'y decoderait en `<` et
  // rouvrirait la balise au moment de l'injection.
  test('les info-bulles survivent au decodage de l’attribut sans redevenir du balisage', () => {
    const out = barChart({ data: [{ label: '<img src=x onerror=alert(1)>', value: 5 }] });
    const m = out.match(/data-tip="([^"]*)"/);
    ok(m, 'une info-bulle est bien posee');
    lacks(m[1], '&lt;img', 'une entite simple se decoderait en balise vivante');
    has(m[1], '&amp;lt;img', 'l’esperluette est echappee, donc le decodage rend du texte');
  });
});

// -----------------------------------------------------------------------------
//  11. app/ui.js — briques de rendu, et leur echappement
// -----------------------------------------------------------------------------

if (need(ui, 'app/ui.js', 'app/ui.js')) suite('app/ui.js', () => {
  const { card, sectionHead, kpi, statbar, table, tag, avatar, avatarStack, meter, split, rankRow, empty, notice, skeleton, toolbar } = ui;
  const rawOf = dom.raw;
  const htmlOf = dom.html;

  test('card, sectionHead et toolbar rendent leur contenu', () => {
    has(card({ title: 'Titre', body: rawOf('<p>corps</p>') }), 'Titre');
    has(card({ title: 'Titre', body: rawOf('<p>corps</p>') }), '<p>corps</p>');
    has(sectionHead('Section', 'Sous-titre'), 'Sous-titre');
    ok(typeof toolbar(rawOf('<button></button>')) === 'string');
  });

  test('kpi, statbar, meter, split et rankRow rendent une valeur lisible', () => {
    has(kpi({ label: 'Appels', value: '12 480' }), '12 480');
    has(statbar([{ label: 'Entrants', value: '12', icon: 'in', tone: 'in' }]), 'Entrants');
    ok(typeof meter(50) === 'string');
    ok(typeof meter(0) === 'string');
    ok(typeof meter(200) === 'string', 'une valeur hors bornes ne leve pas');
    has(split({ label: 'Entrants', value: '12', pct: 60, tone: 'in' }), 'Entrants');
    has(rankRow({ rank: 1, label: 'Cabinet Vidal', sub: '12 appels', metric: '12' }), 'Cabinet Vidal');
  });

  test('table rend un tableau complet', () => {
    const out = table({
      columns: [{ key: 'a', label: 'Colonne A' }, { key: 'b', label: 'Colonne B', align: 'right' }],
      rows: [['un', 'deux'], ['trois', 'quatre']],
    });
    has(out, '<table');
    has(out, 'Colonne A');
    has(out, 'quatre');
    ok(typeof table({ columns: [], rows: [] }) === 'string', 'un tableau vide ne leve pas');
  });

  test('tag, avatar et avatarStack restent lisibles en toute circonstance', () => {
    has(tag('Entrant', 'in'), 'tag--in');
    has(tag('Manqué', 'missed'), 'tag--missed');
    has(tag('Inconnu', 'ton-inexistant'), 'tag--neutral', 'un ton inconnu retombe sur neutre');
    has(avatar('Marie Dupont'), 'MD');
    has(avatarStack(['Marie Dupont', 'Paul Bernard']), 'avatar-stack');
    has(avatarStack(['A B', 'C D', 'E F', 'G H', 'I J'], 3), '+2', 'le surplus est compte');
    ok(typeof avatarStack([]) === 'string');
  });

  test('empty, notice et skeleton disent ce qui manque', () => {
    has(empty('Rien ici', 'Elargissez la periode'), 'Rien ici');
    has(notice({ tone: 'error', title: 'Panne', body: rawOf('detail') }), 'notice--error');
    has(notice({ tone: 'error', title: 'Panne', body: rawOf('detail') }), 'role="alert"', 'une erreur interrompt la lecture');
    has(notice({ tone: 'warn', body: rawOf('x') }), 'role="status"');
    ok(typeof skeleton() === 'string');
    ok(typeof skeleton('card') === 'string');
  });

  test('AUCUNE brique ne laisse passer du balisage non echappe', () => {
    const evil = '<img src=x onerror=alert(1)>';
    // Les cellules de `table` sont, PAR CONTRAT, du HTML deja sur : les pages
    // les construisent avec le gabarit html``. On la sollicite donc comme elles
    // le font, et c'est le libelle de colonne — lui echappe — qui porte
    // l'attaque. Le contrat inverse est verifie par le test suivant.
    const outputs = [
      card({ title: evil, body: rawOf('sur') }),
      sectionHead(evil, evil),
      kpi({ label: evil, value: evil, foot: evil }),
      tag(evil, 'in'),
      empty(evil, evil),
      notice({ tone: 'warn', title: evil, body: rawOf('sur') }),
      rankRow({ rank: 1, label: evil, sub: evil, metric: evil }),
      split({ label: evil, value: evil, pct: 10 }),
      table({ columns: [{ key: 'a', label: evil }], rows: [[htmlOf`${evil}`]] }),
    ];
    for (let i = 0; i < outputs.length; i++) {
      // La charge utile ne doit jamais reapparaitre telle quelle...
      lacks(outputs[i], evil, 'sortie ' + i);
      lacks(outputs[i], '<img', 'sortie ' + i);
      // ...et sa forme echappee doit, elle, etre bien presente : sans cela le
      // test passerait aussi sur une brique qui se contenterait de tout jeter.
      // (On ne cherche PAS « onerror= » : esc() n'echappe pas le signe egal,
      // et n'a aucune raison de le faire — c'est `<` qui desamorce la balise.)
      has(outputs[i], '&lt;img', 'sortie ' + i);
    }
  });

  test('les cellules de table sont du HTML deja sur, comme le contrat l’annonce', () => {
    const out = table({
      columns: [{ key: 'a', label: 'Colonne' }],
      rows: [[rawOf('<b>gras</b>')]],
    });
    has(out, '<b>gras</b>', 'une cellule marquee sure traverse sans etre echappee');
  });
});

// -----------------------------------------------------------------------------
//  12. app/router.js — la table des vues doit coller a index.html
// -----------------------------------------------------------------------------

if (need(router, 'app/router.js', 'app/router.js')) suite('app/router.js', () => {
  const { ROUTES } = router;

  test('les huit vues sont declarees, sans doublon', () => {
    eq(ROUTES.length, 8);
    const ids = ROUTES.map((r) => r.id);
    eq(new Set(ids).size, 8, 'aucun identifiant en double');
    eqDeep(ids, ['monitoring', 'calls', 'missed', 'peers', 'people', 'agents', 'lines', 'diagnostics'],
      'ordre du menu de index.html');
  });

  test('chaque vue porte un titre, un sous-titre et un choix de barre de periode', () => {
    for (const r of ROUTES) {
      ok(r.title && typeof r.title === 'string', 'titre de ' + r.id);
      ok(r.sub && typeof r.sub === 'string', 'sous-titre de ' + r.id);
      eq(typeof r.needsPeriod, 'boolean', 'needsPeriod de ' + r.id);
    }
    eq(ROUTES.find((r) => r.id === 'diagnostics').needsPeriod, false,
      'le diagnostic decrit toute la collecte, pas une fenetre de dates');
    eq(ROUTES.find((r) => r.id === 'agents').needsPeriod, false,
      'l’attribution est rangee par mois, pas par la barre de periode');
  });
});

// -----------------------------------------------------------------------------
//  Rapport
// -----------------------------------------------------------------------------

function report() {
  const total = RESULTS.length;
  const failed = RESULTS.filter((r) => !r.ok && !r.skipped);
  const skipped = RESULTS.filter((r) => r.skipped);
  const passed = total - failed.length - skipped.length;

  const groups = [];
  const byName = new Map();
  for (const r of RESULTS) {
    let g = byName.get(r.suite);
    if (!g) { g = { name: r.suite, items: [] }; byName.set(r.suite, g); groups.push(g); }
    g.items.push(r);
  }

  // Le rapport echappe lui aussi : un message d'erreur peut contenir du
  // balisage. Repli local si app/dom.js est precisement le module en panne.
  function escape(s) {
    if (dom && typeof dom.esc === 'function') return dom.esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  const esc = escape;

  let out = '';
  for (const g of groups) {
    const bad = g.items.filter((r) => !r.ok && !r.skipped).length;
    const skp = g.items.filter((r) => r.skipped).length;
    let cls = 'g-ok';
    if (bad) cls = 'g-bad';
    else if (skp) cls = 'g-skip';

    out += '<section class="g ' + cls + '">';
    out += '<h2>' + esc(g.name) + ' <span class="count">' + (g.items.length - bad - skp) + '/' + g.items.length + '</span></h2>';
    out += '<ul>';
    for (const r of g.items) {
      let mark = '<span class="m ok">OK</span>';
      if (r.skipped) mark = '<span class="m skip">SAUTE</span>';
      else if (!r.ok) mark = '<span class="m bad">ECHEC</span>';
      out += '<li class="' + (r.ok ? 'ok' : (r.skipped ? 'skip' : 'bad')) + '">' + mark + '<span class="n">' + esc(r.name) + '</span>';
      if (r.detail) out += '<pre>' + esc(r.detail) + '</pre>';
      out += '</li>';
    }
    out += '</ul></section>';
  }

  const host = document.getElementById('results');
  if (host) host.innerHTML = out;

  const sum = document.getElementById('summary');
  if (sum) {
    let tone = 'ok';
    if (failed.length) tone = 'bad';
    else if (skipped.length) tone = 'skip';
    let label = passed + ' verifications passees';
    if (failed.length) label += ' — ' + failed.length + ' EN ECHEC';
    if (skipped.length) label += ' — ' + skipped.length + ' sautee(s)';
    sum.className = 'summary ' + tone;
    sum.textContent = label;
  }

  document.title = (failed.length ? 'ECHEC (' + failed.length + ') — ' : 'OK — ') + 'Autotest Keyyo';

  // Point d'accroche pour une verification automatisee (console, ou pilotage
  // du navigateur) : pas besoin de lire la page pour savoir si tout passe.
  window.__selftest = { total, passed, failed: failed.length, skipped: skipped.length, results: RESULTS };

  if (failed.length) {
    console.error('[selftest] ' + failed.length + ' verification(s) en echec');
    for (const r of failed) console.error('  ' + r.suite + ' > ' + r.name + '\n    ' + r.detail);
  } else {
    console.info('[selftest] ' + passed + ' verifications passees, ' + skipped.length + ' sautee(s)');
  }
}

report();
