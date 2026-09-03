// =============================================================================
//  app/dom.js — Assemblage du DOM. AUCUNE DEPENDANCE.
//
//  Ce module est la BRIQUE DE SECURITE du front. Tout ce qui finit dans une
//  page vient de l'API Keyyo : noms d'annuaire, libelles de lignes, noms de
//  destination, messages d'erreur renvoyes par une fonction serverless. Aucune
//  de ces chaines n'est de confiance — un contact d'annuaire nomme
//  `<img src=x onerror=...>` est un vecteur d'injection tout a fait realiste.
//
//  D'ou la regle unique : `html` ECHAPPE TOUT ce qu'on interpole, et la SEULE
//  facon d'y injecter du balisage est de le marquer explicitement avec `raw()`.
//  Le defaut est donc sur : oublier un `raw()` produit du texte visible (bug
//  immediatement voyant), jamais un trou de securite silencieux.
//
//  Consequence pratique, a bien avoir en tete : `html` renvoie une CHAINE, pas
//  un objet marque. Une brique qui renvoie du HTML (ui.js, charts.js) doit donc
//  etre reinjectee via `raw()` :
//
//      html`<div class="grid">${raw(card({ body: raw(inner) }))}</div>`
//
//  Autres regles d'interpolation de `html` :
//    - `null`, `undefined`, `true`, `false`  -> chaine vide. C'est ce qui rend
//      le motif `${cond && html`...`}` utilisable sans precaution.
//    - nombres          -> convertis (NaN et Infinity donnent une chaine vide).
//    - tableaux         -> concatenes, recursivement (une liste de lignes de
//      tableau s'ecrit donc `${rows.map(r => raw(renderRow(r)))}`).
//    - noeud DOM        -> ERREUR EXPLICITE : un noeud n'a rien a faire dans un
//      gabarit de chaine, il faut passer par `h()`.
// =============================================================================

// -----------------------------------------------------------------------------
//  Echappement
// -----------------------------------------------------------------------------

/**
 * Echappe une valeur pour insertion dans du HTML — corps de texte comme valeur
 * d'attribut entre guillemets simples ou doubles.
 * @param {unknown} s
 * @returns {string} chaine vide pour `null` / `undefined`.
 */
export function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Marque une chaine comme DEJA SURE, pour qu'elle traverse `html` sans etre
 * echappee. A n'utiliser que sur du balisage produit par notre propre code.
 * @param {unknown} s
 * @returns {{__html: string}}
 */
export function raw(s) {
  return { __html: s == null ? '' : String(s) };
}

/**
 * Reconnait le marqueur produit par `raw()`. On accepte tout objet portant un
 * `__html` de type chaine : c'est la forme documentee au contrat, donc une
 * brique de rendu peut la construire elle-meme. Ces objets ne proviennent
 * jamais de la charge JSON de l'API, qui n'est composee que de chaines, de
 * nombres et de tableaux.
 * @param {unknown} v
 * @returns {boolean}
 */
function isRaw(v) {
  return !!v && typeof v === 'object' && typeof (/** @type {any} */ (v).__html) === 'string';
}

/**
 * Convertit une valeur interpolee en fragment HTML sur, selon les regles
 * enoncees en tete de fichier.
 * @param {unknown} value
 * @returns {string}
 */
function toHtml(value) {
  if (value == null || value === true || value === false) return '';
  if (isRaw(value)) return /** @type {any} */ (value).__html;
  if (Array.isArray(value)) {
    let out = '';
    for (let i = 0; i < value.length; i++) out += toHtml(value[i]);
    return out;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'object' && typeof (/** @type {any} */ (value).nodeType) === 'number') {
    throw new TypeError(
      'dom.html : un noeud DOM ne peut pas etre interpole dans un gabarit de chaine. '
      + 'Utiliser h() pour construire l\'arbre, ou raw(node.outerHTML).',
    );
  }
  return esc(String(value));
}

/**
 * Gabarit balise qui echappe toute valeur interpolee sauf celles marquees par
 * `raw()`. C'est le SEUL point d'entree autorise pour fabriquer du HTML a
 * partir de donnees.
 * @param {ArrayLike<string> & {raw?: ArrayLike<string>}} strings
 * @param {...unknown} values
 * @returns {string}
 */
