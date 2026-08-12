// =============================================================
//  _store.js  -  Base d'archivage des appels (Vercel Blob).
//
//  Principe :
//   - keyyo/history.json = TOUT l'historique (base). Les appels y sont
//     conserves meme quand Keyyo ne les renvoie plus (fenetre glissante).
//   - A chaque synchro on ne demande a Keyyo que les DERNIERS appels
//     (KEYYO_SYNC_DAYS, defaut 7 j) puis on fusionne dans la base
//     (deduplication par cle date+heure+numeros+sens+ligne).
//   - 1er passage (base vide) : chargement complet KEYYO_HISTORY_DAYS (92 j).
//
//  Prerequis : un Blob store Vercel relie au projet (Storage > Create
//  Database > Blob) -> la variable BLOB_READ_WRITE_TOKEN est injectee.
//  Sans token : le dashboard fonctionne, mais sans memoire (mode direct).
// =============================================================
import { put, list } from '@vercel/blob';
import { fetchAllCalls, buildMeta } from './_keyyo.js';

const HISTORY_PATH = 'keyyo/history.json';

export function storeEnabled() { return !!process.env.BLOB_READ_WRITE_TOKEN; }

// idx : 0=ISO 1=HOUR 2=CALLER 3=CALLED 4=NAT 5=DUR 6=SITE 7=OK 8=CORR 9=WD 10=YM 11=MIN 12=SEC
// La cle exclut la duree : si Keyyo renvoie d'abord un appel en cours puis
// termine, la 2e version (duree max) remplace la 1re au lieu de doublonner.
export function rowKey(r) {
  return [r[0], r[1], r[11] ?? '', r[12] ?? '', r[2], r[3], r[4], r[6]].join('|');
}

export function mergeRows(oldRows, freshRows) {
  const map = new Map();
  for (const r of oldRows || []) map.set(rowKey(r), r);
  let added = 0;
  for (const r of freshRows || []) {
    const k = rowKey(r);
    const prev = map.get(k);
    if (!prev) { map.set(k, r); added++; }
    else if ((r[5] || 0) > (prev[5] || 0) || (prev[7] === 0 && r[7] === 1)) map.set(k, r); // maj duree/abouti
  }
  let rows = [...map.values()];
  // Retention optionnelle (0 = on garde tout, c'est la vocation de la base)
  const keep = parseInt(process.env.KEYYO_RETENTION_DAYS || '0', 10);
  if (keep > 0) {
    const limit = new Date(Date.now() - keep * 864e5).toISOString().slice(0, 10);
    rows = rows.filter(r => r[0] >= limit);
  }
  rows.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : (b[1] - a[1]) || ((b[11] || 0) - (a[11] || 0))));
  return { rows, added };
}

export async function loadHistory() {
  if (!storeEnabled()) return null;
  try {
    const { blobs } = await list({ prefix: HISTORY_PATH, limit: 1 });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return null;
    const j = await res.json();
    return j && Array.isArray(j.rows) ? j : null;
  } catch (e) { return null; }
}

export async function saveHistory(rows) {
  if (!storeEnabled()) return false;
  const body = JSON.stringify({ savedAt: new Date().toISOString(), n: rows.length, rows });
  await put(HISTORY_PATH, body, {
    access: 'public',            // URL non devinable (sous-domaine aleatoire du store)
    contentType: 'application/json',
    addRandomSuffix: false,      // chemin stable -> ecrasement a chaque synchro
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
  return true;
}

// ---- Orchestration commune a /api/data et /api/sync ----
// 1) lit la base  2) demande a Keyyo les derniers appels  3) fusionne  4) persiste.
export async function syncCalls({ full = false } = {}) {
  const syncDays = parseInt(process.env.KEYYO_SYNC_DAYS || '7', 10);
  const fullDays = parseInt(process.env.KEYYO_HISTORY_DAYS || '92', 10);

  const hist = await loadHistory();
  const firstSync = !hist || !hist.rows.length;
  const windowDays = (full || firstSync || !storeEnabled()) ? fullDays : syncDays;

  const { rows: fresh, lines, errors, diag } = await fetchAllCalls({ sinceDays: windowDays });

  let rows = fresh, added = fresh.length, persisted = false;
  if (storeEnabled()) {
    const m = mergeRows(firstSync ? [] : hist.rows, fresh);
    rows = m.rows; added = m.added;
    if (added > 0 || firstSync) { try { await saveHistory(rows); persisted = true; } catch (e) { errors.push('Base : ' + e.message); } }
  }

  return {
    rows,
    lines,
    meta: buildMeta(rows),
    errors,
    diag,
    store: {
      enabled: storeEnabled(),
      firstSync,
      windowDays,
      freshFromKeyyo: fresh.length,
      newAdded: storeEnabled() ? added : null,
      totalArchived: storeEnabled() ? rows.length : null,
      persisted,
      lastSavedAt: persisted ? new Date().toISOString() : (hist ? hist.savedAt : null),
    },
  };
}
