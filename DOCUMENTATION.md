# Keyyo Reporting — Documentation technique & maintenance

Tableau de bord de pilotage de la téléphonie Keyyo : volumes d'appels, analyse des
entrants, correspondants, détail, **alertes d'appels manqués** et résolution des
numéros en noms via **Outlook (Microsoft Graph)** et le **répertoire Keyyo**.

Stack : front statique (HTML/CSS/JS + Chart.js, aucun build) + fonctions serverless
Vercel (Node ≥ 18, ES modules). Aucune base de données : les données sont lues à la
demande depuis l'API Keyyo et mises en cache au niveau du CDN Vercel.

---

## 1. Architecture

```
Navigateur (index.html)
   │  GET /api/data        → appels normalisés (lignes prêtes à afficher)
   │  GET /api/contacts     → map { "+33…": "Nom" }  (Graph ∪ répertoire Keyyo)
   ▼
Fonctions Vercel (/api/*.js)
   ├─ _keyyo.js     cœur : OAuth Keyyo + lecture des call_detail + normalisation
   ├─ data.js       endpoint principal consommé par le dashboard
   ├─ contacts.js   annuaire unifié Microsoft Graph + /directory_contacts Keyyo
   ├─ health.js     diagnostic rapide (statut, comptes, plage de dates)
   ├─ debug.js      dump brut Keyyo (à supprimer en prod)
   └─ probe.js      sonde de découverte du bon filtre de dates (à supprimer en prod)
   ▼
API Keyyo Manager (api.keyyo.com/manager/1.0)  +  Microsoft Graph (graph.microsoft.com)
```

### Format d'une ligne d'appel (`rows`)
Chaque appel est un tableau de 11 champs (indices figés, partagés front/back) :

| idx | nom   | sens | contenu |
|-----|-------|------|---------|
| 0 | ISO   | — | date `YYYY-MM-DD` (fuseau `TZ`) |
| 1 | HOUR  | — | heure 0–23 |
| 2 | CALLER| — | numéro appelant |
| 3 | CALLED| — | numéro appelé |
| 4 | NAT   | — | 1 = sortant, 0 = entrant |
| 5 | DUR   | — | durée en secondes |
| 6 | SITE  | — | nom du site (depuis `KEYYO_SERVICES`) |
| 7 | OK    | — | 1 si durée > 0 (abouti), sinon 0 |
| 8 | CORR  | — | correspondant (appelé si sortant, appelant si entrant) |
| 9 | WD    | — | jour de semaine 0 = lundi … 6 = dimanche |
| 10| YM    | — | mois `YYYY-MM` |

Un **appel manqué** = entrant (NAT = 0) non abouti (OK = 0).

---

## 2. Fichiers

### `index.html` (dashboard)
Application monopage, 6 vues : Vue d'ensemble, Appels entrants (analyse dédiée),
**Appels manqués** (page dédiée : à rappeler vs rappelés, par heure/jour/site,
évolution, top numéros), Appels sortants, Correspondants, Détail. Points clés :

- **Minutes** : chaque ligne porte l'heure exacte (`HOUR` + `MIN`, index 11), affichée
  au format `HH:MM` (tableaux, fiche, notifications).
- **Alertes appels manqués** : une notification + un son se déclenchent à chaque
  nouvel appel entrant manqué ; la notification indique **le numéro appelant, l'heure
  (HH:MM) et le site**.
- **Page Appels manqués** : distingue les manqués déjà **rappelés** (un sortant vers ce
  numéro a suivi) des numéros **à rappeler**, avec KPIs cliquables (explication au clic),
  répartitions par heure / jour / site, évolution, et listes cliquables ouvrant la fiche.

- **État global** `state` : page courante, période (`from`/`to`/`preset`), `site`, `dir`.
- **`filtered()`** applique la période + le site + le sens aux `RAW` (lignes brutes).
- **Résolution des noms** : `normNum()` met tout numéro au format E.164 (`+33…`),
  `nameOf()` / `labelOf()` cherchent dans `CONTACTS`. Le même `normNum` est utilisé
  côté serveur, donc les deux bouts se rejoignent quel que soit le format d'origine
  (`02 53 35 95 65`, `+33 2 53…`, `0033…` → `+33253359565`).