export function html(strings, ...values) {
  // Appele comme une fonction ordinaire (`html('<b>x</b>')`), le gabarit ne
  // pourrait plus distinguer le balisage fixe des donnees : on refuse net
  // plutot que de laisser passer une chaine non echappee.
  if (!strings || !Array.isArray(strings.raw)) {
    throw new TypeError(
      'dom.html doit etre appele comme gabarit balise : html`<p>${valeur}</p>`. '
      + 'Pour une chaine deja sure, utiliser raw(chaine).',
    );
  }
  let out = strings[0] == null ? '' : String(strings[0]);
  for (let i = 0; i < values.length; i++) {
    out += toHtml(values[i]);
    const tail = strings[i + 1];
    out += tail == null ? '' : String(tail);
  }
  return out;
}

// -----------------------------------------------------------------------------
//  Selection et montage
// -----------------------------------------------------------------------------

/**
 * @param {string} sel
 * @param {Document|Element} [root]
 * @returns {HTMLElement|null}
 */
export function qs(sel, root) {
  return (root || document).querySelector(sel);
}

/**
 * @param {string} sel
 * @param {Document|Element} [root]
 * @returns {HTMLElement[]} tableau reel (donc `map`, `filter`, `slice`).
 */
export function qsa(sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}

/**
 * Remplace le contenu d'un element par du HTML deja assemble.
 * @param {Element|string} target element ou selecteur CSS.
 * @param {string|{__html: string}} htmlString
 * @returns {HTMLElement} l'element monte, pour enchainer un `on(...)`.
 * @throws si la cible n'existe pas — c'est un ecart entre le code et
 *         index.html, qu'il faut voir tout de suite et pas diagnostiquer
 *         devant une page blanche.
 */
export function mount(target, htmlString) {
  const el = typeof target === 'string' ? qs(target) : target;
  if (!el || el.nodeType !== 1) {
    throw new Error(
      'dom.mount : cible introuvable (' + String(target) + '). '
      + 'Verifier que l\'identifiant ou le selecteur existe bien dans index.html.',
    );
  }
  el.innerHTML = isRaw(htmlString)
    ? /** @type {any} */ (htmlString).__html
    : (htmlString == null ? '' : String(htmlString));
  return /** @type {HTMLElement} */ (el);
}

// -----------------------------------------------------------------------------
//  Construction d'elements
// -----------------------------------------------------------------------------

/** @returns {string} `camelCase` -> `camel-case`, pour les cles de `dataset`. */
function kebab(s) {
  return String(s).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

/**
 * Normalise la valeur d'un attribut `class` : chaine, tableau de classes, ou
 * objet `{ 'is-active': vrai }`.
 * @param {unknown} v
 * @returns {string}
 */
function classString(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.filter(Boolean).map(String).join(' ');
  if (typeof v === 'object') {
    return Object.keys(v).filter((k) => /** @type {any} */ (v)[k]).join(' ');
  }
  return String(v);
}

/** Distingue un deuxieme argument « enfants » d'un deuxieme argument « attributs ». */
function isChildLike(v) {
  if (v == null) return false;
  if (typeof v === 'string' || typeof v === 'number' || Array.isArray(v)) return true;
  if (isRaw(v)) return true;
  return typeof v === 'object' && typeof (/** @type {any} */ (v).nodeType) === 'number';
}

/**
 * Applique un jeu d'attributs a un element.
 * Cas particuliers : `class` / `className`, `style` (chaine ou objet),
 * `dataset` (objet, en plus des cles `data-*` directes), et toute cle `on*`
 * dont la valeur est une fonction, posee en ecouteur d'evenement.
 * Une valeur `null`, `undefined` ou `false` retire l'attribut ; `true` le pose
 * sans valeur (`disabled`, `hidden`).
 * @param {HTMLElement} el
 * @param {Record<string, unknown>} attrs
 */
function applyAttrs(el, attrs) {
  const keys = Object.keys(attrs);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const v = attrs[key];
    if (v == null || v === false) continue;

    if (key === 'class' || key === 'className') {
      const cls = classString(v);
      if (cls) el.setAttribute('class', cls);
      continue;
    }
    if (key === 'style') {
      if (typeof v === 'object') {
        const props = Object.keys(v);
        for (let j = 0; j < props.length; j++) {
          const pv = /** @type {any} */ (v)[props[j]];
          if (pv == null || pv === false) continue;
          el.style.setProperty(kebab(props[j]), String(pv));
        }
      } else {
        el.setAttribute('style', String(v));
      }
      continue;
    }
    if (key === 'dataset' && typeof v === 'object') {
      const dk = Object.keys(v);
      for (let j = 0; j < dk.length; j++) {
        const dv = /** @type {any} */ (v)[dk[j]];
        if (dv == null || dv === false) continue;
        el.setAttribute('data-' + kebab(dk[j]), dv === true ? '' : String(dv));
      }
      continue;
    }
    if (typeof v === 'function') {
      if (key.length > 2 && key.slice(0, 2) === 'on') {
        el.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (v));
        continue;
      }
      // Une fonction sur un attribut normal ne peut etre qu'une faute de frappe
      // (`click` au lieu de `onclick`) : la signaler plutot que d'ecrire
      // `function () { ... }` dans le HTML.
      throw new TypeError('dom.h : la valeur de « ' + key + ' » est une fonction. Un gestionnaire doit se nommer on' + key + '.');
    }
    el.setAttribute(key, v === true ? '' : String(v));
  }
}

