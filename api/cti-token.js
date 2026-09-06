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
import { getAccessToken, fetchVoipLines, fetchDirectoryContacts, mintCsiToken, keyyoGetAll, keyyoPost } from './_keyyo.js';

/**
 * Plugins CTI que l'application accepte d'activer elle-meme. `websocket` est
 * le canal de la bibliotheque CTI de Keyyo : sans lui, la session s'ouvre
 * mais toute action repond « Cannot treat action » (verifie en production).
 * Les autres plugins (`custom`, `delos`...) sont des integrations tierces :
 * on les montre, on n'y touche pas.
 */
const PLUGINS_ALLOWED = ['websocket'];
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
    const enablePlugin = String(body.enablePlugin == null ? '' : body.enablePlugin).trim().toLowerCase();
    if (enablePlugin && PLUGINS_ALLOWED.indexOf(enablePlugin) < 0) {
      return sendJson(res, 400, {
        error: 'Plugin non pris en charge',
        hint: 'Seul le plugin « ' + PLUGINS_ALLOWED.join(' », « ') + ' » peut être activé depuis l\'application.',
      }, 'no-store');
    }

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
    const pluginsPath = '/services/' + encodeURIComponent(line.csi) + '/cti_plugins';
    /** @returns {Promise<Array<{name: string, enabled: boolean}>>} */
    const listPlugins = async () => (await keyyoGetAll(cfg, token, pluginsPath, {}, { deadline }))
      .filter((p) => p && typeof p === 'object' && p.name)
      .map((p) => ({
        name: String(p.name),
        enabled: p.enabled === true || p.enabled === 1 || String(p.enabled).toLowerCase() === 'true' || String(p.enabled) === '1',
      }));

    /** @type {Array<{name: string, enabled: boolean}>} */
    let plugins = [];
    let pluginsError = '';
    try {
      plugins = await listPlugins();
    } catch (err) {
      pluginsError = errorMessage(err);
    }

    // Activation demandee par l'utilisateur (bouton « Activer » de la page) :
    // ecriture Keyyo, scope cti_admin. On tente le formulaire `enabled=1`,
    // puis le JSON si Keyyo reclame un autre encodage, et on relit l'etat.
    /** @type {{name: string, ok: boolean, error: string}|null} */
    let pluginAction = null;
    if (enablePlugin) {
      const known = plugins.find((p) => p.name.toLowerCase() === enablePlugin);
      if (known && known.enabled) {
        pluginAction = { name: enablePlugin, ok: true, error: '' };
      } else {
        const path = pluginsPath + '/' + encodeURIComponent(enablePlugin);
        try {
          try {
            await keyyoPost(cfg, token, path, { enabled: 1 }, { deadline });
          } catch (err) {
            if (Number(/** @type {any} */ (err).status) === 400) await keyyoPost(cfg, token, path, { enabled: true }, { deadline, json: true });
            else throw err;
          }
          pluginAction = { name: enablePlugin, ok: true, error: '' };
        } catch (err) {
          pluginAction = { name: enablePlugin, ok: false, error: errorMessage(err) };
        }
        try { plugins = await listPlugins(); } catch (err) { pluginsError = errorMessage(err); }
      }
    }

    // Terminaux actuellement enregistres sur la ligne (sip_records : IP, agent
    // utilisateur, MAC). Un appel sortant par le CTI fait d'abord decrocher un
    // poste de la ligne : sans aucun enregistrement, il n'y a rien a faire
    // sonner, et Keyyo repond « Cannot treat action ».
    /** @type {Array<{userAgent: string, ip: string}>} */
    let registrations = [];
    let registrationsError = '';
    try {
      const raw = await keyyoGetAll(cfg, token, '/services/' + encodeURIComponent(line.csi) + '/sip_records', {}, { deadline });
      registrations = raw.filter((r) => r && typeof r === 'object').map((r) => ({
        userAgent: String(r.user_agent || r.userAgent || r.agent || ''),
        ip: String(r.ip || r.ip_address || r.address || ''),
      }));
    } catch (err) {
      registrationsError = errorMessage(err);
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
      pluginAction,
      registrations,
      registrationsError,
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