- **Graphiques** : `mk(id,cfg)` (dé)recrée un graphe Chart.js par id (pas de fuite).
- **Alertes manqués** : `detectMissed()` compare les manqués actuels à l'ensemble
  `seenMissed` (persisté en `localStorage`). Les nouveaux déclenchent un toast, un son
  (`chime()`) et incrémentent la cloche. Au tout premier chargement, on « apprend » les
  manqués existants sans alerter (pas de rafale).
- **Fiche correspondant** : `openDrill(numero)` ouvre une modale avec stats + historique.
- **Sélecteur de dates** : présets (7 j / 30 j / 3 mois / Tout) + plage personnalisée
  (deux champs date) + filtre site.

### `api/_keyyo.js`
- `getAccessToken()` : OAuth2 Keyyo via `refresh_token` (renouvellement auto, cache
  mémoire), repli sur `KEYYO_TOKEN` statique.
- `fetchAllCalls()` : lit `incoming_call_detail` + `outgoing_call_detail` pour chaque
  CSI, suit la pagination `_links.next`, normalise chaque enregistrement.
- `normalizeRecord()` : tolérant aux noms de champs Keyyo réels — horodatage `start_time`
  (Unix), durée `quantity`, appelant `actual_caller` quand `caller` est nul ; repli
  `findAnyTimestamp` pour ne jamais jeter une ligne en silence.
- `safeTz()` : nettoie `TZ` (gère le format POSIX `:UTC`).
- Diagnostic : compte « brut vu / gardé / écarté » par service, exposé dans la réponse.

### `api/data.js`
Appelle `fetchAllCalls()` et renvoie `{ rows, meta, diag, warning, empty }`. Ne met
pas en cache un résultat vide ; sinon cache CDN 5 min.

### `api/contacts.js`
Annuaire unifié. Construit une map `{ "+33…": "Nom" }` depuis :
- **Microsoft Graph** : token applicatif (`client_credentials`), lecture récursive du
  dossier de contacts (et de ses sous-dossiers) du mailbox propriétaire.
- **Répertoire Keyyo** : `GET /directory_contacts` (auth Keyyo), extraction tolérante
  des noms et numéros.
Fusion selon `CONTACTS_SOURCE` (`both`/`graph`/`keyyo`) et `CONTACTS_PRIORITY`.
Cache CDN 1 h. Debug : `/api/contacts?debug=1` (compte par source + échantillon).

### `api/health.js`
`/api/health` : statut (`ok`/`empty`/`error`), nombre d'appels, plage de dates,
détail par tâche. À garder pour la supervision.

### `api/debug.js` et `api/probe.js`
Outils de diagnostic **à supprimer en production** (ils exposent des données brutes).
`probe.js` sert uniquement à identifier le bon filtre de dates (section 5).

### `tools/outlook-csv-to-contacts.mjs`
Convertisseur d'export Outlook CSV → `contacts.json` (solution de repli si on n'utilise
pas la synchro Graph live).

---

## 3. Configuration (variables d'environnement Vercel)

Voir `.env.example` pour la liste complète et commentée. Les essentielles :

| Variable | Rôle |
|---|---|
| `KEYYO_CLIENT_ID` / `KEYYO_CLIENT_SECRET` / `KEYYO_REFRESH_TOKEN` | Auth Keyyo |
| `KEYYO_SERVICES` | `CSI=Site` séparés par des virgules |
| `KEYYO_HISTORY_DAYS` | Profondeur d'historique visée (92 ≈ 3 mois) |
| `KEYYO_SEND_DATE_FILTERS` / `KEYYO_DATE_FILTER_FORMAT` | Filtrage serveur (section 5) |
| `TZ` | Fuseau d'affichage (`Europe/Paris`) |
| `CONTACTS_SOURCE` / `CONTACTS_PRIORITY` | Sources d'annuaire et priorité |
| `GRAPH_*` | App Azure AD + mailbox propriétaire des contacts Outlook |

Après toute modification de variable : **redéployer** (`vercel --prod`) pour qu'elle
soit prise en compte.

---

## 4. Mise en route

1. Renseigner les variables d'environnement (au minimum l'auth Keyyo).
2. `vercel --prod`.
3. Vérifier `/api/health` → `status: ok`, `calls > 0`.
4. (Contacts) configurer Graph et/ou laisser le répertoire Keyyo, puis vérifier
   `/api/contacts?debug=1` → `total > 0`.
