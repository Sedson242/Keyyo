// =============================================================================
//  api/directory.js — numero -> nom.
//
//    GET  /api/directory   la carte numero -> nom, fusion de deux sources ;
//    POST /api/directory   { csv, filename } importe un export de contacts
//                          Keyyo Phone, { clear: true } le supprime.
//                          ADMINISTRATEURS SEULEMENT (shared/roles.js).
//
//  DEUX SOURCES, dans cet ordre de priorite :
//    1. /directory_contacts de l'API Keyyo : l'annuaire du Manager ;
//    2. l'annuaire complementaire : l'export CSV de Keyyo Phone importe depuis
//       la page Administration et conserve sur Blob
//       (keyyo/config/contacts.json, api/_contacts.js).
//  L'annuaire Keyyo prime : un numero present dans les deux garde le nom de
//  l'API, et la difference est signalee en mode debug (importCollisions).
//  Sans store Blob ni import, la reponse est celle de la source unique, comme
//  avant. Microsoft Graph a ete explicitement ecarte par l'utilisateur ; aucun
//  autre annuaire n'est interroge, et il n'y a donc aucune donnee a envoyer a
//  un tiers.
//
//  Les cles sont normalisees en E.164 par shared/phone.js#toE164 : c'est la
//  meme fonction que celle utilisee pour les numeros des appels, ce qui garantit
//  qu'une cle calculee ici correspond a un `peer` calcule la-bas.
//
//  Il n'y a pas de route dediee a l'import : les douze fonctions du plan Vercel
//  sont toutes prises, d'ou le POST sur cette route.
//
//  Parametres GET : ?debug=1 (detail par source + echantillon)  ?force=1
// =============================================================================

import {
  readConfig, readParams, flag, sendJson, rejectCrossSite, readJsonBody, errorMessage,
} from './_config.js';
import { requireRole } from './_auth.js';
import { getAccessToken, fetchDirectoryContacts } from './_keyyo.js';
import { loadArchive } from './_archive.js';
import {
  contactsEnabled, loadContacts, saveContacts, directoryMapFromContacts, mergeDirectory, coverageOf,
} from './_contacts.js';
import { parseContactsExport, emptyImport } from '../shared/contacts.js';
import { isAdmin } from '../shared/roles.js';

/**
 * Cache PRIVE. L'annuaire change peu, d'ou une fenetre plus large que les
 * autres routes — mais elle reste PRIVEE : `s-maxage` aurait depose sur le CDN,
 * cache partage, la correspondance complete numero -> nom des correspondants du
 * client, resservie sans que la fonction ni son controle d'acces soient
 * rejoues. Voir la note detaillee dans api/calls.js. Cinq minutes, et non dix :
 * un import doit apparaitre vite.
 */
const CACHE_PRIVATE = 'private, max-age=300';

/** Taille de l'echantillon renvoye en mode debug. */
const SAMPLE_SIZE = 12;

/** Taille maximale du contenu CSV d'un import, en octets. */
const IMPORT_LIMIT = 2 * 1024 * 1024;

/**
 * Plafond du corps JSON qui enveloppe le CSV : JSON.stringify gonfle le texte
 * (guillemets echappes, retours a la ligne), d'ou une marge au-dessus de
 * IMPORT_LIMIT ; la limite exacte porte sur le CSV lui-meme, en octets.
 */
const BODY_LIMIT = 3 * 1024 * 1024;

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    return sendJson(res, 405, {
      error: 'Methode ' + method + ' non autorisee',
      hint: 'Lire avec GET /api/directory ; importer avec POST /api/directory (administrateurs).',
    }, 'no-store');
  }
  // Annuaire : ouvert a toute personne connectee (un agent en a besoin pour
  // nommer ses correspondants), ferme a tout le monde sinon. L'ecriture est
  // reservee aux administrateurs : verifie dans handlePost.
  const session = await requireRole(req, res, '/api/directory');
  if (!session) return;

  if (method === 'POST') return handlePost(req, res, session);
  return handleGet(req, res);
}

// -----------------------------------------------------------------------------
//  GET : la carte fusionnee
// -----------------------------------------------------------------------------

/**
 * Le contrat de la reponse est celui d'avant, enrichi : `sources.import`,
 * `origin` (les cles venant de l'import), `imported` (etat de l'import) et
 * `degraded` quand l'API Keyyo a echoue et que l'import seul repond.
 * @param {any} req
 * @param {any} res
 */
