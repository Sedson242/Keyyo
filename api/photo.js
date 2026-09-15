// =============================================================================
//  api/photo.js — GET /api/photo?u=<adresse>&s=<taille> : la photo Entra d'une
//  personne, servie par nous.
//
//  Pourquoi passer par le serveur : la page ne detient aucun jeton Microsoft,
//  et la politique de securite (CSP `img-src 'self'`) n'autorise que nos
//  propres images. Le serveur lit la photo dans Graph avec le jeton
//  d'APPLICATION (api/_graph.js), la garde dans le store Blob, et la sert avec
//  un cache prive d'un jour. L'absence de photo est memorisee sept jours pour
//  ne pas redemander a Graph a chaque affichage.
//
//  Reponses : 200 image/jpeg · 404 sans corps (pas de photo) · 503 JSON quand
//  Graph refuse ou manque (la raison est aussi dans le Diagnostic). Dans les
//  deux derniers cas, la page retombe sur les initiales.
//
//  Reservee aux personnes connectees. L'adresse figure dans l'URL : ce sont
//  des adresses professionnelles du meme locataire, visibles de tous dans
//  Outlook ; la route n'expose rien d'autre.
// =============================================================================

import { createHash } from 'node:crypto';
import { readParams, rejectNonGet, sendJson, errorMessage } from './_config.js';
import { requireRole, readAuthConfig } from './_auth.js';
import { archiveEnabled, readBlobBytes, writeBlobBytes, readBlobJson, writeBlobJson } from './_archive.js';
import { fetchUserPhoto, PHOTO_SIZES } from './_graph.js';

/** Duree pendant laquelle une absence de photo n'est pas redemandee. */
const NONE_TTL_MS = 7 * 24 * 3600 * 1000;

/** Duree du cache navigateur d'une photo. */
const CACHE_PRIVATE = 'private, max-age=86400';

/** @param {string} email @param {number} size @returns {string} chemin Blob, sans l'adresse en clair. */
function blobPath(email, size) {
  const h = createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 24);
  return 'keyyo/photos/' + h + '/' + size;
}

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/photo')) return;
  if (!await requireRole(req, res, '/api/photo')) return;

  const params = readParams(req);
  const email = String(params.u || '').trim().toLowerCase();
  if (!/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(email) || email.length > 200) {
    return sendJson(res, 400, { error: 'Adresse invalide', hint: 'Attendu : ?u=adresse@organisation.fr' }, 'no-store');
  }
  const wanted = Number(params.s) || 96;
  const size = PHOTO_SIZES.indexOf(wanted) >= 0 ? wanted : 96;
  const path = blobPath(email, size);

  res.setHeader('Vary', 'Cookie');

  // 1. Le store d'abord : une photo deja lue ne repasse pas par Graph.
  if (archiveEnabled()) {
    try {
      const cached = await readBlobBytes(path + '.jpg');
      if (cached) return sendImage(res, cached.bytes, cached.contentType);
      const none = await readBlobJson(path + '.none.json');
      if (none && Date.now() - Date.parse(String(none.at || '')) < NONE_TTL_MS) return sendNone(res);
    } catch (err) {
      // Un store en panne ne prive pas de photo : on passe par Graph.
    }
  }

  // 2. Graph.
  const auth = readAuthConfig();
  let photo;
  try {
    photo = await fetchUserPhoto(auth, email, size);
  } catch (err) {
    return sendJson(res, 503, { error: 'Photo indisponible', hint: errorMessage(err) }, 'no-store');
  }

  if (photo.status === 'none') {
    if (archiveEnabled()) {
      try { await writeBlobJson(path + '.none.json', { at: new Date().toISOString() }); } catch (err) { /* sans memoire, on redemandera */ }
    }
    return sendNone(res);
  }
  if (archiveEnabled()) {
    try { await writeBlobBytes(path + '.jpg', photo.bytes, photo.contentType); } catch (err) { /* servie quand meme */ }
  }
  return sendImage(res, photo.bytes, photo.contentType);
}

/** @param {any} res @param {Buffer} bytes @param {string} contentType */
function sendImage(res, bytes, contentType) {
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType || 'image/jpeg');
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Cache-Control', CACHE_PRIVATE);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(bytes);
}

/** @param {any} res */
function sendNone(res) {
  res.statusCode = 404;
  res.setHeader('Cache-Control', CACHE_PRIVATE);
  res.end();
}