5. Ouvrir le dashboard. La page « Appels entrants » est l'analyse dédiée (qui appelle,
   quand, par heure/jour, par site, carte d'affluence).

---

## 5. Obtenir 3 mois d'historique (filtre de dates)

Par défaut **`KEYYO_AUTODISCOVER=1`** : au premier appel, `_keyyo.js` essaie
automatiquement plusieurs formats de filtre de dates sur un vrai service et retient
celui qui remonte le plus loin (≈ 3 mois selon `KEYYO_HISTORY_DAYS`). La stratégie
retenue est visible dans `/api/data` → `diag.strategy`. **Aucune régression possible** :
si aucun filtre ne fait mieux, on retombe sur la fenêtre par défaut de Keyyo.

Si l'auto-découverte ne suffit pas, ouvrir **`/api/probe`** (teste ~10 variantes et
affiche `count`/`min`/`max`), repérer la bonne, puis forcer manuellement :

1. Déployer, ouvrir **`/api/probe`** : il teste ~10 variantes de filtre sur un vrai CSI
   et renvoie pour chacune `count`, `min`, `max`.
2. Repérer la variante en `status: 200` avec le `count` le plus élevé et `min` proche de
   la borne `since` (≈ 3 mois en arrière).
3. Régler les variables en conséquence, par ex. si `V2_filters_date_begin_unix` gagne :
   ```
   KEYYO_SEND_DATE_FILTERS=1
   KEYYO_DATE_FILTER_FORMAT=unix
   KEYYO_FILTER_BEGIN=date_begin
   KEYYO_FILTER_END=date_end
   KEYYO_HISTORY_DAYS=92
   ```
4. Redéployer, vérifier `/api/health` (plage `min`→`max` couvrant 3 mois), puis
   **supprimer `api/probe.js` et `api/debug.js`**.

---

## 6. Maintenance courante

- **Ajouter un site/ligne** : ajouter `CSI=Nom` dans `KEYYO_SERVICES`, redéployer.
- **Mettre à jour les noms** : automatique (Graph + Keyyo en cache 1 h). Pour forcer,
  redéployer ou attendre l'expiration du cache.
- **Token Keyyo expiré** : le `refresh_token` se renouvelle seul. S'il est révoqué,
  régénérer et mettre à jour `KEYYO_REFRESH_TOKEN`.
- **Secret Graph expiré** : recréer un secret client dans Azure, mettre à jour
  `GRAPH_CLIENT_SECRET`.
- **Son / alertes** : réglables par l'utilisateur (interrupteurs en bas de la barre
  latérale). Les alertes navigateur demandent l'autorisation au premier usage.

---

## 7. Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| Dashboard « Connexion impossible » | `/api/data` en erreur (auth) | Voir `/api/health`, vérifier l'auth Keyyo |
| Badge « Live · 0 appel » | 0 ligne renvoyée | Élargir la période ; vérifier `/api/debug` |
| `Invalid time zone specified: :UTC` | `TZ` au format POSIX | Déjà géré par `safeTz` ; sinon `TZ=Europe/Paris` |
| Tout à 0 alors que des appels existent | noms de champs Keyyo inattendus | `normalizeRecord` est tolérant ; voir `diag.dropped` dans `/api/data` |
| Noms non résolus | map contacts vide ou format | `/api/contacts?debug=1` ; comparer une clé à un numéro d'appel |
| `/api/contacts` `Authorization_RequestDenied` | permission Graph pas en *Application* / pas de consentement admin | Corriger l'app Azure |
| Historique limité au mois courant | filtre de dates | Section 5 (probe) |

Outils : `/api/health` (supervision), `/api/contacts?debug=1` (annuaire),
`/api/probe` (filtre dates), `/api/debug` (réponse brute Keyyo).

---

## 8. Sécurité

- Ne jamais committer de secret : tout passe par les variables d'environnement Vercel.
- **Supprimer `api/debug.js` et `api/probe.js` en production** (exposent des données).
- Restreindre la permission Graph au seul mailbox utile (Application Access Policy).
- Utiliser un scope Keyyo en lecture seule (`full_access_read_only`) suffit pour le
  reporting.
