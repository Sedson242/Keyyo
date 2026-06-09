# Noms des correspondants (Outlook) + Historique 3 mois

## A. Afficher le nom au lieu du numéro

Le dashboard résout désormais les numéros vers des noms à partir d'un fichier
`contacts.json` placé à la racine du projet (servi à `/contacts.json`). Les noms
apparaissent dans **Correspondants** (table, KPI, graphiques) et **Détail des appels**
(le numéro reste en info-bulle), et la recherche du Détail accepte aussi les noms.

### Étapes
1. **Exporter le carnet partagé depuis Outlook**
   - Outlook (bureau) : *Fichier → Ouvrir et exporter → Importer/Exporter →
     Exporter vers un fichier → Valeurs séparées par des virgules → choisir le dossier
     de contacts partagé → enregistrer en `.csv`*.
   - Ou Outlook web (People) : sélectionner le dossier → *Gérer → Exporter les contacts*.
   - Le partage doit être en lecture pour que le dossier apparaisse chez vous.

2. **Convertir le CSV en `contacts.json`**
   ```bash
   node tools/outlook-csv-to-contacts.mjs export_outlook.csv > contacts.json
   ```
   Le script gère les en-têtes FR et EN, détecte toutes les colonnes téléphone
   (hors fax), normalise au format international `+33…` (identique à Keyyo) et écrit
   `{ "+33141276575": "Nom", … }`. Il affiche en clair le nombre de numéros convertis.

3. **Déployer** : committer `contacts.json` à la racine puis `vercel --prod`.
   Pour mettre à jour les noms, ré-exporter, reconvertir, redéployer (aucun code à toucher).

> Format accepté par le dashboard (voir `contacts.example.json`) :
> - objet `{ "+33…": "Nom" }`, **ou**
> - tableau `[{ "name": "Nom", "numbers": ["+33…","06…"] }]`.
> La correspondance se fait sur le numéro normalisé : `01 41 27 65 75`,
> `+33 1 41 27 65 75`, `0033141276575` donnent tous `+33141276575`.

### Variante « live » (plus tard, optionnel)
Synchroniser directement via **Microsoft Graph** (`/me/contacts` ou un dossier partagé)
nécessite une app Azure AD (permission `Contacts.Read`/`Contacts.Read.Shared`) et un
flux OAuth. C'est plus lourd ; l'export CSV suffit pour démarrer et se reconvertit en
une commande.

## B. Récupérer 3 mois d'historique (pas seulement juin)

Pour vous débloquer, les filtres de date ont été désactivés : Keyyo renvoie donc sa
**fenêtre par défaut** (≈ mois courant). Pour élargir à 3 mois, il faut filtrer par date,
mais le format exact attendu par l'API Keyyo pour les `call_detail` doit être confirmé
sur votre compte.

### Étape 1 — identifier le bon filtre (sonde incluse)
Déployez, puis ouvrez **`/api/probe`**. Il teste 9 variantes sur votre vrai compte et
renvoie, pour chacune, `count`, `min`, `max` (plage de dates couverte) et `has_next`.

Repérez la variante dont le `count` est le plus élevé **et** dont `min` se rapproche de
la borne `since` (≈ 3 mois en arrière). Collez-moi le résultat : je verrouille le réglage.

### Étape 2 — appliquer le réglage
Selon la variante gagnante, on règle dans les variables d'environnement Vercel :
- `KEYYO_SEND_DATE_FILTERS=1`
- `KEYYO_HISTORY_DAYS=92` (ou plus)
- `KEYYO_DATE_FILTER_FORMAT=unix` (ou `date`/`datetime` selon la sonde)
- au besoin `KEYYO_FILTER_BEGIN` / `KEYYO_FILTER_END` (clés du filtre)

`api/_keyyo.js` suit déjà la pagination `_links.next` : si la bonne variante pagine,
tout l'historique est récupéré automatiquement.

### Étape 3 — nettoyage
Une fois 3 mois confirmés, **supprimer `api/probe.js` et `api/debug.js`**.
