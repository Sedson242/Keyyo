// =============================================================================
//  app/ui.js — Briques de rendu. Chaque fonction renvoie une CHAINE HTML.
//
//  Ce module ne touche jamais au DOM et n'ecoute aucun evenement : il compose
//  du balisage a partir des seules classes declarees dans
//  assets/css/components.css et assets/css/pages.css. Aucune classe inventee
//  ici, aucune valeur visuelle en dur : les couleurs et les espacements
//  viennent des tons (`--in`, `--out`, `--missed`, `--answered`) portes par ces
//  classes.
//
//  DEUX SORTES D'ENTREES, et c'est le point de securite du fichier :
//
//    1. Les emplacements TEXTE (titres, libelles, valeurs, sous-titres) sont
//       interpoles dans le gabarit `html` de dom.js, donc ECHAPPES. Les noms
//       viennent de l'annuaire Keyyo et les messages d'erreur de l'API : ils
//       sont hostiles par defaut.
//    2. Les emplacements COMPOSES (`card.body`, `card.action`, les cellules de
//       `table`, `table.foot`, les enfants de `toolbar`, `notice.body`) recoivent
//       du HTML DEJA SUR, construit par la page avec le gabarit `html` ou
//       marque par `raw()`. Ces valeurs sont inserees telles quelles : une page
//       qui y place une chaine venue de l'API sans l'avoir passee par `html`
//       ouvre une injection. La regle est donc : cote page, TOUT fragment se
//       construit avec html`...`.
//
//  Accessibilite : tout ce qui est cliquable est un <button type="button">,
//  toute icone decorative est masquee aux technologies d'assistance, et les
//  tableaux portent un <thead> dont les <th> ont `scope="col"`.
//
//  Sur le masquage des icones : `icon()` de dom.js pose deja `aria-hidden` et
//  `focusable` sur le <svg> lui-meme. L'enveloppe <span> de `decorIcon` ne sert
//  donc qu'a porter une CLASSE quand la brique en a besoin. Elle est a proscrire
//  dans une boite flexible dont la feuille de style vise le <svg> directement :
//  le <span> devient alors l'element flexible a sa place et se laisse comprimer
//  par le texte voisin. C'est pourquoi `notice` rend `icon()` sans enveloppe.
//
//  Note de balisage : certaines briques cliquables (kpi, rankRow) contiennent
//  des blocs empiles. Les classes CSS correspondantes supposent des elements de
//  type bloc, ce qui impose des <div> dans un <button>. C'est un ecart au
//  modele de contenu de <button>, sans effet sur le rendu ni sur les
//  technologies d'assistance, et c'est le prix a payer pour garder un seul
//  element focalisable par brique.
// =============================================================================

import { html, raw, esc, icon } from './dom.js';
import { fmtInt } from './format.js';
import { initialsOf } from '../shared/identity.js';

// -----------------------------------------------------------------------------
//  Outils internes
// -----------------------------------------------------------------------------

/**
 * Recupere un fragment HTML DEJA SUR : `raw()` est deplie, une chaine est prise
 * telle quelle, un tableau est concatene, et tout ce qui est vide devient ''.
 * @param {unknown} v
 * @returns {string}
 */
function frag(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) out += frag(v[i]);
    return out;
  }
  if (typeof v === 'object') {
    // Objet produit par raw() : { __html }.
    if (typeof (/** @type {any} */ (v).__html) === 'string') return /** @type {any} */ (v).__html;
    return '';
  }
  return String(v);
}

/**
 * Valeur textuelle brute (elle sera echappee par le gabarit `html`).
 * @param {unknown} v
 * @returns {string}
 */
function txt(v) {
  if (v === null || v === undefined || v === false) return '';
  // Un raw() range dans un emplacement texte est une erreur d'appel : on rend
  // son contenu EN TEXTE plutot que de l'effacer, pour que la faute se voie a
  // l'ecran au lieu de disparaitre en silence.
  if (typeof v === 'object' && typeof (/** @type {any} */ (v).__html) === 'string') {
    return /** @type {any} */ (v).__html;
  }
  return String(v);
}

