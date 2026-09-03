/* =============================================================================
   app/charts.js — graphiques en SVG genere a la main, zero dependance.

   Pourquoi pas de bibliotheque : la maquette impose des details (piste de fond
   arrondie derriere chaque barre, degrade corail -> orange propre a chaque
   barre, barres tres etroites et tres espacees) qu'aucune librairie generique
   ne rend sans surcharge de configuration. Une chaine SVG ecrite a la main est
   plus courte, plus rapide a peindre, et se releve exactement de la maquette.

   Contrat (docs/ARCHITECTURE.md, section 5) :
     barChart, areaChart, donutChart, heatmap, sparkline -> renvoient une CHAINE
     attachChartTips(root) -> seule fonction qui touche au DOM

   Deux regles non negociables dans ce fichier :
   1. Aucune couleur en dur : tout passe par une variable de tokens.css. Les
      couleurs sont injectees via des styles en ligne (style="fill:var(--in)")
      et non via des attributs de presentation, car var() dans un attribut de
      presentation SVG n'est pas fiable sur tous les moteurs.
   2. Aucune coordonnee non finie : un NaN dans un attribut SVG ne leve aucune
      erreur, il fait juste disparaitre le trace. Toute coordonnee traverse
      donc r2() et toute valeur numerique num().
   ============================================================================= */

import { esc } from './dom.js';

/* -----------------------------------------------------------------------------
   1. Gardes numeriques et petits utilitaires
   -------------------------------------------------------------------------- */

/** Nombre fini, sinon la valeur de repli. */
function num(v, fallback) {
  var x = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(x)) return Number.isFinite(fallback) ? fallback : 0;
  return x;
}

