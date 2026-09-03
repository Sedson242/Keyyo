# Supervision des appels Keyyo

Console web qui lit les relevés d'appels d'un compte Keyyo et répond à quatre
questions : combien d'appels, lesquels ont été manqués, **qui reste à rappeler**,
et comment l'activité se répartit entre les collaborateurs.

Sept vues : Monitoring, Journal des appels, Appels manqués, Correspondants,
Collaborateurs, Lignes Keyyo, Diagnostic.

---

## Ce que fait l'outil

- **Il collecte** les *Call Detail Records* de chaque ligne du parc, par tranches
  mensuelles, dans les deux sens.
- **Il se souvient.** L'API Keyyo n'expose qu'une fenêtre glissante : un appel
  assez ancien cesse d'être renvoyé. Une archive sur Vercel Blob conserve donc
  tout ce qui a été vu passer, et chaque synchronisation ne redemande que les
  derniers jours avant de fusionner.
- **Il nomme.** Les numéros deviennent des noms via l'annuaire du compte, et
  chaque ligne se voit attribuer un collaborateur — voir
  [docs/MAPPING-IDENTITES.md](docs/MAPPING-IDENTITES.md).
- **Il dit ce qu'il ne sait pas.** Chaque rapprochement porte sa source et son
  indice de confiance. Une collecte partielle est signalée par un bandeau, jamais
  masquée. La page Diagnostic expose l'état de l'authentification, de la collecte
  et de l'archive.

La règle métier centrale est le **rappel** : un appel entrant manqué est considéré
comme rappelé s'il existe, strictement après lui, un appel sortant vers le même
correspondant, depuis n'importe quelle ligne du parc. Les manques sont regroupés
par personne, parce que c'est une personne qu'on rappelle, pas un appel.

---

## Pile technique

**Aucune étape de compilation.** Le front est servi tel quel : modules ES natifs,
CSS écrit à la main, graphiques en SVG généré. Pas de bundler, pas de framework,
aucune police ni bibliothèque distante. Le back tient dans des fonctions
serverless Vercel (Node ≥ 18, ESM), avec `@vercel/blob` pour seule dépendance.

Le dossier `shared/` ne contient que des fonctions pures, importées **à
l'identique** par le back et par le front : c'est ce qui garantit qu'une clé
calculée côté serveur correspond à une clé calculée côté navigateur.

`docs/ARCHITECTURE.md` est le **contrat** du projet : il fixe les signatures
exportées par chaque module. Une divergence entre ce document et le code est un
bug à corriger.

```
index.html          coquille : menu, barre de période, sections vides
selftest.html       page de vérification (voir plus bas)
app/                front — main, router, store, api, dom, ui, charts, format, alerts, pages/
api/                fonctions serverless — calls, team, directory, health, sync (+ _config, _keyyo, _archive, _collect)
shared/             noyau pur partagé — phone, time, schema, cdr, identity
assets/css/         tokens, base, components, pages
tests/run.js        harnais exécuté par selftest.html
docs/               ARCHITECTURE.md (contrat), MAPPING-IDENTITES.md
```

---

## Déploiement

Le projet est conçu pour Vercel et n'a rien à construire.

**1. Obtenir les identifiants Keyyo.** Dans la console Keyyo, créer une
application OAuth2 et récupérer l'identifiant client, le secret client et un
refresh token. Le scope `full_access_read_only` suffit : l'outil ne fait que lire.

**2. Créer le projet Vercel** depuis ce dépôt. Aucune commande de build,
aucun répertoire de sortie à déclarer.

**3. Renseigner les variables d'environnement** dans *Settings > Environment
Variables*. Les trois premières sont obligatoires, les autres ont des valeurs par
défaut utilisables :

| Variable | Rôle |
|---|---|
| `KEYYO_CLIENT_ID` | identifiant de l'application OAuth2 |
| `KEYYO_CLIENT_SECRET` | secret client |
| `KEYYO_REFRESH_TOKEN` | refresh token, suivi automatiquement s'il est rotatif |
| `KEYYO_ACCESS_TOKEN` | repli : jeton déjà obtenu, expire en ~1 h, dépannage seulement |
| `KEYYO_TZ` | fuseau d'affichage, `Europe/Paris` par défaut. À préférer à `TZ`, que Vercel définit lui-même |
| `KEYYO_HISTORY_DAYS` | profondeur visée au premier remplissage, 92 jours |
| `KEYYO_SYNC_DAYS` | fenêtre redemandée à chaque synchronisation, 7 jours |
| `KEYYO_RETENTION_DAYS` | purge de l'archive, `0` = jamais |
| `KEYYO_LINE_EMAILS` | forçage manuel ligne → collaborateur |
| `CRON_SECRET` | protège `/api/sync` |
| `BLOB_READ_WRITE_TOKEN` | injecté par Vercel en reliant un store Blob |

