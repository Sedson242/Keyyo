// Vercel Serverless Function -> /api/data
// Lit la base d'archivage (Vercel Blob), synchronise les DERNIERS appels
// depuis Keyyo (fenetre KEYYO_SYNC_DAYS), fusionne, persiste, et renvoie
// TOUT l'historique au dashboard. Cache CDN 5 min (auto-refresh).
// ?force=1 : bypass du cache CDN  |  ?full=1 : re-balayage complet (92 j)
import { syncCalls } from './_store.js';

export default async function handler(req, res) {
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  const full = req.query && (req.query.full === '1' || req.query.full === 'true');
  try {
    const { rows, lines, meta, errors, diag, store } = await syncCalls({ full });

    if (force || full || rows.length === 0) {
      res.setHeader('Cache-Control', 'no-store'); // jamais de cache sur vide/force
    } else {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    }
    res.status(200).json({
      rows,
      lines,
      meta,
      diag,
      store,
      updatedAt: new Date().toISOString(),
      stale: errors.length > 0,
      empty: rows.length === 0,
      warning: errors.length ? errors.join(' | ') : undefined,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ error: e.message });
  }
}