/** Coordonnee sure : finie et arrondie au centieme (SVG n'a pas besoin de plus). */
function r2(v) {
  var x = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function clamp(v, lo, hi) {
  var x = num(v, lo);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Option numerique : `def` quand l'appelant n'a rien passe (ou a passe une
 * valeur non finie), puis bornage. Deux etapes distinctes, sinon une option
 * absente prendrait silencieusement la valeur de la borne basse.
 */
function opt(v, def, lo, hi) {
  var x = num(v, num(def, lo));
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** Sortie de `format` ramenee a une chaine, quoi que rende l'appelant. */
function fv(fmt, value) {
  var s = fmt(num(value, 0));
  return s === null || s === undefined ? '' : String(s);
}

/** Vrai si la valeur peut etre tracee (les points manquants sont des trous). */
function isPlottable(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

/**
 * Couleur acceptee dans un style en ligne. On n'attend que des tokens
 * (`var(--in)`) ou des couleurs CSS simples ; tout le reste est refuse pour
 * qu'une valeur inattendue ne puisse pas glisser de declaration dans le style.
 */
function safeColor(c, fallback) {
  if (typeof c !== 'string') return fallback;
  var s = c.trim();
  if (!s || s.length > 120) return fallback;
  if (!/^[-#a-zA-Z0-9(),.%\s_]+$/.test(s)) return fallback;
  if (/url\s*\(/i.test(s)) return fallback;
  return s;
}

/** Couleur de serie par defaut : ordre fixe de tokens.css. */
function seriesColor(i) {
  return 'var(--series-' + (((num(i, 0) % 8) + 8) % 8 + 1) + ')';
}

/**
 * Echappement d'une valeur d'attribut relue COMME TEXTE (aria-label).
 *
 * Le parseur decode les references de caracteres de toute valeur d'attribut :
 * echapper `&`, `"`, `<` et `>` suffit pour que la valeur relue soit
 * exactement la chaine d'origine. On ne passe donc PAS par esc() avant :
 * l'echappement serait defait par ce decodage, et un lecteur d'ecran
 * annoncerait « &lt;img&gt; » au lieu du texte.
 */
function attrEscText(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Echappement d'une valeur d'attribut REINJECTEE EN HTML : `data-tip`, relu par
 * `attachChartTips` puis pose en innerHTML.
 *
 * PIEGE, corrige ici. Le parseur decode l'attribut UNE FOIS. Une chaine deja
 * echappee par esc() y perd donc sa protection : `&lt;img onerror=...&gt;`
 * redevient `<img onerror=...>` avant d'atteindre innerHTML, et un nom
 * d'annuaire hostile s'execute. Il faut echapper l'esperluette SANS EXCEPTION,
 * pour que le decodage du parseur rende exactement la chaine simplement
 * echappee attendue. Les `<` du balisage que nous fabriquons nous-memes (le
 * `<b>` de la valeur) traversent tels quels : ils sont licites dans une valeur
 * d'attribut, et c'est bien eux que l'on veut voir vivre dans la bulle.
 */
function attrEscHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

/**
 * Attributs d'info-bulle.
 * `tipHtml` est du balisage fabrique ici, dont les parties variables sont deja
 * passees par esc(). `plainLabel` est du TEXTE BRUT : il ne doit pas etre
 * pre-echappe (voir attrEscText).
 */
function tipAttrs(tipHtml, plainLabel, focusable) {
  var out = ' data-tip="' + attrEscHtml(tipHtml) + '"';
  if (plainLabel) out += ' aria-label="' + attrEscText(plainLabel) + '"';
  if (focusable) out += ' tabindex="0"';
  return out;
}

/** Mise en forme par defaut : entier tel quel, decimal a la francaise. */
function defaultFormat(v) {
  var x = num(v, 0);
  if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
  return String(Math.round(x * 10) / 10).replace('.', ',');
}

/** Pas de graduation « rond » (1, 2, 2.5, 5, 10 x puissance de 10). */
function niceStep(raw) {
  var x = num(raw, 1);
  if (!(x > 0)) return 1;
  var mag = Math.pow(10, Math.floor(Math.log10(x)));
  var norm = x / mag;
  var mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

/** Sommet d'axe « rond », divisible par (ticks - 1). Toujours strictement > 0. */
function niceMax(maxValue, ticks) {
  var t = Math.max(2, num(ticks, 5));
  var m = num(maxValue, 0);
  if (!(m > 0)) return 1;
  var top = niceStep(m / (t - 1)) * (t - 1);
  return top > 0 ? top : 1;
}

/** Identifiant unique par graphique : deux degrades homonymes se telescopent. */
var uidSeq = 0;
function gid(prefix) {
  uidSeq += 1;
  return 'kc-' + prefix + '-' + uidSeq;
}

/**
 * Un libelle sur `stride` : au-dela d'une quinzaine de categories, les libelles
 * se chevauchent et l'axe devient illisible.
 */
function labelStride(n, maxLabels) {
  var max = Math.max(1, num(maxLabels, 12));
  return Math.max(1, Math.ceil(num(n, 1) / max));
}

/**
 * Au-dela de ce nombre d'elements, on n'ajoute plus tabindex : 92 arrets de
 * tabulation dans un seul graphique transformeraient le clavier en piege.
 */
var MAX_FOCUSABLE = 40;

/** Enveloppe commune : .chart-wrap est le repere de position de .chart-tip. */
function wrap(inner, legendHtml) {
  return '<div class="chart-wrap">' + inner +
    (legendHtml || '') +
    '<div class="chart-tip" hidden></div></div>';
}

/** Etat vide : on le dit dans le graphique, on ne renvoie pas une chaine vide. */
function emptyChart(height, message, titleText) {
  var H = clamp(height, 60, 2000);
  var W = 600;
  return wrap(
    '<svg class="chart" viewBox="0 0 ' + W + ' ' + r2(H) + '" width="100%"' +
    ' preserveAspectRatio="xMidYMid meet" role="img">' +
    '<title>' + esc(titleText || 'Graphique sans donnée') + '</title>' +
    '<text class="axis-label" x="' + r2(W / 2) + '" y="' + r2(H / 2) + '" text-anchor="middle">' +
    esc(message || 'Aucune donnée sur la période') + '</text>' +
    '</svg>'
  );
}

/* -----------------------------------------------------------------------------
   2. Histogramme — le bloc principal de la maquette
   -------------------------------------------------------------------------- */

/**
 * barChart({ data, height, maxTicks, gradient, color, showTrack, format })
 *
 * data    : [{ label, value, hint? }]
 * gradient: true par defaut (degrade corail -> orange de la maquette)
 * showTrack : true par defaut (piste claire sur toute la hauteur du trace)
 * format  : (value) => string, sert a l'axe et a l'info-bulle
 *
 * Les valeurs negatives sont ramenees a zero pour la geometrie (un volume
 * d'appels ne peut pas etre negatif) mais restent affichees dans l'info-bulle :
 * on ne masque jamais une donnee anormale, on la signale.
 */
export function barChart(opts) {
  var o = opts || {};
  var data = Array.isArray(o.data) ? o.data : [];
  var H = opt(o.height, 220, 60, 2000);
  if (!data.length) return emptyChart(H, 'Aucune donnée sur la période', 'Histogramme vide');

  var ticks = Math.round(opt(o.maxTicks, 5, 2, 8));
  var useGradient = o.gradient !== false;
  var showTrack = o.showTrack !== false;
  var flatColor = safeColor(o.color, 'var(--in)');
  var fmt = typeof o.format === 'function' ? o.format : defaultFormat;

  var n = data.length;
  var padL = 34, padR = 10, padT = 12, padB = 24;
  var plotH = Math.max(24, H - padT - padB);

  // Pas et largeur nominale : la largeur de barre fait le tiers du pas, ce qui
  // donne les barres etroites et tres espacees de la maquette.
  var stepWanted = clamp(600 / n, 9, 58);
  var plotW = Math.max(n * stepWanted, 220);
  var step = plotW / n;
  var W = padL + plotW + padR;
  var barW = clamp(step / 3, 2, 30);
  var baseY = padT + plotH;

  var values = [];
  var i;
  for (i = 0; i < n; i++) values.push(num(data[i] && data[i].value, 0));

  var rawMax = 0;
  for (i = 0; i < n; i++) if (values[i] > rawMax) rawMax = values[i];
  var axisTop = niceMax(rawMax, ticks);

  var gradId = useGradient ? gid('bargrad') : '';
  var focusable = n <= MAX_FOCUSABLE;
  var stride = labelStride(n, 14);

  var svg = '';
  svg += '<svg class="chart" viewBox="0 0 ' + r2(W) + ' ' + r2(H) + '" width="100%"' +
    ' preserveAspectRatio="xMidYMid meet" role="img">';
  svg += '<title>' + esc('Histogramme : ' + n +
    (n > 1 ? ' catégories, maximum ' : ' catégorie, maximum ') + fv(fmt, rawMax)) + '</title>';

  if (useGradient) {
    svg += '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--grad-bar-svg-top)"/>' +
      '<stop offset="1" style="stop-color:var(--grad-bar-svg-bottom)"/>' +
      '</linearGradient></defs>';
  }

  // Axe des ordonnees : 5 graduations, aucune ligne de grille (choix maquette).
  for (i = 0; i < ticks; i++) {
    var frac = i / (ticks - 1);
    var ty = baseY - plotH * frac;
    svg += '<text class="axis-value" x="' + r2(padL - 7) + '" y="' + r2(ty + 3.5) +
      '" text-anchor="end">' + esc(fv(fmt, axisTop * frac)) + '</text>';
  }

  var barFill = useGradient ? 'url(#' + gradId + ')' : flatColor;

  for (i = 0; i < n; i++) {
    var d = data[i] || {};
    var v = values[i];
    var cx = padL + step * (i + 0.5);
    var bx = cx - barW / 2;

    if (showTrack) {
      svg += '<rect class="bar-track" x="' + r2(bx) + '" y="' + r2(padT) +
        '" width="' + r2(barW) + '" height="' + r2(plotH) +
        '" rx="' + r2(barW / 2) + '"/>';
    }

    // Une valeur strictement positive reste visible meme tres petite, sinon
    // « 1 appel » disparaitrait purement et simplement du graphique.
    var bh = v > 0 ? Math.max(3, Math.min(plotH, (v / axisTop) * plotH)) : 0;
    if (bh > 0) {
      svg += '<rect x="' + r2(bx) + '" y="' + r2(baseY - bh) +
        '" width="' + r2(barW) + '" height="' + r2(bh) +
        '" rx="' + r2(Math.min(barW / 2, bh / 2)) +
        '" style="fill:' + barFill + '"/>';
    }

    var label = d.label === null || d.label === undefined ? '' : String(d.label);
    var hint = d.hint === null || d.hint === undefined ? '' : String(d.hint);
    var shown = fv(fmt, v);
    var tipHtml = (label ? esc(label) + ' · ' : '') + '<b>' + esc(shown) + '</b>' +
      (hint ? ' · ' + esc(hint) : '');
    var plain = (label ? label + ' : ' : '') + shown + (hint ? ' (' + hint + ')' : '');

    // Zone sensible pleine hauteur : viser une barre de 3 px a la souris est
    // impossible, on rend toute la colonne survolable.
    svg += '<rect x="' + r2(cx - step / 2) + '" y="' + r2(padT) +
      '" width="' + r2(step) + '" height="' + r2(plotH) +
      '" fill="transparent" pointer-events="all"' +
      tipAttrs(tipHtml, plain, focusable) + '/>';

    if (label && i % stride === 0) {
      svg += '<text class="axis-label" x="' + r2(cx) + '" y="' + r2(H - 7) +
        '" text-anchor="middle">' + esc(label) + '</text>';
    }
  }

  svg += '</svg>';
  return wrap(svg);
}

/* -----------------------------------------------------------------------------
   3. Courbes d'aire — une a trois series
   -------------------------------------------------------------------------- */

/**
 * Trace lisse SANS depassement : les tangentes sont horizontales a chaque
 * point, donc la courbe reste toujours dans l'intervalle des deux valeurs
 * qu'elle relie. Une interpolation de Catmull-Rom, elle, inventerait des
 * sommets au-dessus du maximum reel — inacceptable pour un outil de mesure.
 */
function linePath(pts, smooth) {
  if (!pts.length) return '';
  var d = 'M' + r2(pts[0].x) + ' ' + r2(pts[0].y);
  for (var i = 1; i < pts.length; i++) {
    var p0 = pts[i - 1], p1 = pts[i];
    if (smooth) {
      var dx = (p1.x - p0.x) / 3;
      d += ' C' + r2(p0.x + dx) + ' ' + r2(p0.y) +
        ' ' + r2(p1.x - dx) + ' ' + r2(p1.y) +
        ' ' + r2(p1.x) + ' ' + r2(p1.y);
    } else {
      d += ' L' + r2(p1.x) + ' ' + r2(p1.y);
    }
  }
  return d;
}

/**
 * areaChart({ series, height, showDots })
 *
 * series : [{ name, color, points:[{ label, value }] }] — 3 series au maximum
 * Les points dont la valeur n'est pas finie sont des TROUS : la ligne est
 * coupee, elle ne saute pas d'un point a l'autre en pretendant une continuite.
 */
export function areaChart(opts) {
  var o = opts || {};
  var rawSeries = Array.isArray(o.series) ? o.series.slice(0, 3) : [];
  var H = opt(o.height, 220, 60, 2000);

  var series = [];
  var i, j;
  for (i = 0; i < rawSeries.length; i++) {
    var s = rawSeries[i] || {};
    var pts = Array.isArray(s.points) ? s.points : [];
    if (!pts.length) continue;
    series.push({
      name: typeof s.name === 'string' && s.name ? s.name : 'Série ' + (series.length + 1),
      color: safeColor(s.color, seriesColor(series.length)),
      points: pts
    });
  }
  if (!series.length) return emptyChart(H, 'Aucune donnée sur la période', 'Courbe vide');

  var count = 0;
  for (i = 0; i < series.length; i++) if (series[i].points.length > count) count = series[i].points.length;

  var ticks = Math.round(opt(o.maxTicks, 5, 2, 8));
  var fmt = typeof o.format === 'function' ? o.format : defaultFormat;
  var smooth = o.smooth !== false;

  var padL = 34, padR = 12, padT = 12, padB = 24;
  var plotH = Math.max(24, H - padT - padB);
  var plotW = Math.max(240, Math.min(1000, count * 22));
  var W = padL + plotW + padR;
  var baseY = padT + plotH;

  // Domaine : on inclut toujours zero pour que l'aire ait une base honnete.
  var lo = 0, hi = 0, seen = false;
  for (i = 0; i < series.length; i++) {
    for (j = 0; j < series[i].points.length; j++) {
      var p = series[i].points[j];
      if (!p || !isPlottable(p.value)) continue;
      var v = num(p.value, 0);
      if (!seen) { lo = Math.min(0, v); hi = v; seen = true; }
      else { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  if (!seen) return emptyChart(H, 'Aucune donnée sur la période', 'Courbe vide');
  if (lo > 0) lo = 0;
  var topV = niceMax(hi, ticks);
  if (!(topV > lo)) topV = lo + 1;
  var span = topV - lo;

  // Une seule abscisse : on centre, et surtout on ne divise pas par zero.
  function xAt(k) {
    if (count <= 1) return padL + plotW / 2;
    return padL + (plotW * num(k, 0)) / (count - 1);
  }
  function yAt(value) {
    return baseY - plotH * ((num(value, lo) - lo) / span);
  }

  var stepX = count <= 1 ? plotW : plotW / (count - 1);
  var zeroY = yAt(0);
  var focusable = count <= MAX_FOCUSABLE;
  // Les points ne sont marques que quand ils restent lisibles ; au-dela ils
  // forment un chapelet illisible qui masque la ligne.
  var showDots = o.showDots === undefined ? count <= 14 : !!o.showDots;

  var svg = '';
  svg += '<svg class="chart" viewBox="0 0 ' + r2(W) + ' ' + r2(H) + '" width="100%"' +
    ' preserveAspectRatio="xMidYMid meet" role="img">';
  var names = [];
  for (i = 0; i < series.length; i++) names.push(series[i].name);
  svg += '<title>' + esc('Évolution : ' + names.join(', ') + ' sur ' + count +
    (count > 1 ? ' points' : ' point')) + '</title>';

  var gradIds = [];
  svg += '<defs>';
  for (i = 0; i < series.length; i++) {
    gradIds.push(gid('areagrad'));
    svg += '<linearGradient id="' + gradIds[i] + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:' + series[i].color + ';stop-opacity:0.30"/>' +
      '<stop offset="1" style="stop-color:' + series[i].color + ';stop-opacity:0"/>' +
      '</linearGradient>';
  }
  svg += '</defs>';

  for (i = 0; i < ticks; i++) {
    var frac = i / (ticks - 1);
    var ty = baseY - plotH * frac;
    svg += '<text class="axis-value" x="' + r2(padL - 7) + '" y="' + r2(ty + 3.5) +
      '" text-anchor="end">' + esc(fv(fmt, lo + span * frac)) + '</text>';
  }

  // Aires d'abord, lignes ensuite : la ligne d'une serie ne doit jamais passer
  // sous l'aire d'une autre.
  var runsPerSeries = [];
  for (i = 0; i < series.length; i++) {
    var runs = [];
    var current = [];
    for (j = 0; j < count; j++) {
      var pt = series[i].points[j];
      if (pt && isPlottable(pt.value)) {
        current.push({ x: xAt(j), y: yAt(num(pt.value, 0)) });
      } else if (current.length) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length) runs.push(current);
    runsPerSeries.push(runs);
  }

  for (i = 0; i < series.length; i++) {
    for (j = 0; j < runsPerSeries[i].length; j++) {
      var run = runsPerSeries[i][j];
      if (run.length < 2) continue;
      var dArea = linePath(run, smooth) +
        ' L' + r2(run[run.length - 1].x) + ' ' + r2(zeroY) +
        ' L' + r2(run[0].x) + ' ' + r2(zeroY) + ' Z';
      svg += '<path d="' + dArea + '" style="fill:url(#' + gradIds[i] + ')"/>';
    }
  }

  for (i = 0; i < series.length; i++) {
    for (j = 0; j < runsPerSeries[i].length; j++) {
      var runL = runsPerSeries[i][j];
      if (runL.length < 2) {
        // Point isole : sans marqueur il serait invisible.
        if (runL.length === 1) {
          svg += '<circle cx="' + r2(runL[0].x) + '" cy="' + r2(runL[0].y) +
            '" r="2.6" style="fill:' + series[i].color + '"/>';
        }
        continue;
      }
      svg += '<path d="' + linePath(runL, smooth) + '" style="fill:none;stroke:' +
        series[i].color + ';stroke-width:2;stroke-linecap:round;stroke-linejoin:round"/>';
      if (showDots) {
        for (var k = 0; k < runL.length; k++) {
          svg += '<circle cx="' + r2(runL[k].x) + '" cy="' + r2(runL[k].y) +
            '" r="2.6" style="fill:var(--surface);stroke:' + series[i].color +
            ';stroke-width:1.6"/>';
        }
      }
    }
  }

  // Une zone sensible par abscisse, qui recapitule toutes les series : c'est la
  // comparaison entre series qui interesse, pas une valeur isolee.
  var stride = labelStride(count, 10);
  for (j = 0; j < count; j++) {
    var xc = xAt(j);
    var lab = '';
    for (i = 0; i < series.length && !lab; i++) {
      var lp = series[i].points[j];
      if (lp && lp.label !== null && lp.label !== undefined && lp.label !== '') lab = String(lp.label);
    }
    var parts = [], plainParts = [];
    for (i = 0; i < series.length; i++) {
      var sp = series[i].points[j];
      var txt = sp && isPlottable(sp.value) ? fv(fmt, sp.value) : '—';
      parts.push(esc(series[i].name) + ' <b>' + esc(txt) + '</b>');
      plainParts.push(series[i].name + ' : ' + txt);
    }
    var tipHtml = (lab ? esc(lab) + ' · ' : '') + parts.join(' · ');
    var plain = (lab ? lab + ' — ' : '') + plainParts.join(', ');

    svg += '<rect x="' + r2(xc - stepX / 2) + '" y="' + r2(padT) +
      '" width="' + r2(stepX) + '" height="' + r2(plotH) +
      '" fill="transparent" pointer-events="all"' +
      tipAttrs(tipHtml, plain, focusable) + '/>';

    if (lab && j % stride === 0) {
      svg += '<text class="axis-label" x="' + r2(xc) + '" y="' + r2(H - 7) +
        '" text-anchor="middle">' + esc(lab) + '</text>';
    }
  }

  svg += '</svg>';

  var legend = '';
  if (series.length > 1) {
    legend = '<div class="chart-legend">';
    for (i = 0; i < series.length; i++) {
      legend += '<span class="chart-legend-item">' +
        '<span class="chart-legend-swatch" style="background:' + series[i].color + '"></span>' +
        esc(series[i].name) + '</span>';
    }
    legend += '</div>';
  }
  return wrap(svg, legend);
}

/* -----------------------------------------------------------------------------
   4. Anneau
   -------------------------------------------------------------------------- */

function polar(cx, cy, radius, deg) {
  var a = ((num(deg, 0) - 90) * Math.PI) / 180;
  return { x: num(cx, 0) + num(radius, 0) * Math.cos(a), y: num(cy, 0) + num(radius, 0) * Math.sin(a) };
}

/** Secteur d'anneau entre deux angles, en degres, sens horaire depuis le haut. */
function arcPath(cx, cy, rOut, rIn, a1, a2) {
  var large = Math.abs(num(a2, 0) - num(a1, 0)) > 180 ? 1 : 0;
  var o1 = polar(cx, cy, rOut, a1), o2 = polar(cx, cy, rOut, a2);
  var i2 = polar(cx, cy, rIn, a2), i1 = polar(cx, cy, rIn, a1);
  return 'M' + r2(o1.x) + ' ' + r2(o1.y) +
    ' A' + r2(rOut) + ' ' + r2(rOut) + ' 0 ' + large + ' 1 ' + r2(o2.x) + ' ' + r2(o2.y) +
    ' L' + r2(i2.x) + ' ' + r2(i2.y) +
    ' A' + r2(rIn) + ' ' + r2(rIn) + ' 0 ' + large + ' 0 ' + r2(i1.x) + ' ' + r2(i1.y) + ' Z';
}

/**
 * donutChart({ slices, size, thickness, center })
 *
 * slices : [{ label, value, color }] — les valeurs negatives sont ignorees
 * center : chaine, ou { value, label } pour deux lignes
 *
 * Taille en pixels assumee (pas de largeur 100 %) : un anneau qui s'etire a la
 * largeur d'une carte devient enorme. `svg { max-width: 100% }` de base.css le
 * fait quand meme rentrer dans un conteneur etroit, sans deformation.
 */
export function donutChart(opts) {
  var o = opts || {};
  var size = opt(o.size, 168, 60, 600);
  var thickness = opt(o.thickness, Math.max(10, size * 0.17), 4, Math.max(5, size / 2 - 4));
  var fmt = typeof o.format === 'function' ? o.format : defaultFormat;

  var raw = Array.isArray(o.slices) ? o.slices : [];
  var slices = [];
  var total = 0;
  var i;
  for (i = 0; i < raw.length; i++) {
    var s = raw[i] || {};
    var v = num(s.value, 0);
    if (!(v > 0)) continue;
    slices.push({
      label: s.label === null || s.label === undefined ? '' : String(s.label),
      value: v,
      color: safeColor(s.color, seriesColor(slices.length))
    });
    total += v;
  }

  var cx = size / 2, cy = size / 2;
  var rOut = size / 2 - 1;
  var rIn = Math.max(1, rOut - thickness);
  var focusable = slices.length <= MAX_FOCUSABLE;

  var titleText = total > 0
    ? 'Répartition en anneau : ' + slices.length +
      (slices.length > 1 ? ' parts, total ' : ' part, total ') + fv(fmt, total)
    : 'Répartition en anneau : aucune donnée';

  var svg = '<svg viewBox="0 0 ' + r2(size) + ' ' + r2(size) + '" width="' + r2(size) +
    '" height="' + r2(size) + '" preserveAspectRatio="xMidYMid meet" role="img">' +
    '<title>' + esc(titleText) + '</title>';

  if (total <= 0) {
    // Anneau creux : la place du graphique reste occupee, l'absence est lisible.
    svg += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2((rOut + rIn) / 2) +
      '" style="fill:none;stroke:var(--surface-sunken);stroke-width:' + r2(thickness) + '"/>';
  } else if (slices.length === 1) {
    // Un cercle complet : un arc de 360 degres degenere en un point.
    var only = fv(fmt, slices[0].value);
    svg += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2((rOut + rIn) / 2) +
      '" style="fill:none;stroke:' + slices[0].color + ';stroke-width:' + r2(thickness) + '"' +
      tipAttrs((slices[0].label ? esc(slices[0].label) + ' · ' : '') + '<b>' + esc(only) + '</b> · 100 %',
        (slices[0].label ? slices[0].label + ' : ' : '') + only + ', 100 %', focusable) + '/>';
  } else {
    var angle = 0;
    for (i = 0; i < slices.length; i++) {
      var share = slices[i].value / total;
      var sweep = Math.min(359.99, share * 360);
      if (!(sweep > 0.01)) { angle += sweep; continue; }
      var pct = String(Math.round(share * 1000) / 10).replace('.', ',');
      var shown = fv(fmt, slices[i].value);
      var tip = (slices[i].label ? esc(slices[i].label) + ' · ' : '') +
        '<b>' + esc(shown) + '</b> · ' + esc(pct) + ' %';
      var plain = (slices[i].label ? slices[i].label + ' : ' : '') +
        shown + ' (' + pct + ' %)';
      svg += '<path d="' + arcPath(cx, cy, rOut, rIn, angle, angle + sweep) +
        '" style="fill:' + slices[i].color + '"' +
        tipAttrs(tip, plain, focusable) + '/>';
      angle += sweep;
    }
  }

  var center = o.center;
  if (center) {
    var big = '', small = '';
    if (typeof center === 'string' || typeof center === 'number') {
      big = String(center);
    } else if (typeof center === 'object') {
      big = center.value === null || center.value === undefined ? '' : String(center.value);
      small = center.label === null || center.label === undefined ? '' : String(center.label);
    }
    // dy explicite plutot que dominant-baseline : rendu identique partout.
    if (big) {
      svg += '<text x="' + r2(cx) + '" y="' + r2(cy + (small ? 1 : 7)) +
        '" text-anchor="middle" style="font:var(--t-num-lg);fill:var(--ink)">' + esc(big) + '</text>';
    }
    if (small) {
      svg += '<text x="' + r2(cx) + '" y="' + r2(cy + 16) +
        '" text-anchor="middle" style="font:var(--t-micro);fill:var(--ink-muted)">' + esc(small) + '</text>';
    }
  }

  svg += '</svg>';
  return wrap(svg);
}

/* -----------------------------------------------------------------------------
   5. Carte d'affluence (7 jours x 24 heures)
   -------------------------------------------------------------------------- */

/* Libelles par defaut, index 0 = lundi (meme convention que shared/time.js). */
var DAY_LABELS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

/**
 * Intensite d'une cellule. color-mix garde --surface-sunken comme base, donc
 * une cellule vide est exactement celle du CSS. Si le moteur ne connait pas
 * color-mix, la declaration en ligne est invalide et donc ignoree : la classe
 * .heat-cell reprend la main. Degradation propre, sans test de capacite.
 */
function heatStyle(t) {
  var x = clamp(t, 0, 1);
  if (!(x > 0)) return '';
  // Racine adoucie : sans elle, une seule heure de pointe ecrase tout le reste.
  var pct = Math.round(10 + 90 * Math.pow(x, 0.6));
  return ' style="background:color-mix(in srgb, var(--in) ' + pct + '%, var(--surface-sunken))"';
}

/**
 * heatmap({ matrix, max, rowLabels, format })
 *
 * matrix : number[7][24], index 0 = lundi. Les cases absentes valent zero.
 * Rendu en HTML (classes .heat*, deja definies dans components.css) : 168
 * rectangles SVG couteraient plus cher qu'une grille CSS.
 *
 * Les cellules ne sont PAS focusables : 168 arrets de tabulation seraient un
 * piege au clavier. Le resume accessible est porte par aria-label du bloc.
 */
export function heatmap(opts) {
  var o = opts || {};
  var matrix = Array.isArray(o.matrix) ? o.matrix : [];
  var labels = Array.isArray(o.rowLabels) && o.rowLabels.length >= 7 ? o.rowLabels : DAY_LABELS;
  var fmt = typeof o.format === 'function' ? o.format : defaultFormat;

  var grid = [];
  var total = 0, found = 0;
  var r, c;
  for (r = 0; r < 7; r++) {
    var row = Array.isArray(matrix[r]) ? matrix[r] : [];
    var out = [];
    for (c = 0; c < 24; c++) {
      var v = num(row[c], 0);
      if (v < 0) v = 0;
      out.push(v);
      total += v;
      if (v > found) found = v;
    }
    grid.push(out);
  }

  var max = num(o.max, 0);
  if (!(max > 0)) max = found;

  if (!(total > 0)) {
    return wrap('<div class="empty"><span class="empty-title">Aucune activité</span>' +
      '<span>Pas d\'appel sur la période sélectionnée.</span></div>');
  }

  var html = '<div class="heat" role="img" aria-label="' +
    attrEscText('Carte d\'affluence par jour et par heure. Maximum ' + fv(fmt, max) +
      ' pour une case, ' + fv(fmt, total) + ' au total.') + '">';

  for (r = 0; r < 7; r++) {
    html += '<div class="heat-row"><span class="heat-label">' + esc(String(labels[r])) + '</span>';
    for (c = 0; c < 24; c++) {
      var value = grid[r][c];
      var t = max > 0 ? value / max : 0;
      var hourLab = (c < 10 ? '0' + c : String(c)) + ' h';
      var tip = esc(String(labels[r])) + ' ' + esc(hourLab) + ' · <b>' + esc(fv(fmt, value)) + '</b>';
      html += '<span class="heat-cell"' + heatStyle(t) +
        ' data-tip="' + attrEscHtml(tip) + '"></span>';
    }
    html += '</div>';
  }

  // Axe des heures : sans lui, impossible de situer une colonne.
  html += '<div class="heat-row"><span class="heat-label"></span>';
  for (c = 0; c < 24; c++) {
    html += '<span class="heat-label nowrap">' + (c % 6 === 0 ? esc(String(c)) : '') + '</span>';
  }
  html += '</div>';
  html += '</div>';

  var legend = '<div class="heat-legend"><span>Moins</span>';
  var steps = [0, 0.25, 0.5, 0.75, 1];
  for (var i = 0; i < steps.length; i++) {
    legend += '<span class="heat-legend-cell"' + heatStyle(steps[i]) + '></span>';
  }
  legend += '<span>Plus</span><span class="muted">' +
    esc('jusqu\'à ' + fv(fmt, max) + ' par heure') + '</span></div>';

  return wrap(html, legend);
}

/* -----------------------------------------------------------------------------
   6. Micro-courbe
   -------------------------------------------------------------------------- */

/**
 * sparkline({ values, width, height, color }) — courbe minuscule, sans axe,
 * destinee a une cellule de tableau. Taille en pixels : c'est une glyphe.
 */
export function sparkline(opts) {
  var o = opts || {};
  var raw = Array.isArray(o.values) ? o.values : [];
  var w = opt(o.width, 88, 20, 600);
  var h = opt(o.height, 26, 8, 200);
  var color = safeColor(o.color, 'var(--in)');

  var vals = [];
  var i;
  for (i = 0; i < raw.length; i++) if (isPlottable(raw[i])) vals.push(num(raw[i], 0));

  var head = '<svg viewBox="0 0 ' + r2(w) + ' ' + r2(h) + '" width="' + r2(w) +
    '" height="' + r2(h) + '" preserveAspectRatio="none" role="img">';

  if (!vals.length) {
    return head + '<title>' + esc('Micro-courbe sans donnée') + '</title></svg>';
  }

  var pad = 2;
  var lo = vals[0], hi = vals[0];
  for (i = 1; i < vals.length; i++) {
    if (vals[i] < lo) lo = vals[i];
    if (vals[i] > hi) hi = vals[i];
  }
  var span = hi - lo;
  var innerH = Math.max(1, h - pad * 2);
  var innerW = Math.max(1, w - pad * 2);

  var pts = [];
  for (i = 0; i < vals.length; i++) {
    // Serie plate ou point unique : on trace au milieu, jamais de /0.
    var x = vals.length === 1 ? pad + innerW / 2 : pad + (innerW * i) / (vals.length - 1);
    var y = span > 0 ? pad + innerH * (1 - (vals[i] - lo) / span) : pad + innerH / 2;
    pts.push({ x: x, y: y });
  }

  var d = pts.length === 1
    ? 'M' + r2(pts[0].x - 1) + ' ' + r2(pts[0].y) + ' L' + r2(pts[0].x + 1) + ' ' + r2(pts[0].y)
    : linePath(pts, false);

  return head +
    '<title>' + esc('Micro-courbe, ' + vals.length + ' points, de ' +
      defaultFormat(lo) + ' à ' + defaultFormat(hi)) + '</title>' +
    // non-scaling-stroke : preserveAspectRatio="none" etirerait sinon le trait.
    '<path d="' + d + '" vector-effect="non-scaling-stroke" style="fill:none;stroke:' +
    color + ';stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round"/>' +
    '</svg>';
}

/* -----------------------------------------------------------------------------
   7. Info-bulles
   -------------------------------------------------------------------------- */

/* Un seul jeu d'ecouteurs par racine : la memoire permet de les retirer quand
   attachChartTips est rappele sur la meme racine, sinon chaque re-rendu
   empilerait un jeu supplementaire. */
var wired = typeof WeakMap === 'function' ? new WeakMap() : null;

var TIP_EVENTS = ['pointerover', 'pointermove', 'pointerout', 'pointerleave', 'focusin', 'focusout', 'keydown'];

/**
 * attachChartTips(root) — cable les info-bulles des graphiques contenus dans
 * `root`. Idempotent : un second appel remplace le cablage precedent.
 *
 * La delegation se fait sur la racine, donc un graphique re-rendu ensuite dans
 * la meme racine reste couvert sans nouvel appel.
 */
export function attachChartTips(root) {
  if (!root || typeof root.addEventListener !== 'function' || typeof document === 'undefined') return;

  var previous = wired ? wired.get(root) : null;
  if (previous) {
    previous.detach();
    if (wired) wired.delete(root);
  }

  var active = null;

  function tipOf(el) {
    var box = el && typeof el.closest === 'function' ? el.closest('.chart-wrap') : null;
    if (!box) return null;
    var tip = box.querySelector('.chart-tip');
    if (!tip) {
      // La bulle peut manquer si le balisage a ete assemble a la main.
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.hidden = true;
      box.appendChild(tip);
    }
    return { box: box, tip: tip };
  }

  function place(ctx, el, ev) {
    var boxRect = ctx.box.getBoundingClientRect();
    var x, y;
    if (ev && Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)) {
      // Au pointeur : c'est la que l'oeil est deja.
      x = ev.clientX - boxRect.left;
      y = ev.clientY - boxRect.top;
    } else {
      var elRect = el.getBoundingClientRect();
      x = elRect.left - boxRect.left + elRect.width / 2;
      y = elRect.top - boxRect.top + Math.min(elRect.height / 2, 24);
    }
    var half = ctx.tip.offsetWidth / 2;
    var minX = half + 2;
    var maxX = Math.max(minX, boxRect.width - half - 2);
    if (x < minX) x = minX;
    if (x > maxX) x = maxX;
    if (!(y > 0)) y = 0;
    ctx.tip.style.left = r2(x) + 'px';
    ctx.tip.style.top = r2(y) + 'px';
  }

  function show(el, ev) {
    var ctx = tipOf(el);
    if (!ctx) return;
    var content = el.getAttribute('data-tip');
    if (!content) return;
    // `content` arrive de `data-tip`, que le parseur a deja decode une fois.
    // C'est pour survivre a ce decodage que la valeur est ecrite DOUBLEMENT
    // echappee par attrEscHtml : ce qu'on lit ici est donc la chaine simplement
    // echappee, ou seul le <b> fabrique par ce module est du balisage vivant.
    // C'est cela, et cela seul, qui autorise innerHTML.
    if (active !== el) ctx.tip.innerHTML = content;
    ctx.tip.hidden = false;
    active = el;
    place(ctx, el, ev);
  }

  function hide() {
    if (!active) return;
    var ctx = tipOf(active);
    if (ctx) ctx.tip.hidden = true;
    active = null;
  }

  function target(ev) {
    var t = ev && ev.target;
    if (!t || typeof t.closest !== 'function') return null;
    return t.closest('[data-tip]');
  }

  function onOver(ev) {
    var el = target(ev);
    if (el) show(el, ev);
    else hide();
  }

  function onMove(ev) {
    var el = target(ev);
    if (!el) { hide(); return; }
    show(el, ev);
  }

  function onOut(ev) {
    var el = target(ev);
    // pointerout se declenche aussi en passant d'une colonne a la suivante :
    // on ne masque que si le pointeur quitte vraiment l'element actif.
    if (!el || el === active) hide();
  }

  function onLeave() { hide(); }

  function onFocusIn(ev) {
    var el = target(ev);
    if (el) show(el, null);
    else hide();
  }

  function onFocusOut() { hide(); }

  function onKeyDown(ev) {
    if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) hide();
  }

  var handlers = {
    pointerover: onOver,
    pointermove: onMove,
    pointerout: onOut,
    pointerleave: onLeave,
    focusin: onFocusIn,
    focusout: onFocusOut,
    keydown: onKeyDown
  };

  // Sans capture, volontairement : tous ces evenements remontent, sauf
  // pointerleave, qui ne doit justement se declencher que quand le pointeur
  // quitte la racine — en capture il se declencherait a chaque changement de
  // colonne et ferait clignoter la bulle.
  var i;
  for (i = 0; i < TIP_EVENTS.length; i++) {
    root.addEventListener(TIP_EVENTS[i], handlers[TIP_EVENTS[i]]);
  }

  function detach() {
    hide();
    for (var k = 0; k < TIP_EVENTS.length; k++) {
      root.removeEventListener(TIP_EVENTS[k], handlers[TIP_EVENTS[k]]);
    }
  }

  if (wired) wired.set(root, { detach: detach });
}
