// =============================================================================
//  api/_collect.js — Orchestration d'une collecte.
//
//  Enchainement : archive -> jeton -> lignes -> identites -> releves d'appels
//  (par tranches mensuelles, en parallele borne) -> fusion -> persistance.
//
//  Trois regles gouvernent ce module :
//
//    1. BUDGET DE TEMPS. Une fonction serverless a une duree maximale. Quand le
//       budget est epuise, on RENVOIE CE QU'ON A DEJA, en listant les mois
//       incomplets dans `store.missingMonths`. On n'echoue jamais pour cause
//       de lenteur.
//
//    2. UN MOIS N'EST COUVERT QUE QUAND TOUTES SES REQUETES ONT ABOUTI. Appris
//       en production : une requete Keyyo dure 3 a 4 s, une collecte complete
//       en compte 24 (3 lignes x 2 sens x 4 mois), et la premiere version
//       marquait un mois « synchronise » des qu'UNE de ses requetes avait
//       repondu — les autres, sautees faute de temps, laissaient juillet et
//       aout a zero pour toujours. La couverture porte desormais un drapeau
//       `complete` par mois, pose seulement quand chaque ligne et chaque sens
//       ont ete releves sur le mois entier.
//
//    3. L'HISTORIQUE SE CONSTITUE TOUT SEUL, UNE REQUETE A LA FOIS. Chaque
//       passage incremental (le sondage de la page, le cron) releve d'abord
//       les jours recents, puis consacre le temps restant au mois incomplet
//       LE PLUS ANCIEN de la fenetre d'historique — en sequence, jamais en
//       rafale, pour ne pas disputer le budget aux jours recents ni provoquer
//       un 429. Chaque requete aboutie (une ligne, un sens, un mois) est
//       inscrite dans l'archive : un passage interrompu ne refait jamais ce
//       qui est acquis. Passage apres passage, les trois mois finissent
//       archives ; ensuite seuls les jours recents sont redemandes.
//
//    Echec partiel tolere : une ligne en erreur alimente `errors[]` et
//    n'empeche pas les autres d'aboutir. Seule l'impossibilite totale de
//    produire quoi que ce soit (pas de jeton ET pas d'archive) fait echouer.
// =============================================================================

import { readConfig, errorMessage } from './_config.js';
import {
  getAccessToken, fetchVoipLines, fetchEmailAccounts, fetchDirectoryContacts, fetchCallDetail,
} from './_keyyo.js';
import { archiveEnabled, loadArchive, saveArchive, mergeRows } from './_archive.js';
import { F } from '../shared/schema.js';
import { isoDaysAgo, todayIso, monthSlices, daysBetween } from '../shared/time.js';
import { resolveLineIdentities } from '../shared/identity.js';

/**
 * Nombre maximal de requetes Keyyo simultanees. Volontairement bas : l'API
 * repond 429 au-dela, et un 429 coute plus cher qu'une requete differee.
 */
const MAX_CONCURRENCY = 6;

/** Temps reserve a la fusion et a l'ecriture de l'archive, hors budget de collecte. */
const PERSIST_RESERVE_MS = 3000;

/**
 * @typedef {object} CollectResult
 * @property {any[]} rows
 * @property {any[]} lines
 * @property {object} meta
 * @property {Record<string, {count: number, syncedAt: string}>} coverage
 * @property {Array<object>} errors
 * @property {string[]} warnings
 * @property {object} diag
 * @property {object} store
 */

/**
 * @param {{full?: boolean, month?: string, sinceDays?: number, budgetMs?: number}} [opts]
 * @returns {Promise<CollectResult>}
 */
