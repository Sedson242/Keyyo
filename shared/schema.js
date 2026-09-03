// =============================================================================
//  shared/schema.js — Format d'un appel normalise. CONTRAT FRONT <-> BACK.
//
//  Un appel voyage sous forme de tableau positionnel (et non d'objet) : sur
//  trois mois et plusieurs lignes, cela represente des milliers d'appels, et
//  la forme positionnelle divise environ par trois la taille du JSON.
//
//  Les index sont figes et partages par les deux bouts via la constante `F`.
//  Toute evolution du format doit incrementer `SCHEMA_VERSION` : l'archive
//  stocke sa version, et une archive d'une version anterieure est rebalayee
//  au lieu d'etre lue de travers.
// =============================================================================

export const SCHEMA_VERSION = 3;

/** Noms des champs, dans l'ordre du tableau positionnel. */
export const FIELDS = /** @type {const} */ ([
  'id',        //  0 string  identifiant de l'appel (`call_id`), ou cle synthetique
  'ts',        //  1 number  debut de l'appel, timestamp Unix en secondes (UTC)
  'date',      //  2 string  `YYYY-MM-DD` en heure locale du fuseau d'affichage
  'hour',      //  3 number  0-23, heure locale
  'minute',    //  4 number  0-59, minute locale
  'dir',       //  5 number  1 = sortant, 0 = entrant
  'caller',    //  6 string  appelant, E.164 (`anonymous` si masque)
  'callee',    //  7 string  appele, E.164
  'peer',      //  8 string  le correspondant : `callee` si sortant, `caller` si entrant
  'seconds',   //  9 number  duree en secondes (`quantity` quand `unit` vaut second)
  'answered',  // 10 number  1 = decroche, 0 = non decroche  (voir note ci-dessous)
  'csi',       // 11 string  CSI de la ligne Keyyo concernee
  'unit',      // 12 string  unite du releve : second | sms | ko | textmms | mms
  'cost',      // 13 number|null  cout facture par Keyyo, si fourni
  'destName',  // 14 string  `destination_name` : type de destination (sortant)
]);

/**
 * Index de chaque champ. A utiliser partout plutot que des nombres en dur :
 * `row[F.seconds]`, jamais `row[9]`.
 * @type {{ [K in typeof FIELDS[number]]: number }}
 */
export const F = /** @type {any} */ (Object.freeze(
  Object.fromEntries(FIELDS.map((name, i) => [name, i])),
));

/** Nombre de colonnes attendu sur une ligne bien formee. */
export const ROW_LENGTH = FIELDS.length;

// -----------------------------------------------------------------------------
//  NOTE IMPORTANTE sur `answered`
//
//  L'API Keyyo ne fournit AUCUN indicateur de decroche : le type
//  CallDetailRecord expose `quantity` (avec `unit`), `cost`, les numeros et
//  `start_time`, mais pas de champ « answered » ni de champ « duration ».
//  On deduit donc le decroche de la duree : `quantity > 0` => decroche.
//
//  Verifie sur des enregistrements reels du compte : un sortant abouti sort a
//  170 s, un entrant non decroche sort a 0 s. C'est un proxy, pas une donnee
//  d'origine : un appel decroche puis raccroche dans la meme seconde serait
//  compte comme manque. C'est la seule lecture possible avec cette API.
//
//  Un APPEL MANQUE = entrant (`dir` = 0) et non decroche (`answered` = 0).
// -----------------------------------------------------------------------------

/** @param {any[]} row @returns {boolean} vrai si l'appel est un entrant manque. */
export function isMissed(row) {
  return row[F.dir] === 0 && row[F.answered] === 0;
}

/** @param {any[]} row @returns {boolean} */
export function isIncoming(row) { return row[F.dir] === 0; }

/** @param {any[]} row @returns {boolean} */
export function isOutgoing(row) { return row[F.dir] === 1; }

/**
 * Cle de deduplication d'un appel.
 *
 * Elle exclut deliberement la duree : Keyyo peut renvoyer un appel encore en
 * cours (duree partielle) puis le meme appel termine. La deuxieme version doit
 * REMPLACER la premiere, pas s'ajouter a cote. Quand `call_id` est fourni, il
 * suffit ; sinon on retombe sur la signature horodatage + numeros + ligne.
 * @param {any[]} row
 * @returns {string}
 */
export function rowKey(row) {
  const id = row[F.id];
  if (id) return `id:${id}`;
  return [row[F.ts], row[F.dir], row[F.caller], row[F.callee], row[F.csi]].join('|');
}

/**
 * Convertit une ligne positionnelle en objet nomme (lisibilite, export CSV,
 * debug). A eviter dans les boucles chaudes de rendu.
 * @param {any[]} row
 * @returns {Record<string, any>}
 */
export function toObject(row) {
  /** @type {Record<string, any>} */
  const o = {};
  for (let i = 0; i < FIELDS.length; i++) o[FIELDS[i]] = row[i];
  return o;
}

/**
 * Inverse de `toObject`.
 * @param {Record<string, any>} obj
 * @returns {any[]}
 */
export function fromObject(obj) {
  return FIELDS.map((name) => obj[name]);
}

/**
 * Verifie qu'une ligne a la forme attendue. Utilise a la lecture de l'archive
 * pour ne jamais laisser une ligne corrompue casser le rendu.
 * @param {unknown} row
 * @returns {boolean}
 */
export function isValidRow(row) {
  return Array.isArray(row)
    && row.length === ROW_LENGTH
    && typeof row[F.ts] === 'number' && Number.isFinite(row[F.ts])
    && typeof row[F.date] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row[F.date])
    && (row[F.dir] === 0 || row[F.dir] === 1);
}