/**
 * Ajoute des enfants : chaine ou nombre (texte), noeud DOM, tableau (a plat,
 * recursivement), ou marqueur `raw()` (balisage analyse via `<template>`).
 * @param {HTMLElement|DocumentFragment} parent
 * @param {unknown} kids
 */
function appendChildren(parent, kids) {
  if (kids == null || kids === true || kids === false || kids === '') return;
  if (Array.isArray(kids)) {
    for (let i = 0; i < kids.length; i++) appendChildren(parent, kids[i]);
    return;
  }
  if (isRaw(kids)) {
    // `<template>` analyse n'importe quel fragment sans l'executer et sans
    // exiger un parent valide, contrairement a une affectation d'innerHTML.
    const tpl = document.createElement('template');
    tpl.innerHTML = /** @type {any} */ (kids).__html;
    parent.appendChild(tpl.content);
    return;
  }
  if (typeof kids === 'object' && typeof (/** @type {any} */ (kids).nodeType) === 'number') {
    parent.appendChild(/** @type {Node} */ (kids));
    return;
  }
  if (typeof kids === 'number' && !Number.isFinite(kids)) return;
  parent.appendChild(document.createTextNode(String(kids)));
}

/**
 * Cree un element. Le second argument peut etre omis : `h('p', 'texte')` et
 * `h('ul', [li1, li2])` sont acceptes.
 * @param {string} tag
 * @param {Record<string, unknown>|unknown} [attrs]
 * @param {unknown} [children]
 * @returns {HTMLElement}
 */
export function h(tag, attrs, children) {
  const el = document.createElement(String(tag || 'div'));
  let a = attrs;
  let kids = children;
  // Un deuxieme argument qui ressemble a un enfant EST un enfant. Sans ce test,
  // h('div', ['a']) prendrait le tableau pour des attributs et tenterait de
  // poser un attribut nomme « 0 », ce qui leve une erreur DOM obscure.
  if (isChildLike(a)) {
    kids = kids === undefined ? a : [a, kids];
    a = null;
  }
  if (a && typeof a === 'object') applyAttrs(el, /** @type {Record<string, unknown>} */ (a));
  appendChildren(el, kids);
  return el;
}

// -----------------------------------------------------------------------------
//  Evenements
// -----------------------------------------------------------------------------

