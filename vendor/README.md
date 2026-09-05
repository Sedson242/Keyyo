# Bibliothèques tierces versionnées

La politique de sécurité de contenu du site (`script-src 'self'`) interdit tout
script chargé depuis un autre domaine. Les bibliothèques ci-dessous sont donc
**copiées dans le dépôt** et servies depuis notre origine, plutôt que chargées
depuis les serveurs de Keyyo.

## `keyyo-cti-1.1.js`

Copie de `https://api.keyyo.com/libs/keyyo-cti/1.1/keyyo-cti.min.js`
(SDK CTI JavaScript de Keyyo, version 1.1), récupérée le 5 septembre 2026.

**Deux modifications**, et seulement deux, appliquées à la fonction interne
`loadJS` :

1. l'URL de SockJS `https://ssl.keyyo.com/sharedassets/js/sockjs-0.3.min.js`
   est remplacée par `/vendor/sockjs-0.3.min.js` (copie locale ci-dessous) ;
2. si `window.SockJS` existe déjà, le chargeur appelle directement le rappel au
   lieu de réinjecter le script — l'original le rechargeait à **chaque**
   commande.

Rien d'autre n'est touché : les points d'entrée (`https://ws.keyyo.com/cti`),
les actions et les événements sont ceux de Keyyo. Pour mettre à jour : reprendre
le fichier officiel, réappliquer ces deux remplacements, mettre à jour cette note.

## `sockjs-0.3.min.js`

SockJS client 0.3.4 (MIT), tel que servi par `ssl.keyyo.com`. Non modifié.

## Ce que la CSP autorise en conséquence

`connect-src 'self' https://ws.keyyo.com wss://ws.keyyo.com` — et rien de plus.
SockJS commence par un appel `/info` puis ouvre un WebSocket ; ses transports de
repli en `iframe` restent interdits par `frame-src 'none'`, ce qui est voulu.
