// =============================================================================
//  app/router.js — Navigation entre les sept vues. AUCUN ETAT METIER.
//
//  Le routeur ne connait ni les appels ni les filtres : il traduit un fragment
//  d'URL en identifiant de vue, met la coquille de index.html en accord avec ce
//  choix (menu, titres, sections, barre de periode), puis previent app/main.js.
//  C'est main.js qui decide quoi rendre.
//
//  Pourquoi le fragment plutot qu'un chemin ? Le site est servi en statique :
//  une URL comme /calls ne correspond a aucun fichier et renverrait un 404 au
//  rechargement. Le fragment (#/calls) reste cote navigateur, donc rechargeable
//  et partageable sans configuration de reecriture.
// =============================================================================

import { qs, qsa, on } from './dom.js';

/**
 * Les sept vues, DANS L'ORDRE DU MENU de index.html.
 *
 * `needsPeriod` dit si la barre de periode a un sens sur la vue : le Diagnostic
 * decrit l'etat de la collecte entiere, pas une fenetre de dates — lui laisser
 * la barre laisserait croire qu'elle filtre quelque chose.
 *
 * @type {ReadonlyArray<{id: string, title: string, sub: string, needsPeriod: boolean}>}
 */
export const ROUTES = [
  {
    id: 'monitoring',
    title: 'Monitoring',
    sub: 'Volume, taux de réponse et affluence sur la période choisie',
    needsPeriod: true,
  },
  {
    id: 'calls',
    title: 'Journal des appels',
    sub: 'Tous les appels de la période, du plus récent au plus ancien',
    needsPeriod: true,
  },
  {
    id: 'missed',
    title: 'Appels manqués',
    sub: 'Entrants restés sans réponse et correspondants encore à rappeler',
    needsPeriod: true,
  },
  {
    id: 'peers',
    title: 'Correspondants',
    sub: 'Qui vous appelle, qui vous appelez, et à quelle fréquence',
    needsPeriod: true,
  },
  {
    id: 'people',
    title: 'Collaborateurs',
    sub: 'Activité de chaque personne derrière sa ligne Keyyo',
    needsPeriod: true,
  },
  {
    id: 'lines',
    title: 'Lignes Keyyo',
    sub: 'Charge, taux de réponse et durée par ligne du parc',
    needsPeriod: true,
  },
  {
    id: 'diagnostics',
    title: 'Diagnostic',
    sub: 'État de l’authentification, de la collecte et de l’archive',
    needsPeriod: false,
  },
];

/** Vue servie quand le fragment est vide, inconnu ou malforme. */
const DEFAULT_ROUTE = 'monitoring';

/** @type {string} identifiant de la vue affichee. */
let _current = '';

/** @type {((id: string) => void)|null} */
let _onChange = null;

/** Le cablage n'a lieu qu'une fois, meme si `start` est rappele. */
let _started = false;

/** Etat du tiroir de navigation en mobile. */
let _navOpen = false;

// -----------------------------------------------------------------------------
//  Lecture du fragment
// -----------------------------------------------------------------------------

/**
 * @param {unknown} id
 * @returns {{id: string, title: string, sub: string, needsPeriod: boolean}|null}
 */
function routeById(id) {
  const key = String(id == null ? '' : id);
  for (let i = 0; i < ROUTES.length; i++) {
    if (ROUTES[i].id === key) return ROUTES[i];
  }
  return null;
}

/**
 * Identifiant de vue porte par le fragment courant.
 * Tolerant sur la forme : `#/calls`, `#calls`, `#/calls?x=1` donnent `calls`.
 * Un fragment inconnu retombe sur la vue par defaut, sans jamais jeter.
 * @returns {string}
 */
