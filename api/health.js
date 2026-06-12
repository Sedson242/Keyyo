// Diagnostic rapide : /api/health
import { fetchAllCalls } from './_keyyo.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const t0 = Date.now();
    const { rows, meta, errors, diag } = await fetchAllCalls();
    res.status(200).json({
      status: rows.length ? 'ok' : 'empty',
      calls: rows.length,
      rawSeen: diag.rawSeen,
      strategy: diag.strategy,
      dropped: diag.dropped,
      sites: meta.sites,
      period: { min: meta.min, max: meta.max },
      elapsedMs: Date.now() - t0,
      warnings: errors,
      perTask: diag.perTask,
    });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
}
