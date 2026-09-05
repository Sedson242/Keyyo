# Supervision des appels Keyyo

Console web qui lit les relevés d'appels d'un compte Keyyo et répond à quatre
questions : combien d'appels, lesquels ont été manqués, **qui reste à rappeler**,
et comment l'activité se répartit entre les collaborateurs.

Sept vues : Monitoring, Journal des appels, Appels manqués, Correspondants,
Collaborateurs, Lignes Keyyo, Diagnostic.

**L'accès est réservé à la direction.** Chacun se connecte avec son compte
Microsoft de l'organisation (Entra ID) ; les routes de données refusent toute
requête sans session, et l'application est fermée tant que la connexion n'est
pas configurée.

**Chaque agent a sa page** (`agent.html`) : sa ligne Keyyo pilotée depuis le
navigateur — décrocher, appeler, transférer à un collègue ou à un manager —,
la durée de sonnerie de chaque appel, et son activité du mois (appels pris,
émis et vers qui). Ces faits alimentent un **journal d'attribution** : c'est
le seul moyen de savoir *qui* a pris un appel, puisqu'aucune API Keyyo ne le
dit — trois lignes de site sont partagées par 56 terminaux.

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
index.html          supervision (direction) : écran de connexion, menu, barre de période, barre d'appel
agent.html          page agent : ma ligne, mes collègues, mon activité, barre d'appel
selftest.html       page de vérification (voir plus bas)
app/                front — main, agent, session, cti, callbar, journal, router, store, api, dom, ui, charts, format, alerts, pages/
api/                fonctions serverless — auth, me, cti-token, events, calls, team, directory, health, sync, oauth
                    (+ _auth, _journal, _config, _keyyo, _archive, _collect)
shared/             noyau pur partagé — phone, time, schema, cdr, identity, roles, journal
vendor/             bibliothèques tierces versionnées (Keyyo CTI, SockJS) — voir vendor/README.md
assets/css/         tokens, base, components, pages, callbar
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
| `KEYYO_OAUTH_SETUP` | ouvre `/api/oauth` le temps d'obtenir un jeton, `404` sinon |
| `KEYYO_OAUTH_REDIRECT` | URI de redirection fixe, si la déduction ne convient pas |
| `ENTRA_TENANT_ID` | **obligatoire** — locataire Microsoft Entra |
| `ENTRA_CLIENT_ID` | **obligatoire** — inscription d'application Entra (plateforme Web) |
| `ENTRA_CLIENT_SECRET` | **obligatoire** — secret client de cette inscription |
| `SESSION_SECRET` | signe le cookie de session ; dérivé du secret client à défaut |
| `SESSION_TTL_SECONDS` | durée d'une session, 12 h par défaut |
| `AUTH_DIRECTION_EMAILS` | adresses de la direction, si les app roles Entra ne sont pas configurés |
| `AUTH_REDIRECT_URI` | URI de redirection fixe (`https://<domaine>/api/auth`), si la déduction ne convient pas |

`.env.example` documente chacune d'elles en détail, avec ses bornes et son effet.
Il ne contient que des valeurs d'exemple : **n'y écrivez jamais un secret**.

**3 bis. Configurer la connexion Microsoft.** Dans Entra ID, créer une
inscription d'application avec une plateforme **Web** et l'URI de redirection
`https://<votre-domaine>/api/auth`, un secret client, et, de préférence, deux
rôles d'application `Direction` et `Agent` attribués aux personnes. Sans rôle,
toute personne du locataire est « agent » ; la direction se déclare alors par
`AUTH_DIRECTION_EMAILS`. La marche à suivre pas à pas est dans `.env.example`,
section 8. Tant que ces variables manquent, l'application affiche « Application
fermée » et ne sert aucune donnée.

**4. Créer le store Blob.** *Storage > Create Database > Blob*, puis relier le
store au projet. `BLOB_READ_WRITE_TOKEN` est alors injecté automatiquement. Sans
lui, l'application fonctionne mais **sans mémoire**, et le pied de la barre
latérale l'affiche.

