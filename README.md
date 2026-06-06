# Reporting Keyyo — Node serverless sur Vercel

Dashboard de reporting téléphonie branché en live sur l'API Keyyo Manager, déployé en
fonctions serverless Node sur Vercel. Pas de daemon : la fonction interroge Keyyo à la
demande et le **CDN Vercel** met la réponse en cache (`s-maxage=300, stale-while-revalidate`),
ce qui assure l'auto-refresh sans processus permanent.

## Structure

```
index.html        -> le dashboard (servi à la racine /)
api/data.js       -> /api/data   (flux JSON consommé par le dashboard)
api/health.js     -> /api/health (diagnostic)
api/_keyyo.js     -> lib : appel Keyyo + normalisation (le préfixe _ exclut le routage)
vercel.json       -> maxDuration des fonctions
.env.example      -> modèle des variables d'environnement
```

## Déploiement en ~30 min

### 1. Récupérer le code et le CLI
```bash
npm i -g vercel        # si pas déjà installé
cd keyyo-vercel
vercel link            # crée/associe le projet Vercel
```

### 2. Déclarer les variables d'environnement
Le plus rapide, en une fois pour les 3 environnements :
```bash
vercel env add KEYYO_TOKEN          # coller : f7ef03477334f6fcda947896
vercel env add KEYYO_CLIENT_ID      # coller : 6a2407d6d65c9
vercel env add KEYYO_API_BASE       # https://api.keyyo.com/manager/1.0
vercel env add KEYYO_AUTH_MODE      # query   (basculer en bearer si besoin)
vercel env add KEYYO_SERVICES       # {"33175433361":"Tana","33253359565":"Antsirabe"}
vercel env add KEYYO_HISTORY_DAYS   # 120
vercel env add TZ                   # Europe/Paris
```
(Ou via l'interface : **Project > Settings > Environment Variables**.)

### 3. Tester la connexion Keyyo AVANT de déployer
```bash
vercel env pull .env.local     # récupère les variables en local
npm run test:keyyo             # interroge réellement Keyyo
```
- **OK** → vous voyez le nombre d'appels, les sites, la période.
- **Erreur d'authentification** → repassez `KEYYO_AUTH_MODE` à `bearer`, re-pull, re-test.
- **Réponse non-JSON / 0 appel** → vérifiez le CSI et, au besoin, ajustez les noms de
  champs dans `api/_keyyo.js` (fonction `normalizeRecord`, listes `pick(...)`).

### 4. Déployer
```bash
vercel --prod
```
Ouvrir l'URL fournie. Le badge « Live · maj HH:MM:SS » confirme le branchement.

## Les 3 seuls réglages qui dépendent de votre compte

1. **`KEYYO_SERVICES`** — la map `{ CSI : Site }`. Le CSI est l'identifiant de *service*
   Keyyo (un par site). Vérifiez les CSI exacts dans votre console.
2. **`KEYYO_AUTH_MODE`** — `query` (token en paramètre d'URL) ou `bearer` (en-tête
   `Authorization`). Démarrer en `query`.
3. **Noms de champs de la réponse** — déjà tolérants (`date`/`datetime`,
   `caller`/`calling_number`, `duration`/`billsec`…). À compléter dans `normalizeRecord`
   si votre flux diffère. `npm run test:keyyo` valide en quelques secondes.

> Honnêteté technique : je n'ai pas pu consulter la doc Keyyo depuis mon environnement.
> Le code couvre les conventions REST usuelles de l'API Manager ; le selftest est là
> précisément pour confirmer/infirmer en une commande.

## Fonctionnement du cache (auto-refresh)

- Poll du dashboard : toutes les 60 s sur l'URL **stable** `/api/data` → servi par le CDN.
- Le CDN régénère la donnée toutes les **5 min** en arrière-plan (`stale-while-revalidate`).
- Bouton ⟳ : appelle `/api/data?force=1` → bypass du cache, pull Keyyo immédiat.
- Keyyo n'est donc interrogé que ~1 fois / 5 min, quel que soit le nombre de visiteurs.

## Robustesse

- Requêtes Keyyo **parallélisées** (tous services × entrants/sortants) → rapide, sous la
  limite `maxDuration`.
- **Retries** + **timeout** par requête dans `_keyyo.js`.
- **Échec partiel toléré** : si un site échoue, les autres s'affichent + avertissement.
- Les erreurs ne sont **jamais** mises en cache (`no-store`).

## Option « vrai temps réel » (plus tard)

Si vous voulez une fraîcheur garantie indépendante des visites : ajouter un **Vercel Cron**
qui appelle `/api/data?force=1` toutes les N minutes (réchauffe le cache), ou stocker le
résultat dans **Vercel KV** depuis un cron. Non nécessaire pour démarrer.

## Limites Vercel à connaître

- `vercel-php` n'a rien à voir ici : **tout est en Node**, runtime natif.
- Plan **Hobby** : durée de fonction limitée (≈10–60 s) ; `maxDuration` est à 30 s.
- Après mise en place, **régénérez le token Keyyo** (il a transité en clair).
