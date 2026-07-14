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
        send:    ['changes sent', 'is-neutral']
      };
      var realVerb = verb === 'send' ? (card._pendingVerb || 'request') : verb;
      var note = verb === 'send' && card._note ? card._note.querySelector('.gate__note').value : undefined;
      postGate(card, realVerb, note);
      // `start` (and `send`, which re-invokes the producer) dispatch a real member call that can take
      // seconds to minutes — an immediate "started"/"changes sent" resolved-line would be a premature
      // claim of completion. Show the quiet pending state instead (NOTES F10 defect 3) and let the
      // SSE-driven reload replace it with the server's real post-production render; every other verb
      // resolves synchronously server-side, so its immediate optimistic label stays accurate.
      if (realVerb === 'start' || realVerb === 'request') { markDispatching(card); return; }
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

    /* ---------- SSE: reload on a repo change (fs.watch-driven re-render trigger) ---------- */
    if (window.EventSource) {
      try {
        var es = new EventSource('/events');
        es.onmessage = function (e) {
          if (e.data === 'reload') location.reload();
        };
      } catch (e) { /* no SSE support; the board still works as plain server-rendered pages */ }
    }

    /* ---------- registry: entity switch + edit source ---------- */
    var entities = document.querySelectorAll('[data-entity]');
    if (entities.length) {
      document.addEventListener('click', function (e) {
        var a = e.target.closest('[data-goto]');
        if (!a) return;
        e.preventDefault();
        var key = a.getAttribute('data-goto');
        if (!document.querySelector('[data-entity="' + key + '"]')) return;
        document.querySelectorAll('.reg-nav a[data-goto]').forEach(function (x) {
          x.classList.toggle('is-active', x.getAttribute('data-goto') === key);
        });
        entities.forEach(function (en) {
          en.style.display = en.getAttribute('data-entity') === key ? '' : 'none';
        });
        var m = document.querySelector('.main');
        if (m) m.scrollTop = 0;
      });
    }
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-edit-toggle]');
      if (!t) return;
      var ent = t.closest('.entity');
      var editing = ent.classList.toggle('is-editing');
      t.textContent = editing ? 'View rendered' : 'Edit source';
      var save = ent.querySelector('[data-save]');
      if (save) save.style.display = editing ? '' : 'none';
    });
    /* E8: "Save and commit" POSTs the edited raw markdown to the existing POST /registry/*path route
       (validate -> write -> commit as the Conductor, server-side, with the SAME validator the whole
       repo is checked against). The client only relays the raw text and renders the verdict \u2014 no form
       fields, no client-side authoring. On success the page reloads to re-derive from the committed
       file (invariant 2); on a validation failure the server rolls the file back and returns the
       error, which is shown inline without leaving edit mode so the Conductor can fix and retry. */
    document.addEventListener('click', function (e) {
      var sv = e.target.closest('[data-save]');
      if (!sv) return;
      var ent = sv.closest('.entity');
      if (!ent) return;
      var ta = ent.querySelector('.rawmd-edit');
      var path = ta && ta.getAttribute('data-path');
      var validity = ent.querySelector('.validity');
      if (!ta || !path) return;
      sv.disabled = true;
      sv.textContent = 'Saving\u2026';
      fetch('/registry/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: ta.value })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, body: j }; });
      }).then(function (res) {
        if (res.ok && res.body && res.body.ok) {
          sv.textContent = 'Committed \u2713';
          if (validity) { validity.classList.remove('is-invalid'); validity.innerHTML = '<span class="status-dot is-ok"></span>valid'; }
          setTimeout(function () { location.reload(); }, 500);
        } else {
          sv.disabled = false;
          sv.textContent = 'Save and commit';
          var msg = (res.body && res.body.error) ? res.body.error : 'save failed';
          if (validity) { validity.classList.add('is-invalid'); validity.innerHTML = '<span class="status-dot is-danger"></span>' + msg; }
        }
      }).catch(function () {
        sv.disabled = false;
        sv.textContent = 'Save and commit';
        if (validity) { validity.classList.add('is-invalid'); validity.innerHTML = '<span class="status-dot is-danger"></span>save failed'; }
      });
    });
  });
})();
