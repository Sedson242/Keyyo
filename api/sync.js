// Vercel Serverless Function -> /api/sync  (cible du Cron Vercel)
// Meme logique que /api/data (lecture base + derniers appels + fusion +
// persistance) mais reponse minimale. Garantit que la base avance meme
// sans visite du dashboard. Optionnel : proteger avec CRON_SECRET.
import { syncCalls } from './_store.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { meta, errors, store } = await syncCalls({});
    res.status(200).json({ ok: true, at: new Date().toISOString(), store, period: { min: meta.min, max: meta.max, n: meta.n }, warnings: errors });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
}