`.env.example` documente chacune d'elles en détail, avec ses bornes et son effet.
Il ne contient que des valeurs d'exemple : **n'y écrivez jamais un secret**.

**4. Créer le store Blob.** *Storage > Create Database > Blob*, puis relier le
store au projet. `BLOB_READ_WRITE_TOKEN` est alors injecté automatiquement. Sans
lui, l'application fonctionne mais **sans mémoire**, et le pied de la barre
latérale l'affiche.

**5. Déployer**, puis ouvrir la page **Diagnostic** : elle indique le mode
d'authentification retenu, les lignes détectées, les mois collectés et les lignes
sans identité.

Un cron déclare dans `vercel.json` appelle `/api/sync` chaque jour à 5 h. Vercel
y joint automatiquement l'en-tête `Authorization` attendu quand `CRON_SECRET` est
défini.

---

## Vérification

Il n'y a ni installation de dépendances ni lanceur de tests : la vérification est
une page servie comme le reste du site.

Ouvrir **`/selftest.html`** sur le déploiement. Elle charge `tests/run.js`, qui
contrôle que chaque module se charge et respecte le contrat de
`docs/ARCHITECTURE.md`, puis exécute les fonctions pures : numéros, dates, schéma
d'appel, normalisation des relevés, identités, mise en forme française,
échappement HTML et agrégations du store. Le rapport s'affiche dans la page, et
`window.__selftest` l'expose pour un contrôle automatisé.

Aucune requête n'est émise vers l'API Keyyo : la page peut être ouverte sur la
production sans déclencher de collecte ni consommer de quota.

> Les modules ES exigent une origine HTTP. Ouvrir le fichier par un double-clic
> (`file://`) donne une page vide : c'est une règle du navigateur, pas un défaut
> de la page.

Le rendu des sept vues et la collecte elle-même ne sont pas couverts par ce
harnais — c'est le rôle de la page Diagnostic, en conditions réelles.

---

## Routes

| Route | Réponse |
|---|---|
| `GET /api/calls` | appels normalisés, lignes, métadonnées, couverture, état de l'archive |
| `GET /api/team` | lignes avec leur identité, lignes non résolues, réglage suggéré |
| `GET /api/directory` | annuaire `numéro → nom` |
| `GET /api/health` | état global et liste de contrôles |
| `GET /api/sync` | déclenche une collecte, cible du cron |

Paramètres : `?force=1` contourne le cache CDN, `?full=1` relance un balayage
complet, `?month=AAAA-MM` remplit un mois précis, `?debug=1` détaille
`/api/directory`.

---

## Sécurité

- Les secrets ne vivent que dans les variables d'environnement Vercel. Aucune
  valeur par défaut n'est codée en dur, et `configSummary` ne rapporte que la
  **présence** d'un secret, jamais sa valeur.
- Une politique de sécurité de contenu stricte est posée par `vercel.json` :
  scripts et connexions limités à l'origine du site, aucun script en ligne,
  intégration dans une iframe interdite.
- Tout contenu venant de l'API — noms, numéros, messages d'erreur — traverse le
  gabarit `html` de `app/dom.js`, qui échappe. Le harnais vérifie cet échappement
  brique par brique.
- Le site est marqué `noindex, nofollow`.

> **Avertissement.** Le projet qui précédait celui-ci contenait de vrais secrets
> commités dans git : identifiant client, secret client et refresh token Keyyo,
> ainsi qu'un secret client Azure AD. Un secret présent dans l'historique git
> reste récupérable après suppression du fichier. Ces valeurs doivent être
> considérées comme compromises et régénérées avant toute mise en production.
> Cette version n'utilise plus Microsoft Graph : le secret Azure peut être
> simplement révoqué.

---

## Conventions

Interface et commentaires en français, identifiants de code en anglais. Les
commentaires du code source sont écrits sans accents pour rester lisibles quel
que soit l'encodage de l'éditeur ; les accents sont conservés dans les chaînes
affichées et dans la documentation. Aucune valeur visuelle en dur : tout passe
par une variable de `assets/css/tokens.css`.
