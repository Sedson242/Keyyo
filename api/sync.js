// =============================================================================
//  api/sync.js — GET /api/sync : la cible du cron.
//
//  Meme collecte que /api/calls, mais reponse minimale : personne ne lit ce
//  JSON dans un navigateur, il sert au cron et au remplissage manuel.
//
//  Pourquoi cette route existe alors que /api/calls synchronise deja : l'API
//  Keyyo a une fenetre glissante. Sans visite du tableau de bord pendant
//  plusieurs jours, les appels de cette periode sortiraient de la fenetre et
//  seraient perdus a jamais. Le cron quotidien est le filet de securite.
//
//  Parametres :
//    ?full=1            rebalayage complet sur KEYYO_HISTORY_DAYS (92 jours)
//    ?month=YYYY-MM     remplissage d'un seul mois — c'est la forme a utiliser
//                       quand un rebalayage complet depasse le budget de temps
//    ?days=N            fenetre explicite en jours
//
//  Protection : DEUX portes, pas une de plus.
//    - le cron Vercel, qui envoie « Authorization: Bearer <CRON_SECRET> »
//      des que la variable est definie ;
//    - une personne de la direction connectee (cookie de session), depuis la
//      page Diagnostic.
//  Sans CRON_SECRET, le cron n'a donc plus de porte : la variable est devenue
//  OBLIGATOIRE pour que la synchronisation nocturne fonctionne. Une route qui
//  ecrit l'archive et consomme du quota Keyyo ne reste pas ouverte au public.
// =============================================================================

import { collect } from './_collect.js';
import {
  readConfig, readParams, flag, sendJson, rejectNonGet, errorMessage,
} from './_config.js';
import { readAuthConfig, readSession, safeEqual } from './_auth.js';
import { canAccess } from '../shared/roles.js';

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/sync')) return;

  // La configuration est lue avant tout : elle porte le secret attendu, et une
  // configuration invalide doit produire une erreur nette plutot qu'un 401.
  /** @type {any} */
  let cfg;
  try {
    cfg = readConfig();
  } catch (err) {
    return sendJson(res, 500, {
      ok: false,
      error: 'Configuration inexploitable',
      hint: errorMessage(err),
    }, 'no-store');
  }

  const byCron = !!cfg.cronSecret && isAuthorized(req, cfg.cronSecret);
  let byPerson = false;
  if (!byCron) {
    const auth = readAuthConfig();
    const session = auth.configured ? readSession(req, auth) : null;
    byPerson = !!session && canAccess('/api/sync', session.role);
  }
  if (!byCron && !byPerson) {
    return sendJson(res, 401, {
      ok: false,
      error: 'Non autorisé',
      hint: 'Cette route accepte soit l\'en-tête « Authorization: Bearer <CRON_SECRET> » '
        + '(envoyé automatiquement par les crons Vercel quand CRON_SECRET est défini), '
        + 'soit une personne de la direction connectée.',
    }, 'no-store');
  }

  const params = readParams(req);
  const full = flag(params.full);
  const month = String(params.month || '').trim();
  const days = Number(params.days);

  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Paramètre month invalide',
      hint: 'Format attendu : AAAA-MM, par exemple ?month=' + new Date().toISOString().slice(0, 7) + '.',
    }, 'no-store');
  }

  const startedAt = Date.now();
  try {
    const result = await collect({
      full,
      month,
      sinceDays: Number.isFinite(days) && days > 0 ? days : 0,
    });

    // Un mois demande explicitement mais revenu vide est une information utile :
    // c'est la difference entre « ce mois n'a pas de trafic » et « ce mois n'a
    // pas encore ete collecte ». On la remonte au lieu de la taire.
    const monthCount = month && result.coverage ? (result.coverage[month] || { count: 0 }).count : null;

    sendJson(res, 200, {
      ok: true,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      requested: { full, month: month || null, days: Number.isFinite(days) && days > 0 ? days : null },
      store: result.store,
      period: { min: result.meta.min, max: result.meta.max, n: result.meta.n },
      months: result.meta.months,
      collected: {
        rawSeen: result.diag.rawSeen,
        kept: result.diag.kept,
        dropped: result.diag.dropped,
        dropReasons: result.diag.dropReasons,
        tasks: result.diag.tasks,
        skipped: result.diag.skipped,
      },
      monthCount,
      warnings: result.warnings,
      errors: result.errors,
      next: buildNext(result),
    }, 'no-store');
  } catch (err) {
    sendJson(res, 503, {
      ok: false,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      error: 'Synchronisation impossible',
      hint: errorMessage(err) + ' Détail des contrôles sur /api/health?deep=1.',
    }, 'no-store');
  }
}

/**
 * Comparaison a temps constant du secret de cron. Une egalite naive fuit la
 * longueur du prefixe correct par son temps d'execution ; le cout de faire
 * mieux est nul, autant le faire.
 * @param {any} req
 * @param {string} expected
 * @returns {boolean}
 */
function isAuthorized(req, expected) {
  const header = String((req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return safeEqual(m ? m[1] : '', expected);
}

/**
 * L'action suivante a mener, en clair. C'est ce qui transforme une reponse de
 * cron en outil exploitable : le mois manquant est nomme, avec son URL.
 * @param {{store: any, warnings: string[]}} result
 * @returns {string|null}
 */
function buildNext(result) {
  const missing = (result.store && result.store.missingMonths) || [];
  if (missing.length) {
    return 'Mois non couvert(s) : ' + missing.join(', ')
      + '. Les remplir un par un avec /api/sync?month=' + missing[0]
      + (missing.length > 1 ? ' (puis les suivants)' : '') + '.';
  }
  if (result.store && !result.store.enabled) {
    return 'Mode direct : aucune archive n\'est écrite. Relier un magasin Blob au projet Vercel '
      + 'pour conserver l\'historique au-delà de la fenêtre glissante de l\'API Keyyo.';
  }
  if ((result.warnings || []).length) {
    return 'Collecte partielle : relancer /api/sync pour compléter.';
  }
  return null;
}
