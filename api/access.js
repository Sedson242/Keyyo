// =============================================================================
//  api/access.js — Administration des acces et du routage.
//
//    GET  /api/access   la configuration courante, plus de quoi la remplir :
//                       les lignes du compte et les personnes de l'annuaire
//                       (nom, adresse, ligne de rattachement) ;
//    POST /api/access   { config } — remplace la configuration entiere,
//                       normalisee par shared/access.js, datee et signee.
//
//  ADMINISTRATEURS SEULEMENT (shared/roles.js). Deux gardes de bon sens :
//  la configuration ecrite doit encore contenir un administrateur, et
//  l'administrateur qui ecrit ne peut pas se retirer lui-meme le role sauf
//  s'il le tient d'Entra (auquel cas la configuration ne le lui retire pas).
//
//  Reponse : { config, lines[], people[], me, updatedAt }
// =============================================================================

import {
  readConfig, sendJson, rejectCrossSite, readJsonBody, errorMessage,
} from './_config.js';
import { requireRole } from './_auth.js';
import { accessEnabled, loadAccess, saveAccess } from './_access.js';
import { normalizeAccess, adminCount, emptyAccess } from '../shared/access.js';
import { ROLE_ADMIN } from '../shared/roles.js';
import { getAccessToken, fetchVoipLines, fetchDirectoryContacts } from './_keyyo.js';
import { lineTeams, lineLabel, formatCsi } from '../shared/identity.js';
import { toE164 } from '../shared/phone.js';

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
  const session = await requireRole(req, res, '/api/access');
  if (!session) return;

  if (!accessEnabled()) {
    return sendJson(res, 503, {
      error: 'Administration indisponible',
      hint: 'Aucun store Blob relié au projet : la configuration d\'accès ne peut ni s\'écrire ni se lire.',
    }, 'no-store');
  }

  try {
    if (method === 'POST') {
      if (rejectCrossSite(req, res)) return;
      const body = await readJsonBody(req, { limit: 512 * 1024 });
      if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object') {
        return sendJson(res, 400, { error: 'Corps invalide', hint: 'Attendu : { "config": { members: [...], routing: {...} } }.' }, 'no-store');
      }
      const next = normalizeAccess(body.config);
      if (!adminCount(next)) {
        return sendJson(res, 409, {
          error: 'Plus aucun administrateur',
          hint: 'La configuration doit garder au moins un membre avec le rôle « admin ».',
        }, 'no-store');
      }
      const meAfter = next.members.find((m) => m.email === session.email);
      if (session.src !== 'entra' && (!meAfter || meAfter.role !== ROLE_ADMIN)) {
        return sendJson(res, 409, {
          error: 'Vous ne pouvez pas vous retirer le rôle administrateur',
          hint: 'Faites-le attribuer à quelqu\'un d\'autre, qui pourra ensuite modifier le vôtre.',
        }, 'no-store');
      }
      const saved = await saveAccess(next, session.email);
      return sendJson(res, 200, { ok: true, config: saved, updatedAt: saved.updatedAt }, 'no-store');
    }

    const config = (await loadAccess({ force: true })) || emptyAccess();

    /** @type {string[]} */
    const warnings = [];
    let lines = [];
    let people = [];
    try {
      const cfg = readConfig();
      const deadline = Date.now() + Math.min(cfg.budgetMs, 20000);
      const token = await getAccessToken(cfg);
      const [voipLines, contacts] = await Promise.all([
        fetchVoipLines(cfg, token, { deadline }),
        fetchDirectoryContacts(cfg, token, { deadline }).catch((err) => { warnings.push('Annuaire indisponible : ' + errorMessage(err)); return []; }),
      ]);
      const teams = lineTeams(voipLines, contacts);
      lines = voipLines.map((l) => ({
        csi: String(l.csi),
        label: lineLabel(Object.assign({ person: null }, l)),
        number: formatCsi(l.csi),
        e164: toE164(l.csi),
        members: (teams.find((t) => t.csi === String(l.csi)) || { members: [] }).members.length,
      }));
      /** @type {Map<string, any>} */
      const byEmail = new Map();
      for (const t of teams) {
        for (const m of t.members) {
          if (!m.email) continue;
          const prev = byEmail.get(m.email);
          if (prev) { if (prev.lines.indexOf(t.csi) < 0) prev.lines.push(t.csi); continue; }
          byEmail.set(m.email, { email: m.email, name: m.name, lines: [t.csi] });
        }
      }
      people = Array.from(byEmail.values()).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    } catch (err) {
      warnings.push('Keyyo indisponible : ' + errorMessage(err));
    }

    res.setHeader('Vary', 'Cookie');
    sendJson(res, 200, {
      config,
      lines,
      people,
      me: { email: session.email, name: session.name, role: session.role, src: session.src },
      warnings,
      updatedAt: new Date().toISOString(),
    }, 'no-store');
  } catch (err) {
    sendJson(res, 500, { error: 'Administration en erreur', hint: errorMessage(err) }, 'no-store');
  }
}
