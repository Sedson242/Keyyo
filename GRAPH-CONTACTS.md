# Synchro live des contacts — Microsoft Graph

Le dashboard appelle `/api/contacts` au démarrage. Cette fonction lit le carnet
Outlook via Microsoft Graph et renvoie `{ "+33XXXXXXXXX": "Nom" }` (mise en cache 1 h
côté CDN, donc Graph n'est sollicité qu'une fois par heure). Si Graph n'est pas
configuré ou échoue, le dashboard retombe sur le fichier statique `contacts.json`.

Mode d'authentification : **application (client_credentials)** — aucun utilisateur à
connecter, idéal pour un backend serverless qui lit un carnet partagé.

## 1. Enregistrer l'application Azure AD
Portail Azure → **Microsoft Entra ID → App registrations → New registration**
- Nom : `Reporting Keyyo - Contacts` ; comptes : « single tenant ». Pas d'URI de redirection.
- Noter **Application (client) ID** et **Directory (tenant) ID**.

## 2. Secret client
**Certificates & secrets → New client secret** → copier la **Value** (visible une seule fois)
→ c'est `GRAPH_CLIENT_SECRET`.

## 3. Permission application + consentement admin
**API permissions → Add a permission → Microsoft Graph → Application permissions**
→ ajouter **`Contacts.Read`** → puis **Grant admin consent** (bouton).
> Permission *Application* (pas *Déléguée*). Le consentement admin est obligatoire.

## 4. (Recommandé) Restreindre l'accès au seul mailbox utile
Par défaut une permission application donne accès aux contacts de **tout** le tenant.
Pour limiter au mailbox du carnet partagé, créer une *Application Access Policy*
(PowerShell Exchange Online) :
```powershell
New-ApplicationAccessPolicy -AppId <CLIENT_ID> `
  -PolicyScopeGroupId <groupe-ou-mailbox> -AccessRight RestrictAccess `
  -Description "Reporting Keyyo - contacts uniquement"
```

## 5. Variables d'environnement Vercel
```
GRAPH_TENANT_ID       = <Directory (tenant) ID>
GRAPH_CLIENT_ID       = <Application (client) ID>
GRAPH_CLIENT_SECRET   = <Value du secret>
GRAPH_CONTACTS_USER   = <UPN du mailbox, ex: accueil@bios-expertise.fr>
CONTACTS_DEFAULT_CC   = 33
# Optionnel : cibler un dossier précis
# GRAPH_CONTACTS_FOLDER_ID = <id du contactFolder>
```

### Trouver l'id d'un dossier de contacts (optionnel)
`GET https://graph.microsoft.com/v1.0/users/{UPN}/contactFolders` → relever le `id`
du dossier voulu et le mettre dans `GRAPH_CONTACTS_FOLDER_ID`.

## 6. Déployer et vérifier
`vercel --prod`, puis ouvrir **`/api/contacts`** :
- map `{ "+33…": "Nom", … }` → la synchro marche, les noms apparaîtront dans le dashboard.
- `{ "error": "..." }` → message explicite (config manquante, consentement non accordé,
  mailbox introuvable…). Le plus fréquent : permission non *Application* ou consentement
  admin non accordé (`Authorization_RequestDenied`).

## Champs lus
`displayName` (sinon `givenName + surname`, sinon `companyName`) pour le nom ;
`mobilePhone`, `businessPhones[]`, `homePhones[]` pour les numéros. Tous normalisés en
E.164 (`01 41 27 65 75`, `+33 1 41…`, `0033…` → `+33141276575`, comme Keyyo).