export async function collect(opts) {
  const o = opts || {};
  const startedAt = Date.now();
  const cfg = readConfig();
  const now = startedAt;
  const nowIso = new Date(now).toISOString();

  const budgetMs = clampInt(o.budgetMs, cfg.budgetMs || 24000, 3000, 280000);
  const deadline = startedAt + budgetMs;
  const taskDeadline = Math.max(startedAt + 1500, deadline - PERSIST_RESERVE_MS);

  /** @type {Array<object>} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  // Informations qui ne sont PAS des defauts de collecte : elles s'affichent
  // a part, jamais sous « collecte partielle ».
  /** @type {string[]} */
  const notes = [];

  // -- Archive ---------------------------------------------------------------
  const storeEnabled = archiveEnabled();
  if (!storeEnabled) {
    warnings.push(
      "Archive désactivée : les appels ne sont pas mémorisés, seule la fenêtre encore servie par Keyyo est visible. "
      + 'Relier un store Blob au projet Vercel pour conserver les trois mois.',
    );
  }
  /** @type {{version: number, savedAt: string, rows: any[], coverage: Record<string, any>}|null} */
  let archive = null;
  try {
    archive = await loadArchive();
  } catch (err) {
    warnings.push(errorMessage(err));
    errors.push({ scope: 'archive', message: errorMessage(err) });
  }
  const archiveRows = archive ? archive.rows : [];
  const prevCoverage = archive ? archive.coverage : {};
  const firstSync = !archiveRows.length;

  // -- Jeton -----------------------------------------------------------------
  /** @type {string} */
  let token = '';
  try {
    token = await getAccessToken(cfg);
  } catch (err) {
    const message = errorMessage(err);
    errors.push({ scope: 'auth', message });
    // Sans jeton et sans archive, il n'y a rien a servir : on echoue clairement.
    if (!archiveRows.length) {
      throw new Error(message + " Aucune archive disponible pour servir de repli.");
    }
    warnings.push("Authentification Keyyo en échec : affichage de l'archive seule, sans mise à jour.");
  }

  // -- Lignes et identites ---------------------------------------------------
  /** @type {any[]} */
  let voipLines = [];
  /** @type {any[]} */
  let directoryContacts = [];
  /** @type {any[]} */
  let emailAccounts = [];

  if (token) {
    try {
      voipLines = await fetchVoipLines(cfg, token, { deadline: taskDeadline });
    } catch (err) {
      errors.push({ scope: 'services', message: errorMessage(err) });
    }
    if (!voipLines.length && !hasScope(errors, 'services')) {
      errors.push({
        scope: 'services',
        message: "Aucune ligne VoIP (UCaaSVoIPAccount) sur ce compte Keyyo : il n'y a rien à superviser. "
          + 'Vérifier que le jeton porte sur le bon compte et que le scope full_access_read_only est accordé.',
      });
    }

    // Les sources d'identite sont facultatives : leur absence degrade
    // l'affichage (un CSI au lieu d'un prenom), elle ne bloque pas la collecte.
    const [contactsRes, mailboxesRes] = await Promise.all([
      settle(() => fetchDirectoryContacts(cfg, token, { deadline: taskDeadline })),
      settle(() => fetchEmailAccounts(cfg, token, { deadline: taskDeadline })),
    ]);
    if (contactsRes.ok) directoryContacts = contactsRes.value;
    else errors.push({ scope: 'directory_contacts', message: contactsRes.message });
    if (mailboxesRes.ok) emailAccounts = mailboxesRes.value;
    else errors.push({ scope: 'email_accounts', message: mailboxesRes.message });
  }

  const lines = resolveLineIdentities({
    voipLines,
    directoryContacts,
    emailAccounts,
    overrides: cfg.lineEmails,
  });
  // Deux situations tres differentes, qu'il ne faut pas confondre dans un
  // meme message : une ligne PARTAGEE par une equipe n'est pas une ligne mal
  // configuree, et aucun reglage ne la resoudra.
  const sharedLines = lines.filter((l) => l.shared);
  const unresolvedCount = lines.filter((l) => !l.shared && (!l.person || !l.person.email)).length;

  if (sharedLines.length) {
    // Une INFORMATION, pas un defaut : la collecte est complete, c'est la
    // source qui ne nomme personne. La repartition par personne vient du
    // journal d'attribution (vue Attribution), pas des releves Keyyo.
    const people = sharedLines.reduce((n, l) => n + (l.team ? l.team.length : 0), 0);
    notes.push(
      sharedLines.length + ' ligne(s) sont partagées par ' + people + ' personnes au total. '
      + "Les relevés Keyyo n'indiquent pas quel poste a pris un appel : la répartition par "
      + 'personne vient de la vue Attribution (actions faites dans l’application).',
    );
  }
  if (voipLines.length && unresolvedCount) {
    warnings.push(
      unresolvedCount + ' ligne(s) sur ' + lines.length + " sans adresse e-mail rattachée : "
      + 'voir /api/team pour le réglage KEYYO_LINE_EMAILS à coller.',
    );
  }

  // -- Fenetre a collecter ---------------------------------------------------
  const today = todayIso(now, cfg.tz);
  const historyStart = isoDaysAgo(cfg.historyDays - 1, now, cfg.tz);
  const expectedMonths = monthSlices(historyStart, today).map((s) => s.month);   // le plus recent d'abord
  const month = normalizeMonth(o.month);
  let strategy;
  let windowDays;
  let fromIso;
  let toIso;

  if (month) {
    strategy = 'month';
    const bounds = monthBounds(month, today);
    fromIso = bounds.from;
    toIso = bounds.to;
    windowDays = daysBetween(fromIso, toIso) + 1;
  } else if (o.full || firstSync) {
    strategy = o.full ? 'full' : 'first_sync';
    windowDays = cfg.historyDays;
    fromIso = historyStart;
    toIso = today;
  } else {
    strategy = 'incremental';
    windowDays = clampInt(o.sinceDays, cfg.syncDays, 1, cfg.historyDays);
    fromIso = isoDaysAgo(windowDays - 1, now, cfg.tz);
    toIso = today;
  }
  if (fromIso > toIso) fromIso = toIso;

  const slices = monthSlices(fromIso, toIso);      // le mois le plus recent d'abord

  // -- Ce qu'un mois complet exige : chaque ligne, dans chaque sens ----------
  // La cle « csi:sens » identifie une requete couvrant le mois entier. La
  // couverture archivee garde, par mois, la liste des cles deja acquises
  // (`done`) : c'est elle qui permet d'avancer requete par requete.
  /** @type {string[]} */
  const requiredKeys = [];
  for (const line of voipLines) { requiredKeys.push(line.csi + ':in'); requiredKeys.push(line.csi + ':out'); }
  const doneBefore = (ym) => new Set(Array.isArray((prevCoverage[ym] || {}).done) ? prevCoverage[ym].done.map(String) : []);

  // -- Rattrapage : le mois incomplet le plus ancien de la fenetre -----------
  // En incremental seulement : une collecte complete ou mensuelle vise deja ce
  // qu'on lui demande. Seules les requetes ENCORE MANQUANTES du mois sont
  // relancees, sur le mois entier (borne par la fenetre d'historique et par
  // aujourd'hui), sinon il ne pourrait jamais etre declare complet.
  let backfillMonth = '';
  if (strategy === 'incremental' && token && voipLines.length) {
    const missingBefore = expectedMonths.filter((ym) => !isCompleteEntry(prevCoverage[ym])).sort();
    if (missingBefore.length) backfillMonth = missingBefore[0];
  }

  // -- Taches ----------------------------------------------------------------
  /** @typedef {{csi: string, direction: 'in'|'out', month: string, from: string, to: string, kind: 'recent'|'backfill'}} Task */
  /** @type {Task[]} */
  const recentTasks = [];
  /** @type {Task[]} */
  const backfillTasks = [];
  if (token && voipLines.length) {
    // Tranche par tranche : le mois le plus recent est complet avant d'attaquer
    // le suivant, de sorte qu'un budget epuise ne laisse pas de trou recent.
    for (const slice of slices) {
      for (const line of voipLines) {
        recentTasks.push({ csi: line.csi, direction: 'in', month: slice.month, from: slice.from, to: slice.to, kind: 'recent' });
        recentTasks.push({ csi: line.csi, direction: 'out', month: slice.month, from: slice.from, to: slice.to, kind: 'recent' });
      }
    }
    if (backfillMonth) {
      const b = clampMonthBounds(backfillMonth, historyStart, today);
      const bslices = monthSlices(b.from, b.to);
      const acquired = doneBefore(backfillMonth);
      for (const slice of bslices) {
        for (const line of voipLines) {
          for (const direction of /** @type {Array<'in'|'out'>} */ (['in', 'out'])) {
            if (acquired.has(line.csi + ':' + direction)) continue;
            backfillTasks.push({ csi: line.csi, direction, month: slice.month, from: slice.from, to: slice.to, kind: 'backfill' });
          }
        }
      }
    }
  }
  const tasks = recentTasks.concat(backfillTasks);

  // Une requete « couvre » son mois quand elle porte sur le mois entier (dans
  // la fenetre d'historique). Une tranche de sept jours ne couvre pas un
  // mois : elle ne compte ni pour ni contre sa completude.
  const covering = (t) => {
    const b = clampMonthBounds(t.month, historyStart, today);
    // `to` des tranches est EXCLUSIF (monthSlices) ; `b.to` est inclusif.
    return t.from <= b.from && t.to > b.to;
  };
  /** @type {Record<string, Set<string>>} cles acquises PAR CE PASSAGE, par mois. */
  const doneNow = {};

  /** @type {any[]} */
  const freshRows = [];
  /** @type {Array<object>} */
  const perTask = [];
  /** @type {Set<string>} */
  const touchedMonths = new Set();
  /** @type {Record<string, number>} */
  const dropReasons = {};
  let rawSeen = 0;
  let kept = 0;
  let dropped = 0;
  let skipped = 0;
  let skippedBackfill = 0;
  let truncatedTasks = 0;

  /** @param {Task} task */
  const worker = async (task) => {
    if (Date.now() >= taskDeadline) {
      if (task.kind === 'backfill') skippedBackfill++; else skipped++;
      perTask.push({
        csi: task.csi, direction: task.direction, month: task.month, kind: task.kind,
        from: task.from, to: task.to, ok: false, skipped: true,
        reason: 'budget de temps épuisé avant le lancement',
      });
      return;
    }
    try {
      const res = await fetchCallDetail(cfg, token, {
        csi: task.csi,
        direction: task.direction,
        from: task.from,
        to: task.to,
        month: task.month,
        deadline: taskDeadline,
      });
      for (const row of res.rows) freshRows.push(row);
      const d = /** @type {any} */ (res.diag);
      rawSeen += Number(d.rawSeen) || 0;
      kept += Number(d.kept) || 0;
      dropped += Number(d.dropped) || 0;
      if (d.truncated) truncatedTasks++;
      for (const k of Object.keys(d.dropReasons || {})) {
        dropReasons[k] = (dropReasons[k] || 0) + d.dropReasons[k];
      }
      touchedMonths.add(task.month);
      // Une requete tronquee par la pagination n'a pas tout lu : elle n'est
      // pas acquise, elle sera rejouee (avec KEYYO_MAX_PAGES releve).
      if (covering(task) && !d.truncated) {
        (doneNow[task.month] || (doneNow[task.month] = new Set())).add(task.csi + ':' + task.direction);
      }
      perTask.push(Object.assign({ kind: task.kind }, d));
    } catch (err) {
      const budget = !!(err && /** @type {any} */ (err).budget);
      if (budget) { if (task.kind === 'backfill') skippedBackfill++; else skipped++; }
      const message = errorMessage(err);
      perTask.push({
        csi: task.csi, direction: task.direction, month: task.month, kind: task.kind,
        from: task.from, to: task.to, ok: false, skipped: budget,
        reason: budget ? 'budget de temps épuisé pendant la requête' : message,
      });
      if (!budget) {
        errors.push({
          scope: 'call_detail', csi: task.csi, direction: task.direction, month: task.month, message,
        });
      }
    }
  };

  // Les jours recents en parallele borne ; le rattrapage ensuite, UNE requete
  // a la fois, avec ce qui reste de budget.
  await runPool(recentTasks, MAX_CONCURRENCY, worker);
  await runPool(backfillTasks, 1, worker);

  /**
   * Cles acquises par mois, passe compris, et mois desormais complets (toutes
   * les lignes, dans les deux sens).
   * @type {Record<string, string[]>}
   */
  const doneByMonth = {};
  /** @type {Set<string>} */
  const completeMonths = new Set();
  const monthsSeen = new Set(Object.keys(prevCoverage).concat(Object.keys(doneNow)));
  for (const ym of monthsSeen) {
    const acc = doneBefore(ym);
    for (const k of doneNow[ym] || []) acc.add(k);
    doneByMonth[ym] = Array.from(acc).sort();
    if (requiredKeys.length && requiredKeys.every((k) => acc.has(k))) completeMonths.add(ym);
  }

  if (skipped) {
    warnings.push(
      skipped + ' requête(s) non exécutée(s) faute de temps (budget de ' + budgetMs + ' ms). '
      + 'Les données déjà collectées sont conservées ; la prochaine synchronisation complète.',
    );
  }
  if (truncatedTasks) {
    warnings.push(
      truncatedTasks + ' relevé(s) tronqué(s) par la limite de pagination (KEYYO_MAX_PAGES = '
      + cfg.maxPages + ') : augmenter cette limite ou collecter mois par mois avec ?month=YYYY-MM.',
    );
  }

  // -- Fusion et persistance -------------------------------------------------
  const merged = mergeRows(archiveRows, freshRows, { retentionDays: cfg.retentionDays, now });
  const rows = merged.rows;

  const coverage = buildCoverage(rows, touchedMonths, prevCoverage, nowIso, completeMonths, doneByMonth);
  // Un mois est « manquant » tant qu'il n'est pas COMPLET : absent, ou
  // parcouru sans que toutes ses requetes aient abouti.
  const missingMonths = expectedMonths.filter((ym) => !isCompleteEntry(coverage[ym])).sort();

  if (backfillMonth) {
    if (completeMonths.has(backfillMonth)) {
      const n = coverage[backfillMonth] ? coverage[backfillMonth].count : 0;
      notes.push('Historique : ' + backfillMonth + ' archivé (' + n + ' appel(s)).'
        + (missingMonths.length ? ' Reste à compléter : ' + missingMonths.join(', ') + '.' : ' Les ' + cfg.historyDays + ' jours visés sont couverts.'));
    } else {
      const got = (doneByMonth[backfillMonth] || []).length;
      notes.push('Historique en cours de constitution : ' + backfillMonth + ' est acquis à ' + got + ' requête(s) sur ' + requiredKeys.length
        + (skippedBackfill ? ' (' + skippedBackfill + ' reportée(s) faute de temps)' : '')
        + '. Les mois restants (' + missingMonths.join(', ') + ') se complètent aux prochaines synchronisations, une requête à la fois.');
    }
  } else if (strategy === 'incremental' && missingMonths.length) {
    notes.push('Mois encore incomplets : ' + missingMonths.join(', ') + '.');
  }

  // La couverture peut evoluer SANS qu'aucune ligne ne bouge : un mois collecte
  // et vide n'ajoute rien a `rows` mais doit cesser d'etre declare manquant.
  // Sans ce test, ce constat ne vivrait qu'en memoire de la fonction et serait
  // reperdu a l'invocation suivante.
  //
  // On ne compare QUE la partie structurelle — les mois, leurs comptes et leur
  // completude, dont depend `missingMonths`. Surtout pas `syncedAt` : il vaut
  // l'heure courante pour tout mois parcouru, donc il change a CHAQUE
  // invocation, et le comparer reecrirait l'archive entiere a chaque
  // chargement de page. La signature triee evite au passage toute dependance
  // a l'ordre des cles.
  const coverageKey = (c) => Object.keys(c || {}).sort()
    .map((ym) => ym + ':' + (Number((c[ym] || {}).count) || 0) + ':' + (isCompleteEntry(c[ym]) ? 1 : 0)
      + ':' + (Array.isArray((c[ym] || {}).done) ? c[ym].done.length : 0))
    .join('|');
  const coverageChanged = coverageKey(coverage) !== coverageKey(prevCoverage);

  let persisted = false;
  if (storeEnabled && (merged.added || merged.updated || coverageChanged || !archive)) {
    try {
      persisted = await saveArchive({ rows, coverage });
    } catch (err) {
      warnings.push(errorMessage(err));
      errors.push({ scope: 'archive_write', message: errorMessage(err) });
    }
  }

  const meta = buildMeta(rows);

  return {
    rows,
    lines,
    meta,
    coverage,
    errors,
    warnings,
    notes,
    diag: {
      perTask,
      rawSeen,
      kept,
      dropped,
      dropReasons,
      strategy,
      windowDays,
      elapsedMs: Date.now() - startedAt,
      from: fromIso,
      to: toIso,
      slices: slices.map((s) => s.month),
      tasks: tasks.length,
      skipped,
      skippedBackfill,
      backfillMonth: backfillMonth || null,
      completeMonths: Array.from(completeMonths).sort(),
      budgetMs,
      concurrency: MAX_CONCURRENCY,
    },
    store: {
      enabled: storeEnabled,
      firstSync,
      windowDays,
      freshFromKeyyo: freshRows.length,
      added: merged.added,
      updated: merged.updated,
      total: rows.length,
      persisted,
      lastSavedAt: persisted ? nowIso : (archive && archive.savedAt ? archive.savedAt : null),
      missingMonths,
    },
  };
}

