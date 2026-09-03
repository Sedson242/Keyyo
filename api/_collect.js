// =============================================================================
//  api/_collect.js — Orchestration d'une collecte.
//
//  Enchainement : archive -> jeton -> lignes -> identites -> releves d'appels
//  (par tranches mensuelles, en parallele borne) -> fusion -> persistance.
//
//  Deux regles gouvernent ce module :
//
//    1. BUDGET DE TEMPS. Une fonction serverless a une duree maximale. Quand le
//       budget est epuise, on RENVOIE CE QU'ON A DEJA, en listant les tranches
//       non collectees dans `store.missingMonths` — le cron ou un ?full=1
//       reprendra. On n'echoue jamais pour cause de lenteur.
//
//    2. ECHEC PARTIEL TOLERE. Une ligne en erreur alimente `errors[]` et
//       n'empeche pas les autres d'aboutir. Seule l'impossibilite totale de
//       produire quoi que ce soit (pas de jeton ET pas d'archive) fait echouer.
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

  // -- Archive ---------------------------------------------------------------
  const storeEnabled = archiveEnabled();
  if (!storeEnabled) {
    warnings.push(
      "Archive désactivée : les appels ne sont pas mémorisés, seule la fenêtre encore servie par Keyyo est visible. "
      + 'Définir BLOB_READ_WRITE_TOKEN pour conserver les trois mois.',
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
  const unresolvedCount = lines.filter((l) => !l.person || !l.person.email).length;
  if (voipLines.length && unresolvedCount) {
    warnings.push(
      unresolvedCount + ' ligne(s) sur ' + lines.length + " sans adresse e-mail rattachée : "
      + 'voir /api/team pour le réglage KEYYO_LINE_EMAILS à coller.',
    );
  }

  // -- Fenetre a collecter ---------------------------------------------------
  const today = todayIso(now, cfg.tz);
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
    fromIso = isoDaysAgo(windowDays - 1, now, cfg.tz);
    toIso = today;
  } else {
    strategy = 'incremental';
    windowDays = clampInt(o.sinceDays, cfg.syncDays, 1, cfg.historyDays);
    fromIso = isoDaysAgo(windowDays - 1, now, cfg.tz);
    toIso = today;
  }
  if (fromIso > toIso) fromIso = toIso;

  const slices = monthSlices(fromIso, toIso);      // le mois le plus recent d'abord

  // -- Taches ----------------------------------------------------------------
  /** @type {Array<{csi: string, direction: 'in'|'out', month: string, from: string, to: string}>} */
  const tasks = [];
  if (token && voipLines.length) {
    // Tranche par tranche : le mois le plus recent est complet avant d'attaquer
    // le suivant, de sorte qu'un budget epuise ne laisse pas de trou recent.
    for (const slice of slices) {
      for (const line of voipLines) {
        tasks.push({ csi: line.csi, direction: 'in', month: slice.month, from: slice.from, to: slice.to });
        tasks.push({ csi: line.csi, direction: 'out', month: slice.month, from: slice.from, to: slice.to });
      }
    }
  }

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
  let truncatedTasks = 0;

  await runPool(tasks, MAX_CONCURRENCY, async (task) => {
    if (Date.now() >= taskDeadline) {
      skipped++;
      perTask.push({
        csi: task.csi, direction: task.direction, month: task.month,
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
      perTask.push(d);
    } catch (err) {
      const budget = !!(err && /** @type {any} */ (err).budget);
      if (budget) skipped++;
      const message = errorMessage(err);
      perTask.push({
        csi: task.csi, direction: task.direction, month: task.month,
        from: task.from, to: task.to, ok: false, skipped: budget,
        reason: budget ? 'budget de temps épuisé pendant la requête' : message,
      });
      if (!budget) {
        errors.push({
          scope: 'call_detail', csi: task.csi, direction: task.direction, month: task.month, message,
        });
      }
    }
  });

  if (skipped) {
    warnings.push(
      skipped + ' requête(s) non exécutée(s) faute de temps (budget de ' + budgetMs + ' ms). '
      + 'Les données déjà collectées sont conservées ; relancer /api/sync pour compléter.',
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

  const coverage = buildCoverage(rows, touchedMonths, prevCoverage, nowIso);
  const expectedMonths = monthSlices(isoDaysAgo(cfg.historyDays - 1, now, cfg.tz), today).map((s) => s.month);
  const missingMonths = expectedMonths.filter((ym) => !coverage[ym]);

  // La couverture peut evoluer SANS qu'aucune ligne ne bouge : un mois collecte
  // et vide n'ajoute rien a `rows` mais doit cesser d'etre declare manquant.
  // Sans ce test, ce constat ne vivrait qu'en memoire de la fonction et serait
  // reperdu a l'invocation suivante.
  //
  // On ne compare QUE la partie structurelle — les mois et leurs comptes, dont
  // depend `missingMonths`. Surtout pas `syncedAt` : il vaut l'heure courante
  // pour tout mois parcouru, donc il change a CHAQUE invocation, et le comparer
  // reecrirait l'archive entiere a chaque chargement de page. La signature
  // triee evite au passage toute dependance a l'ordre des cles.
  const coverageKey = (c) => Object.keys(c || {}).sort()
    .map((ym) => ym + ':' + (Number((c[ym] || {}).count) || 0))
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
 * Couverture par mois. Un mois interroge sans aucun appel est enregistre avec
 * `count: 0` : sinon il serait signale « manquant » a chaque synchronisation.
 * @param {any[]} rows
 * @param {Set<string>} touched
 * @param {Record<string, any>} prev
 * @param {string} nowIso
 * @returns {Record<string, {count: number, syncedAt: string}>}
 */
function buildCoverage(rows, touched, prev, nowIso) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of rows) {
    const ym = String(row[F.date] || '').slice(0, 7);
    if (ym) counts[ym] = (counts[ym] || 0) + 1;
  }

  /** @type {Record<string, {count: number, syncedAt: string}>} */
  const coverage = {};

  // On ne reprend de la couverture precedente QUE les mois collectes et VIDES.
  //
  // Eux seuls disparaitraient a tort : ils ne produisent aucune ligne, donc
  // n'apparaissent pas dans `counts`, et une synchronisation incrementale ne
  // les touche plus. Sans cette reprise, un mois legitimement sans appel
  // (ligne creee plus tard, fermeture estivale) serait declare manquant et
  // recollecte indefiniment pour ne rien trouver.
  //
  // Les autres ne sont volontairement PAS repris : un mois qui a des lignes
  // est reconstruit ci-dessous a partir de `rows`, et un mois dont la
  // retention a purge les lignes doit redevenir honnetement absent plutot que
  // de conserver a jamais un compte que plus rien n'appuie.
  if (prev) {
    for (const ym of Object.keys(prev)) {
      const p = prev[ym];
      if (p && Number(p.count) === 0) {
        coverage[ym] = { count: 0, syncedAt: String(p.syncedAt || '') };
      }
    }
  }

  const months = Object.keys(counts).sort();
  for (const ym of months) {
    const before = prev && prev[ym] && prev[ym].syncedAt ? String(prev[ym].syncedAt) : '';
    coverage[ym] = { count: counts[ym], syncedAt: touched.has(ym) ? nowIso : (before || nowIso) };
  }

  // Tout mois REELLEMENT parcouru porte l'horodatage de ce passage, meme s'il
  // est ressorti vide. Sans cette mise a jour, la page Diagnostic annoncerait
  // « il y a trois mois » pour un mois synchronise a l'instant, et inviterait a
  // le recollecter pour rien.
  for (const ym of Array.from(touched).sort()) {
    if (coverage[ym]) coverage[ym].syncedAt = nowIso;
    else coverage[ym] = { count: 0, syncedAt: nowIso };
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