/** @param {unknown} v @returns {boolean} vrai si la valeur a quelque chose a afficher. */
function has(v) {
  if (v === null || v === undefined || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return true;
  return String(v) !== '';
}

/**
 * Modificateur de ton, filtre par liste blanche : le resultat est un nom de
 * classe litteral, jamais une valeur venue de l'appelant.
 * @param {string} prefix   Ex. 'tag' -> 'tag--missed'.
 * @param {unknown} tone
 * @param {string[]} allowed
 * @returns {string}
 */
function toneMod(prefix, tone, allowed) {
  const t = String(tone === null || tone === undefined ? '' : tone);
  return allowed.indexOf(t) >= 0 ? ' ' + prefix + '--' + t : '';
}

/**
 * Pourcentage borne a [0, 100] et arrondi au dixieme.
 * Sert a une largeur en style en ligne : la valeur est donc validee
 * numeriquement avant injection, jamais reprise telle quelle.
 * @param {unknown} v
 * @returns {number}
 */
function pctValue(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n * 10) / 10;
}

/**
 * Entier de disposition borne, pour un style en ligne (largeur minimale de
 * tableau). Renvoie 0 quand la valeur n'est pas exploitable.
 * @param {unknown} v
 * @returns {number}
 */
function pxValue(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(4000, Math.round(n));
}

/**
 * Icone decorative : l'enveloppe porte `aria-hidden`, ce qui masque tout le
 * sous-arbre quel que soit le balisage rendu par `icon()`.
 * @param {string} name  Nom du symbole sans le prefixe (`in` -> `#i-in`).
 * @param {string} [cls] Classe posee sur l'enveloppe.
 * @returns {string}
 */
function decorIcon(name, cls) {
  // Le nom finit dans un attribut `href` : on n'accepte que la forme d'un
  // identifiant de symbole, sans dependre de ce que `icon()` filtre lui-meme.
  const safeName = String(name === null || name === undefined ? '' : name).replace(/[^a-z0-9-]/gi, '');
  const wrap = cls ? ' class="' + esc(cls) + '"' : '';
  return '<span' + wrap + ' aria-hidden="true">' + icon(safeName || 'info') + '</span>';
}

/** Tons acceptes par les differentes briques. */
const KPI_TONES = ['in', 'out', 'missed', 'ok'];
const STAT_TONES = ['out', 'missed', 'ok'];          // le ton entrant est le defaut
const TAG_TONES = ['in', 'out', 'missed', 'ok', 'neutral'];
const AVATAR_TONES = ['out', 'missed', 'dark'];
const METER_TONES = ['out', 'missed', 'ok'];
const SPLIT_TONES = ['out', 'missed', 'ok'];
const NOTICE_TONES = ['ok', 'warn', 'error'];        // 'info' = aspect neutre par defaut
const AVATAR_SIZES = ['sm', 'lg'];                   // 'md' = taille de base

// -----------------------------------------------------------------------------
//  1. Cartes et titres
// -----------------------------------------------------------------------------

/**
 * Carte de contenu.
 *
 * @param {object} opts
 * @param {string} [opts.title]   Texte, echappe.
 * @param {string} [opts.sub]     Texte, echappe.
 * @param {any}    [opts.action]  HTML DEJA SUR (sortie de html`...` ou raw()) :
 *                                pose a droite de l'en-tete. Une chaine y est
 *                                inseree sans echappement — ne jamais y passer
 *                                une valeur venue de l'API telle quelle.
 * @param {any}    [opts.body]    HTML DEJA SUR : le corps de la carte.
 * @param {boolean}[opts.dark]    Variante sombre en accent (card--dark).
 * @param {boolean}[opts.flush]   Supprime le rembourrage (card--flush), pour un
 *                                corps qui apporte le sien : un `table()`.
 *                                Dans ce cas, preferer `sectionHead()` AU-DESSUS
 *                                de la carte plutot qu'un `title` a l'interieur,
 *                                qui se collerait au bord.
 * @param {string} [opts.cls]     Classes supplementaires (ex. 'rate-card').
 * @returns {string}
 */