async function handleGet(req, res) {
  const params = readParams(req);
  const debug = flag(params.debug);
  const force = flag(params.force);

  // L'import se lit d'abord : sans lui, un echec de l'API Keyyo est une
  // erreur ; avec lui, c'est un mode degrade ou les correspondants importes
  // gardent au moins leur nom.
  const imp = await loadContacts({ force });
  const hasImport = !!(imp && imp.contacts.length);

  /** @type {Record<string, string>} */
  let apiMap = {};
  /** @type {any} */
  let apiDetail = null;
  let apiError = '';
  try {
    const cfg = readConfig();
    const deadline = Date.now() + Math.min(cfg.budgetMs, 20000);
    const token = await getAccessToken(cfg);
    const built = directoryMapFromContacts(await fetchDirectoryContacts(cfg, token, { deadline }));
    apiMap = built.map;
    apiDetail = built.detail;
  } catch (err) {
    apiError = errorMessage(err);
  }

  if (apiError && !hasImport) {
    return sendJson(res, 500, {
      map: {},
      count: 0,
      sources: {},
      updatedAt: new Date().toISOString(),
      error: 'Annuaire indisponible',
      hint: apiError + ' Le détail des contrôles est disponible sur /api/health.',
    }, 'no-store');
  }

  const merged = mergeDirectory(apiMap, imp);
  const count = Object.keys(merged.map).length;
  const degraded = !!apiError;
  const cacheControl = (!count || force || debug || degraded) ? 'no-store' : CACHE_PRIVATE;

  /** @type {any} */
  const body = {
    map: merged.map,
    count,
    sources: merged.sources,
    origin: merged.origin,
    imported: hasImport ? importedSummary(imp, merged) : null,
    updatedAt: new Date().toISOString(),
  };

  if (degraded) {
    body.degraded = true;
    body.warning = 'Annuaire Keyyo indisponible : ' + sentence(apiError)
      + ' Seuls les contacts importés nomment les correspondants.';
  } else if (!count) {
    body.warning = 'Annuaire Keyyo vide : aucun contact exploitable dans /directory_contacts. '
      + 'Les correspondants resteront affichés par leur numéro.';
  }

  if (debug) {
    body.debug = {
      detail: {
        directory_contacts: apiDetail || { error: apiError },
        import: imp
          ? { contacts: imp.contacts.length, filename: imp.filename, importedAt: imp.importedAt, importedBy: imp.importedBy, stats: imp.stats }
          : null,
      },
      sample: Object.keys(merged.map).slice(0, SAMPLE_SIZE)
        .map((key) => ({ number: key, name: merged.map[key], origin: merged.origin[key] || 'directory' })),
      importCollisions: merged.collisions,
      note: 'Deux sources : /directory_contacts (prioritaire), puis l’export de contacts Keyyo Phone importé. '
        + 'Aucun annuaire externe n’est interrogé.',
    };
  }

  sendJson(res, 200, body, cacheControl);
}

// -----------------------------------------------------------------------------
//  POST : import ou suppression de l'annuaire complementaire
// -----------------------------------------------------------------------------

/**
 * `{ csv, filename }` importe un export de contacts Keyyo Phone, `{ clear: true }`
 * le supprime. Reserve aux administrateurs ; garde anti-CSRF et corps JSON
 * comme toute route qui ecrit. L'analyse du fichier (shared/contacts.js) est
 * la meme que celle de l'apercu dans le navigateur.
 * @param {any} req
 * @param {any} res
 * @param {import('./_auth.js').Session} session
 */
