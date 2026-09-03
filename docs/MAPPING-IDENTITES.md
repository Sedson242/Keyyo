# Rapprochement ligne → collaborateur

Ce document explique comment l'application déduit **qui est derrière chaque ligne
Keyyo**, pourquoi elle y arrive parfois seule et pas toujours, et quoi faire quand
elle échoue.

Le code correspondant est `shared/identity.js#resolveLineIdentities`. Il est **pur** :
il ne fait aucun appel réseau, on lui passe les trois sources déjà collectées.

---

## 1. Le problème

L'API Manager de Keyyo ne fournit **aucune association « ligne → personne »**.
L'objet `UCaaSVoIPAccount`, qui décrit une ligne, ne porte ni email ni nom de
personne : seulement un CSI (`33253359565`), un nom libre saisi par
l'administrateur (`Poste 101`, `Ligne Marie`, `Accueil`) et un numéro court.

Afficher `33253359565` en tête d'une colonne ne renseigne personne. L'application
reconstruit donc l'association en croisant trois sources documentées :

| Source | Appel | Ce qu'elle apporte |
|---|---|---|
| Lignes | `GET /services?type=UCaaSVoIPAccount` | `csi`, `formatted_csi`, `name`, `short_number`, `presented_number` |
| Annuaire | `GET /directory_contacts` | `email`, `first_name`, `name`, et les numéros de la personne |
| Boîtes mail | `GET /services?type=EmailAccount` | `first_name`, `last_name`, `name`, et **le CSI, qui EST l'adresse** |

> Un `EmailAccount` ne porte **aucun champ `email`** : d'après la documentation
> officielle, ses champs sont `csi`, `formatted_csi`, `name`, `offer_id`,
> `offer_name`, `commitment_start_date`, `status`, `blocking_status`, `options`,
> `first_name`, `last_name` et `quota`. Pour ce type de service, le CSI est
> l'adresse elle-même (`pmarley@keyyomail.com`), là où un service de téléphonie
> a un numéro pour CSI. C'est pourquoi `fetchEmailAccounts` retient la première
> valeur qui ressemble à une adresse parmi `email`, `formatted_csi`, `csi` et
> `name`.

## 1 bis. Ce que l'API n'expose pas — et qui explique tout le reste

La console d'administration Keyyo montre un inventaire de **terminaux** : une
ligne par téléphone, avec un identifiant du type `rqepz@kphone`, un modèle
(« Keyyo Phone »), un état de connexion, et surtout un **Nom** qui est celui de
la personne.

**Rien de cet inventaire n'est accessible par l'API Manager 1.0.** Vérifié dans
la documentation officielle :

- il n'existe **aucun type de service** pour un terminal. Les huit types sont
  `UCaaSVoIPAccount`, `NumberTranslation`, `EmailAccount`, `DSLAccess`,
  `FaxTransfer`, `ACDService`, `MobileAccount` et `VirtualFaxAccount` ;
- **aucun endpoint** ne liste les terminaux. `GET /services/:csi/sip_records`,
  le seul qui s'en approche, ne rend qu'une IP privée, une IP publique, un agent
  utilisateur et une adresse MAC — ni identifiant `@kphone`, ni nom ;
- un `UCaaSVoIPAccount` ne porte **ni adresse e-mail, ni lien vers un compte de
  messagerie** ;
- surtout, un `CallDetailRecord` ne nomme **aucun terminal ni aucun
  utilisateur**. Ses champs sont l'identifiant d'appel, l'horodatage, les
  numéros, la quantité, le coût, l'unité, le roaming et le numéro de
  translation.

**Conséquence directe :** un appel ne peut être rattaché qu'au CSI du service
qui l'a porté, et le seul point de contact documenté entre ce service et une
personne est le champ `name` — celui-là même que la console affiche en face du
terminal. C'est pourquoi la règle 2 ci-dessous s'appuie sur lui, et pourquoi le
numéro de la ligne a été rétrogradé.

---

Seul l'annuaire porte à la fois un **email** et des **numéros** ; les comptes de
messagerie, eux, portent l'adresse dans leur CSI et le nom de la personne dans
`first_name` / `last_name`. Ce sont les deux seules sources d'adresse.

---

## 2. Les six règles, par ordre de confiance

Chaque règle qui aboutit produit un **candidat** portant sa `source`, sa `confidence`
et son `evidence` — le fait concret qui l'a déclenchée. Tous les candidats sont
conservés ; celui de plus forte confiance devient `person`. La page Diagnostic
affiche les autres, ce qui permet de vérifier un rapprochement douteux.

| # | `source` | Confiance | Déclencheur |
|---|---|---:|---|
| 1 | `override` | 1.00 | `KEYYO_LINE_EMAILS` associe explicitement ce CSI à une adresse |
| 2 | `email_account_name` | 0.90 × similarité | **Le nom du terminal** correspond à un compte de messagerie |
| 2 bis | `directory_name` | 0.90 × similarité | Le nom du terminal correspond à un contact d'annuaire |
| 3 | `directory_short_number` | 0.85 | Le numéro abrégé d'un contact est le poste de la ligne |
| 4 | `directory_number` | 0.55 | Un contact d'annuaire porte le numéro **de la ligne** |
| 5 | `line_name` | 0.50 | Le nom du terminal **est** une personne, sans adresse rattachée |