export function card(opts) {
  const o = opts || {};
  const cls = 'card'
    + (o.dark ? ' card--dark' : '')
    + (o.flush ? ' card--flush' : '')
    + (has(o.cls) ? ' ' + txt(o.cls) : '');

  let head = '';
  if (has(o.title) || has(o.sub) || has(o.action)) {
    const heading = has(o.title) ? html`<h3 class="card-title">${txt(o.title)}</h3>` : '';
    const sub = has(o.sub) ? html`<p class="card-sub">${txt(o.sub)}</p>` : '';
    head = html`<div class="card-head">
      <div class="grow">${raw(heading)}${raw(sub)}</div>
      ${raw(frag(o.action))}
    </div>`;
  }

  return html`<div class="${cls}">${raw(head)}${raw(frag(o.body))}</div>`;
}

/**
 * Titre de section pose a meme le fond de page (hors carte).
 * `title` et `sub` sont du texte echappe ; `action` est du HTML deja sur.
 * @param {string} title
 * @param {string} [sub]
 * @param {any} [action]  HTML DEJA SUR.
 * @returns {string}
 */
export function sectionHead(title, sub, action) {
  const subHtml = has(sub) ? html`<p class="section-sub">${txt(sub)}</p>` : '';
  const actionHtml = frag(action);

  // Le titre et le reste se repartissent sur la meme ligne de base ; quand il y
  // a a la fois un sous-titre et une action, on les regroupe a droite.
  let right = subHtml + actionHtml;
  if (subHtml && actionHtml) right = html`<div class="row">${raw(subHtml)}${raw(actionHtml)}</div>`;

  return html`<div class="section-head">
    <h2 class="section-title">${txt(title)}</h2>
    ${raw(right)}
  </div>`;
}

// -----------------------------------------------------------------------------
//  2. Indicateurs
// -----------------------------------------------------------------------------

/**
 * Indicateur cliquable. Le clic revele `why`, l'explication du calcul : c'est
 * la page qui basculera la classe `is-open` sur le bouton (et `aria-expanded`),
 * cette fonction ne cable rien.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string|number} opts.value
 * @param {string} [opts.foot]  Precision discrete sous la valeur.
 * @param {string} [opts.why]   Comment le chiffre est obtenu. Texte echappe.
 * @param {'in'|'out'|'missed'|'ok'} [opts.tone]
 * @returns {string}
 */
export function kpi(opts) {
  const o = opts || {};
  const cls = 'kpi' + toneMod('kpi', o.tone, KPI_TONES);
  const foot = has(o.foot) ? html`<div class="kpi-foot">${txt(o.foot)}</div>` : '';
  const why = has(o.why) ? html`<div class="kpi-why">${txt(o.why)}</div>` : '';
  // Le bouton n'est depliable que s'il a quelque chose a deplier.
  const expandable = why ? ' aria-expanded="false"' : '';

  return html`<button class="${cls}" type="button"${raw(expandable)}>
    <div class="kpi-top"><span class="kpi-label">${txt(o.label)}</span></div>
    <div class="kpi-value">${txt(o.value)}</div>
    ${raw(foot)}${raw(why)}
  </button>`;
}

/**
 * Bandeau de compteurs (les trois chiffres en tete de la vue Monitoring).
 * @param {Array<{label: string, value: string|number, icon?: string, tone?: 'in'|'out'|'missed'|'ok'}>} items
 * @returns {string}
 */
export function statbar(items) {
  const list = Array.isArray(items) ? items : [];
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    const iconName = has(it.icon) ? txt(it.icon) : 'phone';
    const iconCls = 'stat-icon' + toneMod('stat-icon', it.tone, STAT_TONES);
    out += html`<div class="stat">
      ${raw(decorIcon(iconName, iconCls))}
      <div class="stat-body">
        <div class="stat-label">${txt(it.label)}</div>
        <div class="stat-value">${txt(it.value)}</div>
      </div>
    </div>`;
  }
  return html`<div class="statbar">${raw(out)}</div>`;
}

// -----------------------------------------------------------------------------
//  3. Tableaux
// -----------------------------------------------------------------------------