// -----------------------------------------------------------------------------
//  Outils internes
// -----------------------------------------------------------------------------

/**
 * File d'attente a parallelisme borne, ecrite a la main : le projet interdit
 * toute dependance externe. Le worker ne doit jamais rejeter.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} worker
 * @returns {Promise<void>}
 */
async function runPool(items, limit, worker) {
  if (!items.length) return;
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = [];
  for (let w = 0; w < width; w++) {
    runners.push((async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    })());
  }
  await Promise.all(runners);
}

/**
 * Execute une promesse sans laisser son rejet remonter.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ok: true, value: T}|{ok: false, message: string, value: any[]}>}
 */
async function settle(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, message: errorMessage(err), value: [] };
  }
}

/** @param {Array<{scope?: string}>} errors @param {string} scope @returns {boolean} */
function hasScope(errors, scope) {
  for (const e of errors) if (e && e.scope === scope) return true;
  return false;
}

/** @param {unknown} raw @param {number} fallback @param {number} min @param {number} max @returns {number} */
function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** @param {unknown} raw @returns {string} `YYYY-MM` valide, ou chaine vide. */
function normalizeMonth(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : '';
}

/**
 * Bornes calendaires d'un mois, jamais au-dela d'aujourd'hui.
 * @param {string} month `YYYY-MM`
 * @param {string} today `YYYY-MM-DD`
 * @returns {{from: string, to: string}} bornes INCLUSIVES (monthSlices gere l'exclusivite).
 */
