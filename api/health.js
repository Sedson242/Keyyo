// =============================================================================
//  api/health.js — GET /api/health : la supervision.
//
//  Objectif : permettre de dire OU ca casse sans lire le code. Chaque maillon
//  de la chaine est teste SEPAREMENT et rend un controle nomme, avec son
//  resultat, son message et son temps de reponse.
//
//  C'est deliberement plus bavard que /api/calls : cette route n'est pas
//  appelee par le rendu, elle est appelee quand quelque chose ne va pas.
//
//  Le diagnostic historique de ce projet etait « 200 OK mais tout a zero ».
//  Les controles ci-dessous distinguent explicitement les trois causes qui
//  produisaient ce meme symptome : authentification muette, aucune ligne dans
//  le perimetre, et enregistrements recus mais tous ecartes a la normalisation.
//
//  Parametres : ?deep=1  ajoute une sonde reelle de releve d'appels (7 jours
//               sur la premiere ligne). Plus lent, mais c'est le seul controle
//               qui prouve que la chaine complete fonctionne.
// =============================================================================

import {
  readConfig, configSummary, readParams, flag, sendJson, rejectNonGet, errorMessage,
} from './_config.js';
import {
  getAccessToken, fetchVoipLines, fetchEmailAccounts, fetchDirectoryContacts, fetchCallDetail,
} from './_keyyo.js';
import { archiveEnabled, loadArchive } from './_archive.js';
import { resolveLineIdentities } from '../shared/identity.js';
import { isoDaysAgo, todayIso, nextDay } from '../shared/time.js';
import { SCHEMA_VERSION } from '../shared/schema.js';

