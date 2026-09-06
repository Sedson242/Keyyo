// =============================================================================
//  api/cti-token.js — POST /api/cti-token : la cle d'une session CTI.
//
//  Le navigateur pilote la ligne Keyyo (appeler, decrocher, transferer) par
//  l'API CTI, qui s'ouvre avec un JETON CSI : un jeton lie a une ligne, valable
//  une heure. Le frapper est une ECRITURE Manager (scope cti_admin) qui exige
//  les identifiants Keyyo du compte — ils restent donc ici, cote serveur, et
//  seul le jeton CSI, borne a une ligne et a une heure, descend au navigateur.
//
//  QUELLE LIGNE POUR QUELLE PERSONNE. Trois lignes de site sont partagees par
//  56 personnes. La regle : la ligne dont l'annuaire Keyyo rattache l'adresse
//  de la personne connectee (voir shared/identity.js#lineTeams). Si l'annuaire
//  ne la rattache a aucune ligne, ou si elle en demande explicitement une
//  autre (`csi` dans le corps), on sert la ligne demandee — a condition qu'elle
//  existe sur le compte. Sans ligne trouvee ni demandee : 409 avec la liste,
//  pour que la page fasse choisir.
//
//  Reponse : { csi, number, token, expiresAt, line, lines[] }
// =============================================================================

import {
  readConfig, sendJson, rejectNonPost, rejectCrossSite, readJsonBody, errorMessage,
} from './_config.js';
import { requireRole } from './_auth.js';
import { getAccessToken, fetchVoipLines, fetchDirectoryContacts, mintCsiToken, keyyoGetAll } from './_keyyo.js';
import { lineTeams, lineLabel, formatCsi } from '../shared/identity.js';
import { toE164 } from '../shared/phone.js';

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonPost(req, res, '/api/cti-token')) return;
  const session = requireRole(req, res, '/api/cti-token');
  if (!session) return;
  if (rejectCrossSite(req, res)) return;

  try {
    const body = (await readJsonBody(req)) || {};
    const wanted = String(body.csi == null ? '' : body.csi).replace(/\D/g, '');

    const cfg = readConfig();
    const deadline = Date.now() + Math.min(cfg.budgetMs, 20000);
    const token = await getAccessToken(cfg);

    const [voipLines, contacts] = await Promise.all([
      fetchVoipLines(cfg, token, { deadline }),
      fetchDirectoryContacts(cfg, token, { deadline }).catch(() => []),
    ]);
    if (!voipLines.length) {
      return sendJson(res, 503, {
        error: 'Aucune ligne Keyyo',
        hint: 'Le compte Keyyo ne renvoie aucune ligne VoIP : rien a piloter. Voir /api/health.',
      }, 'no-store');
    }

    const teams = lineTeams(voipLines, contacts);
    const me = session.email.toLowerCase();
    const lines = voipLines.map((l) => {
      const team = teams.find((t) => t.csi === String(l.csi));
      const mine = !!team && team.members.some((m) => m.email === me);
      return {
        csi: String(l.csi),
        label: lineLabel(Object.assign({ person: null }, l)),
        number: formatCsi(l.csi),
        e164: toE164(l.csi),
        members: team ? team.members.length : 0,
        mine,
      };
    });

    let line = null;
    if (wanted) {
      line = lines.find((l) => l.csi === wanted) || null;
      if (!line) {
        return sendJson(res, 400, {
          error: 'Ligne inconnue',
          hint: 'La ligne ' + wanted + ' n\'existe pas sur ce compte Keyyo.',
          lines,
        }, 'no-store');
      }
    } else {
      const mine = lines.filter((l) => l.mine);
      if (mine.length === 1) line = mine[0];
      else if (mine.length > 1) {
        // Rattache a plusieurs sites : on ne choisit pas a sa place.
        return sendJson(res, 409, {
          error: 'Plusieurs lignes possibles',
          hint: 'Votre adresse est rattachee a plusieurs lignes : preciser `csi`.',
          lines,
        }, 'no-store');
      } else {
        return sendJson(res, 409, {
          error: 'Aucune ligne rattachée',
          hint: 'L\'annuaire Keyyo ne rattache pas ' + me + ' a une ligne. Choisir une ligne (`csi`), '
            + 'ou ajouter votre adresse au contact d\'annuaire de votre site.',
          lines,
        }, 'no-store');
      }
    }

    // Domaines autorises a utiliser le jeton : celui par lequel la page est
    // arrivee, et le domaine de production annonce par Vercel s'il differe.
    const h = req.headers || {};
    const requestHost = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
    const productionHost = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
    const minted = await mintCsiToken(cfg, token, line.csi, { deadline, domains: [requestHost, productionHost] });

    // Plugins CTI de la ligne. Keyyo conditionne certaines actions (appeler,
    // decrocher...) a des plugins actives ; « Cannot treat action » cote CTI
    // en est le symptome typique. On les liste pour que la page les montre —
    // lecture seule, et tolerante : leur absence n'empeche pas la session.
    /** @type {Array<{name: string, enabled: boolean}>} */
    let plugins = [];
    let pluginsError = '';
    try {
      const raw = await keyyoGetAll(cfg, token, '/services/' + encodeURIComponent(line.csi) + '/cti_plugins', {}, { deadline });
      plugins = raw
        .filter((p) => p && typeof p === 'object' && p.name)
        .map((p) => ({
          name: String(p.name),
          enabled: p.enabled === true || p.enabled === 1 || String(p.enabled).toLowerCase() === 'true' || String(p.enabled) === '1',
        }));
    } catch (err) {
      pluginsError = errorMessage(err);
    }

    res.setHeader('Vary', 'Cookie');
    sendJson(res, 200, {
      csi: line.csi,
      number: line.e164.replace(/^\+/, ''),
      token: minted.token,
      expiresAt: new Date(minted.expiresAt).toISOString(),
      domainMasks: minted.domainMasks,
      plugins,
      pluginsError,
      line,
      lines,
      user: { email: session.email, name: session.name, role: session.role },
      updatedAt: new Date().toISOString(),
    }, 'no-store');
  } catch (err) {
    const status = Number(/** @type {any} */ (err).status);
    sendJson(res, status === 401 || status === 403 ? 502 : 500, {
      error: 'Jeton CTI indisponible',
      hint: errorMessage(err),
    }, 'no-store');
  }
}
