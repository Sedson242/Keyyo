// Vercel Serverless Function -> exposee sur /api/data
// Interroge Keyyo a la demande, met en cache au niveau du CDN Vercel
// (s-maxage + stale-while-revalidate) : pas de daemon, l'auto-refresh
// est assure par la revalidation en arriere-plan du CDN.
import { fetchAllCalls } from './_keyyo.js';

export default async function handler(req, res) {
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  try {
    const { rows, meta, errors } = await fetchAllCalls();

    if (force) {
      res.setHeader('Cache-Control', 'no-store');        // bouton "Actualiser" -> Keyyo frais
    } else {
      // Le CDN sert la donnee en cache et la regenere toutes les 5 min.
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    }
    res.status(200).json({
      rows,
      meta,
      updatedAt: new Date().toISOString(),
      stale: errors.length > 0,
      warning: errors.length ? errors.join(' | ') : undefined,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');           // ne jamais mettre une erreur en cache
    res.status(503).json({ error: e.message });
  }
}