**5. Déployer**, puis ouvrir la page **Diagnostic** : elle indique le mode
d'authentification retenu, les lignes détectées, les mois collectés et les lignes
sans identité.

Un cron déclaré dans `vercel.json` appelle `/api/sync` chaque jour à 5 h. Vercel
y joint automatiquement l'en-tête `Authorization` attendu quand `CRON_SECRET` est
défini — **et c'est désormais la seule porte du cron** : sans `CRON_SECRET`, la
synchronisation nocturne reçoit un `401`.

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

| Route | Accès | Réponse |
|---|---|---|
| `GET /api/auth` | public | connexion Microsoft (`?action=login`), session courante (`?action=me`), déconnexion (`?action=logout`) |
| `GET /api/calls` | direction | appels normalisés, lignes, métadonnées, couverture, état de l'archive |
| `GET /api/team` | direction | lignes avec leur identité, lignes non résolues, réglage suggéré |
| `GET /api/directory` | connecté | annuaire `numéro → nom` |
| `GET /api/health` | direction | état global et liste de contrôles |
| `GET /api/sync` | direction ou cron | déclenche une collecte, cible du cron |
| `GET /api/oauth` | direction | mise en service : obtient un refresh token portant les bons scopes |
| `GET /api/me` | connecté | ma ligne, mes collègues et les managers, avec un numéro chacun |
| `POST /api/cti-token` | connecté | jeton CSI (1 h) pour piloter la ligne depuis le navigateur |
| `POST /api/events` | connecté | écrit des faits dans le journal d'attribution, au nom de la session |
| `GET /api/events` | connecté | relit le journal : sa partition, ou tout le mois pour la direction (`scope=all`) |

Toute route de données commence par le garde `requireRole` de `api/_auth.js`,
qui applique la politique de `shared/roles.js` : `503` tant que la connexion
n'est pas configurée, `401` sans session, `403` hors rôle. La politique refuse
par défaut : une route qui n'y figure pas n'est ouverte à personne.

`/api/oauth` répond `404` tant que `KEYYO_OAUTH_SETUP` ne vaut pas `1`. Elle
sert à ajouter le scope `cti_admin`, indispensable au pilotage des appels : un
scope ne s'ajoute pas à un jeton déjà émis, il faut refaire l'autorisation. La
marche à suivre complète est dans `.env.example`, section 7. **Refermez la
route après usage** : elle affiche un refresh token en clair.

Paramètres : `?force=1` contourne le cache CDN, `?full=1` relance un balayage
complet, `?month=AAAA-MM` remplit un mois précis, `?debug=1` détaille
`/api/directory`.

---

## Sécurité

- **Connexion Microsoft Entra jouée côté serveur** (code + PKCE + secret
  client). Le navigateur ne reçoit jamais de jeton Microsoft, seulement un
  cookie de session `HttpOnly; Secure; SameSite=Lax` signé HMAC-SHA256. Le
  jeton d'identité est validé (émetteur, destinataire, locataire, nonce,
  expiration) avant toute ouverture de session.
- Les secrets ne vivent que dans les variables d'environnement Vercel. Aucune
  valeur par défaut n'est codée en dur, et `configSummary` ne rapporte que la
  **présence** d'un secret, jamais sa valeur.
- Une politique de sécurité de contenu stricte est posée par `vercel.json` :
  scripts limités à l'origine du site (la bibliothèque CTI de Keyyo est donc
  **versionnée** dans `vendor/`), connexions limitées à l'origine et à
  `ws.keyyo.com` (le WebSocket de la téléphonie), aucun script en ligne,
  intégration dans une iframe interdite.
- Les écritures (`/api/events`, `/api/cti-token`) exigent un en-tête que seul
  un script de notre origine peut poser, en plus du cookie `SameSite=Lax`.
- Le journal d'attribution est écrit par le serveur seul, dans une partition
  par personne nommée par empreinte, avec l'adresse de la **session** : une
  page ne peut pas écrire au nom d'une autre.
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
