// =============================================================================
//  api/team.js — GET /api/team : qui est derriere chaque ligne Keyyo.
//
//  C'est l'exigence centrale de l'outil : afficher un PRENOM plutot qu'un CSI.
//  L'API Manager ne fournit aucune association « ligne -> personne », elle est
//  reconstruite par shared/identity.js en croisant /services et
//  /directory_contacts. Chaque rapprochement porte sa source, sa confiance et
//  son indice — et les lignes non resolues sont listees, jamais masquees, avec
//  la ligne KEYYO_LINE_EMAILS prete a coller pour les corriger a la main.
//
//  Cette route ne collecte AUCUN appel : elle n'interroge que les trois
//  ressources d'identite, ce qui la garde rapide.
//
//  Parametres : ?force=1
// =============================================================================

import { readConfig, readParams, flag, sendJson, rejectNonGet, errorMessage } from './_config.js';
import { getAccessToken, fetchVoipLines, fetchDirectoryContacts, fetchEmailAccounts } from './_keyyo.js';
import { resolveLineIdentities, lineLabel } from '../shared/identity.js';

const CACHE_FRESH = 's-maxage=300, stale-while-revalidate=600';

/** Domaine de repli quand aucune adresse connue ne permet de le deduire. */
const FALLBACK_DOMAIN = 'exemple.fr';

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/team')) return;

  const params = readParams(req);
  const force = flag(params.force);

  try {
    const cfg = readConfig();
    const deadline = Date.now() + Math.min(cfg.budgetMs, 20000);
    const token = await getAccessToken(cfg);

    const voipLines = await fetchVoipLines(cfg, token, { deadline });

    /** @type {string[]} */
    const warnings = [];
    /** @type {any[]} */
    let directoryContacts = [];
    /** @type {any[]} */
    let emailAccounts = [];

    // Les sources d'identite sont facultatives : sans elles on affiche encore
    // les lignes, simplement moins bien nommees.
    const [contacts, mailboxes] = await Promise.all([
      settle(() => fetchDirectoryContacts(cfg, token, { deadline })),
      settle(() => fetchEmailAccounts(cfg, token, { deadline })),
    ]);
    if (contacts.ok) directoryContacts = contacts.value;
    else warnings.push("Annuaire /directory_contacts indisponible : " + contacts.message);
    if (mailboxes.ok) emailAccounts = mailboxes.value;
    else warnings.push('Comptes e-mail indisponibles : ' + mailboxes.message);

    const resolved = resolveLineIdentities({
      voipLines,
      directoryContacts,
      emailAccounts,
      overrides: cfg.lineEmails,
    });

    const lines = resolved.map((line) => ({
      csi: line.csi,
      formattedCsi: line.formattedCsi || '',
      name: line.name || '',
      shortNumber: line.shortNumber || '',
      presentedNumber: line.presentedNumber || '',
      status: line.status || '',
      blockingStatus: line.blockingStatus || '',
      offerName: line.offerName || '',
      label: lineLabel(line),
      person: line.person || null,
      candidates: line.candidates || [],
    }));

    const unresolved = lines
      .filter((l) => !l.person || !l.person.email)
      .map((l) => ({
        csi: l.csi,
        formattedCsi: l.formattedCsi,
        name: l.name,
        shortNumber: l.shortNumber,
        label: l.label,
        reason: !l.person
          ? "aucun candidat : ni contact d'annuaire au bon numéro, ni nom de ligne exploitable"
          : 'rapproché par « ' + l.person.source + ' » mais sans adresse e-mail connue',
      }));

    const sources = countSources(lines);
    const suggestion = buildSuggestion(lines, directoryContacts, emailAccounts);

    if (!lines.length) {
      warnings.push(
        "Aucune ligne VoIP sur ce compte Keyyo : vérifier que le jeton porte sur le bon compte "
        + 'et que le scope full_access_read_only est accordé.',
      );
    }

    const cacheControl = (!lines.length || force) ? 'no-store' : CACHE_FRESH;

    sendJson(res, 200, {
      lines,
      unresolved,
      suggestion,
      sources,
      updatedAt: new Date().toISOString(),
      warnings,
    }, cacheControl);
  } catch (err) {
    const message = errorMessage(err);
    sendJson(res, 500, {
      lines: [],
      unresolved: [],
      suggestion: '',
      sources: {},
      updatedAt: new Date().toISOString(),
      error: 'Identités indisponibles',
      hint: message + ' Le détail des contrôles est disponible sur /api/health.',
    }, 'no-store');
  }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ok: true, value: T}|{ok: false, message: string, value: any[]}>}
 */
async function settle(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, message: errorMessage(err), value: [] };
  }
}

/**
 * Comptage par source de rapprochement, pour voir d'un coup d'oeil sur quoi
 * repose l'affichage des prenoms.
 * @param {Array<{person: any}>} lines
 * @returns {Record<string, number>}
 */
function countSources(lines) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const line of lines) {
    const key = line.person && line.person.source ? String(line.person.source) : 'aucune';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Construit la ligne KEYYO_LINE_EMAILS a coller dans les variables
 * d'environnement : les lignes deja resolues gardent leur adresse reelle, les
 * lignes non resolues recoivent un gabarit a completer.
 * @param {Array<{csi: string, person: any}>} lines
 * @param {any[]} contacts
 * @param {any[]} mailboxes
 * @returns {string}
 */
function buildSuggestion(lines, contacts, mailboxes) {
  if (!lines.length) return '';
  const domain = guessDomain(contacts, mailboxes);
  const pairs = [];
  for (const line of lines) {
    const email = line.person && line.person.email ? String(line.person.email) : '';
    pairs.push(line.csi + '=' + (email || 'prenom.nom@' + domain));
  }
  return 'KEYYO_LINE_EMAILS=' + pairs.join(',');
}

/**
 * Domaine le plus represente parmi les adresses connues : sans lui, le gabarit
 * proposerait un domaine faux, que l'utilisateur recopierait tel quel.
 * @param {any[]} contacts
 * @param {any[]} mailboxes
 * @returns {string}
 */
function guessDomain(contacts, mailboxes) {
  /** @type {Record<string, number>} */
  const tally = {};
  const scan = (list) => {
    for (const item of list || []) {
      const email = item && item.email ? String(item.email) : '';
      const at = email.lastIndexOf('@');
      if (at <= 0) continue;
      const domain = email.slice(at + 1).toLowerCase();
      if (domain) tally[domain] = (tally[domain] || 0) + 1;
    }
  };
  scan(contacts);
  scan(mailboxes);

  let best = '';
  let bestCount = 0;
  for (const domain of Object.keys(tally)) {
    if (tally[domain] > bestCount) { best = domain; bestCount = tally[domain]; }
  }
  return best || FALLBACK_DOMAIN;
}
