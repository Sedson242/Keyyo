// =============================================================================
//  api/oauth.js — GET /api/oauth : obtenir un refresh token avec les bons scopes.
//
//  POURQUOI CETTE ROUTE EXISTE. Un scope OAuth2 ne s'ajoute pas apres coup a un
//  jeton deja emis. Le refresh token du projet a ete frappe avec
//  `full_access_read_only` ; pour piloter la telephonie (API CTI) il faut
//  `cti_admin`, donc REFAIRE le flot d'autorisation en demandant les deux. Cela
//  suppose un aller-retour par le navigateur puis un echange serveur portant le
//  secret client — penible et facile a rater a la main. Cette route l'automatise.
//
//  ELLE EST FERMEE PAR DEFAUT. Sans `KEYYO_OAUTH_SETUP=1`, elle repond 404 et ne
//  laisse rien deviner de son existence. On l'active le temps de la manoeuvre,
//  puis ON LA REDESACTIVE : elle affiche un refresh token en clair, ce qui est
//  la raison meme de son existence et aussi son principal danger.
//
//  ELLE N'ECRIT RIEN. Ni journal, ni archive, ni variable : le jeton obtenu est
//  affiche une fois, a l'exploitant de le coller dans Vercel. Le laisser
//  quelque part serait recreer le probleme que ce projet a deja connu (des
//  secrets commites dans git).
//
//  Parametres : aucun a l'aller. Keyyo rappelle ensuite ?code=…&state=…
// =============================================================================

import { readConfig, readParams, sendJson, rejectNonGet, errorMessage } from './_config.js';
import { readAuthConfig, requireRole } from './_auth.js';

/** Point d'autorisation Keyyo. Different de l'hote de l'API. */
const AUTHORIZE_URL = 'https://ssl.keyyo.com/oauth2/authorize.php';

/**
 * Scopes demandes. `full_access_read_only` couvre toute la collecte actuelle ;
 * `cti_admin` ajoute la generation de jetons CSI, indispensable a l'API CTI.
 * La documentation Keyyo nomme ce parametre `scopes`, au PLURIEL, et attend une
 * liste separee par des virgules — s'en ecarter le fait ignorer en silence.
 */
const SCOPES = 'full_access_read_only,cti_admin';

/** Nom du cookie portant l'anti-rejeu entre l'aller et le retour. */
const STATE_COOKIE = 'keyyo_oauth_state';

/**
 * @param {any} req
 * @param {any} res
 */
export default async function handler(req, res) {
  if (rejectNonGet(req, res, '/api/oauth')) return;

  // Fermeture par defaut. On repond 404 plutot que 403 : une route de mise en
  // service ne doit pas signaler qu'elle existe quand elle est eteinte.
  if (String(process.env.KEYYO_OAUTH_SETUP || '').trim() !== '1') {
    return sendJson(res, 404, { error: 'Route inconnue.' }, 'no-store');
  }

  // Une fois la connexion Entra en place, cette route — qui affiche un
  // refresh token — n'est plus ouverte qu'a la direction. Avant, elle ne tient
  // qu'a KEYYO_OAUTH_SETUP : c'est le mode « mise en service », a refermer.
  if (readAuthConfig().configured && !requireRole(req, res, '/api/oauth')) return;

  const params = readParams(req);

  try {
    const cfg = readConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      return sendJson(res, 500, {
        error: 'Configuration incomplète',
        detail: 'KEYYO_CLIENT_ID et KEYYO_CLIENT_SECRET sont nécessaires pour ce flot.',
      }, 'no-store');
    }

    const redirectUri = redirectUriOf(req);

    // -- Retour de Keyyo : on echange le code contre les jetons. -------------
    if (params.code) {
      const expected = cookieValue(req, STATE_COOKIE);
      if (!expected || !params.state || params.state !== expected) {
        // L'etat protege d'un code injecte par un tiers. Une divergence n'est
        // jamais benigne : on refuse sans rien echanger.
        return html(res, 400, page(
          'État invalide',
          '<p>Le paramètre <code>state</code> ne correspond pas à celui de la demande. '
          + 'La procédure a peut-être été relancée dans un autre onglet. '
          + '<a href="/api/oauth">Recommencer</a>.</p>',
        ));
      }

      const body = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: 'authorization_code',
        code: String(params.code),
        redirect_uri: redirectUri,
        state: String(params.state),
      });

      const answer = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const text = await answer.text();
      /** @type {any} */
      let payload = null;
      try { payload = JSON.parse(text); } catch (err) { payload = null; }

      if (!answer.ok || !payload || !payload.refresh_token) {
        const detail = payload && (payload.error_description || payload.error)
          ? String(payload.error_description || payload.error)
          : 'Réponse illisible de ' + cfg.tokenUrl + ' (HTTP ' + answer.status + ').';
        return html(res, 502, page(
          'Échange refusé',
          '<p>Keyyo n’a pas délivré de jeton.</p><p class="err">' + esc(detail) + '</p>'
          + '<p><a href="/api/oauth">Recommencer</a></p>',
        ));
      }

      const granted = String(payload.scope || '');
      const hasCti = granted.split(/[\s,]+/).indexOf('cti_admin') >= 0;

      return html(res, 200, page('Jeton obtenu', ''
        + '<p>Scopes réellement accordés :</p>'
        + '<p class="' + (hasCti ? 'ok' : 'err') + '"><code>' + esc(granted || '(aucun)') + '</code></p>'
        + (hasCti
          ? '<p class="ok">✔ <strong>cti_admin est accordé.</strong> L’API CTI sera utilisable.</p>'
          : '<p class="err">✘ <strong>cti_admin n’est PAS accordé.</strong> Le pilotage des appels '
            + 'restera indisponible. Vérifiez que ce scope est autorisé pour votre application sur '
            + '<a href="https://api.keyyo.com/developers/apps">le portail développeur Keyyo</a>, '
            + 'puis recommencez.</p>')
        + '<h2>Nouveau refresh token</h2>'
        + '<p>Collez-le dans Vercel, variable <code>KEYYO_REFRESH_TOKEN</code>, puis redéployez.</p>'
        + '<pre class="token">' + esc(String(payload.refresh_token)) + '</pre>'
        + '<h2>Ensuite, impérativement</h2>'
        + '<ol>'
        + '<li>Remplacez <code>KEYYO_REFRESH_TOKEN</code> dans les variables du projet Vercel.</li>'
        + '<li>Repassez <code>KEYYO_OAUTH_SETUP</code> à vide pour refermer cette route.</li>'
        + '<li>Redéployez.</li>'
        + '</ol>'
        + '<p class="err">Ce jeton donne accès à votre compte Keyyo. Ne le laissez ni dans un '
        + 'fichier, ni dans git, ni dans une conversation.</p>'));
    }

    // -- Aller : on envoie l'exploitant chez Keyyo. --------------------------
    const state = randomState();
    const url = AUTHORIZE_URL
      + '?client_id=' + encodeURIComponent(cfg.clientId)
      + '&response_type=code'
      + '&state=' + encodeURIComponent(state)
      + '&scopes=' + encodeURIComponent(SCOPES)
      + '&redirect_uri=' + encodeURIComponent(redirectUri);

    res.setHeader('Set-Cookie',
      STATE_COOKIE + '=' + state + '; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=900');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 302;
    res.setHeader('Location', url);
    res.end();
  } catch (err) {
    sendJson(res, 500, { error: 'Flot OAuth impossible', detail: errorMessage(err) }, 'no-store');
  }
}

