// =============================================================================
//  api/events.js — Le journal d'attribution.
//
//    POST /api/events   { events: [...] }   la page rapporte ce qu'elle a fait
//                                          ou vu ; ecrit dans la partition de
//                                          LA PERSONNE CONNECTEE, jamais ailleurs.
//    GET  /api/events?month=AAAA-MM        relecture :
//                                          - un agent ne lit que sa partition ;
//                                          - la direction lit tout le mois.
//
//  Le back est le SEUL ecrivain, et il impose l'adresse de la session sur
//  chaque evenement : une page ne peut pas ecrire au nom d'un autre, meme en
//  forgeant le corps. Les evenements sont normalises et dedupliques par
//  shared/journal.js — un fait rapporte deux fois reste un fait.
//
//  Reponse d'ecriture : { accepted, rejected, byMonth: { 'AAAA-MM': n } }
//  Reponse de lecture : { month, scope, events[], partitions, summary }
// =============================================================================

import {
  readParams, sendJson, rejectCrossSite, readJsonBody, errorMessage,
} from './_config.js';
import { requireRole } from './_auth.js';
import { canAccess, isDirection } from '../shared/roles.js';
import { normalizeEvent, monthOf, summarize } from '../shared/journal.js';
import { journalEnabled, appendEvents, readUserMonth, readMonth } from './_journal.js';

/** Plafond d'evenements par envoi : au-dela, c'est une erreur de la page. */
const MAX_BATCH = 200;

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Methode ' + method + ' non autorisee' }, 'no-store');
  }
  const session = requireRole(req, res, '/api/events');
  if (!session) return;

  if (!journalEnabled()) {
    return sendJson(res, 503, {
      error: 'Journal indisponible',
      enabled: false,
      hint: 'Aucun store Blob relié au projet : le journal d\'attribution ne peut ni s\'écrire ni se lire. '
        + 'Relier un store Blob (Storage → Connect) puis redéployer.',
    }, 'no-store');
  }

  try {
    if (method === 'POST') {
      if (rejectCrossSite(req, res)) return;
      const body = await readJsonBody(req, { limit: 512 * 1024 });
      const raw = body && Array.isArray(body.events) ? body.events : null;
      if (!raw) {
        return sendJson(res, 400, { error: 'Corps invalide', hint: 'Attendu : { "events": [ ... ] }.' }, 'no-store');
      }
      if (raw.length > MAX_BATCH) {
        return sendJson(res, 413, { error: 'Envoi trop volumineux', hint: MAX_BATCH + ' evenements au plus par envoi.' }, 'no-store');
      }

      const now = Math.floor(Date.now() / 1000);
      /** @type {Record<string, any[]>} */
      const byMonth = {};
      let rejected = 0;
      for (const item of raw) {
        const e = normalizeEvent(item, { email: session.email, now });
        if (!e) { rejected++; continue; }
        const ym = monthOf(e.ts);
        (byMonth[ym] || (byMonth[ym] = [])).push(e);
      }

      /** @type {Record<string, number>} */
      const written = {};
      for (const ym of Object.keys(byMonth)) {
        const r = await appendEvents(session.email, ym, byMonth[ym]);
        written[ym] = r.added;
      }

      return sendJson(res, 200, {
        accepted: raw.length - rejected,
        rejected,
        byMonth: written,
        at: new Date().toISOString(),
      }, 'no-store');
    }

    // -- Lecture ----------------------------------------------------------------
    const params = readParams(req);
    let month = String(params.month || '').trim();
    if (!month) month = monthOf(Math.floor(Date.now() / 1000));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return sendJson(res, 400, { error: 'Paramètre month invalide', hint: 'Format attendu : AAAA-MM.' }, 'no-store');
    }
    const wantAll = String(params.scope || '').toLowerCase() === 'all';
    if (wantAll && !(isDirection(session.role) && canAccess('/api/calls', session.role))) {
      return sendJson(res, 403, {
        error: 'Accès réservé',
        hint: 'La lecture du journal de toute l\'equipe est reservee a la direction.',
      }, 'no-store');
    }

    res.setHeader('Vary', 'Cookie');
    if (wantAll) {
      const all = await readMonth(month);
      return sendJson(res, 200, {
        month,
        scope: 'all',
        events: all.events,
        partitions: all.partitions,
        summary: summarize(all.events),
        updatedAt: new Date().toISOString(),
      }, 'no-store');
    }
    const mine = await readUserMonth(session.email, month);
    return sendJson(res, 200, {
      month,
      scope: 'me',
      events: mine,
      partitions: mine.length ? 1 : 0,
      summary: summarize(mine, { email: session.email }),
      updatedAt: new Date().toISOString(),
    }, 'no-store');
  } catch (err) {
    sendJson(res, 500, { error: 'Journal en erreur', hint: errorMessage(err) }, 'no-store');
  }
}