/** Fenetre de la sonde ?deep=1 : assez courte pour rester rapide. */
const PROBE_DAYS = 7;

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/health')) return;

  const params = readParams(req);
  const deep = flag(params.deep);
  const startedAt = Date.now();

  /** @type {Array<{id: string, label: string, level: 'ok'|'warn'|'error', message: string, elapsedMs: number, detail?: any}>} */
  const checks = [];

  /**
   * Execute un controle en capturant son echec : un maillon casse ne doit
   * jamais empecher les suivants d'etre testes, sinon on ne voit qu'un
   * probleme a la fois.
   * @param {string} id
   * @param {string} label
   * @param {() => Promise<{level?: 'ok'|'warn'|'error', message: string, detail?: any, value?: any}>} fn
   * @returns {Promise<any>} la valeur produite par le controle, ou null s'il a echoue.
   */
  async function check(id, label, fn) {
    const t0 = Date.now();
    try {
      const r = await fn();
      checks.push({
        id,
        label,
        level: r.level || 'ok',
        message: r.message,
        elapsedMs: Date.now() - t0,
        detail: r.detail,
      });
      return 'value' in r ? r.value : null;
    } catch (err) {
      checks.push({
        id, label, level: 'error', message: errorMessage(err), elapsedMs: Date.now() - t0,
      });
      return null;
    }
  }

  // -- 1. Configuration -------------------------------------------------------
  /** @type {any} */
  let cfg = null;
  await check('config', 'Variables d\'environnement', async () => {
    cfg = readConfig();
    const overrides = Object.keys(cfg.lineEmails || {}).length;
    return {
      message: 'Configuration lue. Fuseau ' + cfg.tz + ', historique visé ' + cfg.historyDays
        + ' jours, fenêtre de synchronisation ' + cfg.syncDays + ' jours'
        + (overrides ? ', ' + overrides + ' association(s) manuelle(s) de ligne' : '') + '.',
      detail: configSummary(cfg),
    };
  });

  // Sans configuration, rien d'autre n'est testable : on rend ce qu'on sait.
  if (!cfg) {
    return sendJson(res, 503, {
      status: 'error',
      schemaVersion: SCHEMA_VERSION,
      calls: 0,
      period: { min: null, max: null },
      lines: [],
      checks,
      elapsedMs: Date.now() - startedAt,
      hint: 'La configuration est inexploitable : aucun autre contrôle n\'a pu être mené. '
        + 'Renseigner les variables d\'environnement du projet Vercel, puis redéployer.',
    }, 'no-store');
  }

  // -- 2. Authentification ----------------------------------------------------
  const token = await check('auth', 'Authentification Keyyo (OAuth2)', async () => {
    const t = await getAccessToken(cfg);
    if (!t) throw new Error('Jeton d\'accès vide renvoyé par ' + cfg.tokenUrl + '.');
    return {
      message: 'Jeton d\'accès obtenu auprès de ' + cfg.tokenUrl + '.',
      value: t,
    };
  });

  if (!token) {
    return sendJson(res, 503, {
      status: 'error',
      schemaVersion: SCHEMA_VERSION,
      calls: 0,
      period: { min: null, max: null },
      lines: [],
      checks,
      elapsedMs: Date.now() - startedAt,
      hint: 'Authentification refusée. Vérifier KEYYO_CLIENT_ID, KEYYO_CLIENT_SECRET et '
        + 'KEYYO_REFRESH_TOKEN. Un refresh_token révoqué doit être régénéré dans la console Keyyo.',
    }, 'no-store');
  }

  // -- 3. Lignes VoIP ---------------------------------------------------------
  const voipLines = await check('services', 'Lignes VoIP (GET /services)', async () => {
    const lines = await fetchVoipLines(cfg, token);
    if (!lines.length) {
      return {
        level: 'error',
        message: 'Aucune ligne de type UCaaSVoIPAccount sur ce compte. Sans ligne, aucun appel '
          + 'ne peut être collecté. Vérifier le périmètre du jeton (scope full_access_read_only) '
          + 'et que le compte porte bien des lignes de téléphonie.',
        value: [],
      };
    }
    const inService = lines.filter((l) => l.status === 'in_service').length;
    return {
      level: inService ? 'ok' : 'warn',
      message: lines.length + ' ligne(s) trouvée(s), dont ' + inService + ' en service.',
      detail: lines.map((l) => ({ csi: l.csi, name: l.name, status: l.status, shortNumber: l.shortNumber })),
      value: lines,
    };
  }) || [];

  // -- 4. Annuaire (source d'identite principale) -----------------------------
  const contacts = await check('directory', 'Annuaire (GET /directory_contacts)', async () => {
    const list = await fetchDirectoryContacts(cfg, token);
    const withEmail = list.filter((c) => c.email).length;
    if (!list.length) {
      return {
        level: 'warn',
        message: 'Annuaire vide. Les numéros externes resteront affichés en numéro, et le '
          + 'rapprochement ligne → collaborateur devra passer par KEYYO_LINE_EMAILS.',
        value: [],
      };
    }
    return {
      level: withEmail ? 'ok' : 'warn',
      message: list.length + ' contact(s), dont ' + withEmail + ' avec une adresse email.'
        + (withEmail ? '' : ' Sans email, les prénoms ne peuvent pas être déduits de l\'annuaire.'),
      value: list,
    };
  }) || [];

  // -- 5. Comptes de messagerie (source d'identite secondaire) ----------------
  const mailboxes = await check('email_accounts', 'Comptes de messagerie (GET /services)', async () => {
    const list = await fetchEmailAccounts(cfg, token);
    const withEmail = list.filter((m) => m.email).length;
    return {
      level: 'ok',
      message: list.length
        ? list.length + ' compte(s) de messagerie, dont ' + withEmail + ' avec une adresse exploitable.'
        : 'Aucun compte de messagerie Keyyo sur ce compte : source d\'identité non disponible, '
          + 'ce qui est normal si la messagerie n\'est pas souscrite.',
      value: list,
    };
  }) || [];

  // -- 6. Rapprochement des identites ----------------------------------------
  const resolved = await check('identities', 'Rapprochement ligne → collaborateur', async () => {
    const lines = resolveLineIdentities({
      voipLines,
      directoryContacts: contacts,
      emailAccounts: mailboxes,
      overrides: cfg.lineEmails,
    });
    const withPerson = lines.filter((l) => l.person).length;
    const withEmail = lines.filter((l) => l.person && l.person.email).length;
    /** @type {Record<string, number>} */
    const bySource = {};
    for (const l of lines) {
      if (!l.person) continue;
      bySource[l.person.source] = (bySource[l.person.source] || 0) + 1;
    }
    const unresolved = lines.filter((l) => !l.person || !l.person.email).map((l) => l.csi);

    return {
      level: unresolved.length ? 'warn' : 'ok',
      message: withEmail + ' ligne(s) sur ' + lines.length + ' associée(s) à une adresse email'
        + (withPerson > withEmail ? ' (' + (withPerson - withEmail) + ' avec un prénom mais sans email)' : '')
        + (unresolved.length
          ? '. Lignes non associées : ' + unresolved.join(', ')
            + ' — les forcer avec KEYYO_LINE_EMAILS (voir la page Diagnostic).'
          : '.'),
      detail: { bySource, unresolved },
      value: lines,
    };
  }) || [];

  // -- 7. Archive -------------------------------------------------------------
  const archive = await check('archive', 'Archive (Vercel Blob)', async () => {
    if (!archiveEnabled()) {
      return {
        level: 'warn',
        message: 'Aucun magasin Blob relié (BLOB_READ_WRITE_TOKEN absent) : l\'outil fonctionne '
          + 'en mode direct, sans mémoire. L\'API Keyyo ayant une fenêtre glissante, '
          + 'l\'historique ancien sera perdu. Créer un store Blob et le relier au projet.',
        value: null,
      };
    }
    const a = await loadArchive();
    if (!a) {
      return {
        level: 'warn',
        message: 'Magasin Blob relié mais archive absente ou d\'un format antérieur : '
          + 'le prochain appel déclenchera un remplissage complet sur '
          + cfg.historyDays + ' jours.',
        value: null,
      };
    }
    const months = Object.keys(a.coverage || {}).sort();
    return {
      message: a.rows.length + ' appel(s) archivé(s), sauvegarde du '
        + (a.savedAt || 'date inconnue')
        + (months.length ? ', mois couverts : ' + months.join(', ') : '') + '.',
      detail: { savedAt: a.savedAt, rows: a.rows.length, coverage: a.coverage },
      value: a,
    };
  });

  // -- 8. Sonde de releve d'appels (facultative) ------------------------------
  // C'est le seul controle qui prouve la chaine COMPLETE : requete, pagination,
  // normalisation. Il distingue « 0 enregistrement recu » de « enregistrements
  // recus mais tous ecartes », les deux causes du symptome « tout a zero ».
  let probe = null;
  if (deep && voipLines.length) {
    probe = await check('call_detail', 'Sonde de relevé d\'appels (' + PROBE_DAYS + ' jours)', async () => {
      const csi = voipLines[0].csi;
      const from = isoDaysAgo(PROBE_DAYS - 1, Date.now(), cfg.tz);
      const to = nextDay(todayIso(Date.now(), cfg.tz));   // date_end est exclusive
      const results = await Promise.all([
        fetchCallDetail(cfg, token, { csi, direction: 'in', from, to }),
        fetchCallDetail(cfg, token, { csi, direction: 'out', from, to }),
      ]);
      const rawSeen = results.reduce((a, r) => a + Number(r.diag.rawSeen || 0), 0);
      const kept = results.reduce((a, r) => a + Number(r.diag.kept || 0), 0);
      const dropped = results.reduce((a, r) => a + Number(r.diag.dropped || 0), 0);
      /** @type {Record<string, number>} */
      const dropReasons = {};
      for (const r of results) {
        for (const k of Object.keys(r.diag.dropReasons || {})) {
          dropReasons[k] = (dropReasons[k] || 0) + r.diag.dropReasons[k];
        }
      }

      let level = /** @type {'ok'|'warn'|'error'} */ ('ok');
      let message;
      if (rawSeen === 0) {
        level = 'warn';
        message = 'Keyyo a répondu sans erreur mais n\'a renvoyé aucun enregistrement sur les '
          + PROBE_DAYS + ' derniers jours pour la ligne ' + csi + '. Soit cette ligne n\'a pas eu '
          + 'de trafic, soit la fenêtre est vide : élargir avec /api/sync?full=1.';
      } else if (kept === 0) {
        level = 'error';
        message = rawSeen + ' enregistrement(s) reçu(s) mais AUCUN retenu à la normalisation. '
          + 'Des appels sont perdus. Raisons : ' + describeReasons(dropReasons) + '.';
      } else {
        level = dropped ? 'warn' : 'ok';
        message = rawSeen + ' enregistrement(s) reçu(s), ' + kept + ' retenu(s)'
          + (dropped ? ', ' + dropped + ' écarté(s) — ' + describeReasons(dropReasons) : '') + '.';
      }
      return { level, message, detail: { csi, from, to, rawSeen, kept, dropped, dropReasons }, value: { rawSeen, kept } };
    });
  }

  // -- Verdict ----------------------------------------------------------------
  const hasError = checks.some((c) => c.level === 'error');
  const archivedCalls = archive && Array.isArray(archive.rows) ? archive.rows.length : 0;
  const probedCalls = probe ? Number(probe.kept) || 0 : 0;
  const calls = archivedCalls || probedCalls;

  let status = 'ok';
  if (hasError) status = 'error';
  else if (!calls && (deep || archiveEnabled())) status = 'empty';

  const period = { min: null, max: null };
  if (archive && archive.coverage) {
    const months = Object.keys(archive.coverage).sort();
    if (months.length) {
      period.min = months[0] + '-01';
      period.max = months[months.length - 1];
    }
  }

  sendJson(res, hasError ? 503 : 200, {
    status,
    schemaVersion: SCHEMA_VERSION,
    calls,
    period,
    lines: resolved.map((l) => ({
      csi: l.csi,
      name: l.name,
      status: l.status,
      shortNumber: l.shortNumber,
      person: l.person
        ? {
          firstName: l.person.firstName,
          lastName: l.person.lastName,
          email: l.person.email,
          source: l.person.source,
          confidence: l.person.confidence,
          evidence: l.person.evidence,
        }
        : null,
    })),
    checks,
    elapsedMs: Date.now() - startedAt,
    hint: buildHint(status, checks, deep),
  }, 'no-store');   // la supervision n'est jamais mise en cache
}