// -----------------------------------------------------------------------------
//  Outils
// -----------------------------------------------------------------------------

/**
 * URI de redirection, deduite de la requete.
 *
 * Elle doit correspondre EXACTEMENT a celle declaree sur le portail Keyyo, sans
 * quoi l'autorisation est refusee. On la reconstruit depuis les en-tetes plutot
 * que de la coder en dur : le domaine d'un deploiement Vercel change a chaque
 * livraison.
 * @param {any} req
 * @returns {string}
 */
function redirectUriOf(req) {
  const forced = String(process.env.KEYYO_OAUTH_REDIRECT || '').trim();
  if (forced) return forced;
  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '');
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || 'https');
  return proto + '://' + host + '/api/oauth';
}

/** @returns {string} etat anti-rejeu, imprevisible. */
function randomState() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * Valeur d'un cookie de la requete.
 * @param {any} req
 * @param {string} name
 * @returns {string}
 */
function cookieValue(req, name) {
  const raw = String((req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/** @param {unknown} s @returns {string} */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Reponse HTML. Cette route est la seule du projet a en produire : elle
 * s'adresse a un humain dans son navigateur, pas au front.
 * @param {any} res
 * @param {number} status
 * @param {string} body
 */
function html(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(body);
}

/**
 * Gabarit de page. Styles en ligne : la CSP du projet autorise `style-src
 * 'unsafe-inline'`, et cette page ne doit dependre d'aucune feuille externe
 * pour rester lisible meme si le reste du site est casse.
 * @param {string} title
 * @param {string} inner  HTML deja sur.
 * @returns {string}
 */
function page(title, inner) {
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow">'
    + '<title>' + esc(title) + ' — Autorisation Keyyo</title>'
    + '<style>'
    + 'body{margin:0;padding:32px 20px;background:#faf8f5;color:#2a2018;'
    + 'font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + '.w{max-width:760px;margin:0 auto}'
    + 'h1{font-size:22px;margin:0 0 18px}h2{font-size:15px;margin:26px 0 8px}'
    + 'code{background:#efe9e2;padding:2px 6px;border-radius:4px;font-size:.92em}'
    + 'pre.token{background:#2a2018;color:#f6f2ee;padding:14px;border-radius:10px;'
    + 'white-space:pre-wrap;word-break:break-all;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}'
    + '.ok{color:#15803d}.err{color:#b91c1c}'
    + 'a{color:inherit}ol{padding-left:20px}'
    + '</style></head><body><div class="w"><h1>' + esc(title) + '</h1>' + inner + '</div></body></html>';
}