/**
 * Tableau de donnees, enveloppe dans `table-wrap` (defilement horizontal).
 *
 * IMPORTANT — SECURITE : chaque cellule de `rows` est une chaine HTML DEJA
 * SURE. Elle est inseree sans echappement, exactement comme fournie. Les pages
 * les construisent donc TOUJOURS avec le gabarit html`...` de dom.js, qui
 * echappe les noms d'annuaire, les numeros et les messages d'API.
 *
 * Une ligne cliquable se fait en placant un <button> dans une cellule, pas en
 * rendant le <tr> cliquable : le focus clavier reste ainsi atteignable.
 *
 * @param {object} opts
 * @param {Array<{key?: string, label?: string, align?: string, cls?: string}>} opts.columns
 *        `align: 'right'` (ou 'num') aligne a droite en chiffres tabulaires.
 *        `cls` est ajoute a l'en-tete ET aux cellules de la colonne
 *        (ex. 'shrink', 'strong').
 * @param {Array<Array<any>>} opts.rows  Tableau de lignes, chaque ligne etant un
 *        tableau de cellules HTML deja sures.
 * @param {any} [opts.foot]     HTML DEJA SUR, rendu dans `table-foot`.
 * @param {number} [opts.minWidth]  Largeur minimale en pixels ; validee puis
 *        posee en style en ligne, car c'est la seule facon de deroger au
 *        minimum par defaut de `.table`.
 * @returns {string}
 */
export function table(opts) {
  const o = opts || {};
  const columns = Array.isArray(o.columns) ? o.columns : [];
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const span = columns.length > 0 ? columns.length : 1;

  // Classe de colonne : l'alignement vient d'une liste blanche, `cls` de
  // l'appelant est echappe par le gabarit.
  const colCls = [];
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c] || {};
    const align = String(col.align === null || col.align === undefined ? '' : col.align);
    const parts = [];
    if (align === 'right' || align === 'num') parts.push('num');
    if (has(col.cls)) parts.push(txt(col.cls));
    colCls.push(parts.join(' '));
  }

  let head = '';
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c] || {};
    head += colCls[c]
      ? html`<th scope="col" class="${colCls[c]}">${txt(col.label)}</th>`
      : html`<th scope="col">${txt(col.label)}</th>`;
  }

  let body = '';
  if (!rows.length) {
    body = html`<tr><td colspan="${span}">${raw(empty('Aucune donnée', 'Aucune ligne ne correspond à la période et aux filtres choisis.'))}</td></tr>`;
  } else {
    for (let r = 0; r < rows.length; r++) {
      const cells = Array.isArray(rows[r]) ? rows[r] : [rows[r]];
      const count = Math.max(cells.length, columns.length);
      let tds = '';
      for (let c = 0; c < count; c++) {
        const cls = c < colCls.length ? colCls[c] : '';
        const cell = raw(frag(cells[c]));
        tds += cls ? html`<td class="${cls}">${cell}</td>` : html`<td>${cell}</td>`;
      }
      body += html`<tr>${raw(tds)}</tr>`;
    }
  }

  const min = pxValue(o.minWidth);
  const style = min ? html` style="min-width:${min}px"` : '';
  const foot = has(o.foot) ? html`<div class="table-foot">${raw(frag(o.foot))}</div>` : '';

  return html`<div class="table-wrap">
    <table class="table"${raw(style)}>
      <thead><tr>${raw(head)}</tr></thead>
      <tbody>${raw(body)}</tbody>
    </table>
    ${raw(foot)}
  </div>`;
}

// -----------------------------------------------------------------------------
//  4. Etiquettes, avatars
// -----------------------------------------------------------------------------

/**
 * Etiquette d'etat avec sa pastille.
 * @param {string} label
 * @param {'in'|'out'|'missed'|'ok'|'neutral'} [tone]  Defaut : 'neutral'.
 * @returns {string}
 */
export function tag(label, tone) {
  const mod = toneMod('tag', tone, TAG_TONES) || ' tag--neutral';
  return html`<span class="tag${raw(mod)}"><span class="tag-dot" aria-hidden="true"></span>${txt(label)}</span>`;
}

/**
 * Pastille d'initiales. Les initiales viennent de shared/identity.js afin que
 * front et back derivent le meme libelle a partir du meme nom.
 *
 * L'element est `aria-hidden` : il double toujours un nom deja lisible a cote.
 *
 * @param {string} label
 * @param {object} [opts]
 * @param {'sm'|'md'|'lg'} [opts.size]  Defaut : 'md'.
 * @param {'out'|'missed'|'dark'} [opts.tone]
 * @returns {string}
 */
export function avatar(label, opts) {
  const o = opts || {};
  const size = AVATAR_SIZES.indexOf(String(o.size)) >= 0 ? ' avatar--' + o.size : '';
  const cls = 'avatar' + size + toneMod('avatar', o.tone, AVATAR_TONES);
  return html`<span class="${raw(cls)}" aria-hidden="true">${initialsOf(label)}</span>`;
}