async function handlePost(req, res, session) {
  if (!isAdmin(session.role)) {
    return sendJson(res, 403, {
      error: 'Accès réservé',
      hint: 'L’import d’un annuaire est réservé aux administrateurs.',
    }, 'no-store');
  }
  if (rejectCrossSite(req, res)) return;

  try {
    const body = await readJsonBody(req, { limit: BODY_LIMIT });

    if (!contactsEnabled()) {
      return sendJson(res, 503, {
        error: 'Import indisponible',
        hint: 'Aucun store Blob relié au projet : l’annuaire complémentaire ne peut pas être conservé.',
      }, 'no-store');
    }

    const input = body && typeof body === 'object' ? body : {};

    if (input.clear === true) {
      await saveContacts(emptyImport(), session.email);
      return sendJson(res, 200, { ok: true, imported: null }, 'no-store');
    }

    const csv = typeof input.csv === 'string' ? input.csv : '';
    const tooBig = !!csv && Buffer.byteLength(csv, 'utf8') > IMPORT_LIMIT;
    if (!csv.trim() || tooBig) {
      return sendJson(res, 400, {
        error: 'Corps invalide',
        hint: 'Attendu : { "csv": "<contenu du fichier>", "filename": "…" } ou { "clear": true }.'
          + (tooBig ? ' Le fichier dépasse 2 Mo.' : ''),
      }, 'no-store');
    }
    const filename = String(input.filename == null ? '' : input.filename).trim().slice(0, 200);

    let parsed;
    try {
      parsed = parseContactsExport(csv);
    } catch (err) {
      return sendJson(res, 400, { error: 'Format non reconnu', hint: errorMessage(err) }, 'no-store');
    }
    if (!parsed.stats.contacts) {
      return sendJson(res, 400, {
        error: 'Aucun contact exploitable',
        hint: parsed.stats.rows + ' ligne(s) lue(s), mais aucune ne porte à la fois un nom et un numéro exploitable. '
          + 'Vérifier que le fichier est bien l’export de contacts de Keyyo Phone.',
        stats: parsed.stats,
        warnings: parsed.warnings,
      }, 'no-store');
    }

    const saved = await saveContacts(
      { ...emptyImport(), filename, contacts: parsed.contacts, stats: parsed.stats },
      session.email,
    );

    // Couverture : tolerante, jamais bloquante. L'import est deja conserve ;
    // un annuaire Keyyo ou une archive indisponibles n'appauvrissent que le
    // compte rendu.
    const warnings = parsed.warnings.slice();
    /** @type {Record<string, string>} */
    let apiMap = {};
    try {
      const cfg = readConfig();
      const deadline = Date.now() + Math.min(cfg.budgetMs, 20000);
      const token = await getAccessToken(cfg);
      apiMap = directoryMapFromContacts(await fetchDirectoryContacts(cfg, token, { deadline })).map;
    } catch (err) {
      warnings.push('Annuaire Keyyo indisponible pendant l’import (' + errorMessage(err)
        + ') : la couverture est calculée avec l’import seul.');
    }
    const merged = mergeDirectory(apiMap, saved);
    let coverage = null;
    try {
      const archive = await loadArchive();
      if (archive) coverage = coverageOf(archive.rows, merged);
    } catch (err) {
      warnings.push('Archive illisible (' + errorMessage(err) + ') : couverture non calculée.');
    }

    return sendJson(res, 200, {
      ok: true,
      imported: importedSummary(saved, merged),
      stats: saved.stats || parsed.stats,
      warnings,
      collisions: merged.collisions,
      coverage,
    }, 'no-store');
  } catch (err) {
    sendJson(res, 500, { error: 'Import en erreur', hint: errorMessage(err) }, 'no-store');
  }
}

// -----------------------------------------------------------------------------
//  Utilitaires
// -----------------------------------------------------------------------------

/**
 * Etat de l'import tel que le front l'affiche (page Administration).
 * @param {import('../shared/contacts.js').ContactsImport} imp
 * @param {{sources: {import: number}, collisions: any[]}} merged
 * @returns {{count: number, numbers: number, importedAt: string, importedBy: string, filename: string}}
 */
function importedSummary(imp, merged) {
  return {
    count: imp.contacts.length,
    numbers: importedNumbers(imp, merged),
    importedAt: imp.importedAt,
    importedBy: imp.importedBy,
    filename: imp.filename,
  };
}

/**
 * Termine une phrase par un point si elle n'a pas deja sa ponctuation : les
 * messages d'erreur se concatenent dans un avertissement lisible.
 * @param {string} s
 * @returns {string}
 */
function sentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return /[.!?…]$/.test(t) ? t : t + '.';
}

/**
 * Nombre de numeros distincts de l'import : le compteur calcule a l'analyse
 * (`stats.numbers`), le meme que celui de l'apercu de la page Administration.
 * A defaut (import conserve sans compteurs), les cles ajoutees par l'import
 * plus celles que l'annuaire Keyyo lui masque sous un autre nom.
 * @param {import('../shared/contacts.js').ContactsImport} imp
 * @param {{sources: {import: number}, collisions: any[]}} merged
 * @returns {number}
 */
function importedNumbers(imp, merged) {
  const n = imp && imp.stats ? Number(imp.stats.numbers) : 0;
  if (Number.isFinite(n) && n > 0) return n;
  return merged.sources.import + merged.collisions.length;
}