**Règle 1 — le réglage manuel est souverain.** Il l'emporte sur toute déduction, y
compris sur un rapprochement par numéro exact. C'est le recours quand
l'automatisme se trompe, pas seulement quand il échoue.

**Règle 2 — le nom du terminal, source principale.** C'est le libellé que la
console d'administration Keyyo affiche dans la colonne **Nom**, en face de chaque
terminal Keyyo Phone : sur un compte réel il porte le nom de la personne
(`Sonia Rakoto`), pas un intitulé de poste. Ce nom est rapproché **d'abord des
comptes de messagerie** — les adresses connectées à l'application — puis, à
défaut seulement, de l'annuaire.

`nameSimilarity` compare les jetons des deux libellés, accents et ponctuation
retirés, particules (`de`, `du`, `van`…) ignorées. Le score doit atteindre
`NAME_MATCH_THRESHOLD` (0,6). Un nom **exact** sort donc à 0,90 et l'emporte sur
toutes les règles fondées sur un numéro ; une ressemblance faible sort près du
seuil et perd, à juste titre, contre une égalité de numéro.

**Règle 3 — le numéro abrégé.** Égalité exacte entre le poste de la ligne et le
numéro abrégé d'un contact d'annuaire, qui lui porte l'adresse.

**Règle 4 — le numéro de la ligne, volontairement rétrogradé.** Ce rapprochement
identifie **une ligne, pas la personne qui s'en sert** : plusieurs terminaux
peuvent partager une ligne, et un numéro direct peut changer de titulaire sans
que l'annuaire suive. Il reste utile en repli quand le terminal ne porte pas de
nom exploitable, mais il ne l'emporte plus sur le nom du terminal. La comparaison
se fait en E.164 via `shared/phone.js#toE164`, donc `02 53 35 95 61`,
`+33253359561` et `0033253359561` trouvent le même contact.

**Règle 5 — le nom seul.** Aucune source ne porte l'adresse, mais le nom du
terminal reste la meilleure désignation disponible, et c'est exactement celle que
l'administration Keyyo affiche. Aucune adresse n'est inventée, et la confiance de
0,50 dit qu'il s'agit d'une lecture, pas d'un rapprochement.

Les règles 2 et 5 partagent le même garde-fou : le nom doit compter de un à trois
jetons significatifs et ne contenir aucun mot de service (`ligne`, `poste`,
`standard`, `accueil`, `fax`, `groupe`, `sda`). Un terminal nommé « Accueil » ne
fabrique donc jamais de collaborateur.

Une ligne qui ne déclenche aucune règle garde `person: null`. Elle reste affichée
et sélectionnable, sous son nom de ligne ou son numéro : **rien n'est deviné en
silence, et rien ne disparaît**.

---

## 3. Ce qui est affiché

`lineLabel(line)` choisit, dans cet ordre : le prénom de la personne, son nom
complet, le nom de la ligne, le numéro formaté, le CSI, puis `—`.

Le **prénom seul** est volontaire : dans une équipe d'une dizaine de personnes il
suffit à identifier, et il tient dans une colonne de tableau là où un nom complet
oblige à tronquer.

---

## 4. Quand une ligne n'est pas résolue

La page **Diagnostic** liste les lignes sans identité et compose la valeur exacte à
coller dans `KEYYO_LINE_EMAILS`, CSI non résolus déjà remplis. Il n'y a rien à
rédiger à la main.

Le réglage se saisit dans *Vercel > Project > Settings > Environment Variables*,
sous l'un ou l'autre de ces deux formats :

```
33253359561=marie.dupont@exemple.fr,33253359562=paul.bernard@exemple.fr
```

```
{"33253359561":"marie.dupont@exemple.fr","33253359562":"paul.bernard@exemple.fr"}
```

La clé est le **CSI réduit à ses chiffres**, tel qu'il apparaît sur la page
Diagnostic. Aucune conversion en E.164 n'est faite ici : coller un numéro national
(`0253359561`) ne correspondrait à aucune ligne. Une adresse invalide est ignorée
sans bruit, ce qui évite qu'une faute de frappe casse tout le réglage.

Un redéploiement est nécessaire pour que Vercel prenne en compte la nouvelle valeur.

---

## 5. Ce que l'application ne fait pas

- **Aucun appel à Microsoft Graph.** Une version antérieure lisait les contacts
  Outlook pour compléter l'annuaire. Ce chemin a été retiré : il exigeait un secret
  client Azure et un consentement d'administrateur pour un gain marginal.
  `/directory_contacts` suffit.
- **Aucune déduction d'accent depuis une adresse email.** `stephane.sedson@…` donne
  `Stephane`, pas `Stéphane` : l'information n'est pas dans l'adresse. Dès que
  l'API fournit un `first_name`, il est préféré à la déduction.
- **Aucun rapprochement sur une initiale.** `p.lecorre@…` donne un nom de famille
  mais pas de prénom : une initiale n'en est pas un.
- **Aucun rapprochement sur une boîte fonctionnelle.** `contact@`, `accueil@`,
  `sav@`, `compta@` et une trentaine d'autres désignent un service, pas une
  personne. La liste est dans `shared/identity.js`.
