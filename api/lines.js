// Vercel Serverless Function -> /api/lines
// Inventaire des lignes : CSI, nom, email rattache, prenom deduit.
// Sert a VERIFIER que les 3 lignes sont bien suivies et que le mapping
// email -> prenom est correct (qui appelle / qui decroche).
import { __test as K, discoverServices, getLines } from './_keyyo.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const cfg = K.readConfig();
    const token = await K.getAccessToken(cfg);
    const all = await discoverServices(cfg, token);       // toutes les lignes du compte
    if (!cfg.services) cfg.services = all;                // mode auto
    const lines = await getLines(cfg, token);
    const trackedCsi = new Set(Object.keys(cfg.services).map(String));
    const notTracked = Object.entries(all).filter(([csi]) => !trackedCsi.has(String(csi)))
      .map(([csi, name]) => ({ csi, name }));
    res.status(200).json({
      trackedCount: Object.keys(cfg.services).length,
      lines,                       // { site: { csi, site, email, firstName, serviceName } }
      notTracked,                  // lignes existantes non incluses dans KEYYO_SERVICES
      hint: notTracked.length ? 'Des lignes ne sont pas suivies : passer KEYYO_SERVICES=auto ou les ajouter.' : 'Toutes les lignes du compte sont suivies.',
    });
  } catch (e) { res.status(503).json({ error: e.message }); }
}
