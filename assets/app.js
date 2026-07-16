/* levare — vanilla interactions. No frameworks. */
(function () {
  'use strict';

  /* ---------- theme ---------- */
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem('levare-theme'); } catch (e) {}
  if (stored === 'dark' || stored === 'light') {
    root.setAttribute('data-theme', stored);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.setAttribute('data-theme', 'light');
  }
  function themeLabel() {
    return root.getAttribute('data-theme') === 'dark' ? '\u25D0 Dark' : '\u25D1 Light';
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.textContent = themeLabel();
      btn.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('levare-theme', next); } catch (e) {}
        document.querySelectorAll('[data-theme-toggle]').forEach(function (b) { b.textContent = themeLabel(); });
      });
    });

    /* ---------- mobile rail ---------- */
    var rail = document.querySelector('.rail');
    document.querySelectorAll('[data-rail-toggle]').forEach(function (b) {
      b.addEventListener('click', function () { if (rail) rail.classList.toggle('is-open'); });
    });
    document.addEventListener('click', function (e) {
      if (rail && rail.classList.contains('is-open') &&
          !rail.contains(e.target) && !e.target.closest('[data-rail-toggle]')) {
        rail.classList.remove('is-open');
      }
    });

    /* ---------- work-unit rows expand ---------- */
    document.querySelectorAll('.unit__head').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('a, button')) return;
        row.closest('.unit').classList.toggle('is-open');
      });
    });

    /* ---------- long lists (NOTES UI11) ----------
       Left nav: a Projects/Ideas section over 7 rows renders its overflow already in the DOM, just
       `hidden` (render.ts#railLongList) — "+ N more" reveals it in place, client-side, no navigation.
       Delegated on `document` (not queried at DOMContentLoaded) because it must keep working even
       though the rail is never one of the two regions a client-side navigation swap replaces (see the
       fragment-swap notes further down) — delegation costs nothing here and needs no special-casing
       either way. */
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-rail-expand]');
      if (!btn) return;
      var overflow = btn.previousElementSibling;
      if (overflow && overflow.classList.contains('railsec__overflow')) overflow.hidden = false;
      btn.remove();
    });

    /* Registry list filter: client-side, filter-as-you-type over the entity name and the visible
       card body — never the hidden raw-markdown source (that's "Edit source" material, not what's on
       screen). Delegated on `document` (an `input` event bubbles) so it keeps working after a UI10
       fragment swap replaces `.main` with a freshly server-rendered filter input + card set, with no
       rebind step of its own. */
    document.addEventListener('input', function (e) {
      var input = e.target.closest('[data-registry-filter]');
      if (!input) return;
      var host = input.closest('.main') || document;
      var q = (input.value || '').trim().toLowerCase();
      host.querySelectorAll('.entity.card').forEach(function (card) {
        var title = card.querySelector('.entity__title');
        var rendered = card.querySelector('.rendered');
        var text = ((title ? title.textContent : '') + ' ' + (rendered ? rendered.textContent : '')).toLowerCase();
        card.classList.toggle('is-filtered-out', q.length > 0 && text.indexOf(q) === -1);
      });
    });

    /* ---------- gate cards ---------- */
    /* The board is a stateless projection (PRD invariant 2): a gate verb POSTs to the real route,
       flips frontmatter server-side and commits as the Conductor; the SSE listener below reloads on
       the fs.watch-driven re-render trigger. The local resolveGate() call is purely the felt, quiet
       motion the design brief asks for while that round-trip is in flight. */
    function postGate(card, verb, note) {
      var project = card.getAttribute('data-gate-project');
      var target = card.getAttribute('data-gate-target');
      if (!project || !target) return Promise.resolve();
      return fetch('/gates/' + encodeURIComponent(project) + '/' + encodeURIComponent(target) + '/' + encodeURIComponent(verb), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note || undefined })
      }).catch(function (err) { console.error('gate verb failed', err); });
    }

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.gate [data-verb]');
      if (!btn) return;
      var card = btn.closest('.gate');
      var verb = btn.getAttribute('data-verb');

      if (verb === 'request' || verb === 'rescope') { openNote(card, verb); return; }
      if (verb === 'cancel') { closeNote(card); return; }

      var map = {
        approve: ['approved', 'is-ok'],
        reject:  ['rejected', 'is-danger'],
        notyet:  ['not yet', 'is-neutral'],
        send:    ['changes sent', 'is-neutral'],
        skip:    ['skipped', 'is-neutral'],
        abandon: ['abandoned', 'is-danger']
      };
      var realVerb = verb === 'send' ? (card._pendingVerb || 'request') : verb;
      var note = verb === 'send' && card._note ? card._note.querySelector('.gate__note').value : undefined;
      postGate(card, realVerb, note);
      // `start`, `send` (re-invokes the producer), and `retry` (NOTES F19 — re-invokes the same
      // member, costing money again) all dispatch a real member call that can take seconds to
      // minutes — an immediate resolved-line would be a premature claim of completion. Show the quiet
      // pending state instead (NOTES F10 defect 3) and let the SSE-driven reload replace it with the
      // server's real post-production render; every other verb resolves synchronously server-side, so
      // its immediate optimistic label stays accurate.
      if (realVerb === 'start' || realVerb === 'request' || realVerb === 'retry') { markDispatching(card); return; }
      var m = map[verb];
      if (!m) return;
      resolveGate(card, m[0], m[1]);
    });

    /* Local, in-place pending feedback (NOTES UI6 — the goal's one intended behaviour change):
       a Start/Request-changes/Retry click used to wipe the WHOLE card's innerHTML with a bare
       "dispatching…" line, losing the title/producer/context underneath it until the next SSE
       reload — the anti-pattern the Conductor flagged. Mirrors render.ts#dispatchingHtml's own
       server-rendered dispatching state exactly (components.ts#pendingState's shape): only the
       verbs row and the badge text change; everything else on the card stays exactly where it was. */
    function markDispatching(card) {
      card.classList.add('is-dispatching');
      // Only the start-gate badge's text ever reads "dispatching" server-side (render.ts#gateCardHtml:
      // the default/artifact-blocked badges — "on you"/"exhausted"/"blocked" — never change on
      // dispatch, only their verbs row does) — match that exactly rather than overwriting a badge
      // whose text the server would never have changed either.
      var badge = card.querySelector('.gate__badge.is-start');
      if (badge) badge.textContent = 'dispatching';
      // `request`/`rescope` open a note (openNote, below) that appends a SECOND `.gate__verbs` (its
      // own Send/Cancel row) alongside the original, now-hidden one — target whichever is the one
      // actually on screen, via `card._note` when a note is open.
      var verbs = card._note ? card._note.querySelector('.gate__verbs') : card.querySelector('.gate__verbs');
      if (!verbs) return;
      var note = card._note ? card._note.querySelector('.gate__note') : null;
      if (note) note.disabled = true;
      verbs.classList.add('gate__verbs--pending');
      verbs.textContent = '';
      var pending = document.createElement('span');
      pending.classList.add('pending');
      var dots = document.createElement('span');
      dots.classList.add('turn--pending');
      var dotsInner = document.createElement('span');
      dotsInner.classList.add('turn__dots');
      for (var i = 0; i < 3; i++) dotsInner.appendChild(document.createElement('span'));
      dots.appendChild(dotsInner);
      var label = document.createElement('span');
      label.classList.add('pending__label');
      label.textContent = 'dispatching…';
      pending.appendChild(dots);
      pending.appendChild(label);
      verbs.appendChild(pending);
    }

    function openNote(card, verb) {
      card._pendingVerb = verb;
      var verbs = card.querySelector('.gate__verbs');
      if (card.querySelector('.gate__note')) return;
      var container = verbs.parentNode;
      var wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';
      var ta = document.createElement('textarea');
      ta.className = 'gate__note';
      ta.placeholder = verb === 'rescope' ? 'How should this be re-scoped?' : 'What needs to change?';
      var row = document.createElement('div');
      row.className = 'gate__verbs';
      row.innerHTML =
        '<button class="verb is-gate" data-verb="send">' +
        (verb === 'rescope' ? 'Send re-scope' : 'Send changes') +
        '</button><button class="verb" data-verb="cancel">Cancel</button>';
      wrap.appendChild(ta); wrap.appendChild(row);
      verbs.style.display = 'none';
      container.appendChild(wrap);
      ta.focus();
      card._note = wrap;
    }
    function closeNote(card) {
      if (card._note) { card._note.remove(); card._note = null; }
      var verbs = card.querySelector('.gate__verbs');
      if (verbs) verbs.style.display = '';
    }

    function resolveGate(card, label, cls) {
      var nameEl = card.querySelector('.gate__name');
      var name = nameEl ? nameEl.textContent : 'gate';
      card.classList.add('is-resolved');
      card.classList.remove('gate--start');
      card.classList.remove('gate--cta');
      card.innerHTML =
        '<span class="resolved-line" style="display:flex;align-items:center;gap:11px;width:100%">' +
          '<span class="dia"></span>' +
          '<a class="link">' + name + '</a>' +
          '<span class="decision ' + cls + '">' + label + '</span>' +
          '<span class="who">you \u00b7 just now</span>' +
        '</span>';
      // decrement any "needs you" counters
      var count = document.querySelector('[data-gatecount]');
      if (count) {
        var n = parseInt(count.getAttribute('data-gatecount'), 10) || 0;
        if (n > 0) { n -= 1; count.setAttribute('data-gatecount', n); count.textContent = n; }
      }
      var statN = document.querySelector('[data-gatestat]');
      if (statN) {
        var s = parseInt(statN.getAttribute('data-gatestat'), 10) || 0;
        if (s > 0) { s -= 1; statN.setAttribute('data-gatestat', s); statN.textContent = s; }
      }
    }

    /* ---------- Orchestrator conversation turns (UI8) ---------- */
    /* One turn per unbroken run of same-speaker messages: the mark (Orchestrator) or right-aligned
       accent bubble (Conductor) is the only speaker signal now, shown/applied once per turn rather
       than a "RESPONSE"/"BRIEFING" header repeated on every message (design brief item 1/4). A
       same-speaker message immediately following the last turn in `.orch__body` merges into it —
       `buildBodyEl` returns the new message element (a `<p class="turn__body">`, built via textContent
       so untrusted reply/user text is never parsed as markup); a different speaker (or an empty panel)
       starts a fresh turn instead. */
    function lastTurn(body) {
      var last = body.lastElementChild;
      return (last && last.classList.contains('turn')) ? last : null;
    }

    /* NOTES UI11: every client-appended turn (either speaker) carries a quiet caption stamped at the
       moment the turn was created — mirrors render.ts#turnCaption's markup exactly (a `.turn__caption
       mono` line, its relative-time text wrapped in `.turn__time` carrying the full ISO stamp as its
       hover `title`), so a server-rendered and a client-appended caption read identically. A brand-new
       turn is always "now" (there is no elapsed time between creating it and stamping it) — the same
       bucketing as derive.ts#captionTime exists here only so a caption that outlives a page session
       (the panel is never torn down by a client-side navigation swap) still reads as coarse minutes/
       hours/days if ever recomputed, not because this call site needs anything but "now" today. */
    function relativeCaptionText(mins) {
      if (mins < 1) return 'now';
      if (mins < 60) return mins + 'm';
      var hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h';
      return Math.floor(hours / 24) + 'd';
    }
    function buildCaption() {
      var date = new Date();
      var cap = document.createElement('div');
      cap.className = 'turn__caption mono';
      var time = document.createElement('span');
      time.className = 'turn__time';
      time.title = date.toISOString();
      time.textContent = relativeCaptionText(0);
      cap.appendChild(time);
      return cap;
    }

    function appendTurnMessage(body, speaker, buildBodyEl) {
      var last = lastTurn(body);
      var turn = (last && last.classList.contains('turn--' + speaker)) ? last : null;
      if (!turn) {
        turn = document.createElement('div');
        turn.className = 'turn turn--' + speaker;
        if (speaker === 'orch') {
          var mark = document.createElement('span');
          mark.className = 'turn__mark';
          mark.setAttribute('aria-hidden', 'true');
          mark.appendChild(document.createElement('i'));
          mark.appendChild(document.createElement('b'));
          turn.appendChild(mark);
        }
        var content = document.createElement('div');
        content.className = 'turn__content';
        turn.appendChild(content);
        body.appendChild(turn);
        turn.appendChild(buildCaption());
      }
      turn.querySelector('.turn__content').appendChild(buildBodyEl());
      body.scrollTop = body.scrollHeight;
      return turn;
    }

    /* ---------- summon gate into orchestrator ---------- */
    document.addEventListener('click', function (e) {
      var s = e.target.closest('[data-summon]');
      if (!s) return;
      e.preventDefault();
      var body = document.querySelector('.orch__body');
      if (!body) return;
      var tplId = s.getAttribute('data-summon');
      var tpl = document.getElementById(tplId);
      var narrate = s.getAttribute('data-narrate') || 'Here is the gate you asked to review.';
      appendTurnMessage(body, 'orch', function () {
        var p = document.createElement('p');
        p.className = 'turn__body';
        p.textContent = narrate;
        return p;
      });
      if (tpl) {
        var node = tpl.content.cloneNode(true);
        body.appendChild(node);
      }
      body.scrollTop = body.scrollHeight;
    });

    /* ---------- composer ---------- */
    /* A disabled composer (no ANTHROPIC_API_KEY — see render.ts#orchestratorPanel) never attaches a
       submit listener at all: the server-rendered `disabled` input already can't receive focus or
       Enter, and this is the client-side half of the same "never pretend to talk" rule (NOTES C11). */
    document.querySelectorAll('.composer:not(.is-disabled) form').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = form.querySelector('input');
        var text = (input.value || '').trim();
        if (!text) return;
        var body = form.closest('.orch').querySelector('.orch__body');
        // The Conductor's own message: right-aligned, accent bubble (item 3) \u2014 merges into the
        // previous turn if the last thing said was also the Conductor's (item 4).
        appendTurnMessage(body, 'user', function () {
          var p = document.createElement('p');
          p.className = 'turn__body';
          p.textContent = text;
          return p;
        });
        input.value = '';

        function showReply(replyText) {
          appendTurnMessage(body, 'orch', function () {
            var p = document.createElement('p');
            p.className = 'turn__body';
            p.textContent = replyText;
            return p;
          });
        }
        // An error or a disabled-state response is shown as what it is, never dressed up as an
        // Orchestrator reply (NOTES C11 \u2014 the whole point of deleting the deterministic boundary was
        // to stop a non-answer from impersonating a real one).
        function showError(errText) {
          appendTurnMessage(body, 'orch', function () {
            var p = document.createElement('p');
            p.className = 'turn__body';
            p.style.color = 'var(--danger)';
            p.textContent = errText;
            return p;
          });
        }
        // In-flight state (item 5): local and inline, exactly where the reply will land \u2014 the mark
        // plus an animated "thinking\u2026" indicator, a fresh turn right after the Conductor's own (never
        // merged into it, since the speaker differs), cleared as soon as a reply or failure arrives.
        // Never a bar/spinner that replaces more of the panel than this.
        var pendingTurn = appendTurnMessage(body, 'orch', function () {
          var p = document.createElement('p');
          p.className = 'turn__body turn--pending';
          var dots = document.createElement('span');
          dots.className = 'turn__dots';
          for (var i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
          p.appendChild(dots);
          p.appendChild(document.createTextNode('thinking\u2026'));
          return p;
        });
        pendingTurn.classList.add('turn--pending');
        input.disabled = true;
        fetch('/orchestrator/message', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text })
        }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            pendingTurn.remove();
            if (r.ok && r.data && r.data.ok) { showReply(r.data.reply || ''); }
            else { showError((r.data && (r.data.reason || r.data.error)) || 'The Orchestrator could not answer.'); }
          })
          .catch(function () {
            pendingTurn.remove();
            showError('Could not reach the board \u2014 check your connection and try again.');
          })
          .then(function () { input.disabled = false; input.focus(); });
      });
    });

    /* ---------- confirm modal (reusable primitive) ----------
       Replaces the browser's native confirm()/alert() everywhere in the product (UI4 item 1): a small
       centered panel over a dimmed backdrop, in levare's own palette, with a plain question and two
       actions (a quiet "keep editing" dismiss and a destructive "discard"). ONE instance per page
       (render.ts#confirmModalHtml, a sibling of `.app` in `shell()`, present on every screen), reused
       by any future confirmation need — not a one-off for the registry editor. `confirmModal(question,
       opts)` returns a Promise<boolean> (true = the destructive action was confirmed) so a caller
       reads like `window.confirm` used to, without ever calling it; `opts.confirmLabel`/
       `opts.cancelLabel` override the button text for a future non-"discard" confirmation without
       touching this helper's body. */
    var confirmModal = (function () {
      var el = document.getElementById('confirm-modal');
      if (!el) return function () { return Promise.resolve(true); };
      var questionEl = el.querySelector('.confirm-modal__question');
      var okBtn = el.querySelector('[data-confirm-discard]');
      var keepBtn = el.querySelector('[data-confirm-keep]');
      var backdrop = el.querySelector('[data-confirm-backdrop]');
      var pending = null; // the in-flight Promise's resolve fn, or null while closed

      function resolveWith(result) {
        if (!pending) return;
        var resolve = pending;
        pending = null;
        el.hidden = true;
        resolve(result);
      }

      okBtn.addEventListener('click', function () { resolveWith(true); });
      keepBtn.addEventListener('click', function () { resolveWith(false); });
      backdrop.addEventListener('click', function () { resolveWith(false); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && pending) resolveWith(false);
      });

      return function (question, opts) {
        questionEl.textContent = question;
        okBtn.textContent = (opts && opts.confirmLabel) || 'Discard';
        keepBtn.textContent = (opts && opts.cancelLabel) || 'Keep editing';
        el.hidden = false;
        return new Promise(function (resolve) { pending = resolve; });
      };
    })();

    /* ---------- client-side navigation (NOTES UI10) ----------
       In-app link clicks swap the CONTENT COLUMN (the server-rendered `<main class="main">`, plus its
       page's own extras — gate-summon templates, the registry editor overlay — swapped into a stable
       `[data-extras-host]` sibling) instead of a full page load. The app shell — header, rail, the
       Orchestrator panel (and thus its conversation), and the one persistent SSE connection below — is
       never touched by a swap: only `.main` and `[data-extras-host]` are ever replaced. This fixes the
       hang (rapid full navigations were exhausting Chrome's ~6-connections-per-origin HTTP/1.1 limit —
       curl answered the server in 0.138s during the episode; the browser just had nowhere left to
       queue the newest request), the conversation wipe, and the per-click asset/SSE churn, all at
       once — see NOTES UI10 for the full diagnosis.
       Correctness (the goal's own CRITICAL CONSTRAINT, re: NOTES UI4 — naive tab interception was
       removed once already because it broke back/forward): every in-app navigation calls
       history.pushState; a popstate listener re-fetches and swaps for the restored URL, so back/
       forward behave exactly like real navigation; a cold GET of any URL is untouched — the fragment
       path is opt-in via a request header only this code ever sends. A failed fetch (server down,
       network error, or a non-fragment response — e.g. the onboarding screen) never shows a broken
       half-swap: it falls back to a real navigation instead (FAILURE HONESTY). */
    function decodeTitleEntities(s) {
      return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    }

    function isInAppAnchor(a) {
      if (!a || a.tagName !== 'A') return false;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#') return false;
      if (a.hasAttribute('download')) return false;
      var target = a.getAttribute('target');
      if (target && target !== '_self') return false;
      if (href.slice(0, 2) === '//') return false; // protocol-relative — a different origin
      if (/^https?:\/\//i.test(href)) {
        var origin = /^https?:\/\/[^/]+/i.exec(href);
        if (!origin || origin[0].toLowerCase() !== location.origin.toLowerCase()) return false;
      } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
        return false; // mailto:, tel:, etc. — never an in-app screen route
      } else if (href.charAt(0) !== '/') {
        return false; // this app only ever emits root-relative screen links
      }
      return true;
    }

    /* Registry deep-link highlight (UI4 item 4), now reusable across a swap, not just the initial
       load: `/registry/<kind>/<name>` renders the same list view as `/registry/<kind>` with
       `data-highlight="<kind>-<name>"` on `.main` — the exact `id` `entityBlock` already gives that
       card. Scrolls to it and flashes `.is-highlighted` once per (real or swapped-in) load. */
    function applyHighlight(mainEl) {
      var host = mainEl || document.querySelector('.main[data-highlight]');
      var name = host && host.getAttribute && host.getAttribute('data-highlight');
      if (!name) return;
      var target = document.getElementById(name);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('is-highlighted');
      }
    }

    function fetchFragment(url) {
      return fetch(url, { headers: { 'X-Levare-Fragment': '1' } }).then(function (res) {
        var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        if (!res.ok || ct.indexOf('application/json') === -1) return null;
        return res.json().then(
          function (data) { return (data && data.ok && typeof data.main === 'string') ? data : null; },
          function () { return null; }
        );
      }, function () { return null; });
    }

    /* Replaces `.main` outright (its own opening-tag attributes, e.g. `data-highlight`, differ per
       page) and re-fills `[data-extras-host]` — never the rail, the Orchestrator `<aside>`, or the app
       header, which this function never even looks at. */
    function swapFragment(data) {
      var oldMain = document.querySelector('.main');
      if (!oldMain || !oldMain.parentNode) return false;
      var wrap = document.createElement('div');
      wrap.innerHTML = data.main;
      var newMain = wrap.firstElementChild;
      if (!newMain) return false;
      oldMain.parentNode.replaceChild(newMain, oldMain);

      var extrasHost = document.querySelector('[data-extras-host]');
      if (extrasHost) extrasHost.innerHTML = data.extras || '';
      // The registry editor overlay (when present) is part of `extras` — its old DOM node (and every
      // listener attached directly to it) was just discarded along with the innerHTML above. Rebind
      // to whichever instance exists now (a fresh one, or none at all on a non-registry page).
      bindEditorOverlay();

      if (typeof data.title === 'string' && data.title) document.title = decodeTitleEntities(data.title);
      applyHighlight(newMain);
      if (window.scrollTo) window.scrollTo(0, 0);
      return true;
    }

    var navToken = 0;
    function navigate(url, opts) {
      opts = opts || {};
      var token = ++navToken;
      return fetchFragment(url).then(function (data) {
        if (token !== navToken) return; // superseded by a newer navigation — never apply a stale swap
        if (!data || !swapFragment(data)) {
          location.href = url; // FAILURE HONESTY: never a broken half-swap — a real navigation instead
          return;
        }
        if (opts.push) history.pushState({ levare: true }, '', url);
      });
    }

    /* Used for a same-URL content refresh (the SSE reload trigger below, and a successful registry
       save) — never pushes a new history entry, since the URL itself hasn't changed. */
    function refreshCurrent() {
      return navigate(location.pathname + location.search, { push: false });
    }

    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest('a[href]');
      if (!isInAppAnchor(a)) return;
      var href = a.getAttribute('href');
      e.preventDefault();
      navigate(href, { push: true });
    });

    if (window.addEventListener) {
      window.addEventListener('popstate', function () {
        navigate(location.pathname + location.search, { push: false });
      });
    }

    applyHighlight(); // the cold-loaded page's own deep-link highlight, if any

    /* ---------- SSE: swap the content region on a repo change (fs.watch-driven re-render trigger) ----------
       Used to be `location.reload()` — a full page load that tore down and reopened this very
       connection on every repo change, and wiped the Orchestrator conversation besides. The stream
       itself is untouched by navigation now (see above): this is the ONE EventSource for the page's
       entire lifetime, reload pushes included. */
    if (window.EventSource) {
      try {
        var es = new EventSource('/events');
        es.onmessage = function (e) {
          if (e.data === 'reload') refreshCurrent();
        };
      } catch (e) { /* no SSE support; the board still works as plain server-rendered pages */ }
    }

    /* ---------- registry: overlay editor (UI3) ----------
       "Edit source" opens the ONE shared overlay (render.ts#editorOverlay) instead of an inline,
       card-cramped textarea. As the Conductor types, the buffer is debounced (~250ms after the last
       keystroke) into POST /registry/check/*path \u2014 the SAME validator `levare validate` and the
       save route both run, just pointed at the unsaved buffer instead of the file on disk (see
       validate.ts's `overlay` param); never a second, client-side validation implementation. Save
       stays blocked (button disabled) until that check comes back valid. Cancel, Escape, and a
       backdrop click all dismiss the overlay; each first checks whether the buffer differs from what
       was loaded (`isDirty()`) and only prompts "Discard unsaved changes?" when it does \u2014 an
       unchanged buffer closes immediately. Saving successfully closes the overlay itself (in addition
       to the existing content refresh that re-derives from the newly committed file).
       NOTES UI10: the overlay lives in the swappable "extras" region (render.ts#pageBody) \u2014 a
       fresh `#editor-overlay` element is created by every registry-page swap, and is simply absent on
       any other screen. `bindEditorOverlay()` (re)attaches this section's direct element listeners
       (Cancel/backdrop/Save/textarea-input \u2014 the ones a real DOM swap discards along with the old
       nodes they were attached to) to whichever overlay instance currently exists; it runs once at
       startup and again after every swap (see `swapFragment` above) that might have replaced it. The
       two document-delegated listeners below (the "Edit source" trigger and Escape) are attached only
       ONCE \u2014 delegation already finds the live target dynamically, so rebinding them per swap
       would just accumulate duplicate handlers \u2014 and call through `openEditor`/`requestDismiss`,
       which `bindEditorOverlay()` reassigns to close over whichever overlay instance is current. */
    var openEditor = function () {};
    var requestDismiss = function () {};

    function bindEditorOverlay() {
      var overlay = document.getElementById('editor-overlay');
      if (!overlay) {
        openEditor = function () {};
        requestDismiss = function () {};
        return;
      }
      var ovTitle = overlay.querySelector('.editor-overlay__title');
      var ovKind = overlay.querySelector('.editor-overlay__kind');
      var ovTextarea = overlay.querySelector('.editor-overlay__textarea');
      var ovValidity = overlay.querySelector('.validity');
      var ovErrors = overlay.querySelector('.editor-overlay__errors');
      var ovSave = overlay.querySelector('[data-editor-save]');
      var ovCancel = overlay.querySelector('[data-editor-cancel]');
      var ovBackdrop = overlay.querySelector('[data-editor-backdrop]');
      var current = null; // { path, original } \u2014 null whenever the overlay is closed
      var checkTimer = null;
      var checkToken = 0;

      function isDirty() {
        return !!current && ovTextarea.value !== current.original;
      }

      /* The check route returns the SAME ValidationError[] the CLI formats with a code and a
         file:line locator (levare validate's own output, unchanged — src/cli.ts#formatResult). The
         editor is a different audience: the Conductor is looking at an unsaved buffer, not a
         checked-out file tree, and the editor shows no line numbers — so a bare `:line` locator would
         point at nothing visible. UI4 item 2: render the human message only. */
      function renderErrors(errors) {
        ovErrors.innerHTML = '';
        (errors || []).forEach(function (er) {
          var row = document.createElement('div');
          row.className = 'editor-overlay__err';
          var msg = document.createElement('p');
          msg.textContent = er.message;
          row.appendChild(msg);
          ovErrors.appendChild(row);
        });
      }

      function setValid() {
        ovValidity.classList.remove('is-invalid');
        ovValidity.innerHTML = '<span class="status-dot is-ok"></span>valid';
        renderErrors([]);
        ovSave.disabled = false;
      }
      function setInvalid(errors, label) {
        ovValidity.classList.add('is-invalid');
        ovValidity.innerHTML = '<span class="status-dot is-danger"></span>' + (label || 'invalid');
        renderErrors(errors);
        ovSave.disabled = true;
      }
      function setChecking() {
        ovValidity.classList.remove('is-invalid');
        ovValidity.innerHTML = '<span class="status-dot is-idle"></span>checking\u2026';
        ovSave.disabled = true;
      }

      function runCheck() {
        if (!current) return;
        var path = current.path;
        var token = ++checkToken;
        setChecking();
        fetch('/registry/check/' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: ovTextarea.value })
        }).then(function (r) {
          return r.json().catch(function () { return { ok: false, errors: [] }; });
        }).then(function (body) {
          if (token !== checkToken || !current) return; // stale response or overlay closed meanwhile
          if (body && body.ok) setValid(); else setInvalid(body && body.errors, 'invalid');
        }).catch(function () {
          if (token !== checkToken || !current) return;
          setInvalid([{ code: 'CHECK_FAILED', message: 'could not reach the board to validate', file: path }], 'unknown');
        });
      }

      function scheduleCheck() {
        if (checkTimer) clearTimeout(checkTimer);
        checkTimer = setTimeout(runCheck, 250);
      }

      openEditor = function (path, name, kind, raw) {
        current = { path: path, original: raw };
        ovTitle.textContent = name;
        ovKind.textContent = kind;
        ovTextarea.value = raw;
        ovSave.textContent = 'Save and commit';
        overlay.hidden = false;
        runCheck();
        ovTextarea.focus();
      };

      function closeEditor() {
        if (checkTimer) clearTimeout(checkTimer);
        checkToken++; // invalidate any in-flight check response
        current = null;
        overlay.hidden = true;
      }

      /** Cancel / Escape / backdrop all funnel through here \u2014 the one dirty-check gate. A clean
          buffer closes immediately; a dirty one asks via the shared in-app confirm modal (UI4 item 1)
          \u2014 never the browser's native confirm(). */
      requestDismiss = function () {
        if (!isDirty()) { closeEditor(); return; }
        confirmModal('Discard unsaved changes?').then(function (discard) {
          if (discard) closeEditor();
        });
      };

      ovCancel.addEventListener('click', requestDismiss);
      ovBackdrop.addEventListener('click', requestDismiss);
      ovTextarea.addEventListener('input', function () {
        ovSave.disabled = true; // stays blocked until the debounced re-check comes back valid
        scheduleCheck();
      });

      ovSave.addEventListener('click', function () {
        if (!current || ovSave.disabled) return;
        var path = current.path;
        ovSave.disabled = true;
        ovSave.textContent = 'Saving\u2026';
        fetch('/registry/' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: ovTextarea.value })
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, body: j }; });
        }).then(function (res) {
          if (res.ok && res.body && res.body.ok) {
            ovSave.textContent = 'Committed \u2713';
            closeEditor();
            setTimeout(function () { refreshCurrent(); }, 400);
          } else {
            ovSave.disabled = false;
            ovSave.textContent = 'Save and commit';
            var msg = (res.body && res.body.error) ? res.body.error : 'save failed';
            setInvalid([{ code: 'SAVE_FAILED', message: msg, file: path }], 'save failed');
          }
        }).catch(function () {
          ovSave.disabled = false;
          ovSave.textContent = 'Save and commit';
          setInvalid([{ code: 'SAVE_FAILED', message: 'could not reach the board', file: path }], 'save failed');
        });
      });
    }

    bindEditorOverlay();

    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-edit-open]');
      if (!t) return;
      var card = t.closest('.entity');
      if (!card) return;
      var src = card.querySelector('.rawmd-source');
      openEditor(
        t.getAttribute('data-path'),
        t.getAttribute('data-editor-name') || '',
        t.getAttribute('data-editor-kind') || '',
        src ? src.value : '',
      );
    });
    document.addEventListener('keydown', function (e) {
      var overlay = document.getElementById('editor-overlay');
      if (e.key === 'Escape' && overlay && !overlay.hidden) requestDismiss();
    });
  });
})();
