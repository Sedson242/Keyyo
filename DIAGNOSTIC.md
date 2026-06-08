# Diagnostic & corrections — Reporting Keyyo

## Symptôme
Badge vert « Live · maj HH:MM:SS » mais **tous les indicateurs à 0** (appels, entrants,
sortants, durées). Aucune erreur affichée.

## Lecture du symptôme
Le badge vert prouve que `/api/data` a renvoyé **HTTP 200**. Si la fonction avait échoué
(auth, réseau), le front aurait montré l'overlay « Connexion impossible » (503). Donc :

> l'API a répondu 200 avec `rows: []`. Le dashboard affiche fidèlement 0.

Le problème est **côté collecte/normalisation**, pas côté affichage. Le mapping des
colonnes du front (`C = {ISO:0…YM:10}`) correspond exactement au format émis par le
back (`[iso,hour,caller,called,nat,dur,site,ok,corr,wd,ym]`) — vérifié.

## Cause RACINE confirmée (via /api/debug)
Le `/api/debug` a tranché :
- **CSI corrects** (`33175433361`, `33253359565` = services « BIOS Expertise »). Pas un problème de périmètre.
- **Keyyo renvoie bien des appels** : 40 sortants + 17 entrants (sans filtre), sous
  `_embedded.CallDetailRecord`.
- Donc **mécanisme #1 confirmé** : la normalisation jetait 100 % des lignes car les noms de
  champs réels n'étaient pas reconnus :
  - horodatage = **`start_time`** (Unix en chaîne, ex. `"1780298446"` → 01/06/2026),
  - durée = **`quantity`** (`unit: "second"`), et non `duration`/`billsec`,
  - en entrant `caller` est `null` → numéro réel dans **`actual_caller`** / `caller_presentation`.

Corrigé et **vérifié sur les échantillons réels** : sortant 170 s / abouti, entrant 0 s /
non abouti, correspondant entrant = `+33253359565`.

## Deux mécanismes possibles (au départ, indiscernables)
1. **Keyyo renvoie des enregistrements, mais `normalizeRecord` les jette tous** parce que
   le champ d'horodatage porte un nom non prévu (la liste `pick(...)` ne couvrait pas, p. ex.,
   `start_time`). → **Reproduit hors-ligne** : 2 enregistrements en entrée, 0 ligne en sortie.
2. **Keyyo renvoie réellement 0 enregistrement** : CSI erroné (les valeurs de
   `KEYYO_SERVICES` doivent être les identifiants de service, pas forcément les numéros),
   fenêtre de dates vide, ou clés/format de filtre incorrects.

Les deux donnent le même résultat (200 + 0 ligne) — d'où l'impossibilité de trancher
depuis le navigateur. La correction rend ces deux cas **observables**.

## Corrections apportées
**`api/_keyyo.js`**
- `normalizeRecord` : repli `findAnyTimestamp` — si aucun champ nommé ne donne de date,
  on scanne toutes les valeurs à la recherche d'un horodatage plausible. Fini le rejet
  silencieux de 100 % des lignes. Listes de champs (date/caller/called/durée) élargies.
- `extractRecords` : gère `_embedded` à plat **et** imbriqué, plus d'enveloppes connues,
  et en dernier recours le premier tableau d'objets trouvé.
- **Diagnostic** : compteurs `rawSeen` (bruts vus) vs `kept` (gardés) vs `dropped`
  (écartés), par service/sens, remontés dans la réponse.
- Message d'erreur explicite distinguant « 0 brut » (CSI/filtres) de « brut > 0 mais tout
  écarté » (noms de champs).
- Filtres de date configurables : `KEYYO_DATE_FILTER_FORMAT` = `date|datetime|unix`,
  `KEYYO_SEND_DATE_FILTERS` = `0` pour tester sans filtre.
- Validation optionnelle des CSI (`KEYYO_VALIDATE_CSI=1`) contre `/services`.
- **Secrets retirés du code** : plus de token/secret en dur — tout vient des variables
  d'environnement. (Le token historique a transité en clair : **à révoquer**.)

**`api/data.js` / `api/health.js`**
- Propagent `diag` et un drapeau `empty`. Un résultat vide n'est plus mis en cache.

**`index.html`**
- Plus de badge vert trompeur quand 0 ligne : état **« Live · 0 appel »** orange +
  bannière de diagnostic affichant `rawSeen/kept/dropped` et pointant vers `/api/debug`.

## Étape suivante (à faire sur le déploiement — je ne peux pas joindre Keyyo d'ici)
1. Déployer, puis ouvrir **`/api/debug`**. Regarder :
   - bloc `A_services` → quels sont les **vrais CSI** ? Comparer à `KEYYO_SERVICES`.
   - blocs `C_outgoing_sans_filtre` / `D_incoming_sans_filtre` → `count` et `sample`.
2. Selon le résultat :
   - `count: 0` partout → **CSI ou périmètre** : corriger `KEYYO_SERVICES` avec les CSI
     réels vus dans `A_services`.
   - `count > 0` avec un `sample` → relever le **nom exact du champ date** du `sample` ;
     il est désormais capté automatiquement, mais on peut l'ajouter explicitement dans
     `DATE_FIELDS` pour être sûr.
   - Si `C/D` renvoient des données mais que `/api/health` montre `dropped > 0` →
     mismatch de champ confirmé.
3. Une fois `/api/health` à `status: ok` avec `calls > 0`, **supprimer `api/debug.js`**.
