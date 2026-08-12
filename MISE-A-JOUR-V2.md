# Mise à jour v2 — 3 lignes, collaborateurs (email→prénom), base d'archivage, synchro live

## Ce qui change

### 1. Les 3 lignes incluses dans le reporting
`KEYYO_SERVICES=auto` (nouveau défaut) : le backend découvre **toutes** les lignes du
compte via `GET /services` — les 3 lignes remontent sans rien coder. Le mapping
explicite `CSI=Nom,CSI=Nom,CSI=Nom` reste possible.
Vérification : ouvrir **`/api/lines`** → liste des lignes suivies + celles éventuellement
non suivies (`notTracked`).

### 2. Email et prénom rattachés à chaque ligne
Pour chaque CSI, le backend lit `GET /services/:csi` et en extrait l'**email** rattaché,
puis le **prénom** (segment avant le premier point de l'adresse : `pierre.lecorre@…` → `Pierre`).
- Dashboard : nouveau tableau **« Lignes & collaborateurs »** (vue d'ensemble) :
  qui appelle (sortants émis par ligne) et qui décroche (entrants décrochés par ligne),
  manqués, durée cumulée.
- Le prénom s'affiche partout à côté de la ligne (`Tana · Pierre`), y compris dans le
  sélecteur, les tableaux, les notifications et l'**export CSV** (colonne Collaborateur).

### 3. Historique 3 mois
Au **premier chargement** (base vide), la fenêtre demandée à Keyyo est
`KEYYO_HISTORY_DAYS=92` (≈ 3 mois), avec l'auto-découverte du bon filtre de dates déjà
en place. Ensuite l'historique **s'accumule** dans la base : au fil des mois vous
dépasserez les 3 mois sans limite (`KEYYO_RETENTION_DAYS=0` = on garde tout).

### 4. Base d'archivage + mise à jour live
Nouveau module `api/_store.js` (**Vercel Blob**, fichier `keyyo/history.json`) :
- la base conserve les anciens appels même quand Keyyo ne les renvoie plus ;
- chaque synchro ne redemande à Keyyo que les **derniers appels**
  (`KEYYO_SYNC_DAYS=7`), fusionnés par déduplication
  (clé date+heure+min+sec+numéros+sens+ligne ; la durée est mise à jour si un appel
  était encore en cours) ;
- **live** : le dashboard interroge `/api/data` toutes les 60 s (cache CDN 5 min),
  et chaque passage synchronise la base ; un **Cron Vercel** appelle `/api/sync`
  chaque jour à 05:00 en filet de sécurité (les jours sans visite).
  Sur plan Pro, vous pouvez densifier le cron dans `vercel.json`
  (ex. `*/10 * * * *`).
- Statut visible dans le pied de page : `base : N archivés (+x)`.

## Déploiement (3 étapes)

1. **Créer le Blob store** : Vercel → projet → **Storage → Create Database → Blob**
   → le relier au projet. La variable `BLOB_READ_WRITE_TOKEN` est injectée
   automatiquement. (Sans elle, tout fonctionne mais sans mémoire.)
2. **Variables d'environnement** (Project → Settings → Environment Variables) :
   - `KEYYO_SERVICES` = `auto` (ou compléter le mapping avec la 3e ligne)
   - `KEYYO_HISTORY_DAYS` = `92` · `KEYYO_SYNC_DAYS` = `7` · `KEYYO_RETENTION_DAYS` = `0`
   - optionnel : `CRON_SECRET` (protège `/api/sync`)
3. **Déployer** : `vercel --prod` (la dépendance `@vercel/blob` s'installe seule).

## Contrôles après déploiement

| URL | Attendu |
|---|---|
| `/api/lines` | 3 lignes, chacune avec `email` et `firstName` |
| `/api/data?full=1` | 1er remplissage : `store.firstSync=true`, `windowDays=92` |
| `/api/sync` | `{ok:true, store:{newAdded:…, totalArchived:…}}` |
| Dashboard | Tableau « Lignes & collaborateurs » + pied de page `base : N archivés` |

## Points d'attention
- **Charte graphique** appliquée : vert `#00C55A` (entrants/accents) et marine `#14146E`
  (sortants/navigation).
- Le blob est en accès `public` avec URL non devinable (sous-domaine aléatoire du
  store) : acceptable pour ce périmètre, mais ne partagez pas l'URL du blob. Pour un
  stockage strictement privé, basculer sur Upstash Redis/Postgres (évolution possible).
- Bug corrigé au passage dans `api/contacts.js` : le `grant_type` OAuth Microsoft
  contenait une adresse email → remis à `client_credentials` (la synchro des noms
  Outlook fonctionnera désormais).
- `api/probe.js` et `api/debug.js` sont toujours présents : à supprimer une fois la
  prod validée.