function monthBounds(month, today) {
  const from = month + '-01';
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const firstOfNext = ny + '-' + String(nm).padStart(2, '0') + '-01';
  const last = prevDay(firstOfNext);
  return { from, to: last > today ? today : last };
}

/** @param {string} iso @returns {string} veille de `YYYY-MM-DD`. */
function prevDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Bornes INCLUSIVES d'un mois, rognees a la fenetre d'historique et a
 * aujourd'hui : c'est ce qu'une collecte doit couvrir pour que le mois soit
 * declare complet.
 * @param {string} month `YYYY-MM`
 * @param {string} historyStart `YYYY-MM-DD`
 * @param {string} today `YYYY-MM-DD`
 * @returns {{from: string, to: string}}
 */
function clampMonthBounds(month, historyStart, today) {
  const b = monthBounds(month, today);
  return { from: b.from < historyStart ? historyStart : b.from, to: b.to };
}

/**
 * Une entree de couverture dit-elle que le mois est complet ? Les archives
 * ecrites avant le drapeau `complete` repondent non : elles seront relevees
 * une fois en entier, puis marquees. C'est le prix, paye une seule fois, de
 * la certitude.
 * @param {any} entry
 * @returns {boolean}
 */
function isCompleteEntry(entry) {
  return !!(entry && entry.complete === true);
}

