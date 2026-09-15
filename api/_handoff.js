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
//  et lu par GET /api/handoff. Deux transferts simultanes sur la meme ligne
//  sont rares ; le pire cas est un passage oublie, pas une donnee fausse.
// =============================================================================

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
