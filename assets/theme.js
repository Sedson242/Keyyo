// Applique les preferences d'affichage AVANT le premier rendu (evite un flash
// clair en mode sombre) : theme, transparence, animations, densite et menu
// reduit, gardes dans le navigateur par app/shell.js. Script classique et non
// module, charge dans le <head> des trois pages : la CSP interdit le script en
// ligne, et un module s'executerait apres la premiere peinture.
(function () {
  try {
    var p = JSON.parse(localStorage.getItem('1call-prefs') || '{}') || {};
    var root = document.documentElement;
    if (p.theme === 'dark' || p.theme === 'light') root.setAttribute('data-theme', p.theme);
    if (p.glass === 'off') root.setAttribute('data-glass', 'off');
    if (p.motion === 'reduce') root.setAttribute('data-motion', 'reduce');
    if (p.density === 'compact') root.setAttribute('data-density', 'compact');
    if (p.nav === 'mini') root.setAttribute('data-nav', 'mini');
  } catch (err) {
    /* stockage indisponible : reglages du systeme */
  }
})();
