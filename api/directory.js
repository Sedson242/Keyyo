// =============================================================================
//  api/directory.js — GET /api/directory : numero -> nom.
//
//  Source UNIQUE : /directory_contacts de l'API Keyyo. Microsoft Graph a ete
//  explicitement ecarte par l'utilisateur ; aucun autre annuaire n'est
//  interroge, et il n'y a donc aucune donnee a envoyer a un tiers.
//
//  Les cles sont normalisees en E.164 par shared/phone.js#toE164 : c'est la
//  meme fonction que celle utilisee pour les numeros des appels, ce qui garantit
//  qu'une cle calculee ici correspond a un `peer` calcule la-bas.
//
//  Parametres : ?debug=1 (detail par source + echantillon)  ?force=1
// =============================================================================

import { readConfig, readParams, flag, sendJson, rejectNonGet, errorMessage } from './_config.js';
import { getAccessToken, fetchDirectoryContacts } from './_keyyo.js';
import { toE164 } from '../shared/phone.js';
import { capitalizeName } from '../shared/identity.js';

/** L'annuaire bouge rarement : une heure de cache CDN suffit largement. */
const CACHE_FRESH = 's-maxage=3600, stale-while-revalidate=7200';

/** Taille de l'echantillon renvoye en mode debug. */
const SAMPLE_SIZE = 12;

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/directory')) return;

  const params = readParams(req);
  const debug = flag(params.debug);
  const force = flag(params.force);

  try {
    const cfg = readConfig();
    const deadline = Date.now() + Math.min(cfg.budgetMs, 20000);
    const token = await getAccessToken(cfg);
    const contacts = await fetchDirectoryContacts(cfg, token, { deadline });

    /** @type {Record<string, string>} */
    const map = {};
    const detail = {
      contacts: contacts.length,
      contactsNamed: 0,
      contactsSkipped: 0,
      numbers: 0,
      speedNumbers: 0,
      rejected: 0,
      collisions: 0,
    };

    /**
     * Premier pose gagne : les numeros principaux d'un contact sont parcourus
     * avant les numeros abreges, et l'ordre des contacts est celui de l'API.
     * @param {unknown} raw
     * @param {string} label
     * @param {'numbers'|'speedNumbers'} bucket
     */
    const add = (raw, label, bucket) => {
      const key = toE164(raw);
      if (!key || key === 'anonymous') { detail.rejected++; return; }
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        if (map[key] !== label) detail.collisions++;
        return;
      }
      map[key] = label;
      detail[bucket]++;
    };

    for (const contact of contacts) {
      const label = displayLabel(contact);
      if (!label) { detail.contactsSkipped++; continue; }
      detail.contactsNamed++;
      for (const n of contact.numbers || []) add(n, label, 'numbers');
      for (const n of contact.speedNumbers || []) add(n, label, 'speedNumbers');
    }

    const count = Object.keys(map).length;
    const cacheControl = (!count || force || debug) ? 'no-store' : CACHE_FRESH;

    /** @type {any} */
    const body = {
      map,
      count,
      sources: { directory_contacts: count },
      updatedAt: new Date().toISOString(),
    };

    if (!count) {
      body.warning = "Annuaire Keyyo vide : aucun contact exploitable dans /directory_contacts. "
        + 'Les correspondants resteront affichés par leur numéro.';
    }

    if (debug) {
      body.debug = {
        detail: { directory_contacts: detail },
        sample: Object.keys(map).slice(0, SAMPLE_SIZE).map((key) => ({ number: key, name: map[key] })),
        note: "Source unique : /directory_contacts. Aucun annuaire externe n'est interrogé.",
      };
    }

    sendJson(res, 200, body, cacheControl);
  } catch (err) {
    const message = errorMessage(err);
    sendJson(res, 500, {
      map: {},
      count: 0,
      sources: {},
      updatedAt: new Date().toISOString(),
      error: 'Annuaire indisponible',
      hint: message + ' Le détail des contrôles est disponible sur /api/health.',
    }, 'no-store');
  }
}

/**
 * Libelle affichable d'un contact. `lastName` vient du champ `name` de
 * DirectoryContact, souvent saisi en capitales : on le recapitalise pour ne pas
 * afficher « SEDSON » au milieu d'une liste.
 * @param {{firstName?: string, lastName?: string, company?: string, email?: string}} contact
 * @returns {string}
 */
function displayLabel(contact) {
  const first = pretty(contact.firstName);
  const last = pretty(contact.lastName);
  const person = [first, last].filter(Boolean).join(' ');
  if (person) return person;

  const company = String(contact.company || '').trim();
  if (company) return company;

  const email = String(contact.email || '').trim();
  if (email) return email.split('@')[0];

  return '';
}

/** @param {unknown} raw @returns {string} */
function pretty(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // Recapitaliser seulement si la saisie est entierement en capitales : sinon on
  // abimerait un nom deja correctement ecrit (« van der Berg »).
  return s === s.toLocaleUpperCase('fr-FR') ? capitalizeName(s) : s;
}