/**
 * Resume lisible d'un decompte de rejets, borne aux trois raisons principales.
 * @param {Record<string, number>} reasons
 * @returns {string}
 */
function describeReasons(reasons) {
  const entries = Object.entries(reasons || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'aucune raison enregistrée';
  return entries.slice(0, 3).map(([reason, n]) => n + ' × ' + reason).join(', ')
    + (entries.length > 3 ? ', et ' + (entries.length - 3) + ' autre(s)' : '');
}

/**
 * Une seule phrase disant quoi faire ensuite. On pointe le PREMIER controle en
 * erreur : c'est presque toujours lui qui cause les suivants.
 * @param {string} status
 * @param {Array<{id: string, label: string, level: string, message: string}>} checks
 * @param {boolean} deep
 * @returns {string}
 */
function buildHint(status, checks, deep) {
  const firstError = checks.find((c) => c.level === 'error');
  if (firstError) {
    return 'Contrôle en échec : « ' + firstError.label + ' ». ' + firstError.message;
  }
  if (status === 'empty') {
    return 'La chaîne technique répond, mais aucun appel n\'est disponible. Lancer un '
      + 'remplissage complet avec /api/sync?full=1, puis mois par mois avec '
      + '/api/sync?month=AAAA-MM si le budget de temps est atteint.';
  }
  const warns = checks.filter((c) => c.level === 'warn');
  if (warns.length) {
    return warns.length + ' avertissement(s) : ' + warns.map((w) => w.label).join(', ')
      + '. Rien de bloquant, mais ces points limitent la qualité des données.';
  }
  return deep
    ? 'Tous les contrôles passent, sonde de relevé incluse.'
    : 'Tous les contrôles passent. Ajouter ?deep=1 pour sonder en plus un relevé d\'appels réel.';
}
