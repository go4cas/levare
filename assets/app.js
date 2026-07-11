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
        start:   ['started', 'is-ok'],
        notyet:  ['not yet', 'is-neutral'],
        send:    ['changes sent', 'is-neutral']
      };
      var m = map[verb];
      if (m) resolveGate(card, m[0], m[1]);
    });

    function openNote(card, verb) {
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
    document.querySelectorAll('.composer form').forEach(function (form) {
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
        setTimeout(function () {
          var r = document.createElement('div');
          r.className = 'msg';
          r.innerHTML =
            '<div class="msg__label"><span class="k">reply</span><span class="t">now</span></div>' +
            '<p class="msg__body">Noted. I\u2019ll fold that into the next brief \u2014 nothing here changes state until you act on a gate.</p>';
          body.appendChild(r);
          body.scrollTop = body.scrollHeight;
        }, 480);
      });
    });

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
    document.addEventListener('click', function (e) {
      var sv = e.target.closest('[data-save]');
      if (!sv) return;
      sv.textContent = 'Committed \u2713';
      sv.disabled = true;
      setTimeout(function () { sv.textContent = 'Save and commit'; sv.disabled = false; }, 1600);
    });
  });
})();
