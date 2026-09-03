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
import {
  getAccessToken, fetchServices, fetchVoipLines, fetchDirectoryContacts, fetchEmailAccounts,
} from './_keyyo.js';
import { resolveLineIdentities, lineLabel } from '../shared/identity.js';

const CACHE_FRESH = 's-maxage=300, stale-while-revalidate=600';

/** Domaine de repli quand aucune adresse connue ne permet de le deduire. */
const FALLBACK_DOMAIN = 'exemple.fr';

/**
 * Types de service tentes par `?inventory=1`.
 *
 * Les deux premiers sont cites par la documentation dans les rubriques
 * « Applicable types » de /sip_records et /incoming_call_detail, mais
 * n'apparaissent PAS dans la liste des huit types de GET /services : ce sont
 * les meilleurs candidats pour designer un terminal. Les suivants sont des
 * noms plausibles, essayes parce qu'un refus coute une requete et repond
 * definitivement.
 */
const PROBE_TYPES = [
  'SIPAccount', 'TelephonyService', 'KeyyoPhone', 'Phone', 'Device', 'Terminal', 'Softphone',
];

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

    // -- ?inventory=1 : l'INVENTAIRE BRUT des services de ce compte. ---------
    //
    // Toutes les autres routes filtrent par type (`UCaaSVoIPAccount`,
    // `EmailAccount`) : personne n'a donc jamais regarde ce que ce compte
    // contient VRAIMENT. Or la console d'administration montre 56 terminaux
    // Keyyo Phone identifies par `c8um2@kphone`, introuvables dans les huit
    // types documentes.
    //
    // Cette sonde repond a la question empiriquement : elle demande d'abord
    // TOUS les services sans aucun filtre, puis reessaie avec les types que la
    // documentation mentionne au detour d'une page sans les lister
    // (`SIPAccount` pour /sip_records, `TelephonyService` pour
    // /incoming_call_detail), et enfin quelques noms plausibles. Chaque
    // service est rendu avec son `_resource_type`, son CSI et son nom.
    if (flag(params.inventory)) {
      const all = await settle(() => fetchServices(cfg, token, '', { deadline }));

      /** @type {Record<string, any[]>} */
      const byType = {};
      if (all.ok) {
        for (const s of all.value) {
          if (!s || typeof s !== 'object') continue;
          const type = String(s._resource_type || 'inconnu');
          if (!byType[type]) byType[type] = [];
          byType[type].push({
            csi: String(s.csi == null ? '' : s.csi),
            formattedCsi: String(s.formatted_csi == null ? '' : s.formatted_csi),
            name: String(s.name == null ? '' : s.name),
            offerName: String(s.offer_name == null ? '' : s.offer_name),
            status: String(s.status == null ? '' : s.status),
            firstName: String(s.first_name == null ? '' : s.first_name),
            lastName: String(s.last_name == null ? '' : s.last_name),
            shortNumber: String(s.short_number == null ? '' : s.short_number),
          });
        }
      }

      // Types non documentes, tentes un par un. Un refus est une reponse : il
      // dit que la piste est fermee, ce qui vaut mieux que de le supposer.
      const probes = {};
      for (const type of PROBE_TYPES) {
        const r = await settle(() => fetchServices(cfg, token, type, { deadline }));
        probes[type] = r.ok
          ? { ok: true, count: r.value.length, sample: r.value.slice(0, 3).map((s) => ({
            resourceType: String((s && s._resource_type) || ''),
            csi: String((s && s.csi) || ''),
            name: String((s && s.name) || ''),
          })) }
          : { ok: false, error: r.message };
      }

      return sendJson(res, 200, {
        inventory: {
          ok: all.ok,
          error: all.ok ? '' : all.message,
          total: all.ok ? all.value.length : 0,
          types: Object.keys(byType).sort().map((t) => ({ type: t, count: byType[t].length })),
          services: byType,
        },
        probes,
        updatedAt: new Date().toISOString(),
      }, 'no-store');
    }

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
      // Equipe partageant la ligne. Une ligne Keyyo est partagee par plusieurs
      // terminaux Keyyo Phone, et aucun releve d'appel ne dit lequel a repondu.
      team: line.team || [],
      shared: !!line.shared,
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