function parseHash() {
  let raw = '';
  try {
    raw = String(window.location.hash || '');
  } catch (err) {
    raw = '';
  }
  const first = raw.replace(/^#\/?/, '').split(/[/?&]/)[0];
  return routeById(first) ? first : DEFAULT_ROUTE;
}

/**
 * Aligne le fragment sur la vue reellement affichee, sans empiler d'entree
 * d'historique et sans declencher `hashchange` (`replaceState` n'en emet pas).
 * @param {string} id
 */
function normalizeHash(id) {
  const target = '#/' + id;
  try {
    if (String(window.location.hash || '') === target) return;
    if (window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', target);
    } else {
      window.location.hash = target;
    }
  } catch (err) {
    console.warn('[router] fragment d\'URL non modifiable :', err);
  }
}

// -----------------------------------------------------------------------------
//  Tiroir de navigation (mobile)
// -----------------------------------------------------------------------------

function openNav() {
  const side = qs('#sidebar');
  const scrim = qs('#nav-scrim');
  const toggle = qs('#nav-toggle');
  if (side) side.classList.add('is-open');
  if (scrim) {
    // Le voile porte `hidden` dans index.html : il faut le retirer AVANT
    // d'ajouter `is-open`, sinon le navigateur passe de « pas de boite » a
    // « boite opaque » sans etat intermediaire et la transition ne joue pas.
    scrim.hidden = false;
    // Lecture d'une propriete de disposition : force le calcul du style dans
    // l'etat « visible mais transparent », d'ou part la transition.
    void scrim.offsetWidth;
    scrim.classList.add('is-open');
  }
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
  _navOpen = true;
}

function closeNav() {
  if (!_navOpen) return;
  const side = qs('#sidebar');
  const scrim = qs('#nav-scrim');
  const toggle = qs('#nav-toggle');
  if (side) side.classList.remove('is-open');
  // `hidden` n'est PAS repose : sans `is-open` le voile est deja transparent et
  // inerte (`pointer-events: none`), et le masquer tout de suite couperait la
  // transition de fermeture.
  if (scrim) scrim.classList.remove('is-open');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  _navOpen = false;
}

// -----------------------------------------------------------------------------
//  Barre de periode
// -----------------------------------------------------------------------------

/**
 * Montre ou retire la barre de periode.
 *
 * POURQUOI un style en ligne ici : `.periodbar` declare `display: flex` dans
 * pages.css, et une regle d'auteur l'emporte sur la regle `[hidden]` de la
 * feuille du navigateur. L'attribut `hidden` seul ne masquerait donc rien. Il
 * reste pose pour les technologies d'assistance ; c'est `display` qui retire
 * reellement la barre du flux.
 * @param {boolean} visible
 */
function setPeriodBarVisible(visible) {
  const bar = qs('#periodbar');
  if (!bar) return;
  if (visible) {
    bar.hidden = false;
    bar.style.removeProperty('display');
  } else {
    bar.hidden = true;
    bar.style.setProperty('display', 'none');
  }
}

// -----------------------------------------------------------------------------
//  Application d'une route
// -----------------------------------------------------------------------------

/**
 * Met la coquille en accord avec `id`, puis previent l'abonne.
 * Idempotente : rejouer la meme route ne fait que reecrire les memes attributs.
 * @param {string} id
 */
function apply(id) {
  const route = routeById(id) || routeById(DEFAULT_ROUTE);
  _current = route.id;

  const items = qsa('.nav-item[data-route]');
  for (let i = 0; i < items.length; i++) {
    const el = items[i];
    const active = el.getAttribute('data-route') === route.id;
    el.classList.toggle('is-active', active);
    // `aria-current` n'a de sens que sur l'element courant : le retirer ailleurs
    // vaut mieux que de le poser a « false », qui reste annonce par certains
    // lecteurs d'ecran.
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }

  const pages = qsa('.page[data-page]');
  for (let i = 0; i < pages.length; i++) {
    pages[i].classList.toggle('is-active', pages[i].getAttribute('data-page') === route.id);
  }

  const title = qs('#page-title');
  if (title) title.textContent = route.title;
  const sub = qs('#page-sub');
  if (sub) sub.textContent = route.sub;

  setPeriodBarVisible(route.needsPeriod);

  // Choisir une vue depuis le tiroir mobile doit refermer le tiroir : sinon la
  // page choisie reste cachee derriere le voile.
  closeNav();

  if (_onChange) {
    // Une page qui plante ne doit pas laisser le routeur a moitie applique.
    try {
      _onChange(route.id);
    } catch (err) {
      console.error('[router] le rendu de la vue « ' + route.id + ' » a echoue :', err);
    }
  }
}

// -----------------------------------------------------------------------------
//  API publique
// -----------------------------------------------------------------------------

/**
 * Cable la navigation et applique immediatement la vue portee par l'URL.
 * @param {(id: string) => void} [onChange] appele apres chaque changement de vue.
 */
export function start(onChange) {
  _onChange = typeof onChange === 'function' ? onChange : null;

  if (_started) {
    apply(parseHash());
    return;
  }
  _started = true;

  // Delegation depuis la barre laterale : les sept boutons sont statiques dans
  // index.html, mais un seul ecouteur suffit et survit a tout remplacement.
  const side = qs('#sidebar');
  if (side) {
    on(side, 'click', '.nav-item[data-route]', function (ev, el) {
      ev.preventDefault();
      go(el.getAttribute('data-route'));
    });
  }

  window.addEventListener('hashchange', function () {
    apply(parseHash());
  });

  const toggle = qs('#nav-toggle');
  if (toggle) {
    on(toggle, 'click', function () {
      if (_navOpen) closeNav();
      else openNav();
    });
  }

  const scrim = qs('#nav-scrim');
  if (scrim) {
    on(scrim, 'click', function () {
      closeNav();
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && _navOpen) closeNav();
  });

  const id = parseHash();
  normalizeHash(id);
  apply(id);
}

/**
 * Va a une vue. Passe par le fragment quand il change, pour que le bouton
 * « Retour » du navigateur fonctionne comme l'utilisateur s'y attend.
 * @param {string} id
 */
export function go(id) {
  const route = routeById(id) || routeById(DEFAULT_ROUTE);
  const target = '#/' + route.id;
  let hash = '';
  try {
    hash = String(window.location.hash || '');
  } catch (err) {
    hash = '';
  }
  if (hash === target) {
    // Fragment inchange : `hashchange` ne se declenchera pas, on applique.
    apply(route.id);
    return;
  }
  try {
    window.location.hash = target;      // declenche hashchange -> apply
  } catch (err) {
    apply(route.id);
  }
}

/** @returns {string} identifiant de la vue affichee. */
export function current() {
  return _current || parseHash();
}
