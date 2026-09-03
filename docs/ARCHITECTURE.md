# Architecture — Supervision des appels Keyyo

Ce document est le **contrat** du projet : il fixe les signatures exportées par
chaque module. Tout le code s'y conforme ; en cas de divergence entre ce
document et le code, c'est un bug à corriger.

---

## 1. Principes

**Aucune étape de compilation.** Le front est servi tel quel : modules ES natifs
chargés par le navigateur (`<script type="module">`), CSS écrit à la main,
graphiques en SVG généré. Aucun *bundler*, aucun *framework*, aucune police ni
bibliothèque distante. Le back est en fonctions serverless Vercel (Node ≥ 18,
ESM), avec pour seule dépendance `@vercel/blob`.

**Un noyau pur, partagé.** Le dossier `shared/` ne contient que des fonctions
pures : ni `fetch`, ni `process`, ni DOM. Il est importé **à l'identique** par le
back (chemin relatif depuis `api/`) et par le front (module ES). Les deux bouts
normalisent donc les numéros et les dates avec le même code — c'est ce qui
garantit qu'une clé calculée côté serveur correspond à une clé calculée côté
navigateur.

**Rien de deviné en silence.** Chaque rapprochement (numéro → nom,
ligne → personne) porte sa source et son indice de confiance, et la page
Diagnostic les affiche. Une collecte partielle est signalée, jamais masquée.

---

## 2. Flux de données

```
API Keyyo Manager 1.0                        Navigateur
  /services?type=…            ┌────────────┐
  /directory_contacts   ───►  │ api/*.js   │ ───► GET /api/calls     ─┐
  /services/:csi/           │ (Vercel)   │      GET /api/team       ├─► app/store.js
      incoming_call_detail   │            │      GET /api/directory  │      │
      outgoing_call_detail   └─────┬──────┘      GET /api/health    ─┘      ▼
                                   │                              app/pages/*.js
                                   ▼                                   (rendu)
                        Archive Vercel Blob
                         keyyo/history.json
```

- Le back collecte par **tranches mensuelles** (`shared/time.js#monthSlices`)
  pour qu'aucune requête ne dépasse la durée maximale d'une fonction.