/**
 * Couverture par mois. Un mois interroge sans aucun appel est enregistre avec
 * `count: 0` : sinon il serait signale « manquant » a chaque synchronisation.
 * Le drapeau `complete` n'est pose que par une collecte qui a couvert le mois
 * entier, et il survit aux passages incrementaux suivants.
 * @param {any[]} rows
 * @param {Set<string>} touched
 * @param {Record<string, any>} prev
 * @param {string} nowIso
 * @param {Set<string>} complete  mois dont toutes les requetes couvrantes ont abouti
 * @param {Record<string, string[]>} [doneByMonth]  cles « csi:sens » acquises, par mois
 * @returns {Record<string, {count: number, syncedAt: string, complete: boolean, done: string[]}>}
 */
function buildCoverage(rows, touched, prev, nowIso, complete, doneByMonth) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of rows) {
    const ym = String(row[F.date] || '').slice(0, 7);
    if (ym) counts[ym] = (counts[ym] || 0) + 1;
  }

  /** @type {Record<string, {count: number, syncedAt: string, complete: boolean, done: string[]}>} */
  const coverage = {};
  const done = complete || new Set();
  const wasComplete = (ym) => isCompleteEntry(prev && prev[ym]);
  const acquired = (ym) => (doneByMonth && Array.isArray(doneByMonth[ym]) ? doneByMonth[ym].slice()
    : (prev && prev[ym] && Array.isArray(prev[ym].done) ? prev[ym].done.map(String) : []));

  // On ne reprend de la couverture precedente QUE les mois collectes et VIDES.
  //
  // Eux seuls disparaitraient a tort : ils ne produisent aucune ligne, donc
  // n'apparaissent pas dans `counts`, et une synchronisation incrementale ne
  // les touche plus. Sans cette reprise, un mois legitimement sans appel
  // (ligne creee plus tard, fermeture estivale) serait declare manquant et
  // recollecte indefiniment pour ne rien trouver — a condition qu'il ait ete
  // releve en entier, ce que dit son drapeau.
  //
  // Les autres ne sont volontairement PAS repris : un mois qui a des lignes
  // est reconstruit ci-dessous a partir de `rows`, et un mois dont la
  // retention a purge les lignes doit redevenir honnetement absent plutot que
  // de conserver a jamais un compte que plus rien n'appuie.
  if (prev) {
    for (const ym of Object.keys(prev)) {
      const p = prev[ym];
      if (p && Number(p.count) === 0) {
        coverage[ym] = { count: 0, syncedAt: String(p.syncedAt || ''), complete: wasComplete(ym), done: acquired(ym) };
      }
    }
  }

  const months = Object.keys(counts).sort();
  for (const ym of months) {
    const before = prev && prev[ym] && prev[ym].syncedAt ? String(prev[ym].syncedAt) : '';
    coverage[ym] = { count: counts[ym], syncedAt: touched.has(ym) ? nowIso : (before || nowIso), complete: wasComplete(ym), done: acquired(ym) };
  }

  // Tout mois REELLEMENT parcouru porte l'horodatage de ce passage, meme s'il
  // est ressorti vide. Sans cette mise a jour, la page Diagnostic annoncerait
  // « il y a trois mois » pour un mois synchronise a l'instant, et inviterait a
  // le recollecter pour rien.
  for (const ym of Array.from(touched).sort()) {
    if (coverage[ym]) coverage[ym].syncedAt = nowIso;
    else coverage[ym] = { count: 0, syncedAt: nowIso, complete: false, done: acquired(ym) };
  }

  // Les cles acquises par ce passage (meme sans ligne produite) et le drapeau
  // de completude, pose seulement sur les mois releves en entier.
  for (const ym of Object.keys(doneByMonth || {})) {
    if (!coverage[ym]) coverage[ym] = { count: 0, syncedAt: nowIso, complete: false, done: acquired(ym) };
    else coverage[ym].done = acquired(ym);
  }
  for (const ym of done) {
    if (!coverage[ym]) coverage[ym] = { count: 0, syncedAt: nowIso, complete: true, done: acquired(ym) };
    else coverage[ym].complete = true;
  }
  return coverage;
}

/**
 * @param {any[]} rows
 * @returns {{n: number, min: string|null, max: string|null, days: number, months: string[], csis: string[]}}
 */
function buildMeta(rows) {
  let min = '';
  let max = '';
  /** @type {Set<string>} */
  const months = new Set();
  /** @type {Set<string>} */
  const csis = new Set();

  for (const row of rows) {
    const date = String(row[F.date] || '');
    if (date) {
      if (!min || date < min) min = date;
      if (!max || date > max) max = date;
      months.add(date.slice(0, 7));
    }
    const csi = String(row[F.csi] || '');
    if (csi) csis.add(csi);
  }

  return {
    n: rows.length,
    min: min || null,
    max: max || null,
    days: min && max ? daysBetween(min, max) + 1 : 0,
    months: Array.from(months).sort().reverse(),
    csis: Array.from(csis).sort(),
  };
}