/**
 * Grappe d'avatars qui se chevauchent, avec un compteur au-dela de `max`.
 * L'ensemble est expose comme une image nommee : les pastilles sont muettes,
 * mais la liste des personnes reste lisible pour un lecteur d'ecran.
 * @param {string[]} labels
 * @param {number} [max]  Defaut : 4.
 * @returns {string}
 */
export function avatarStack(labels, max) {
  const list = Array.isArray(labels) ? labels.filter(has) : [];
  if (!list.length) return '<div class="avatar-stack"></div>';

  const limit = isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 4;
  const shown = list.slice(0, limit);
  const rest = list.length - shown.length;

  let out = '';
  for (let i = 0; i < shown.length; i++) out += avatar(shown[i], { size: 'sm' });
  if (rest > 0) out += html`<span class="avatar-more" aria-hidden="true">+${rest}</span>`;

  const names = shown.map(txt).join(', ');
  const label = rest > 0 ? names + ' et ' + rest + ' autre' + (rest > 1 ? 's' : '') : names;

  return html`<div class="avatar-stack" role="img" aria-label="${label}">${raw(out)}</div>`;
}

// -----------------------------------------------------------------------------
//  5. Barres de repartition
// -----------------------------------------------------------------------------

/**
 * Barre fine, destinee a une cellule de tableau.
 * La largeur est un pourcentage borne a [0, 100] : seule valeur intrinsequement
 * dynamique, donc le seul style en ligne.
 * @param {number} pct
 * @param {'out'|'missed'|'ok'} [tone]
 * @returns {string}
 */
export function meter(pct, tone) {
  const p = pctValue(pct);
  const cls = 'meter' + toneMod('meter', tone, METER_TONES);
  return html`<div class="${raw(cls)}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}">
    <span class="meter-fill" style="width:${p}%"></span>
  </div>`;
}

/**
 * Ligne de repartition : libelle et valeur a gauche, barre remplie a droite.
 *
 * `pct` est un pourcentage (0 a 100), borne avant d'etre injecte comme largeur.
 * Le pourcentage affiche est arrondi a l'entier : les repartitions se lisent en
 * points, pas en centiemes.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string|number} opts.value  Valeur brute (ex. « 1 240 appels »).
 * @param {number} opts.pct
 * @param {'out'|'missed'|'ok'} [opts.tone]
 * @returns {string}
 */
export function split(opts) {
  const o = opts || {};
  const p = pctValue(o.pct);
  const cls = 'split' + toneMod('split', o.tone, SPLIT_TONES);
  const value = has(o.value) ? html`<div class="split-value">${txt(o.value)}</div>` : '';

  return html`<div class="${raw(cls)}">
    <div>
      <div class="split-label">${txt(o.label)}</div>
      ${raw(value)}
    </div>
    <div class="split-track">
      <span class="split-fill" style="width:${p}%"></span>
      <span class="split-pct">${fmtInt(Math.round(p))}&nbsp;%</span>
    </div>
  </div>`;
}

// -----------------------------------------------------------------------------
//  6. Liste classee
// -----------------------------------------------------------------------------

/**
 * Ligne d'un classement (« Top Performance » de la maquette).
 * @param {object} opts
 * @param {number|string} [opts.rank]  Rang affiche en pastille sur l'avatar.
 * @param {string} opts.label          Nom de la personne ou du correspondant.
 * @param {string} [opts.sub]
 * @param {string|number} [opts.metric]
 * @param {'out'|'missed'|'dark'} [opts.tone]
 * @returns {string}
 */
export function rankRow(opts) {
  const o = opts || {};
  const badge = has(o.rank) ? html`<span class="rank-badge" aria-hidden="true">${txt(o.rank)}</span>` : '';
  const sub = has(o.sub) ? html`<div class="rank-sub">${txt(o.sub)}</div>` : '';
  const metric = has(o.metric) ? html`<div class="rank-metric">${txt(o.metric)}</div>` : '';

  return html`<button class="rank-row" type="button">
    <span class="rank-avatar">${raw(avatar(o.label, { tone: o.tone }))}${raw(badge)}</span>
    <span class="rank-body">
      <span class="rank-name">${txt(o.label)}</span>
      ${raw(sub)}
    </span>
    ${raw(metric)}
  </button>`;
}

