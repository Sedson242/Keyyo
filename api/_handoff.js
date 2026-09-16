// =============================================================================
//  api/_handoff.js — Passages d'appel en cours, par ligne.
//
//  Sur une ligne partagee, « transferer a Aicha » fait resonner tout le site :
//  Keyyo ne sait pas viser un poste. Ce que l'application peut faire, c'est
//  DIRE a qui l'appel est destine : quand Emma transfere M. X vers la ligne en
//  visant Aicha, on note ici { correspondant, pour Aicha, par Emma, quand }.
//  Le navigateur d'Aicha, qui voit M. X resonner dans la minute, reconnait le
//  passage : la fenetre d'appel n'apparait que chez elle, avec « de la part
//  d'Emma », et l'appel decroche lui est attribue (shared/journal.js).
//
//  Un petit fichier par ligne (`keyyo/handoff/<csi>.json`), les derniers
//  passages seulement, ecrit par POST /api/events (qui recoit le transfert)
//  et lu par GET /api/events?handoff=<csi>. Deux transferts simultanes sur la
//  meme ligne sont rares ; le pire cas est un passage oublie, pas une donnee
//  fausse.
// =============================================================================

import { createHash } from 'node:crypto';
import { archiveEnabled, readBlobJson, writeBlobJson } from './_archive.js';
import { HANDOFF_WINDOW_SEC } from '../shared/journal.js';

/** Passages conserves par ligne. */
const KEEP = 30;

/** @param {string} csi @returns {string} */
function pathOf(csi) {
  return 'keyyo/handoff/' + String(csi).replace(/\D/g, '') + '.json';
}

/**
 * @typedef {object} Handoff
 * @property {string} peer     correspondant transfere (numero, ou 'anonymous')
 * @property {string} toEmail  personne visee
 * @property {string} toName
 * @property {string} byEmail  personne qui a transfere
 * @property {string} byName
 * @property {number} at       secondes Unix
 */

/**
 * Enregistre un passage d'appel.
 * @param {string} csi
 * @param {Handoff} h
 * @returns {Promise<void>}
 */
export async function recordHandoff(csi, h) {
  if (!archiveEnabled() || !csi) return;
  const path = pathOf(csi);
  let list = [];
  try {
    const cur = await readBlobJson(path);
    if (cur && Array.isArray(cur.handoffs)) list = cur.handoffs;
  } catch (err) { list = []; }
  const now = Math.floor(Date.now() / 1000);
  list = list.filter((x) => x && Number(x.at) > now - 3600);
  list.push(h);
  if (list.length > KEEP) list = list.slice(list.length - KEEP);
  await writeBlobJson(path, { csi: String(csi), savedAt: new Date().toISOString(), handoffs: list });
}

/**
 * Passages encore valables sur une ligne (dans la fenetre).
 * @param {string} csi
 * @returns {Promise<Handoff[]>}
 */
export async function pendingHandoffs(csi) {
  if (!archiveEnabled() || !csi) return [];
  let list = [];
  try {
    const cur = await readBlobJson(pathOf(csi));
    if (cur && Array.isArray(cur.handoffs)) list = cur.handoffs;
  } catch (err) { return []; }
  const now = Math.floor(Date.now() / 1000);
  return list.filter((x) => x && Number(x.at) > now - HANDOFF_WINDOW_SEC - 30);
}

// -----------------------------------------------------------------------------
//  Annonces d'appel : « Emma appelle Aicha »
//
//  Quand Emma compose le numero d'une collegue depuis l'application, ce qui
//  sonne chez Aicha est le numero de la ligne d'Emma — souvent celui du site,
//  partage par vingt personnes : impossible de dire qui appelle. L'annonce le
//  dit : { d'Emma, pour Aicha, depuis ce numero, quand }. Rangee PAR PERSONNE
//  VISEE (`keyyo/handoff/to/<empreinte de l'adresse>.json`) et relue par son
//  navigateur avec les passages d'appel (GET /api/events?handoff=). Fenetre
//  courte : un appel sonne dans les secondes qui suivent.
// -----------------------------------------------------------------------------

/** Fenetre de validite d'une annonce, en secondes. */
export const INTENT_WINDOW_SEC = 90;

/** @param {string} email @returns {string} */
function intentPathOf(email) {
  const h = createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 24);
  return 'keyyo/handoff/to/' + h + '.json';
}

/**
 * @typedef {object} Intent
 * @property {'dial'} kind
 * @property {string} peer     numero qui va sonner chez la personne visee (ligne de l'appelant)
 * @property {string} toEmail  personne visee
 * @property {string} byEmail  qui appelle
 * @property {string} byName
 * @property {number} at       secondes Unix
 */

/**
 * Enregistre une annonce d'appel vers une personne.
 * @param {string} toEmail
 * @param {Intent} intent
 * @returns {Promise<void>}
 */
export async function recordIntent(toEmail, intent) {
  const e = String(toEmail || '').trim().toLowerCase();
  if (!archiveEnabled() || !e) return;
  const path = intentPathOf(e);
  let list = [];
  try {
    const cur = await readBlobJson(path);
    if (cur && Array.isArray(cur.intents)) list = cur.intents;
  } catch (err) { list = []; }
  const now = Math.floor(Date.now() / 1000);
  list = list.filter((x) => x && Number(x.at) > now - 600);
  list.push(intent);
  if (list.length > KEEP) list = list.slice(list.length - KEEP);
  await writeBlobJson(path, { toEmail: e, savedAt: new Date().toISOString(), intents: list });
}

/**
 * Annonces encore valables pour une personne.
 * @param {string} email
 * @returns {Promise<Intent[]>}
 */
export async function pendingIntents(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!archiveEnabled() || !e) return [];
  let list = [];
  try {
    const cur = await readBlobJson(intentPathOf(e));
    if (cur && Array.isArray(cur.intents)) list = cur.intents;
  } catch (err) { return []; }
  const now = Math.floor(Date.now() / 1000);
  return list.filter((x) => x && Number(x.at) > now - INTENT_WINDOW_SEC);
}
