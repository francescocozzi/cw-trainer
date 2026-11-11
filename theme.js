"use strict";
// Caricato nell'<head>: applica il tema salvato prima del primo disegno, così di notte
// non lampeggia la pagina chiara. Il tema è per dispositivo e non passa dal server.
(function () {
  let t = null;
  try { t = localStorage.getItem("cw-theme"); } catch (e) {}
  if (t === "light" || t === "dark" || t === "night") document.documentElement.dataset.theme = t;
})();
