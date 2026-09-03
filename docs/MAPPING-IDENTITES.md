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
| Boîtes mail | `GET /services?type=EmailAccount` | `email`, `first_name`, `last_name` |

Seul l'annuaire porte à la fois un **email** et des **numéros** : c'est lui qui fait
le pont, et c'est pourquoi les règles les plus fiables s'appuient dessus.

---

## 2. Les six règles, par ordre de confiance

Chaque règle qui aboutit produit un **candidat** portant sa `source`, sa `confidence`
et son `evidence` — le fait concret qui l'a déclenchée. Tous les candidats sont
conservés ; celui de plus forte confiance devient `person`. La page Diagnostic
affiche les autres, ce qui permet de vérifier un rapprochement douteux.

| # | `source` | Confiance | Déclencheur |
|---|---|---:|---|
| 1 | `override` | 1.00 | `KEYYO_LINE_EMAILS` associe explicitement ce CSI à une adresse |
| 2 | `directory_number` | 0.95 | Un contact d'annuaire porte le numéro de la ligne |
| 3 | `directory_short_number` | 0.85 | Le numéro abrégé d'un contact est le poste de la ligne |
| 4 | `directory_name` | 0.70 × similarité | Le nom de la ligne ressemble au nom d'un contact |
| 5 | `email_account_name` | 0.70 × similarité | Le nom de la ligne ressemble au nom d'une boîte mail |
| 6 | `line_name` | 0.35 | Le nom de la ligne **est** un prénom, sans email rattaché |

**Règle 1 — le réglage manuel est souverain.** Il l'emporte sur toute déduction, y
compris sur un rapprochement par numéro exact. C'est le recours quand
l'automatisme se trompe, pas seulement quand il échoue.

**Règles 2 et 3 — l'identité par le numéro.** Ce sont les seules qui reposent sur une
égalité, pas sur une ressemblance. La comparaison se fait en E.164 via
`shared/phone.js#toE164`, donc `02 53 35 95 61`, `+33253359561` et `0033253359561`
trouvent le même contact. La règle 2 essaie le CSI, le CSI formaté puis le numéro
présenté, et s'arrête au premier contact trouvé.

**Règles 4 et 5 — l'identité par le nom.** `nameSimilarity` compare les jetons des
deux libellés, accents et ponctuation retirés, particules (`de`, `du`, `van`…)
ignorées. Le score doit atteindre `NAME_MATCH_THRESHOLD` (0,6) pour être retenu, et
la confiance finale reste plafonnée à 0,7 : une ressemblance de nom n'est jamais
une preuve. Le meilleur score gagne, l'annuaire passant avant les boîtes mail.

**Règle 6 — le dernier recours.** Si rien n'a fonctionné et que le nom de la ligne
ressemble à un prénom (un à trois jetons, sans `ligne`, `poste`, `standard`,
`accueil`, `fax`, `groupe` ni `sda`), il est lu comme tel. Aucun email n'est
associé, et la confiance de 0,35 dit clairement qu'il s'agit d'une lecture, pas
d'un rapprochement.

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
