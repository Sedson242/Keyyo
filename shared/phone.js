// =============================================================================
//  shared/phone.js — Normalisation et formatage des numeros. FONCTIONS PURES.
//
//  Importe tel quel par le back (fonctions Vercel) ET par le front (module ES).
//  Aucune dependance, aucune API Node ni navigateur.
//
//  Regle unique : toute comparaison de numeros se fait sur la forme E.164
//  (`+33253359565`). Les deux bouts de la chaine utilisent `toE164`, donc un
//  numero recu en `02 53 35 95 65`, `+33 2 53 35 95 65`, `0033253359565` ou
//  `33253359565` produit toujours la meme cle.
// =============================================================================

/** Indicatif pays par defaut, applique aux numeros nationaux (0X XX XX XX XX). */
export const DEFAULT_CC = '33';

/** Numeros que Keyyo renvoie a la place d'un appelant masque. */
const ANONYMOUS = new Set(['anonymous', 'anonyme', 'restricted', 'unknown', 'private', 'masque']);

/**
 * Met un numero au format E.164 (`+33...`).
 * @param {unknown} raw    Numero dans n'importe quel format.
 * @param {string} [cc]    Indicatif pays a appliquer aux numeros nationaux.
 * @returns {string}       `+33...`, `anonymous`, ou `''` si inexploitable.
 */
export function toE164(raw, cc = DEFAULT_CC) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (ANONYMOUS.has(s.toLowerCase())) return 'anonymous';

  // On ne garde que les chiffres et un eventuel + de tete.
  let x = s.replace(/[^\d+]/g, '');
  if (x.includes('+')) x = '+' + x.replace(/\+/g, '');
  if (!x || x === '+') return '';

  if (x.startsWith('+')) {
    // deja international
  } else if (x.startsWith('00')) {
    x = '+' + x.slice(2);
  } else if (x.length === 10 && x[0] === '0') {
    // national francais : 0253359565 -> +33253359565
    x = '+' + cc + x.slice(1);
  } else if (x.length <= 6) {
    // numero court / interne (poste, service special) : on le laisse tel quel,
    // sans prefixe, pour ne pas fabriquer un faux numero international.
    return x;
  } else {
    x = '+' + x;
  }

  const digits = x.slice(1);
  if (digits.length < 6 || digits.length > 15) return '';   // hors plage E.164
  return x;
}

/** @returns {boolean} vrai si le numero est un appelant masque. */
export function isAnonymous(num) {
  return toE164(num) === 'anonymous';
}

/** @returns {boolean} vrai si le numero est un poste interne (numero court). */
export function isShortNumber(num) {
  const k = toE164(num);
  return !!k && !k.startsWith('+') && k !== 'anonymous';
}

/**
 * Affichage lisible d'un numero, en francais quand c'est un numero FR.
 * `+33253359565` -> `02 53 35 95 65` ; sinon groupes de 2 apres l'indicatif.
 * @param {unknown} raw
 * @returns {string}
 */
export function formatNumber(raw) {
  const k = toE164(raw);
  if (!k) return '—';
  if (k === 'anonymous') return 'Masqué';
  if (!k.startsWith('+')) return k;                          // poste interne

  if (/^\+33[1-9]\d{8}$/.test(k)) {
    return ('0' + k.slice(3)).replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  }
  // International : +CC puis paires de chiffres.
  const cc = k.slice(1, 3);
  const rest = k.slice(3).replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  return `+${cc} ${rest}`.trim();
}

/**
 * Type de numero, pour le libelle et la couleur dans l'interface.
 * @param {unknown} raw
 * @returns {'anonymous'|'internal'|'mobile'|'fixe'|'special'|'international'|'inconnu'}
 */
export function numberKind(raw) {
  const k = toE164(raw);
  if (!k) return 'inconnu';
  if (k === 'anonymous') return 'anonymous';
  if (!k.startsWith('+')) return 'internal';
  if (k.startsWith('+33')) {
    const n = k.slice(3);
    if (/^[67]/.test(n)) return 'mobile';
    if (/^[1-5]/.test(n)) return 'fixe';
    if (/^[89]/.test(n)) return 'special';
    return 'fixe';
  }
  return 'international';
}

/**
 * Construit un index de recherche `E.164 -> valeur` en normalisant les cles.
 * La premiere valeur posee gagne (permet de gerer les priorites de source).
 * @template T
 * @param {Iterable<[unknown, T]>} pairs
 * @param {{minDigits?: number}} [opts]
 * @returns {Record<string, T>}
 */
export function indexByNumber(pairs, opts = {}) {
  const minDigits = opts.minDigits ?? 6;
  /** @type {Record<string, T>} */
  const out = {};
  for (const [num, value] of pairs) {
    const k = toE164(num);
    if (!k || k === 'anonymous') continue;
    if (k.startsWith('+') && k.length - 1 < minDigits) continue;
    if (value == null || value === '') continue;
    if (!(k in out)) out[k] = value;
  }
  return out;
}
