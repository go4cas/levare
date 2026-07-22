// levare — shared behaviour for the Phase 1 foundation showcase pages (tokens/icons/components).
// Vanilla JS, no build step. Theme toggle only — these pages have no other interactivity beyond
// what each page defines locally.
(function () {
  "use strict";
  const KEY = "levare-foundation-theme";

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.querySelector("[data-theme-toggle]");
    if (btn) btn.textContent = theme === "dark" ? "☾ dark" : "☼ light";
  }

  function current() {
    return localStorage.getItem(KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }

  document.addEventListener("DOMContentLoaded", function () {
    apply(current());
    const btn = document.querySelector("[data-theme-toggle]");
    if (btn) {
      btn.addEventListener("click", function () {
        const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        localStorage.setItem(KEY, next);
        apply(next);
      });
    }
  });
})();
