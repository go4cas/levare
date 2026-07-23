// levare landing page — the score rail's scroll behaviour, plus the two other pieces of motion
// the design amendment invites: the install command's copy affordance, and evidence settling
// into place once. No framework, no build step. Every branch below is a no-op if its DOM hook
// is missing, so this file works unmodified on any page that reuses landing.css.
(function () {
  "use strict";

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- the rail: scrollspy over each major section (amendment §1) ----------
  var rails = Array.prototype.slice.call(document.querySelectorAll("[data-rail]"));
  if (rails.length) {
    var sections = rails.map(function (r) { return r.closest("section"); });
    var TRIGGER = 140; // px from viewport top a section must cross to read as "in view"
    var gateArrived = false;

    var updateRail = function () {
      var activeIndex = -1;
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].getBoundingClientRect().top <= TRIGGER) activeIndex = i;
      }
      // a short final section can never cross the trigger line if the page can't scroll that
      // far — at true page-bottom the last node reads as active regardless of its own height.
      var atBottom = window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 2;
      if (atBottom) activeIndex = sections.length - 1;
      rails.forEach(function (rail, i) {
        var state = i < activeIndex ? "passed" : i === activeIndex ? "active" : "upcoming";
        rail.setAttribute("data-state", state);

        // the gate diamond arrives once, with brass treatment, the instant its section is
        // reached — the page's one theatrical beat (amendment §4). Never re-triggered.
        if (rail.hasAttribute("data-gate") && state !== "upcoming" && !gateArrived) {
          gateArrived = true;
          var node = rail.querySelector(".rail-node.is-gate");
          if (node) {
            node.classList.add("is-arrived");
            if (!reduceMotion) node.classList.add("is-arriving");
          }
        }
      });
    };

    var ticking = false;
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () { updateRail(); ticking = false; });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    updateRail();
  }

  // ---------- evidence settling into place once, as it enters view (amendment §4) ----------
  // Progressive enhancement: the hidden starting state is only applied here, in script, and only
  // when motion is allowed — so with JS off or motion reduced, every card is simply visible.
  if (!reduceMotion && "IntersectionObserver" in window) {
    var revealEls = document.querySelectorAll("[data-reveal]");
    revealEls.forEach(function (el) { el.classList.add("js-reveal"); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in-view");
        io.unobserve(entry.target);
      });
    }, { threshold: 0.2 });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  // ---------- install command: physical copy affordance that confirms in place ----------
  document.querySelectorAll(".copy-btn[data-copy-target]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var src = document.getElementById(btn.getAttribute("data-copy-target"));
      if (!src) return;
      var text = src.textContent;

      var confirm = function () {
        btn.classList.add("is-copied");
        window.clearTimeout(btn._copyTimer);
        btn._copyTimer = window.setTimeout(function () {
          btn.classList.remove("is-copied");
        }, 1400);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(confirm, confirm);
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* clipboard unavailable */ }
        document.body.removeChild(ta);
        confirm();
      }
    });
  });
})();
