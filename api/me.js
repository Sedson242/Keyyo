// =============================================================================
//  api/me.js — GET /api/me : le profil de travail de la personne connectee.
//
//  Ce que la page agent a besoin de savoir avant de decrocher son premier
//  appel : qui elle est, sur quelle ligne l'annuaire la rattache, et a qui elle
//  peut transferer — ses collegues et les managers — avec un NUMERO, une
//  ADRESSE (pour viser une personne lors d'un passage d'appel, et pour sa
//  photo) et rien d'autre : la page agent ne voit pas les appels des autres.
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
import { roleLabel, isDirection } from '../shared/roles.js';
import { journalEnabled } from './_journal.js';
import { loadAccess } from './_access.js';
import { linesOf, shouldPopup, routingFor, memberOf } from '../shared/access.js';
import { toE164 } from '../shared/phone.js';

/** Cache prive et court : le profil bouge peu, mais il est nominatif. */
const CACHE_PRIVATE = 'private, max-age=120';

/** @param {string} email @returns {string} adresse de la photo Entra, servie par /api/photo. */
function photoUrl(email) {
  return '/api/photo?u=' + encodeURIComponent(String(email).toLowerCase()) + '&s=96';
}

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/me')) return;
  const session = await requireRole(req, res, '/api/me');
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
    const access = await loadAccess();
    const directionSet = new Set(auth.directionEmails);
    if (isDirection(session.role)) directionSet.add(me);
    if (access) for (const m of access.members) if (isDirection(m.role)) directionSet.add(m.email);

    // Lignes de la personne : la configuration d'acces d'abord (posee par un
    // administrateur), l'annuaire Keyyo a defaut.
    const configured = access ? linesOf(access, me) : [];
    const lines = voipLines.map((l) => {
      const team = teams.find((t) => t.csi === String(l.csi));
      const csi = String(l.csi);
      const mine = configured.length ? configured.indexOf(csi) >= 0 : (!!team && team.members.some((m) => m.email === me));
      return {
        csi,
        label: lineLabel(Object.assign({ person: null }, l)),
        number: formatCsi(l.csi),
        e164: toE164(l.csi),
        members: team ? team.members.length : 0,
        mine,
        // Routage : qui est presente a l'appel entrant de cette ligne, et
        // moi, y suis-je ? Sans routage configure, tout le monde l'est.
        popup: access ? shouldPopup(access, me, csi) : true,
        routedTo: access ? routingFor(access, csi) : [],
      };
    });
    const myLines = lines.filter((l) => l.mine);
    const member = access ? memberOf(access, me) : null;

    // Collegues : toute personne rattachee a une ligne du compte, sauf soi.
    // Le numero DIRECT pose par un administrateur (page Administration)
    // passe avant tout : c'est le seul qui fait sonner cette personne et non
    // tout son site. Ensuite le numero abrege de l'annuaire, un numero propre,
    // et a defaut la ligne du site.
    /** @type {Map<string, any>} */
    const seen = new Map();
    const configured_number = (email) => {
      const m = access && email ? access.members.find((x) => x.email === String(email).toLowerCase()) : null;
      return m && m.number ? m.number : '';
    };
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
        const admin = configured_number(m.email);
        const direct = m.speedNumbers.length ? m.speedNumbers[0] : '';
        const own = m.numbers.find((n) => !lines.some((l) => l.e164 === n)) || '';
        seen.set(key, {
          name: m.name,
          // L'adresse sert au passage d'appel (viser une personne sur une
          // ligne partagee) et a sa photo : adresse professionnelle du meme
          // locataire, deja visible de tous dans Outlook.
          email: m.email || '',
          number: admin || direct || own || (line ? line.e164 : ''),
          numberKind: admin ? 'direct' : (direct ? 'poste' : (own ? 'direct' : 'ligne du site')),
          lines: line ? [line.label] : [],
          manager: !!m.email && directionSet.has(m.email),
          photo: m.email ? photoUrl(m.email) : '',
        });
      }
    }
    // Membres poses par un administrateur mais absents de l'annuaire Keyyo :
    // ils sont joignables des qu'ils ont un numero direct.
    if (access) {
      for (const m of access.members) {
        if (m.email === me || seen.has(m.email) || !m.number) continue;
        const labels = m.lines.map((c) => { const l = lines.find((x) => x.csi === c); return l ? l.label : ''; }).filter(Boolean);
        seen.set(m.email, {
          name: m.name || m.email.split('@')[0],
          email: m.email,
          number: m.number,
          numberKind: 'direct',
          lines: labels,
          manager: directionSet.has(m.email),
          photo: photoUrl(m.email),
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
      user: Object.assign(publicUser(session), { roleLabel: roleLabel(session.role), photo: photoUrl(session.email) }),
      line: myLines.length === 1 ? myLines[0] : null,
      lines,
      colleagues,
      managers: colleagues.filter((c) => c.manager),
      journal: { enabled: journalEnabled() },
      access: {
        configured: !!access && access.members.length > 0,
        member: member ? { role: member.role, lines: member.lines, popup: member.popup } : null,
        source: configured.length ? 'configuration' : 'annuaire',
      },
      note: 'Les managers sont la direction et les administrateurs connus de l\'application, presents dans l\'annuaire Keyyo.',
      warnings,
      updatedAt: new Date().toISOString(),
    }, 'no-store');
  } catch (err) {
    sendJson(res, 500, {
      error: 'Profil indisponible',
      hint: errorMessage(err) + ' Le détail des contrôles est disponible sur /api/health.',
    }, 'no-store');
  }
}
