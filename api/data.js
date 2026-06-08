// Vercel Serverless Function -> /api/data
// Interroge Keyyo a la demande ; cache au niveau du CDN Vercel.
import { fetchAllCalls } from './_keyyo.js';

export default async function handler(req, res) {
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  try {
    const { rows, meta, errors, diag } = await fetchAllCalls();

    if (force || rows.length === 0) {
      // ne pas mettre en cache un resultat vide : on veut re-essayer vite
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    }
    res.status(200).json({
      rows,
      meta,
      diag,
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
