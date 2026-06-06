// Diagnostic rapide : /api/health
import { fetchAllCalls } from './_keyyo.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const t0 = Date.now();
    const { rows, meta, errors } = await fetchAllCalls();
    res.status(200).json({
      status: 'ok',
      calls: rows.length,
      sites: meta.sites,
      period: { min: meta.min, max: meta.max },
      elapsedMs: Date.now() - t0,
      warnings: errors,
    });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
}