- L'archive Blob **conserve** les appels même quand Keyyo ne les renvoie plus
  (l'API a une fenêtre glissante). Les synchronisations suivantes ne redemandent
  que les derniers jours et fusionnent par déduplication.
- Sans jeton Blob, tout fonctionne en **mode direct** (sans mémoire) : le
  bandeau d'avertissement le dit explicitement.

---

## 3. `shared/` — noyau pur (déjà écrit, ne pas modifier sans raison)

### `shared/phone.js`
```js
export const DEFAULT_CC: string                      // '33'
export function toE164(raw, cc?): string             // '' | 'anonymous' | '+33…' | poste court
export function isAnonymous(num): boolean
export function isShortNumber(num): boolean
export function formatNumber(raw): string            // '02 53 35 95 65' | 'Masqué' | '—'
export function numberKind(raw): 'anonymous'|'internal'|'mobile'|'fixe'|'special'|'international'|'inconnu'
export function indexByNumber(pairs, opts?): Record<string, T>
```

### `shared/time.js`
```js
export const DEFAULT_TZ: string                      // 'Europe/Paris'
export function safeTz(tz): string
export function parseTimestamp(raw): Date|null        // unix (s ou ms) ou chaîne
export function isPlausibleDate(d, now?): boolean
export function localParts(date, tz?): { date, hour, minute, second, ym, weekday }
                                                     // weekday : 0 = lundi … 6 = dimanche
export function toKeyyoDate(date, tz?): string        // 'YYYY-MM-DD HH:MM'
export function isoDaysAgo(days, now?, tz?): string
export function todayIso(now?, tz?): string
export function monthSlices(fromIso, toIso): Array<{month, from, to}>   // `to` EXCLUSIF
export function nextDay(iso): string
export function daysBetween(fromIso, toIso): number
```

### `shared/schema.js`
```js
export const SCHEMA_VERSION: number                  // 3
export const FIELDS: string[]
export const F: Record<string, number>               // F.seconds, F.dir, …
export const ROW_LENGTH: number
export function isMissed(row): boolean               // entrant non décroché
export function isIncoming(row): boolean
export function isOutgoing(row): boolean
export function rowKey(row): string                  // clé de déduplication
export function toObject(row): Record<string, any>
export function fromObject(obj): any[]
export function isValidRow(row): boolean
```

Colonnes d'une ligne d'appel (`F`) :

| idx | champ | contenu |
|----:|-------|---------|
| 0 | `id` | `call_id` Keyyo, ou `''` |
| 1 | `ts` | début de l'appel, **timestamp Unix en secondes** |
| 2 | `date` | `YYYY-MM-DD`, heure locale du fuseau d'affichage |
| 3 | `hour` | 0–23 |
| 4 | `minute` | 0–59 |
| 5 | `dir` | `1` = sortant, `0` = entrant |
| 6 | `caller` | appelant, E.164 |
| 7 | `callee` | appelé, E.164 |
| 8 | `peer` | le correspondant (`callee` si sortant, `caller` si entrant) |
| 9 | `seconds` | durée en secondes |
| 10 | `answered` | `1` = décroché, `0` = non décroché |
| 11 | `csi` | CSI de la ligne Keyyo |
| 12 | `unit` | `second` \| `sms` \| `ko` \| `textmms` \| `mms` |
| 13 | `cost` | coût, ou `null` |
| 14 | `destName` | `destination_name` |

### `shared/cdr.js`
```js
export function normalizeCdr(raw, ctx): any[]|null
        // ctx : { direction: 'in'|'out', csi, tz, now?, onDrop?(raw, reason) }
export function extractRecords(payload): any[]        // dépile _embedded.CallDetailRecord
export function nextLink(payload): string|null        // _links.next.href
```

### `shared/identity.js`
```js
export function capitalizeName(s): string
export function normalizeName(s): string             // minuscules, sans accents
export function nameTokens(s): string[]
export function isEmail(s): boolean
export function nameFromEmail(email): { first, last, local }
export function firstNameFromEmail(email): string|null
export function nameSimilarity(a, b): number         // 0..1
export const NAME_MATCH_THRESHOLD: number            // 0.6
export function resolveLineIdentities(input): Array<VoipLine & {person, candidates}>
        // input : { voipLines, directoryContacts?, emailAccounts?, overrides? }
export function lineLabel(line): string
export function initialsOf(label): string
export function parseLineEmails(raw): Record<string, string>
export function isPhoneCsi(csi): boolean       // un CSI a-t-il la forme d'un numéro ?
export function formatCsi(csi): string         // '02 53 35 95 65' | 'rqepz@kphone' | '—'
```

`person` : `{ email, firstName, lastName, displayName, source, confidence, evidence }`
avec `source` ∈ `override` \| `directory_number` \| `directory_short_number` \|
`directory_name` \| `email_account_name` \| `line_name`.

---

## 4. `api/` — fonctions serverless

### `api/_config.js`
```js
export const DEFAULT_BASE: string
export const DEFAULT_TOKEN_URL: string
export const DEFAULT_HISTORY_DAYS: number             // 92
export function readConfig(env?): Config
export function configSummary(cfg): object            // sans aucun secret

// Helpers d'entrée/sortie HTTP, communs aux routes : lire une entrée
// extérieure sans lui faire confiance relève de la même responsabilité.
export function readParams(req): Record<string, string>
export function flag(raw): boolean                    // `?force` sans valeur = actif
export function sendJson(res, status, body, cacheControl?): void
export function rejectNonGet(req, res, route): boolean
export function errorMessage(err): string             // borné à 500 caractères
```
`Config` : `{ base, tokenUrl, clientId, clientSecret, refreshToken, staticToken,
tz, historyDays, syncDays, retentionDays, pageLimit, maxPages, budgetMs,
lineEmails, cronSecret, blobEnabled }`

Variables lues : voir `.env.example`. `readConfig` **jette** une erreur claire si
aucun moyen d'authentification n'est configuré.

Le fuseau vient de `KEYYO_TZ`, et de `TZ` seulement en repli. La plateforme
définit elle-même `TZ` (à `UTC`) dans l'environnement des fonctions : la lire
sans précaution ferait gagner Vercel à tous les coups et le défaut
`Europe/Paris` ne s'appliquerait jamais. Un `TZ` valant `UTC` est donc ignoré ;
pour demander réellement UTC, on renseigne `KEYYO_TZ=UTC`.

### `api/_keyyo.js`
```js
export async function getAccessToken(cfg): Promise<string>     // OAuth2 refresh_token, cache mémoire
export async function keyyoGet(cfg, token, path, params?, opts?): Promise<any>
export async function keyyoGetAll(cfg, token, path, params?, opts?): Promise<any[]>
                                     // suit _links.next puis limit/offset
export async function fetchServices(cfg, token, type?, opts?): Promise<any[]>
export async function fetchVoipLines(cfg, token, opts?): Promise<VoipLine[]>
export async function fetchEmailAccounts(cfg, token, opts?): Promise<EmailAccount[]>
export async function fetchDirectoryContacts(cfg, token, opts?): Promise<DirectoryContact[]>
export async function fetchCallDetail(cfg, token, args): Promise<{rows, diag}>
                                     // args : { csi, direction, from, to, deadline, onDrop? }
```
`opts : { deadline? }` — échéance absolue en millisecondes. **Toute route qui
appelle Keyyo doit la passer** : sans elle, un annuaire volumineux pousse la
fonction au-delà du `maxDuration` de `vercel.json` et la plateforme la coupe
sans rien renvoyer.

### `api/_archive.js`
```js
export const ARCHIVE_PATH: string                     // 'keyyo/history.json'
export function archiveEnabled(): boolean
export async function loadArchive(): Promise<{version, savedAt, rows, coverage}|null>
export async function saveArchive(payload): Promise<boolean>
export function mergeRows(oldRows, freshRows, opts?): { rows, added, updated }
```
`coverage` : `{ [YYYY-MM]: { count, syncedAt } }` — sert à savoir quels mois
sont déjà collectés et à reprendre un remplissage interrompu.

### `api/_collect.js`
```js
export async function collect(opts): Promise<CollectResult>
        // opts : { full?, month?, sinceDays?, budgetMs? }
```
`CollectResult` : `{ rows, lines, meta, coverage, errors, warnings, diag, store }`
- `meta` : `{ n, min, max, days, months[], csis[] }`
- `diag` : `{ perTask[], rawSeen, kept, dropped, dropReasons, strategy, windowDays, elapsedMs }`
- `store` : `{ enabled, firstSync, windowDays, freshFromKeyyo, added, updated, total, persisted, lastSavedAt, missingMonths[] }`

### Points d'entrée HTTP

| Route | Réponse |
|---|---|
| `GET /api/calls` | `{ schemaVersion, fields, rows, lines, meta, coverage, store, diag, updatedAt, empty, warning }` |
| `GET /api/team` | `{ lines, unresolved[], suggestion, sources, updatedAt }` |
| `GET /api/directory` | `{ map: {"+33…": "Nom"}, count, sources, updatedAt }` |
| `GET /api/health` | `{ status: 'ok'\|'empty'\|'error', calls, period, lines, checks[], elapsedMs }` |
| `GET /api/sync` | `{ ok, at, store, period, warnings }` — cible du cron |

Paramètres : `?force=1` (contourne le cache CDN), `?full=1` (rebalayage complet),
`?month=YYYY-MM` (remplissage d'un mois précis), `?debug=1` sur `/api/directory`,
`?deep=1` sur `/api/health` (ajoute une sonde réelle de relevé d'appels, seul
contrôle qui prouve que la chaîne complète fonctionne).

`/api/health` répond **503 en portant quand même ses `checks`** quand un maillon
casse. Un client qui jette le corps d'une réponse d'erreur perd exactement le
diagnostic qu'il était venu chercher.

---

## 5. `app/` — front

### `app/format.js` — mise en forme française
```js
export function fmtInt(n): string                 // 12 480  (espace insécable fine)
export function fmtPct(n, digits?): string        // 63,89 %
export function fmtDuration(seconds): string      // 4 min 12 s
export function fmtDurationShort(seconds): string // 4m12
export function fmtHms(seconds): string           // 12 h 40
export function fmtDate(iso): string              // 03/09/2026
export function fmtDateLong(iso): string          // 3 septembre 2026
export function fmtDayShort(iso): string          // mer. 3 sept.
export function fmtTime(hour, minute): string     // 14:05
export function fmtMonth(ym): string              // sept. 2026
export function fmtClock(isoDateTime): string     // 14:05:31
export function fmtRelative(isoDateTime): string  // il y a 4 min
export const WEEKDAYS: string[]                   // ['Lun',…,'Dim'], index 0 = lundi
export function pluralize(n, one, many): string
```

### `app/dom.js` — assemblage du DOM
```js
export function esc(s): string                    // échappement HTML
export function h(tag, attrs?, children?): HTMLElement
export function html(strings, ...values): string  // gabarit balisé, échappe les valeurs
export function raw(s): {__html: string}          // marque une valeur déjà sûre
export function mount(target, htmlString): HTMLElement
export function qs(sel, root?): HTMLElement|null
export function qsa(sel, root?): HTMLElement[]
export function on(root, event, selector, handler): void   // délégation d'évènements
export function icon(name, cls?): string          // <svg><use href="#i-name"/></svg>
```
`html` échappe **toute** valeur interpolée sauf celles passées par `raw()`.
Tout contenu venant de l'API (noms, numéros, messages d'erreur) passe par là.

### `app/charts.js` — graphiques SVG, sans dépendance
```js
export function barChart(opts): string
   // { data:[{label, value, hint?}], height?, maxTicks?, gradient?, color?, showTrack?, format? }
export function areaChart(opts): string
   // { series:[{name, color, points:[{label, value}]}], height?, showDots? }
export function donutChart(opts): string
   // { slices:[{label, value, color}], size?, thickness?, center? }
export function heatmap(opts): string
   // { matrix:number[7][24], max?, rowLabels? }
export function sparkline(opts): string
   // { values:number[], width?, height?, color? }
export function attachChartTips(root): void        // active les info-bulles
```
Toutes renvoient une **chaîne HTML**. Les couleurs viennent des variables CSS
(`var(--in)`, `var(--out)`…), jamais de valeurs en dur.

### `app/store.js` — état et agrégations
```js
export const state: { page, from, to, preset, csi, dir, search, granularity }
export function setFilter(patch): void            // fusionne puis notifie
export function subscribe(fn): () => void
export function getRows(): any[]                  // toutes les lignes brutes
export function filtered(): any[]                 // lignes après période + ligne + sens
export function getLines(): Line[]                // lignes Keyyo + identités
export function lineByCsi(csi): Line|null
export function nameOf(number): string|null       // annuaire
export function labelOf(number): string           // nom, sinon numéro formaté
export function stats(rows): Stats
export function byDay(rows, range?): Array<{label, value, in, out, missed}>
export function byMonth(rows, range?): Array<{label, value, in, out, missed}>
        // range : { from?, to? } — plage forcée. Sans elle, la série couvre
        // l'étendue réelle des lignes. Les deux séries sont CONTINUES : un jour
        // ou un mois sans appel produit quand même un point à zéro.
export function byHour(rows): number[]            // 24 entrées
export function byWeekday(rows): number[]         // 7 entrées, 0 = lundi
export function heatMatrix(rows): number[][]      // [7][24]
export function byLine(rows): Array<LineStats>
export function byPeer(rows): Array<PeerStats>
export function callbackAnalysis(rows): { pending, done }
export function trend(rows, unit): Array<{label, value}>
export async function load(opts?): Promise<void>  // { force?, full? }
export function status(): { kind, at, warning, empty, store, diag, meta }
```
`Stats` : `{ total, in, out, missed, answered, answerRate, avgDuration,
medianDuration, totalDuration, uniquePeers }`

### `app/ui.js` — briques de rendu (renvoient des chaînes HTML)
```js
export function card(opts): string        // { title?, sub?, action?, body, dark?, flush?, cls? }
export function sectionHead(title, sub?, action?): string
export function kpi(opts): string         // { label, value, foot?, why?, tone? }
export function statbar(items): string    // [{ label, value, icon, tone }]
export function table(opts): string       // { columns:[{key,label,align?,cls?}], rows:[cells[]], foot?, minWidth? }
export function tag(label, tone): string  // tone : in|out|missed|ok|neutral
export function avatar(label, opts?): string
export function avatarStack(labels, max?): string
export function meter(pct, tone?): string
export function split(opts): string       // { label, value, pct, tone }
export function rankRow(opts): string     // { rank, label, sub, metric, tone? }
export function empty(title, sub?): string
export function notice(opts): string      // { tone, title, body }
export function skeleton(kind?): string
export function toolbar(children): string
```

### `app/api.js`
```js
export async function getCalls(opts?): Promise<any>
export async function getTeam(): Promise<any>
export async function getDirectory(): Promise<any>
export async function getHealth(): Promise<any>
export async function postSync(opts?): Promise<any>
export class ApiError extends Error { status; body }
```

### `app/router.js`
```js
export const ROUTES: Array<{id, title, sub, needsPeriod}>
export function start(onChange): void      // lit le fragment d'URL, câble la navigation
export function go(id): void
export function current(): string
```

### `app/alerts.js`
```js
export function init(): void
export function check(rows): void          // détecte les nouveaux manqués
export function toast(opts): void          // { title, sub?, tone? }
export function renderCenter(rows): void   // remplit le popover de la cloche
export function unreadCount(): number
export function markAllRead(): void
```
La détection mémorise les manqués déjà vus dans `localStorage` (clé
`keyyo.seenMissed`) et **n'alerte pas** au premier chargement, pour éviter une
rafale de notifications sur trois mois d'historique.

### `app/pages/*.js`
Chaque module exporte :
```js
export function render(root): void         // écrit dans l'élément de section
```
et lit son état via `app/store.js`. Aucun module de page n'appelle `fetch`
directement.

### `app/main.js`
```js
export function boot(): void               // appelé automatiquement par index.html
```
Amorçage : `alerts.init()` → câblage de la coquille → `router.start()` →
`store.subscribe()` → `store.load()` → sondage toutes les 60 s (suspendu quand
l'onglet est masqué) → rendu.

C'est le seul module qui connaisse à la fois le routeur, le store, les alertes
et les sept pages. Il ne calcule aucune statistique : il tient à jour la
coquille de `index.html` (pastille d'état, bandeau d'avertissement, barre de
période, pastille du menu, pied de la barre latérale, bloc de compte), ouvre la
**fiche correspondant**, et délègue le contenu de chaque vue au module de page.

- **Un seul rendu par changement d'état.** Les notifications du store sont
  regroupées dans une frame d'animation : un clic sur un preset (qui modifie
  `preset` puis `from`/`to`) ne reconstruit la vue qu'une fois.
- **Une seule vue rendue.** Les six autres sections gardent leur DOM précédent,
  invisible. Changer de vue ne recalcule que la vue demandée.
- **La fiche correspondant n'est ouverte que d'ici.** Les pages émettent
  `document.dispatchEvent(new CustomEvent('keyyo:drill', { detail: { number } }))` ;
  aucune ne touche à la modale. La fiche porte l'historique **complet** connu du
  correspondant, pas la période affichée : on l'ouvre pour décider s'il faut
  rappeler, et « on s'est parlé il y a six semaines » est le renseignement utile.
- **`boot()` ne s'exécute que si la coquille est présente** (`#page-monitoring`).
  Hors de `index.html`, importer le module ne déclenche donc ni collecte ni
  erreur : c'est ce qui rend `main.js` vérifiable par la page d'autotest.

---

## 6. Vérification — `selftest.html`

Le projet est en zéro-build : il n'y a ni installation de dépendances ni
lanceur de tests. La vérification tient donc dans une page servie comme le
reste du site.

Ouvrir **`/selftest.html`** sur le déploiement. La page charge `tests/run.js`,
qui :

1. importe chaque module du **noyau partagé (section 3)** et du **front
   (section 5)**, et vérifie qu'il exporte ce que ce document déclare. C'est ce
   contrôle qui attrape une erreur de syntaxe, un import cassé ou un export
   disparu. Les fonctions serverless de la **section 4 en sont exclues** : elles
   s'exécutent dans Node, pas dans le navigateur, et importer `@vercel/blob`
   depuis une page échouerait. C'est `/api/health` qui les vérifie, en
   conditions réelles ;
2. exécute les fonctions pures : numéros, dates, schéma d'appel, normalisation
   des CDR, identités, mise en forme française, échappement HTML, et les
   agrégations de `store.js` — dont `callbackAnalysis`, la règle métier
   centrale ;
3. affiche un rapport, et expose `window.__selftest` (`{total, passed, failed,
   skipped, results}`) pour un contrôle automatisé.

Aucune requête n'est émise vers l'API Keyyo : la page peut être ouverte sur la
production sans déclencher de collecte ni consommer de quota.

> Les modules ES exigent une origine HTTP. Ouvrir le fichier par un double-clic
> (`file://`) donne une page vide : c'est une règle du navigateur, pas un défaut
> de la page. Le rendu des sept vues et la collecte, eux, ne sont pas couverts
> ici — c'est le rôle de la page Diagnostic, en conditions réelles.

---

## 7. Conventions

- **Français** dans l'interface et les commentaires ; **anglais** pour les
  identifiants de code.
- Commentaires sans accents dans le code source (`api/`, `app/`, `shared/`) pour
  rester lisibles quel que soit l'encodage de l'éditeur ; les accents sont
  autorisés dans les chaînes affichées et dans la documentation.
- Pas de `innerHTML` avec une valeur non échappée : toujours `html` de `dom.js`.
- Pas de valeur visuelle en dur : tout passe par une variable de `tokens.css`.
- Aucune boucle de rendu ne recrée le DOM entier plus d'une fois par
  changement d'état.
