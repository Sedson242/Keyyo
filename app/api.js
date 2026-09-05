// =============================================================================
//  app/api.js — Couche d'appel HTTP vers les fonctions serverless. SANS DEPENDANCE.
//
//  Un seul chemin de code fait les requetes (`request`), pour que le timeout,
//  l'analyse JSON, la deduplication et la mise en forme des erreurs soient
//  identiques partout. Les modules de page n'appellent JAMAIS `fetch`
//  directement : ils passent par ce module, ou par app/store.js.
//
//  TIMEOUT GENEREUX (30 s) : la premiere collecte parcourt trois mois de CDR
//  par tranches mensuelles, ligne par ligne et sens par sens. Un timeout de
//  10 s couperait une collecte legitime et donnerait un ecran vide alors que
//  le serveur travaille encore.
//
//  ANTI-TEMPETE : le sondage de 60 s, un clic sur « Rafraichir » et le premier
//  rendu d'une page peuvent demander la meme chose au meme instant. Deux appels
//  identiques encore en vol partagent donc UNE seule requete reseau.
//
//  AUCUN CACHE APPLICATIF : on ne conserve pas les reponses en memoire, sans
//  quoi l'ecran mentirait sur la fraicheur des donnees. C'est le CDN (et
//  l'en-tete `Cache-Control` pose par les fonctions) qui amortit la charge.
//  `?force=1` contourne ce cache, cote CDN comme cote navigateur.
// =============================================================================

/** Prefixe des fonctions serverless. Le site est servi a la racine du domaine. */
const BASE = '/api';

/** Timeout par defaut, en millisecondes. */
const DEFAULT_TIMEOUT_MS = 30000;

/** Timeout de /api/sync : la route declenche une collecte complete. */
const SYNC_TIMEOUT_MS = 60000;

/**
 * Requetes en vol, indexees par `METHODE URL`.
 * @type {Map<string, Promise<any>>}
 */
const inflight = new Map();

// -----------------------------------------------------------------------------
//  Erreur
// -----------------------------------------------------------------------------

/**
 * Echec d'un appel a l'API interne. `status` vaut 0 quand la requete n'a jamais
 * abouti (reseau coupe, timeout) : l'interface peut ainsi distinguer « pas de
 * reseau » de « le serveur a repondu non ».
 */
export class ApiError extends Error {
  /**
   * @param {string} message message deja redige en francais, affichable tel quel.
   * @param {{status?: number, body?: any, url?: string, cause?: unknown}} [info]
   */
  constructor(message, info) {
    super(message);
    this.name = 'ApiError';
    const i = info || {};
    /** @type {number} code HTTP, ou 0 si la reponse n'a jamais ete recue. */
    this.status = typeof i.status === 'number' ? i.status : 0;
    /** @type {any} charge utile analysee de la reponse d'erreur, ou `null`. */
    this.body = i.body === undefined ? null : i.body;
    /** @type {string} URL appelee, utile a la page Diagnostic. */
    this.url = i.url || '';
    if (i.cause !== undefined) this.cause = i.cause;
  }
}

// -----------------------------------------------------------------------------
//  Requete interne
// -----------------------------------------------------------------------------

/**
 * Assemble l'URL. Les valeurs `null`, `undefined` et `''` sont ecartees : une
 * cle vide dans la chaine de requete changerait la cle de cache CDN sans rien
 * changer a la reponse.
 * @param {string} path
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
function buildUrl(path, params) {
  const url = BASE + path;
  if (!params) return url;
  const qs = new URLSearchParams();
  const keys = Object.keys(params);
  for (let i = 0; i < keys.length; i++) {
    const v = params[keys[i]];
    if (v == null || v === '' || v === false) continue;
    qs.set(keys[i], v === true ? '1' : String(v));
  }
  const s = qs.toString();
  return s ? url + '?' + s : url;
}

/** @returns {string} message d'erreur redige, selon ce que le serveur a dit. */
function describeHttpError(status, body, url) {
  // Une fonction serverless qui echoue proprement renvoie un message : il est
  // plus precis que tout ce qu'on pourrait deviner ici, on le prefere.
  const fromBody = body && typeof body === 'object'
    ? (body.error || body.message || (body.warning && String(body.warning)) || '')
    : '';
  if (fromBody) return String(fromBody);

  if (status === 401) {
    return 'Session absente ou expirée (401) : reconnectez-vous.';
  }
  if (status === 403) {
    return 'Accès réservé (403) : cette ressource est limitée à la direction.';
  }
  if (status === 404) {
    return 'Route ' + url + ' introuvable (404). Le déploiement est incomplet : '
      + 'la fonction correspondante n’a pas été publiée.';
  }
  if (status === 429) {
    return 'Trop de requêtes (429). L’API Keyyo limite le débit : patienter une minute '
      + 'avant de relancer une collecte.';
  }
  if (status === 504 || status === 408) {
    return 'Le serveur a dépassé son temps d’exécution (' + status + '). Relancer la collecte '
      + 'mois par mois depuis la page Diagnostic plutôt qu’en une seule fois.';
  }
  if (status >= 500) {
    return 'Erreur du serveur (' + status + ') sur ' + url + '. Consulter la page Diagnostic '
      + 'et les journaux de la fonction.';
  }
  return 'Requête refusée (' + status + ') sur ' + url + '.';
}

