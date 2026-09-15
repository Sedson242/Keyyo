// =============================================================================
//  api/handoff.js — GET /api/handoff?csi=<ligne> : les passages d'appel en
//  cours sur une ligne (voir api/_handoff.js).
//
//  La page agent l'interroge quand un appel entrant se presente : si le
//  correspondant vient d'etre transfere par un collegue en visant quelqu'un,
//  elle sait pour qui il sonne. Reponse : { csi, handoffs: [...], updatedAt }.
// =============================================================================

import { readParams, sendJson, rejectNonGet, errorMessage } from './_config.js';
import { requireRole } from './_auth.js';
import { pendingHandoffs } from './_handoff.js';

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/handoff')) return;
  if (!await requireRole(req, res, '/api/handoff')) return;

  const params = readParams(req);
  const csi = String(params.csi || '').replace(/\D/g, '');
  if (!csi) return sendJson(res, 400, { error: 'Paramètre csi manquant', hint: 'Attendu : ?csi=<numéro de la ligne>' }, 'no-store');

  try {
    const handoffs = await pendingHandoffs(csi);
    res.setHeader('Vary', 'Cookie');
    sendJson(res, 200, { csi, handoffs, updatedAt: new Date().toISOString() }, 'no-store');
  } catch (err) {
    sendJson(res, 500, { error: 'Passages illisibles', hint: errorMessage(err) }, 'no-store');
  }
}