/**
 * Delegation d'evenements : un seul ecouteur sur `root`, quel que soit le
 * nombre de lignes rendues. C'est ce qui permet de reconstruire une page
 * entiere sans recabler quoi que ce soit.
 *
 *     on('#page-calls', 'click', '.row-menu', (ev, el) => { ... });
 *
 * Le `selector` est facultatif : `on(root, 'change', handler)` pose un
 * ecouteur direct.
 * @param {Element|Document|string} root element, selecteur CSS, ou document.
 * @param {string} event nom de l'evenement (`click`, `input`, `change`...).
 * @param {string|Function} selector selecteur des descendants a ecouter.
 * @param {Function} [handler] recoit `(event, matchedElement)`.
 * @returns {void}
 */
export function on(root, event, selector, handler) {
  const el = typeof root === 'string' ? qs(root) : root;
  if (!el || typeof (/** @type {any} */ (el).addEventListener) !== 'function') {
    throw new Error('dom.on : racine introuvable (' + String(root) + ').');
  }

  // Forme courte sans selecteur.
  if (typeof selector === 'function' && handler === undefined) {
    el.addEventListener(event, /** @type {EventListener} */ (selector));
    return;
  }
  if (typeof handler !== 'function') {
    throw new TypeError('dom.on : gestionnaire manquant pour « ' + event + ' » sur « ' + String(selector) + ' ».');
  }
  const sel = String(selector);

  el.addEventListener(event, function (ev) {
    const target = /** @type {any} */ (ev.target);
    // `ev.target` peut etre un noeud texte ou le document : sans `closest`, il
    // n'y a rien a rapprocher du selecteur.
    if (!target || typeof target.closest !== 'function') return;
    const match = target.closest(sel);
    if (!match) return;
    // `contains` borne la delegation au sous-arbre de la racine : un clic dans
    // un autre panneau remonte jusqu'au document mais ne doit pas declencher
    // ici. (`Node.contains` inclut le noeud lui-meme, la racine passe donc.)
    if (!el.contains(match)) return;
    handler(ev, match);
  });
}

// -----------------------------------------------------------------------------
//  Icones
// -----------------------------------------------------------------------------

/**
 * Noms d'icones disponibles : ce sont EXACTEMENT les `<symbol id="i-...">`
 * declares en tete de index.html. Toute autre valeur ne dessinerait rien.
 * (`i-base`, dans les `<defs>`, est un `<g>` d'attributs communs, pas une
 * icone : il n'apparait donc pas ici.)
 *
 *   Navigation : monitoring, calls, missed, peers, people, lines, diagnostics
 *   Appels     : in, out, phone, clock
 *   Interface  : bell, search, download, refresh, chevron, menu, close, more
 *   Etats      : alert, info, check, mail, empty
 */
const ICON_NAMES = [
  'monitoring', 'calls', 'missed', 'peers', 'people', 'lines', 'diagnostics',
  'in', 'out', 'phone', 'clock',
  'bell', 'search', 'download', 'refresh', 'chevron', 'menu', 'close', 'more',
  'alert', 'info', 'check', 'mail', 'empty',
];
const ICON_SET = new Set(ICON_NAMES);

/** Noms deja signales : un avertissement par nom, pas un par ligne rendue. */
const _iconWarned = new Set();

/**
 * Reference une icone de la bibliotheque de index.html.
 * La taille et la couleur viennent toujours du CSS du conteneur (`.btn svg`,
 * `.nav-item svg`, `.stat-icon svg`...), jamais d'un attribut en dur.
 * @param {string} name un des noms de `ICON_NAMES`.
 * @param {string} [cls] classes CSS a poser sur le `<svg>`.
 * @returns {string} chaine HTML, vide si le nom est absent.
 */
export function icon(name, cls) {
  // On ne garde que les caracteres d'un identifiant de symbole : le nom finit
  // dans un attribut `href`, il ne doit jamais pouvoir en sortir.
  const n = String(name == null ? '' : name).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!n) return '';
  if (!ICON_SET.has(n) && !_iconWarned.has(n)) {
    _iconWarned.add(n);
    console.warn('dom.icon : icone « ' + n + ' » absente de index.html. Noms disponibles : ' + ICON_NAMES.join(', '));
  }
  const attr = cls ? ' class="' + esc(cls) + '"' : '';
  return '<svg' + attr + ' aria-hidden="true" focusable="false"><use href="#i-' + n + '"/></svg>';
}
