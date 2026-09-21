'use strict';

/* Custom Outdoor Design — the public site.
   Everything here is an enhancement. With JavaScript off the page still
   reads, the questions still open, and the phone number is still a link. */

(function () {
  /* =================================================================
     THE ONLY THINGS YOU SHOULD NEED TO CHANGE
     ================================================================= */

  /* Turn this off the day the site goes live and the bar across the top
     of the page disappears. Leave it on while there are still
     placeholders in index.html. */
  var DRAFT = true;

  /* Where the estimate form sends to. The crew app answers this at
     /api/estimate. If the site is hosted somewhere separate from the
     app, put the app's full address here instead:
     'https://app.your-domain.com/api/estimate' */
  var ESTIMATE_ENDPOINT = '/api/estimate';

  /* Used only when the form cannot reach the server, so a customer
     standing in a wet basement still gets hold of somebody. */
  var FALLBACK_PHONE = '(555) 012-3456';
  var FALLBACK_EMAIL = 'office@example.com';

  /* =================================================================== */

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --------------------------- the draft bar ------------------------ */

  if (DRAFT) {
    var bar = document.getElementById('draftbar');
    bar.innerHTML =
      '<b>Draft</b> &mdash; still to fill in: phone, email, town and service ' +
      'area, the year he started, licence number, warranty, lead times, and ' +
      'the photos. Search index.html for PLACEHOLDER. Set DRAFT to false in ' +
      'js/site.js to remove this bar.';
    bar.hidden = false;
  }

  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  /* ------------------------- photographs ---------------------------- */

  /* Each frame starts empty and says so. Drop a file in site/photos with
     the name the markup asks for and it fills itself in. */
  function fillFrames() {
    var slots = document.querySelectorAll('.frame img[data-photo]');

    Array.prototype.forEach.call(slots, function (img) {
      var frame = img.parentNode;
      var note = document.createElement('span');

      note.textContent = 'Photo goes here — ' + img.getAttribute('data-photo');
      frame.classList.add('empty');
      frame.appendChild(note);
      img.hidden = true;

      img.addEventListener('load', function () {
        frame.classList.remove('empty');
        if (note.parentNode) note.parentNode.removeChild(note);
        img.hidden = false;
      });

      // Missing file: the frame simply stays as it is.
      img.addEventListener('error', function () { img.hidden = true; });

      img.setAttribute('loading', 'lazy');
      img.src = img.getAttribute('data-photo');
    });
  }

  /* ---------------------------- the sky ----------------------------- */

  /* Stars in the last of the light, and the drift of mist off a head
     that has just shut down. Decorative only: if the canvas does not
     draw, the scene underneath is already complete. */
  function skyCanvas() {
    var canvas = document.getElementById('sparks');
    if (!canvas || !canvas.getContext) return;

    var ctx = canvas.getContext('2d');
    var stars = [];
    var motes = [];
    var w = 0;
    var h = 0;

    function size() {
      var box = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = box.width;
      h = box.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function seed() {
      stars = [];
      motes = [];

      // Thickest overhead, gone by the horizon where the light still is.
      var count = Math.round(Math.min(w, 1400) / 9);
      for (var i = 0; i < count; i++) {
        var y = Math.pow(Math.random(), 1.8) * h * 0.62;
        stars.push({
          x: Math.random() * w,
          y: y,
          r: Math.random() * 1.1 + 0.3,
          a: (1 - y / (h * 0.7)) * (Math.random() * 0.5 + 0.25),
          t: Math.random() * Math.PI * 2,
        });
      }

      var mcount = Math.round(Math.min(w, 1400) / 26);
      for (var j = 0; j < mcount; j++) {
        motes.push({
          x: Math.random() * w,
          y: h * 0.62 + Math.random() * h * 0.36,
          r: Math.random() * 1.6 + 0.6,
          a: Math.random() * 0.3 + 0.08,
          vx: (Math.random() - 0.5) * 0.14,
          vy: -(Math.random() * 0.1 + 0.03),
        });
      }
    }

    function draw(time) {
      ctx.clearRect(0, 0, w, h);

      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var tw = reduced ? 1 : 0.72 + Math.sin(time / 1400 + s.t) * 0.28;
        ctx.globalAlpha = Math.max(0, s.a * tw);
        ctx.fillStyle = '#EAF2F6';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      for (var j = 0; j < motes.length; j++) {
        var m = motes[j];
        ctx.globalAlpha = m.a;
        ctx.fillStyle = '#F0B25E';
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();

        if (reduced) continue;

        m.x += m.vx;
        m.y += m.vy;

        // Back to the grass once it has risen out of the frame.
        if (m.y < h * 0.56 || m.x < -10 || m.x > w + 10) {
          m.x = Math.random() * w;
          m.y = h * 0.62 + Math.random() * h * 0.36;
        }
      }

      ctx.globalAlpha = 1;
    }

    var running = true;

    function frame(time) {
      if (!running) return;
      draw(time);
      window.requestAnimationFrame(frame);
    }

    size();
    window.addEventListener('resize', size);

    if (reduced) {
      draw(0);
      return;
    }

    // Nothing spins while the hero is off screen.
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        var visible = entries[0].isIntersecting;
        if (visible && !running) { running = true; window.requestAnimationFrame(frame); }
        running = visible;
      }, { threshold: 0 }).observe(canvas);
    }

    window.requestAnimationFrame(frame);
  }

  /* --------------------------- the drift ---------------------------- */

  /* The sky moves slower than the lawn, the way it does out of a truck
     window. A few pixels — enough to feel, not enough to notice. */
  function parallax() {
    if (reduced) return;

    var hero = document.querySelector('.hero');
    var sky = document.querySelector('.sky');
    var ridge = document.querySelector('.ridge');
    if (!hero || !sky) return;

    var ticking = false;

    function settle() {
      var y = window.pageYOffset || document.documentElement.scrollTop;
      if (y > hero.offsetHeight + 200) { ticking = false; return; }
      sky.style.transform = 'translate3d(0,' + (y * 0.16).toFixed(1) + 'px,0)';
      if (ridge) ridge.style.transform = 'translate3d(0,' + (y * 0.07).toFixed(1) + 'px,0)';
      ticking = false;
    }

    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(settle);
    }, { passive: true });
  }

  /* ------------------------- the estimate form ---------------------- */

  function estimateForm() {
    var form = document.getElementById('estimate-form');
    if (!form) return;

    var note = document.getElementById('f-note');
    var send = document.getElementById('f-send');

    function say(message, kind) {
      note.innerHTML = message;
      note.className = 'formnote' + (kind ? ' ' + kind : '');
    }

    function value(name) {
      var el = form.elements[name];
      return el ? String(el.value || '').trim() : '';
    }

    function flag(name, bad) {
      var el = form.elements[name];
      if (el) el.classList.toggle('bad', !!bad);
    }

    /* If the server cannot be reached we do not lose the job — the
       details go into an email they can send by hand. */
    function rescue(request) {
      var lines = [
        'Name: ' + request.name,
        'Phone: ' + request.phone,
        'Address: ' + request.address,
        'Work: ' + (request.work.join(', ') || 'not sure'),
        'Best time: ' + request.reach,
        '',
        request.detail,
      ].join('\n');

      var mail = 'mailto:' + FALLBACK_EMAIL
        + '?subject=' + encodeURIComponent('Estimate request — ' + request.name)
        + '&body=' + encodeURIComponent(lines);

      say(
        'That did not go through from here. Please call us on '
        + '<a href="tel:' + FALLBACK_PHONE.replace(/[^\d+]/g, '') + '">' + FALLBACK_PHONE
        + '</a> or <a href="' + mail + '">send it as an email</a> — '
        + 'we have kept what you typed.',
        'bad'
      );
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      var request = {
        name: value('name'),
        phone: value('phone'),
        address: value('address'),
        detail: value('detail'),
        reach: value('reach'),
        email: value('email'),
        fax: value('fax'),
        work: Array.prototype.filter
          .call(form.querySelectorAll('input[name="work"]'), function (box) { return box.checked; })
          .map(function (box) { return box.value; }),
      };

      var missing = ['name', 'phone', 'address'].filter(function (field) {
        var empty = !request[field];
        flag(field, empty);
        return empty;
      });

      if (missing.length) {
        say('We need your name, a phone number and the address before we can '
          + 'come and look at it.', 'bad');
        form.elements[missing[0]].focus();
        return;
      }

      if (request.phone.replace(/\D/g, '').length < 7) {
        flag('phone', true);
        say('That phone number looks short — check it and send it again.', 'bad');
        form.elements.phone.focus();
        return;
      }

      send.disabled = true;
      send.textContent = 'Sending…';
      say('Sending it over…');

      fetch(ESTIMATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }).then(function (res) {
        if (!res.ok) throw new Error('rejected');
        return res.json().catch(function () { return {}; });
      }).then(function () {
        form.innerHTML =
          '<p class="formhead">Thank you — it is with us</p>'
          + '<p>We have your details and we will call you back to arrange a '
          + 'time to walk the property, usually the same day.</p>'
          + '<p class="formnote">Something urgent in the meantime? '
          + '<a href="tel:' + FALLBACK_PHONE.replace(/[^\d+]/g, '') + '">'
          + FALLBACK_PHONE + '</a></p>';
        form.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
      }).catch(function () {
        send.disabled = false;
        send.textContent = 'Send it over';
        rescue(request);
      });
    });

    // Clear the red as soon as they start fixing it.
    form.addEventListener('input', function (event) {
      if (event.target.classList) event.target.classList.remove('bad');
    });
  }

  /* ------------------------------ go -------------------------------- */

  fillFrames();
  skyCanvas();
  parallax();
  estimateForm();
}());