/**
 * Execute reellement la requete : timeout, analyse JSON, erreur explicite.
 *
 * Une ECRITURE (`opts.body`) part en JSON avec l'en-tete `X-Requested-With:
 * keyyo` : c'est ce que le serveur exige pour distinguer un script de notre
 * origine d'un formulaire poste depuis un autre site (voir api/_config.js
 * #rejectCrossSite). `keepalive` laisse la requete partir pendant que la page
 * se ferme — utile pour vider le journal d'attribution.
 *
 * @param {string} method
 * @param {string} url
 * @param {{timeoutMs?: number, noCache?: boolean, body?: any, keepalive?: boolean}} opts
 * @returns {Promise<any>}
 */
async function execute(method, url, opts) {
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  /** Message unique du depassement de delai, que la coupure survienne a l'envoi ou a la lecture. */
  const timeoutError = (err) => new ApiError(
    'Délai dépassé (' + Math.round(timeoutMs / 1000) + ' s) sur ' + url + '. '
    + 'La première collecte des trois mois peut être longue : réessayer dans une minute, '
    + 'ou remplir un mois à la fois depuis la page Diagnostic.',
    { status: 0, url, cause: err },
  );
  const isAbort = (err) => !!err && /** @type {any} */ (err).name === 'AbortError';

  // Le timer couvre TOUT l'echange, lecture du corps incluse : une reponse dont
  // les en-tetes arrivent vite mais dont le flux se bloque doit aussi echouer.
  try {
    /** @type {Response} */
    let res;
    try {
      /** @type {Record<string, string>} */
      const headers = { Accept: 'application/json' };
      /** @type {RequestInit} */
      const init = {
        method,
        headers,
        credentials: 'same-origin',
        // Seul un rafraichissement force ignore le cache HTTP : le reste du temps,
        // laisser le navigateur reutiliser la reponse du CDN est exactement ce
        // qu'on veut d'un tableau de bord sonde toutes les minutes.
        cache: opts.noCache ? 'no-store' : 'default',
        signal: controller.signal,
      };
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['X-Requested-With'] = 'keyyo';
        init.body = JSON.stringify(opts.body);
        init.cache = 'no-store';
      }
      if (opts.keepalive) init.keepalive = true;
      res = await fetch(url, init);
    } catch (err) {
      if (isAbort(err)) throw timeoutError(err);
      throw new ApiError(
        'Impossible de joindre ' + url + ' : réseau indisponible ou fonction hors service.',
        { status: 0, url, cause: err },
      );
    }

    // 204 sans corps : legitime pour une route qui n'a rien a dire.
    if (res.status === 204) return null;

    /** @type {string} */
    let text;
    try {
      text = await res.text();
    } catch (err) {
      if (isAbort(err)) throw timeoutError(err);
      throw new ApiError(
        'Lecture de la réponse de ' + url + ' interrompue (connexion coupée en cours de transfert).',
        { status: res.status, url, cause: err },
      );
    }

    /** @type {any} */
    let body = null;
    let parseFailed = false;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        // On ne masque pas l'echec : le texte brut part dans `body` pour la page
        // Diagnostic, et l'appelant recoit une erreur qui nomme le probleme.
        parseFailed = true;
        body = { raw: text.slice(0, 500) };
      }
    }

    if (!res.ok) {
      // Une session tombee en cours d'utilisation (expiration, deconnexion
      // dans un autre onglet) se voit ici en premier : on le signale a la
      // coquille, qui remet l'ecran de connexion. La demande « qui suis-je »
      // en est exclue, elle sert justement a poser cette question.
      if (res.status === 401 && typeof document !== 'undefined' && url.indexOf('/auth?') < 0) {
        try {
          document.dispatchEvent(new CustomEvent('keyyo:unauthenticated', { detail: { url } }));
        } catch (err) { /* un navigateur sans CustomEvent n'a rien a signaler */ }
      }
      throw new ApiError(describeHttpError(res.status, parseFailed ? null : body, url), {
        status: res.status,
        body,
        url,
      });
    }
    if (parseFailed) {
      throw new ApiError(
        'Réponse illisible de ' + url + ' : du texte au lieu du JSON attendu '
        + '(souvent une page d’erreur de la plateforme). Voir le détail dans body.raw.',
        { status: res.status, body, url },
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Point de passage unique. Deux appels identiques simultanes partagent la meme
 * promesse ; un appel posterieur au reglement repart sur une requete neuve.
 * @param {string} path
 * @param {{params?: Record<string, unknown>, method?: string, timeoutMs?: number, noCache?: boolean}} [opts]
 * @returns {Promise<any>}
 */
function request(path, opts) {
  const o = opts || {};
  const method = (o.method || 'GET').toUpperCase();
  const url = buildUrl(path, o.params);
  const key = method + ' ' + url;

  // Deux ecritures vers la meme URL ne sont pas la meme requete : on ne les
  // fusionne jamais. Seules les lectures se partagent.
  if (method !== 'GET') return execute(method, url, o);

  const pending = inflight.get(key);
  if (pending) return pending;

  const p = execute(method, url, o).finally(() => {
    // Comparaison avant suppression : si une requete plus recente a deja pris
    // la place sous la meme cle, ce n'est pas a nous de la retirer.
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/**
 * Valide un parametre de mois. Un mois mal forme cote client produirait une
 * collecte silencieusement vide : on refuse tout de suite, avec le format attendu.
 * @param {unknown} month
 * @returns {string}
 */
function monthParam(month) {
  const s = String(month == null ? '' : month).trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) {
    throw new ApiError('Mois « ' + s + " » invalide : le format attendu est AAAA-MM (par exemple 2026-09).", {
      status: 0,
      url: BASE,
    });
  }
  return s;
}

// -----------------------------------------------------------------------------
//  Points d'entree
// -----------------------------------------------------------------------------

/**
 * Appels, lignes et diagnostic de collecte.
 * @param {{force?: boolean, full?: boolean, month?: string, timeoutMs?: number}} [opts]
 *        `force` contourne le cache, `full` relance un balayage complet des trois
 *        mois, `month` (AAAA-MM) ne remplit qu'un mois.
 * @returns {Promise<any>} `{ schemaVersion, fields, rows, lines, meta, coverage, store, diag, updatedAt, empty, warning }`
 */
export async function getCalls(opts) {
  const o = opts || {};
  /** @type {Record<string, unknown>} */
  const params = {};
  if (o.force) params.force = '1';
  if (o.full) params.full = '1';
  if (o.month != null && o.month !== '') params.month = monthParam(o.month);
  return request('/calls', {
    params,
    noCache: !!o.force,
    timeoutMs: o.timeoutMs,
  });
}

/**
 * Lignes Keyyo et identites resolues, avec les lignes restees sans personne.
 * @param {{force?: boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<any>} `{ lines, unresolved, suggestion, sources, updatedAt }`
 */
export async function getTeam(opts) {
  const o = opts || {};
  return request('/team', {
    params: o.force ? { force: '1' } : undefined,
    noCache: !!o.force,
    timeoutMs: o.timeoutMs,
  });
}

/**
 * Annuaire `numero E.164 -> nom`, pour nommer les correspondants.
 * @param {{force?: boolean, debug?: boolean, timeoutMs?: number}} [opts]
 *        `debug` demande le detail des sources (page Diagnostic).
 * @returns {Promise<any>} `{ map, count, sources, updatedAt }`
 */
export async function getDirectory(opts) {
  const o = opts || {};
  /** @type {Record<string, unknown>} */
  const params = {};
  if (o.force) params.force = '1';
  if (o.debug) params.debug = '1';
  return request('/directory', {
    params,
    noCache: !!o.force,
    timeoutMs: o.timeoutMs,
  });
}

/**
 * Etat de la chaine : authentification, collecte, archive.
 *
 * `deep` demande a /api/health une sonde REELLE de releve d'appels, en plus des
 * controles de configuration : c'est ce que declenche le bouton « Contrôle
 * approfondi » de la page Diagnostic. Le parametre est donc relaye, et la
 * reponse sortie du cache — deux sondes identiques ne doivent pas se recouvrir.
 * @param {{force?: boolean, deep?: boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<any>} `{ status, calls, period, lines, checks, elapsedMs }`
 */
export async function getHealth(opts) {
  const o = opts || {};
  /** @type {Record<string, unknown>} */
  const params = {};
  if (o.force) params.force = '1';
  if (o.deep) params.deep = '1';
  return request('/health', {
    params,
    noCache: !!o.force || !!o.deep,
    timeoutMs: o.timeoutMs,
  });
}

/**
 * Qui est connecte. Repond 200 avec `{ authenticated, user }`, 401 sans
 * session, 503 si la connexion n'est pas configuree — les deux derniers
 * arrivent en ApiError, que app/session.js traduit en etat d'ecran.
 * Jamais mis en cache : la reponse change a chaque connexion.
 * @returns {Promise<any>} `{ authenticated, configured, user: { email, name, role, roleLabel, expiresAt } }`
 */
export async function getMe() {
  return request('/auth', { params: { action: 'me' }, noCache: true, timeoutMs: 15000 });
}

/**
 * Profil de travail de la personne connectee : sa ligne, ses collegues et les
 * managers avec un numero pour chacun.
 * @param {{force?: boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<any>} `{ user, line, lines, colleagues, managers, journal, warnings }`
 */
export async function getProfile(opts) {
  const o = opts || {};
  return request('/me', { noCache: !!o.force, timeoutMs: o.timeoutMs });
}

/**
 * Frappe un jeton CSI pour ouvrir une session CTI sur une ligne. ECRITURE :
 * chaque appel consomme une frappe cote Keyyo, on ne l'appelle qu'a
 * l'ouverture et avant l'expiration.
 * @param {{csi?: string, timeoutMs?: number}} [opts] `csi` force une ligne.
 * @returns {Promise<any>} `{ csi, number, token, expiresAt, line, lines }`
 *          409 (ApiError) avec `body.lines` quand aucune ligne n'est rattachee.
 */
export async function postCtiToken(opts) {
  const o = opts || {};
  return request('/cti-token', {
    method: 'POST',
    body: o.csi ? { csi: String(o.csi) } : {},
    timeoutMs: o.timeoutMs,
  });
}

/**
 * Envoie des evenements au journal d'attribution.
 * @param {any[]} events
 * @param {{keepalive?: boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<any>} `{ accepted, rejected, byMonth }`
 */
export async function postEvents(events, opts) {
  const o = opts || {};
  return request('/events', {
    method: 'POST',
    body: { events: Array.isArray(events) ? events : [] },
    keepalive: !!o.keepalive,
    timeoutMs: o.timeoutMs,
  });
}

/**
 * Relit le journal d'attribution d'un mois.
 * @param {{month?: string, scope?: 'me'|'all', timeoutMs?: number}} [opts]
 * @returns {Promise<any>} `{ month, scope, events, partitions, summary }`
 */
export async function getEvents(opts) {
  const o = opts || {};
  /** @type {Record<string, unknown>} */
  const params = {};
  if (o.month) params.month = monthParam(o.month);
  if (o.scope === 'all') params.scope = 'all';
  return request('/events', { params, noCache: true, timeoutMs: o.timeoutMs });
}

/**
 * Declenche une synchronisation immediate (meme travail que le cron).
 *
 * La route est envoyee en POST — c'est une ecriture : elle collecte chez Keyyo
 * et reecrit l'archive Blob. Mais `/api/sync` est aussi la cible d'un cron
 * Vercel, qui l'appelle en GET ; si la fonction n'accepte que ce verbe, on
 * retente explicitement en GET plutot que de laisser l'utilisateur devant un
 * « 405 » incomprehensible.
 * @param {{full?: boolean, month?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<any>} `{ ok, at, store, period, warnings }`
 */
export async function postSync(opts) {
  const o = opts || {};
  /** @type {Record<string, unknown>} */
  const params = {};
  if (o.full) params.full = '1';
  if (o.month != null && o.month !== '') params.month = monthParam(o.month);

  const common = {
    params,
    noCache: true,
    timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : SYNC_TIMEOUT_MS,
  };

  try {
    return await request('/sync', Object.assign({ method: 'POST' }, common));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 405 || err.status === 501)) {
      return request('/sync', Object.assign({ method: 'GET' }, common));
    }
    throw err;
  }
}
