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

    function markDispatching(card) {
      card.classList.add('is-resolved', 'is-dispatching');
      card.classList.remove('gate--start', 'gate--cta');
      card.innerHTML =
        '<span class="resolved-line" style="display:flex;align-items:center;gap:11px;width:100%">' +
          '<span class="msg msg--pending" style="display:inline-flex"><span class="msg__dots"><span></span><span></span><span></span></span></span>' +
          '<span class="gate__dispatching">dispatching…</span>' +
        '</span>';
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

    /* ---------- summon gate into orchestrator ---------- */
    document.addEventListener('click', function (e) {
      var s = e.target.closest('[data-summon]');
      if (!s) return;
      e.preventDefault();
      var body = document.querySelector('.orch__body');
      if (!body) return;
      var tplId = s.getAttribute('data-summon');
      var tpl = document.getElementById(tplId);
      var msg = document.createElement('div');
      msg.className = 'msg';
      msg.innerHTML =
        '<div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>' +
        '<p class="msg__body">' + (s.getAttribute('data-narrate') ||
          'Here is the gate you asked to review.') + '</p>';
      body.appendChild(msg);
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
        var u = document.createElement('div');
        u.className = 'msg msg--user';
        u.innerHTML = '<p class="msg__body"></p>';
        u.querySelector('.msg__body').textContent = text;
        body.appendChild(u);
        input.value = '';
        body.scrollTop = body.scrollHeight;
        function showReply(text) {
          var r = document.createElement('div');
          r.className = 'msg';
          r.innerHTML = '<div class="msg__label"><span class="k">reply</span><span class="t">now</span></div><p class="msg__body"></p>';
          r.querySelector('.msg__body').textContent = text;
          body.appendChild(r);
          body.scrollTop = body.scrollHeight;
        }
        // An error or a disabled-state response is shown as what it is, never dressed up as an
        // Orchestrator reply (NOTES C11 \u2014 the whole point of deleting the deterministic boundary was
        // to stop a non-answer from impersonating a real one).
        function showError(text) {
          var r = document.createElement('div');
          r.className = 'msg';
          r.innerHTML = '<div class="msg__label"><span class="k">error</span><span class="t">now</span></div><p class="msg__body" style="color:var(--danger)"></p>';
          r.querySelector('.msg__body').textContent = text;
          body.appendChild(r);
          body.scrollTop = body.scrollHeight;
        }
        // Pending state (a real SDK call routinely takes seconds): quiet, non-attention-seeking per
        // the design brief's motion rules, cleared as soon as a reply (or a failure) arrives, so the
        // composer never just looks dead while the Orchestrator is working.
        var pending = document.createElement('div');
        pending.className = 'msg msg--pending';
        pending.innerHTML = '<div class="msg__dots"><span></span><span></span><span></span></div>';
        body.appendChild(pending);
        body.scrollTop = body.scrollHeight;
        input.disabled = true;
        fetch('/orchestrator/message', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text })
        }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            pending.remove();
            if (r.ok && r.data && r.data.ok) { showReply(r.data.reply || ''); }
            else { showError((r.data && (r.data.reason || r.data.error)) || 'The Orchestrator could not answer.'); }
          })
          .catch(function () {
            pending.remove();
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

    /* ---------- SSE: reload on a repo change (fs.watch-driven re-render trigger) ---------- */
    if (window.EventSource) {
      try {
        var es = new EventSource('/events');
        es.onmessage = function (e) {
          if (e.data === 'reload') location.reload();
        };
      } catch (e) { /* no SSE support; the board still works as plain server-rendered pages */ }
    }

    /* ---------- registry: entity-kind links (UI4 item 4) ----------
       Switching kinds (the rail's Registry section, the in-content tab strip) is a real navigation to
       `/registry/<kind>` now — a path segment, matching `/project/<name>`/`/idea/<name>` elsewhere in
       the product — not a client-side swap. No click interception here on purpose: a plain <a href>
       re-derives the page from the server on every kind switch (PRD invariant 2), which is also what
       makes the browser's back/forward buttons behave correctly across registry navigation for free. */

    /* ---------- registry: deep-link highlight (UI4 item 4) ----------
       `/registry/<kind>/<name>` renders the SAME list view as `/registry/<kind>` with
       `data-highlight="<kind>-<name>"` on `.main` (render.ts#renderRegistry) — the exact `id`
       `entityBlock` already gives that card. Scrolls to it and flashes `.is-highlighted` once per
       load; preserves what the old `#connectors-<name>` fragment anchor used to do (scroll + point at
       the entity), now driven by the path instead of a fragment. */
    var highlightHost = document.querySelector('.main[data-highlight]');
    if (highlightHost) {
      var highlightEl = document.getElementById(highlightHost.getAttribute('data-highlight'));
      if (highlightEl) {
        highlightEl.scrollIntoView({ block: 'center' });
        highlightEl.classList.add('is-highlighted');
      }
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
       to the existing full-page reload that re-derives from the newly committed file). */
    var overlay = document.getElementById('editor-overlay');
    if (overlay) {
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

      function openEditor(path, name, kind, raw) {
        current = { path: path, original: raw };
        ovTitle.textContent = name;
        ovKind.textContent = kind;
        ovTextarea.value = raw;
        ovSave.textContent = 'Save and commit';
        overlay.hidden = false;
        runCheck();
        ovTextarea.focus();
      }

      function closeEditor() {
        if (checkTimer) clearTimeout(checkTimer);
        checkToken++; // invalidate any in-flight check response
        current = null;
        overlay.hidden = true;
      }

      /** Cancel / Escape / backdrop all funnel through here \u2014 the one dirty-check gate. A clean
          buffer closes immediately; a dirty one asks via the shared in-app confirm modal (UI4 item 1)
          \u2014 never the browser's native confirm(). */
      function requestDismiss() {
        if (!isDirty()) { closeEditor(); return; }
        confirmModal('Discard unsaved changes?').then(function (discard) {
          if (discard) closeEditor();
        });
      }

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

      ovCancel.addEventListener('click', requestDismiss);
      ovBackdrop.addEventListener('click', requestDismiss);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !overlay.hidden) requestDismiss();
      });
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
            setTimeout(function () { location.reload(); }, 400);
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
  });
})();
