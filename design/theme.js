// conet · theme runtime (vanilla JS variant for static HTML targets)
// Mirrors the API of design/theme.tsx without React.
// Usage:
//   <script src="/design/theme.js"></script>
//   <script>conet.theme.set('light');</script>

(function () {
  var KEY = "conet:theme";
  var DEFAULT = "dark";
  var THEMES = ["dark", "light"];

  function isTheme(v) { return THEMES.indexOf(v) >= 0; }

  function getTheme() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (isTheme(attr)) return attr;
    try {
      var ls = localStorage.getItem(KEY);
      if (isTheme(ls)) return ls;
    } catch (e) { /* unavailable */ }
    return DEFAULT;
  }

  function setTheme(t) {
    if (!isTheme(t)) return;
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(KEY, t); } catch (e) { /* swallow */ }
    try { window.dispatchEvent(new CustomEvent("conet:theme", { detail: t })); } catch (e) { /* old */ }
  }

  function bindSwitch(rootEl) {
    if (!rootEl) return;
    var buttons = rootEl.querySelectorAll("button[data-theme-value]");
    function refresh() {
      var current = getTheme();
      buttons.forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-value") === current));
      });
    }
    buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        var v = b.getAttribute("data-theme-value");
        if (v) setTheme(v);
      });
    });
    window.addEventListener("conet:theme", refresh);
    refresh();
  }

  /** Auto-bind any [data-theme-switch] elements once DOM is ready. */
  function autoBind() {
    var els = document.querySelectorAll("[data-theme-switch]");
    els.forEach(bindSwitch);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoBind);
  } else {
    autoBind();
  }

  window.conet = window.conet || {};
  window.conet.theme = {
    KEY: KEY,
    DEFAULT: DEFAULT,
    THEMES: THEMES,
    get: getTheme,
    set: setTheme,
    bind: bindSwitch
  };
})();