// -----------------------------------------------------------------------------
//  7. Etats : vide, bandeau, chargement
// -----------------------------------------------------------------------------

/**
 * Etat vide. Dit ce qui manque, et si possible quoi faire.
 * @param {string} title
 * @param {string} [sub]
 * @returns {string}
 */
export function empty(title, sub) {
  const subHtml = has(sub) ? html`<p>${txt(sub)}</p>` : '';
  return html`<div class="empty">
    ${raw(decorIcon('empty'))}
    <p class="empty-title">${txt(title)}</p>
    ${raw(subHtml)}
  </div>`;
}

/**
 * Bandeau d'information.
 *
 * `title` est du texte echappe. `body` est du HTML DEJA SUR : il porte souvent
 * un <code> (nom de variable d'environnement a definir). Un message venant de
 * l'API s'y compose donc avec html`${message}`, jamais par concatenation.
 *
 * @param {object} opts
 * @param {'ok'|'warn'|'error'|'info'} [opts.tone]  Defaut : 'info' (neutre).
 * @param {string} [opts.title]
 * @param {any} [opts.body]  HTML DEJA SUR.
 * @returns {string}
 */
export function notice(opts) {
  const o = opts || {};
  const tone = String(o.tone === null || o.tone === undefined ? '' : o.tone);
  const cls = 'notice' + toneMod('notice', tone, NOTICE_TONES);

  // L'icone dit la meme chose que la couleur, pour qui ne distingue pas les tons.
  let name = 'info';
  if (tone === 'ok') name = 'check';
  else if (tone === 'warn' || tone === 'error') name = 'alert';

  // Une erreur interrompt la lecture ; le reste s'annonce sans presser.
  const role = tone === 'error' ? 'alert' : 'status';
  const title = has(o.title) ? html`<span class="notice-title">${txt(o.title)}</span> ` : '';

  // Le <svg> est rendu DIRECTEMENT, sans enveloppe : `.notice` est une boite
  // flexible et sa regle `.notice svg { flex: 0 0 auto; width: 16px }` vise le
  // svg lui-meme. Interpose, un <span> devient l'element flexible a la place du
  // svg, se laisse comprimer par le texte voisin et reduit l'icone a quelques
  // pixels. `icon()` pose deja `aria-hidden` et `focusable` : l'enveloppe
  // n'apportait rien.
  return html`<div class="${raw(cls)}" role="${raw(role)}">
    ${raw(icon(name))}
    <div>${raw(title)}${raw(frag(o.body))}</div>
  </div>`;
}

/**
 * Ossature de chargement, decorative (`aria-hidden`) : c'est la page qui
 * annonce l'attente, pas la forme grise.
 * @param {'text'|'title'|'block'|'card'} [kind]  Defaut : 'block'.
 * @returns {string}
 */
export function skeleton(kind) {
  const k = String(kind === null || kind === undefined ? '' : kind);

  if (k === 'text') return '<div class="skeleton skeleton--text" aria-hidden="true"></div>';
  if (k === 'title') return '<div class="skeleton skeleton--title" aria-hidden="true"></div>';

  // Carte complete : un titre puis un bloc, pour reserver la place du contenu
  // et eviter que la mise en page ne saute a l'arrivee des donnees.
  if (k === 'card') {
    return '<div class="card" aria-hidden="true">'
      + '<div class="stack">'
      + '<div class="skeleton skeleton--title"></div>'
      + '<div class="skeleton skeleton--block"></div>'
      + '</div>'
      + '</div>';
  }

  return '<div class="skeleton skeleton--block" aria-hidden="true"></div>';
}

// -----------------------------------------------------------------------------
//  8. Barre d'outils
// -----------------------------------------------------------------------------

/**
 * Barre d'outils horizontale. `children` est du HTML DEJA SUR (une chaine, ou
 * un tableau de chaines concatenees dans l'ordre). Un `<span class="toolbar-spacer">`
 * pousse ce qui suit vers la droite.
 * @param {any} children  HTML DEJA SUR.
 * @returns {string}
 */
export function toolbar(children) {
  return html`<div class="toolbar">${raw(frag(children))}</div>`;
}
