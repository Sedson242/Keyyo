// =============================================================================
//  api/calls.js — GET /api/calls : la source unique du front.
//
//  Renvoie les appels au format positionnel de shared/schema.js, les lignes
//  avec leur identite resolue, et tout le diagnostic de la collecte.
//
//  Cache CDN de 5 minutes, SAUF si la reponse est vide ou si l'appelant a
//  demande un contournement (?force=1) ou un rebalayage (?full=1) : mettre en
//  cache une reponse vide fige un ecran vide pendant cinq minutes.
//
//  Parametres : ?force=1  ?full=1  ?month=YYYY-MM  ?days=N
// =============================================================================

import { collect } from './_collect.js';
import { readParams, flag, sendJson, rejectNonGet, errorMessage } from './_config.js';
import { SCHEMA_VERSION, FIELDS } from '../shared/schema.js';

const CACHE_FRESH = 's-maxage=300, stale-while-revalidate=600';

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/calls')) return;

  const params = readParams(req);
  const force = flag(params.force);
  const full = flag(params.full);
  const month = String(params.month || '').trim();
  const days = Number(params.days);

  try {
    const result = await collect({
      full,
      month,
      sinceDays: Number.isFinite(days) && days > 0 ? days : 0,
    });

    const empty = !result.rows.length;
    const cacheControl = (empty || force || full) ? 'no-store' : CACHE_FRESH;

    sendJson(res, 200, {
      schemaVersion: SCHEMA_VERSION,
      fields: FIELDS,
      rows: result.rows,
      lines: result.lines,
      meta: result.meta,
      coverage: result.coverage,
      store: result.store,
      diag: Object.assign({}, result.diag, {
        errors: result.errors,
        warnings: result.warnings,
      }),
      updatedAt: new Date().toISOString(),
      empty,
      warning: buildWarning(result, empty),
    }, cacheControl);
  } catch (err) {
    const message = errorMessage(err);
    // Une reponse d'erreur n'est jamais mise en cache : le probleme est le plus
    // souvent une variable d'environnement, corrigee en quelques secondes.
    sendJson(res, 500, {
      schemaVersion: SCHEMA_VERSION,
      fields: FIELDS,
      rows: [],
      lines: [],
      meta: { n: 0, min: null, max: null, days: 0, months: [], csis: [] },
      coverage: {},
      store: null,
      diag: null,
      updatedAt: new Date().toISOString(),
      empty: true,
      warning: message,
      error: 'Collecte impossible',
      hint: message + ' Le détail des contrôles est disponible sur /api/health.',
    }, 'no-store');
  }
}

/**
 * Un seul message, lisible, pour le bandeau du front. Les avertissements
 * d'exploitation passent avant : ils disent quoi faire.
 * @param {{warnings: string[], errors: Array<{scope?: string, message?: string}>}} result
 * @param {boolean} empty
 * @returns {string|null}
 */
function buildWarning(result, empty) {
  const parts = [];
  if (empty) {
    parts.push(
      'Aucun appel sur la période demandée. Vérifier que les lignes ont bien du trafic, '
      + 'puis relancer une collecte complète avec ?full=1.',
    );
  }
  for (const w of result.warnings || []) parts.push(w);

  const errors = result.errors || [];
  if (errors.length) {
    const first = errors[0];
    parts.push(
      errors.length + ' erreur(s) pendant la collecte — ' + (first.scope ? first.scope + ' : ' : '')
      + (first.message || 'cause inconnue'),
    );
  }
  return parts.length ? parts.join(' · ') : null;
}
