// =============================================================================
//  api/me.js — GET /api/me : le profil de travail de la personne connectee.
//
//  Ce que la page agent a besoin de savoir avant de decrocher son premier
//  appel : qui elle est, sur quelle ligne l'annuaire la rattache, et a qui elle
//  peut transferer — ses collegues et les managers — avec un NUMERO pour
//  chacun. Rien de plus : la page agent ne voit ni les appels des autres, ni
//  leurs adresses (les collegues sont rendus par nom et numero seulement).
//
//  Les « managers » sont les personnes de la direction telles que
//  l'application les connait : AUTH_DIRECTION_EMAILS croise avec l'annuaire.
//  Un app role Entra n'est pas lisible ici (on ne voit que le sien), d'ou ce
//  choix de source, dit tel quel dans la reponse.
// =============================================================================

import { readConfig, sendJson, rejectNonGet, errorMessage } from './_config.js';
import { requireRole, readAuthConfig, publicUser } from './_auth.js';
import { getAccessToken, fetchVoipLines, fetchDirectoryContacts } from './_keyyo.js';
import { lineTeams, lineLabel, formatCsi } from '../shared/identity.js';
import { roleLabel } from '../shared/roles.js';
import { journalEnabled } from './_journal.js';
import { toE164 } from '../shared/phone.js';

/** Cache prive et court : le profil bouge peu, mais il est nominatif. */
const CACHE_PRIVATE = 'private, max-age=120';

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/me')) return;
  const session = requireRole(req, res, '/api/me');
  if (!session) return;

  try {
    const cfg = readConfig();
    const auth = readAuthConfig();
    const deadline = Date.now() + Math.min(cfg.budgetMs, 20000);
    const token = await getAccessToken(cfg);

    /** @type {string[]} */
    const warnings = [];
    const [voipLines, contacts] = await Promise.all([
      fetchVoipLines(cfg, token, { deadline }),
      fetchDirectoryContacts(cfg, token, { deadline }).catch((err) => {
        warnings.push('Annuaire indisponible : ' + errorMessage(err));
        return [];
      }),
    ]);

    const me = session.email.toLowerCase();
    const teams = lineTeams(voipLines, contacts);
    const directionSet = new Set(auth.directionEmails);
    if (session.role === 'direction') directionSet.add(me);

    const lines = voipLines.map((l) => {
      const team = teams.find((t) => t.csi === String(l.csi));
      return {
        csi: String(l.csi),
        label: lineLabel(Object.assign({ person: null }, l)),
        number: formatCsi(l.csi),
        e164: toE164(l.csi),
        members: team ? team.members.length : 0,
        mine: !!team && team.members.some((m) => m.email === me),
      };
    });
    const myLines = lines.filter((l) => l.mine);

    // Collegues : toute personne rattachee a une ligne du compte, sauf soi.
    // Un numero direct d'abord (numero abrege = poste), sinon la ligne du site.
    /** @type {Map<string, any>} */
    const seen = new Map();
    for (const t of teams) {
      const line = lines.find((l) => l.csi === t.csi);
      for (const m of t.members) {
        if (!m.name || m.email === me) continue;
        const key = (m.email || m.name).toLowerCase();
        if (seen.has(key)) {
          const prev = seen.get(key);
          if (line && prev.lines.indexOf(line.label) < 0) prev.lines.push(line.label);
          continue;
        }
        const direct = m.speedNumbers.length ? m.speedNumbers[0] : '';
        const own = m.numbers.find((n) => !lines.some((l) => l.e164 === n)) || '';
        seen.set(key, {
          name: m.name,
          number: direct || own || (line ? line.e164 : ''),
          numberKind: direct ? 'poste' : (own ? 'direct' : 'ligne du site'),
          lines: line ? [line.label] : [],
          manager: !!m.email && directionSet.has(m.email),
        });
      }
    }
    const colleagues = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name, 'fr'));

    if (!contacts.length) warnings.push('Annuaire vide : aucun collegue a proposer pour un transfert.');
    if (!journalEnabled()) {
      warnings.push('Aucun store Blob relié au projet : le journal d\'attribution (vos appels pris, émis, transférés) ne sera pas conservé.');
    }

    res.setHeader('Vary', 'Cookie');
    sendJson(res, 200, {
      user: Object.assign(publicUser(session), { roleLabel: roleLabel(session.role) }),
      line: myLines.length === 1 ? myLines[0] : null,
      lines,
      colleagues,
      managers: colleagues.filter((c) => c.manager),
      journal: { enabled: journalEnabled() },
      note: 'Les managers sont les adresses de AUTH_DIRECTION_EMAILS presentes dans l\'annuaire Keyyo.',
      warnings,
      updatedAt: new Date().toISOString(),
    }, warnings.length ? 'no-store' : CACHE_PRIVATE);
  } catch (err) {
    sendJson(res, 500, {
      error: 'Profil indisponible',
      hint: errorMessage(err) + ' Le détail des contrôles est disponible sur /api/health.',
    }, 'no-store');
  }
}
