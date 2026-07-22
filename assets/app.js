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

    /* ---------- Orchestrator status popover: close affordance (Phase 2 cluster 4 item 1) ----------
       `<details>` has no native close button; the popover's own header close control just clears the
       trigger's `open` attribute, same mechanism a click on the summary itself already toggles. */
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-orchind-close]');
      if (!btn) return;
      var det = btn.closest('details.orchind');
      if (det) det.open = false;
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
       the fs.watch-driven re-render trigger. The local pending/resolved treatment below is purely the
       felt, quiet motion the design brief asks for while that round-trip is in flight. */
    function postGate(card, verb, note) {
      var project = card.getAttribute('data-gate-project');
      var target = card.getAttribute('data-gate-target');
      if (!project || !target) return Promise.resolve(null);
      return fetch('/gates/' + encodeURIComponent(project) + '/' + encodeURIComponent(target) + '/' + encodeURIComponent(verb), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note || undefined })
      // The response body (`{ ok, error }`, board/serve.ts's own gate route shape) is read for EVERY
      // verb now, not just a merge gate's own execution-on-approval (amendment 1 §2 R5 — "failure
      // keeps state and offers retry" applies to every gate verb, not one special case).
      }).then(function (res) { return res.json().catch(function () { return null; }); })
        .catch(function (err) { console.error('gate verb failed', err); return null; });
    }

    // amendment 1 §2 R4 (tier 1 — button, 0-1s, decision writes): pressed state is instant; the
    // spinner only appears after a short delay so a fast op (an ordinary approve/reject, a plain
    // frontmatter commit) never flashes one. `start`/`request`/`retry`/`recheck`/a merge gate's own
    // `approve` dispatch a real member or repository-scale operation the daemon itself tracks as
    // `dispatching` (NOTES F10 defect 3) — those are never "fast", so their loading state has always
    // shown instantly and keeps doing so; everything else is new to this delayed treatment.
    var SPINNER_DELAY_MS = 350;

    function isDispatchVerb(realVerb, isMergeGate) {
      return realVerb === 'start' || realVerb === 'request' || realVerb === 'retry' || realVerb === 'recheck' || (isMergeGate && realVerb === 'approve');
    }

    // The resolved-line label a FAST verb collapses to on success (resolveGate, below) — dispatch
    // verbs never call resolveGate locally; their card is replaced wholesale by the next SSE-driven
    // re-render once the daemon's own production finishes.
    var RESOLVED_LABEL = {
      approve: ['approved', 'is-ok'],
      reject: ['rejected', 'is-danger'],
      notyet: ['not yet', 'is-neutral'],
      skip: ['skipped', 'is-neutral'],
      abandon: ['abandoned', 'is-danger'],
      rescope: ['re-scoped', 'is-neutral']
    };
    // The progressive label a fast verb's spinner reads once shown (SPINNER_DELAY_MS in) — dispatch
    // verbs keep the existing generic "dispatching…" regardless of which one fired.
    var FAST_PENDING_LABEL = {
      approve: 'approving…',
      reject: 'rejecting…',
      notyet: 'noting…',
      skip: 'skipping…',
      abandon: 'abandoning…',
      rescope: 're-scoping…'
    };

    function pendingEl(label) {
      var pending = document.createElement('span');
      pending.classList.add('pending');
      var dots = document.createElement('span');
      dots.classList.add('turn--pending');
      var dotsInner = document.createElement('span');
      dotsInner.classList.add('turn__dots');
      for (var i = 0; i < 3; i++) dotsInner.appendChild(document.createElement('span'));
      dots.appendChild(dotsInner);
      var labelEl = document.createElement('span');
      labelEl.classList.add('pending__label');
      labelEl.textContent = label;
      pending.appendChild(dots);
      pending.appendChild(labelEl);
      return pending;
    }

    /* Tier-1 button state (R4) AND no-double-submit (R5): the WHOLE verb group disables the instant
       any one of its buttons is clicked — never just the clicked button — and the clicked one is
       marked pressed immediately. The dots+label pending treatment only replaces the row's content
       once `delayMs` elapses and the action is still in flight; a response that lands before then
       never shows a spinner at all. Mirrors render/components.ts#pendingState's own shape (only the
       verbs row's content changes; title/producer/context stay exactly where they were) so a locally
       shown pending state and the server-rendered `dispatchingHtml` one read identically. */
    function beginPending(card, verbsRow, btn, delayMs, label) {
      var buttons = verbsRow.querySelectorAll('button');
      buttons.forEach(function (b) { b.disabled = true; });
      btn.classList.add('is-pressed');
      var note = card._note ? card._note.querySelector('.gate__note') : null;
      if (note) note.disabled = true;

      var state = { settled: false, timer: null };
      function showSpinner() {
        if (state.settled) return;
        verbsRow.classList.add('gate__verbs--pending');
        verbsRow.textContent = '';
        verbsRow.appendChild(pendingEl(label));
      }
      if (delayMs <= 0) showSpinner();
      else state.timer = setTimeout(showSpinner, delayMs);
      state.cancel = function () {
        state.settled = true;
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      };
      return state;
    }

    /* amendment 1 §2 R5 — "failure keeps state and offers retry": a failed write never silently
       resets the card. The verb returns to idle (a fresh button, never the old disabled ones — this
       IS the idle state, not a resurrection of stale DOM) and a danger-toned notice states what
       happened, exactly the treatment render/components.ts#callout gives every other danger message
       on the board. `retryVerb`/`retryLabel` let a merge gate's own `approve` — an EXECUTION that can
       fail for reasons a bare re-click can't fix — offer Re-check instead of repeating the identical
       doomed attempt; every other verb retries itself. */
    function settleFailure(card, verbsRow, message, retryVerb, retryLabel) {
      card.classList.remove('is-dispatching');
      verbsRow.classList.remove('gate__verbs--pending');
      var notice = document.createElement('div');
      notice.className = 'notice notice--danger';
      var text = document.createElement('span');
      text.className = 'notice__text';
      text.textContent = message || 'the request failed';
      notice.appendChild(text);
      verbsRow.parentNode.insertBefore(notice, verbsRow);
      verbsRow.textContent = '';
      var retry = document.createElement('button');
      retry.className = 'verb is-primary';
      retry.setAttribute('data-verb', retryVerb);
      retry.textContent = retryLabel;
      verbsRow.appendChild(retry);
    }

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.gate [data-verb]');
      if (!btn) return;
      var card = btn.closest('.gate');
      var verb = btn.getAttribute('data-verb');

      if (verb === 'request' || verb === 'rescope') { openNote(card, verb); return; }
      if (verb === 'cancel') { closeNote(card); return; }
      if (card._inflight) return; // R5: one in-flight action per gate card — a second click is a no-op.

      var realVerb = verb === 'send' ? (card._pendingVerb || 'request') : verb;
      var note = verb === 'send' && card._note ? card._note.querySelector('.gate__note').value : undefined;
      // `btn.closest('.gate__verbs')` finds whichever row is actually visible — the original approve/
      // request/reject row, or (once `request`/`rescope` opened a note) its Send/Cancel replacement.
      var verbsRow = btn.closest('.gate__verbs');
      var isMergeGate = card.classList.contains('gate--merge');
      var isMergeApprove = isMergeGate && realVerb === 'approve';
      var dispatchVerb = isDispatchVerb(realVerb, isMergeGate);
      var retryVerb = isMergeApprove ? 'recheck' : realVerb;
      var retryLabel = isMergeApprove ? 'Re-check' : 'Retry';

      card._inflight = true;
      if (dispatchVerb) {
        card.classList.add('is-dispatching');
        // Only the start-gate badge's text ever reads "dispatching" server-side (render.ts#gateCardHtml:
        // the default/artifact-blocked badges never change on dispatch, only their verbs row does).
        var badge = card.querySelector('.gate__badge.is-start');
        if (badge) badge.textContent = 'dispatching';
      }
      var label = dispatchVerb ? 'dispatching…' : (FAST_PENDING_LABEL[realVerb] || 'working…');
      var pending = beginPending(card, verbsRow, btn, dispatchVerb ? 0 : SPINNER_DELAY_MS, label);

      postGate(card, realVerb, note).then(function (result) {
        card._inflight = false;
        pending.cancel();
        var failed = !result || result.ok === false;
        if (failed) {
          var message = (result && result.error) || 'could not reach the board — check your connection and try again.';
          settleFailure(card, verbsRow, message, retryVerb, retryLabel);
          return;
        }
        // A dispatch verb's production continues asynchronously server-side; the SSE reload below
        // replaces this card with the daemon's real post-production render once it lands — an
        // immediate resolved-line here would be a premature claim of completion.
        if (dispatchVerb) return;
        var m = RESOLVED_LABEL[realVerb];
        resolveGate(card, m ? m[0] : realVerb, m ? m[1] : 'is-neutral');
      });
    });

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

    /* Phase 2 cluster 4 item 3: the role row (name + mono timestamp) — mirrors
       render/components.ts#turnRow's markup exactly, so a server-rendered and a client-appended row
       read identically. It is now the ONE speaker signal besides the Orchestrator's own accent mark;
       the message surface below it (`.turn__body`) carries no speaker-specific colour. */
    function buildRow(speaker) {
      var row = document.createElement('div');
      row.className = 'turn__row';
      var name = document.createElement('span');
      name.className = 'turn__name';
      name.textContent = speaker === 'orch' ? 'Orchestrator' : 'You';
      row.appendChild(name);
      row.appendChild(buildCaption());
      return row;
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
        content.appendChild(buildRow(speaker));
        turn.appendChild(content);
        body.appendChild(turn);
      }
      turn.querySelector('.turn__content').appendChild(buildBodyEl());
      body.scrollTop = body.scrollHeight;
      return turn;
    }

    /* NOTES V11-CONV: the panel's own `data-scope` attribute (stamped server-side by
       render/shell.ts#orchestratorPanel, the same value used to key `conversations/<scope>/...`) is
       the ONE place this file reads "what scope is the Conductor talking in" — never re-derived from
       `location.pathname` here, so the routing rules (which URL belongs to which project) live in
       exactly one place (the server) instead of two. */
    function currentOrchScope() {
      var el = document.querySelector('.orch[data-scope]');
      return el ? el.getAttribute('data-scope') : 'studio';
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
        // In-flight state (item 5, evolved by Phase 2 cluster 4 item 3): local and inline, exactly
        // where the reply will land \u2014 the mark plus content-shaped skeleton lines standing in for
        // the reply that hasn't arrived yet (amendment 1 R5, review F28 \u2014 a lie-free "still working"
        // signal, not a "thinking\u2026" dots+text claim), a fresh turn right after the Conductor's own
        // (never merged into it, since the speaker differs), cleared as soon as a reply or failure
        // arrives. Never a bar/spinner that replaces more of the panel than this.
        var pendingTurn = appendTurnMessage(body, 'orch', function () {
          var p = document.createElement('p');
          p.className = 'turn__body turn--pending';
          var line1 = document.createElement('span');
          line1.className = 'skeleton-block turn__skel-line';
          line1.style.width = '78%';
          var line2 = document.createElement('span');
          line2.className = 'skeleton-block turn__skel-line';
          line2.style.width = '48%';
          p.appendChild(line1);
          p.appendChild(line2);
          return p;
        });
        pendingTurn.classList.add('turn--pending');
        input.disabled = true;
        fetch('/orchestrator/message', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text, scope: currentOrchScope() })
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

    /* Amendment 1 §2 R5, review F28: "skeletons shaped like the real anatomy... no gray boxes, no
       full-page spinners" for initial load/refetch. This app's pages are synchronous server renders
       (a local file read, not a slow network call) — the one place a genuine loading GAP exists is the
       client-side navigation fetch itself. Mirrors tier 1's own honesty rule (amendment 1 §2 R4): the
       skeleton only appears after a short delay, so a fast local navigation (the overwhelming common
       case) never flashes one — it's reserved for the rare slow case, never decoration. */
    var SKELETON_DELAY_MS = 400;
    function maybeShowSkeleton() {
      var main = document.querySelector('.main');
      if (!main) return null;
      return setTimeout(function () {
        var overlay = document.createElement('div');
        overlay.setAttribute('data-skeleton', '1');
        overlay.className = 'skeleton-overlay';
        overlay.innerHTML =
          '<div class="skeleton-block" style="width:38%;height:22px"></div>' +
          '<div class="skeleton-block" style="height:64px"></div>' +
          '<div class="skeleton-block" style="height:64px"></div>' +
          '<div class="skeleton-block" style="height:64px"></div>';
        main.appendChild(overlay);
      }, SKELETON_DELAY_MS);
    }
    function clearSkeleton(timer) {
      clearTimeout(timer);
      document.querySelectorAll('[data-skeleton]').forEach(function (el) { el.remove(); });
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

    /* NOTES V11-CONV: resyncs ONLY the persisted-tail region (`[data-orch-tail]`) when the destination
       page's scope differs from the panel's current one — e.g. client-navigating from the studio into
       a project. Deliberately gated on an actual scope CHANGE, not run on every swap: a same-scope
       refresh (including the SSE `reload` → `refreshCurrent()` path that fires right after this very
       tab sends a message) would otherwise re-render a persisted tail that now includes the exchange
       this tab already appended live a moment ago, showing it twice. The live-appended turns for
       whatever scope was showing before a genuine scope change stay in the DOM as-is (never cleared —
       consistent with UI10's original choice to never touch `.orch__body`'s message history on a
       swap); recorded as a known, accepted limitation in NOTES V11-CONV. */
    function syncOrchTail(data) {
      var orch = document.querySelector('.orch[data-scope]');
      if (!orch || typeof data.scope !== 'string' || orch.getAttribute('data-scope') === data.scope) return;
      orch.setAttribute('data-scope', data.scope);
      var tail = document.querySelector('[data-orch-tail]');
      if (tail && typeof data.orchTail === 'string') tail.innerHTML = data.orchTail;
    }

    /* amendment 1 §2 R4, tier 2 (card, 1-10s resolution/refetch): a same-URL refresh (the SSE reload
       trigger below, a post-save content refresh) is a card RESOLVING, not a page transition — the
       Conductor's scroll position and reading context should survive it, and whatever visibly changed
       (a stat's count, a work-unit's status badge) should read as having just ticked, not as having
       silently been someone else's page all along. `swapFragment` itself keeps doing the ONE atomic
       DOM replacement it always did (already correct — a single `replaceChild` never renders a blank
       frame); `sameUrl` only gates the two things that differ between "I resolved" and "I navigated":
       scroll position (kept vs reset) and the flash pass below (on vs off — a cross-page navigation
       has nothing meaningful to compare against, every field is legitimately new). */
    function snapshotLiveValues(mainEl) {
      var snap = { stats: [], units: {} };
      mainEl.querySelectorAll('.statstrip .n').forEach(function (n) { snap.stats.push(n.textContent); });
      mainEl.querySelectorAll('.units > .unit[data-unit]').forEach(function (u) {
        var chip = u.querySelector('.unit__head .chip');
        snap.units[u.getAttribute('data-unit')] = chip ? chip.textContent + '|' + chip.className : null;
      });
      return snap;
    }

    function flashLiveChanges(before, mainEl) {
      mainEl.querySelectorAll('.statstrip .n').forEach(function (n, i) {
        if (before.stats[i] !== undefined && before.stats[i] !== n.textContent) n.classList.add('tick-flash');
      });
      mainEl.querySelectorAll('.units > .unit[data-unit]').forEach(function (u) {
        var key = u.getAttribute('data-unit');
        if (!(key in before.units)) return; // a brand-new row — nothing to compare, nothing to flash
        var chip = u.querySelector('.unit__head .chip');
        var now = chip ? chip.textContent + '|' + chip.className : null;
        if (before.units[key] !== null && before.units[key] !== now) u.querySelector('.unit__head').classList.add('tick-flash');
      });
    }

    /* Replaces `.main` outright (its own opening-tag attributes, e.g. `data-highlight`, differ per
       page) and re-fills `[data-extras-host]` — never the rail or the app header, which this function
       never even looks at. The Orchestrator `<aside>` itself is untouched too (UI10's own conversation-
       preserving guarantee) except for the persisted-tail resync above, scoped to exactly the one
       region that can legitimately differ per page. */
    function swapFragment(data, sameUrl) {
      var oldMain = document.querySelector('.main');
      if (!oldMain || !oldMain.parentNode) return false;
      var before = sameUrl ? snapshotLiveValues(oldMain) : null;
      var wrap = document.createElement('div');
      wrap.innerHTML = data.main;
      var newMain = wrap.firstElementChild;
      if (!newMain) return false;
      oldMain.parentNode.replaceChild(newMain, oldMain);
      if (before) flashLiveChanges(before, newMain);

      // Regression fix (Phase 2 cluster 4 seal-time finding): a background refresh — an SSE `reload`
      // from ANY repo change, not just this tab's own writes; e.g. the daemon's own startup tick still
      // landing a moment after a fast navigate+click — must never destroy an OPEN, mid-edit overlay.
      // `extras` is entirely static/repo-independent for the registry page's own editor-overlay shell
      // (its title/kind/buffer are populated by openEditor(), never server-rendered per request), so
      // skipping this swap while the Conductor has it open loses nothing: the next natural refresh
      // (the save flow's own `refreshCurrent()`, or the next SSE tick after Cancel/Escape/backdrop
      // closes it) catches the extras region up normally. Re-binding is skipped in lockstep — it would
      // otherwise reset `bindEditorOverlay()`'s closure state (`current`/`checkTimer`) out from under
      // the still-live, still-open DOM node even without touching the DOM itself.
      var liveOverlay = document.getElementById('editor-overlay');
      var editorIsOpen = !!liveOverlay && !liveOverlay.hidden;
      var extrasHost = document.querySelector('[data-extras-host]');
      if (extrasHost && !editorIsOpen) extrasHost.innerHTML = data.extras || '';
      // The registry editor overlay (when present) is part of `extras` — its old DOM node (and every
      // listener attached directly to it) was just discarded along with the innerHTML above. Rebind
      // to whichever instance exists now (a fresh one, or none at all on a non-registry page).
      if (!editorIsOpen) bindEditorOverlay();

      syncOrchTail(data);

      if (typeof data.title === 'string' && data.title) document.title = decodeTitleEntities(data.title);
      applyHighlight(newMain);
      // A genuine navigation lands the Conductor at the top of a new page, same as ever; a same-URL
      // resolve leaves them exactly where they were reading (tier 2 — a card resolving must not yank
      // the page out from under whatever the Conductor is doing).
      if (!sameUrl && window.scrollTo) window.scrollTo(0, 0);
      return true;
    }

    var navToken = 0;
    function navigate(url, opts) {
      opts = opts || {};
      var token = ++navToken;
      var skeletonTimer = maybeShowSkeleton();
      return fetchFragment(url).then(function (data) {
        clearSkeleton(skeletonTimer);
        if (token !== navToken) return; // superseded by a newer navigation — never apply a stale swap
        if (!data || !swapFragment(data, opts.sameUrl)) {
          location.href = url; // FAILURE HONESTY: never a broken half-swap — a real navigation instead
          return;
        }
        if (opts.push) history.pushState({ levare: true }, '', url);
      });
    }

    /* Used for a same-URL content refresh (the SSE reload trigger below, and a successful registry
       save) — never pushes a new history entry, since the URL itself hasn't changed. */
    function refreshCurrent() {
      return navigate(location.pathname + location.search, { push: false, sameUrl: true });
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
      var ovDirty = overlay.querySelector('[data-editor-dirty]');
      var ovFront = overlay.querySelector('.editor-overlay__textarea--front');
      var ovBody = overlay.querySelector('.editor-overlay__textarea--body');
      var ovValidity = overlay.querySelector('.validity');
      var ovErrors = overlay.querySelector('.editor-overlay__errors');
      var ovSave = overlay.querySelector('[data-editor-save]');
      var ovCancel = overlay.querySelector('[data-editor-cancel]');
      var ovBackdrop = overlay.querySelector('[data-editor-backdrop]');
      var current = null; // { path, hasFrontmatter, originalFront, originalBody } — null when closed
      var checkTimer = null;
      var checkToken = 0;
      var validState = 'checking'; // 'valid' | 'invalid' | 'checking'

      /* Phase 2 cluster 4 item 4a: the modal shows the frontmatter/body split as two labeled zones,
         but the check/save routes still read and write ONE raw markdown string — split on open,
         rejoined on every check/save. Every real entity/artifact file opens with `---\n...\n---\n\n`,
         so this round-trips byte-for-byte; `isDirty()` still compares each zone's OWN starting value
         (never the rejoined string) so a freshly opened buffer can never read dirty from a formatting
         quirk in the split/join alone. */
      function splitFrontmatter(raw) {
        if (raw.slice(0, 4) !== '---\n') return { front: '', body: raw, hasFrontmatter: false };
        var rest = raw.slice(4);
        var closeIdx = rest.indexOf('\n---');
        if (closeIdx === -1) return { front: '', body: raw, hasFrontmatter: false };
        var front = rest.slice(0, closeIdx);
        var body = rest.slice(closeIdx + 4).replace(/^\r?\n\r?\n?/, '');
        return { front: front, body: body, hasFrontmatter: true };
      }
      function joinFrontmatter(front, body) {
        return '---\n' + front + '\n---\n\n' + body;
      }
      function currentContent() {
        if (!current) return '';
        return current.hasFrontmatter ? joinFrontmatter(ovFront.value, ovBody.value) : ovBody.value;
      }

      function isDirty() {
        return !!current && (ovFront.value !== current.originalFront || ovBody.value !== current.originalBody);
      }
      function updateDirtyMarker() {
        ovDirty.hidden = !isDirty();
      }
      function recomputeSave() {
        ovSave.disabled = !(isDirty() && validState === 'valid'); // item 4d: dirty AND valid, never valid alone
      }

      function autoGrow(el) {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
      }

      /* The check route returns the SAME ValidationError[] the CLI formats with a code and a
         file:line locator (levare validate's own output, unchanged — src/cli.ts#formatResult).
         Item 4b: each row now reads "line · key" (muted, mono) beside the validator's own human
         message — structured, not a bare status dot. `key` is best-effort, read off the SAME
         message text the validator already writes (most of validate.ts's messages name the field as
         `field '<key>'`/`key '<key>'`); falls back to the error's own `code` when the message names
         no field (e.g. a cross-entity reference error) — never fabricated, always something the
         response actually carries. */
      function errorLocator(er) {
        var loc = (typeof er.line === 'number') ? ('L' + er.line) : '—';
        var m = /\b(?:field|key)\s+'([^']+)'/.exec(er.message || '');
        var key = m ? m[1] : (er.code || '');
        return loc + ' · ' + key;
      }
      function renderErrors(errors) {
        ovErrors.innerHTML = '';
        (errors || []).forEach(function (er) {
          var row = document.createElement('div');
          row.className = 'editor-overlay__err';
          var loc = document.createElement('span');
          loc.className = 'editor-overlay__err-loc mono';
          loc.textContent = errorLocator(er);
          var msg = document.createElement('p');
          msg.className = 'editor-overlay__err-msg';
          msg.textContent = er.message;
          row.appendChild(loc);
          row.appendChild(msg);
          ovErrors.appendChild(row);
        });
      }

      /* item 4b: the validity indicator is now the SAME `.chip` markup statusBadge() renders
         everywhere else on the board (done/waiting/failed — never a bare status dot here either). */
      function setValid() {
        validState = 'valid';
        ovValidity.innerHTML = '<span class="chip is-done">valid</span>';
        renderErrors([]);
        recomputeSave();
      }
      function setInvalid(errors, label) {
        validState = 'invalid';
        ovValidity.innerHTML = '<span class="chip is-failed">' + (label || 'invalid') + '</span>';
        renderErrors(errors);
        recomputeSave();
      }
      function setChecking() {
        validState = 'checking';
        ovValidity.innerHTML = '<span class="chip is-waiting">checking…</span>';
        recomputeSave();
      }

      function runCheck() {
        if (!current) return;
        var path = current.path;
        var token = ++checkToken;
        setChecking();
        fetch('/registry/check/' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: currentContent() })
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
        var split = splitFrontmatter(raw);
        current = { path: path, hasFrontmatter: split.hasFrontmatter, originalFront: split.front, originalBody: split.body };
        ovTitle.textContent = name;
        ovKind.textContent = kind;
        ovFront.value = split.front;
        ovBody.value = split.body;
        autoGrow(ovFront);
        autoGrow(ovBody);
        ovSave.textContent = 'Save and commit';
        updateDirtyMarker();
        overlay.hidden = false;
        runCheck();
        ovFront.focus();
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
      [ovFront, ovBody].forEach(function (ta) {
        ta.addEventListener('input', function () {
          autoGrow(ta);
          updateDirtyMarker();
          ovSave.disabled = true; // stays blocked until the debounced re-check comes back valid (and dirty)
          scheduleCheck();
        });
      });

      ovSave.addEventListener('click', function () {
        if (!current || ovSave.disabled) return;
        var path = current.path;
        ovSave.disabled = true;
        ovSave.textContent = 'Saving…';
        fetch('/registry/' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: currentContent() })
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, body: j }; });
        }).then(function (res) {
          if (res.ok && res.body && res.body.ok) {
            ovSave.textContent = 'Committed ✓';
            closeEditor();
            setTimeout(function () { refreshCurrent(); }, 400);
          } else {
            ovSave.textContent = 'Save and commit';
            var msg = (res.body && res.body.error) ? res.body.error : 'save failed';
            setInvalid([{ code: 'SAVE_FAILED', message: msg, file: path }], 'save failed');
          }
        }).catch(function () {
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
