// The boot guard (#265): what a page says when its scripts never start.
//
// A page's module script (main.js on the landing and the case view) runs only once every
// module it imports statically has loaded. If one is blocked (a content blocker refused
// js/pageview.js in v2026.10.26.5), 404s mid-deploy or throws, the script never runs, and
// the case view sat on "Loading..." for good. The pages inline `bootGuard` into a classic
// script in <head>, ahead of their module scripts, so it can't be blocked or fail to load
// itself. It listens for
// - an `error` event on one of the site's own <script> elements, inline or loaded from the
//   page's origin (the module graph failed to load: the browser fires it at the module
//   script whose graph it was), and
// - an uncaught error from the page's own origin before the scripts say they've started
//   (a module that loaded but threw while evaluating),
// and waits `timeout` ms for `stareBoot.ready()`, which each page's module script calls
// once it has wired the page. On the first of those that comes before `ready()`, it puts
// a message in the first of `targets` (element ids) that is on screen: the page didn't
// start, a content blocker is the likely cause, and a link that reloads the page.
//
// A `ready()` after the timeout (a slow connection, not a broken one) takes the message
// down again. Errors after `ready()` are the page's own to report.
//
// It has to run as an inline script and so can't import anything; the pages put it in with
// `(${bootGuard})(options, window)`. Under a Content-Security-Policy the inline script
// needs its own `'sha256-...'` in `script-src`, like the theme and caseroute.js scripts.
// web/tests/bootguard.test.js runs it against a fake window.

/**
 * Watch the page's scripts start. `opts`: `targets`, element ids to show the message
 * in, the first one on screen; `what`, what didn't start ("The reader"); `errorClass`, a
 * class to add to the target while the message shows; `timeout`, ms to wait for
 * `stareBoot.ready()`. Sets `win.stareBoot`.
 */
export function bootGuard(opts, win) {
  var doc = win.document;
  var state = { ready: false, shown: null, timer: null };

  function target() {
    var ids = opts.targets || [];
    var fallback = null;
    for (var i = 0; i < ids.length; i++) {
      var el = doc.getElementById(ids[i]);
      if (!el) continue;
      if (!fallback) fallback = el;
      if (el.getClientRects().length > 0) return el;
    }
    return fallback;
  }

  function show(timedOut) {
    if (state.ready || state.shown) return;
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', function () { show(timedOut); });
      return;
    }
    var el = target();
    if (!el) return;
    var msg = doc.createElement('span');
    msg.setAttribute('role', 'alert');
    msg.setAttribute('data-boot-guard', timedOut ? 'timeout' : 'error');
    msg.appendChild(doc.createTextNode((opts.what || 'This page') + (timedOut
      ? ' hasn’t started after ' + Math.round(opts.timeout / 1000) + ' seconds: its scripts are loading slowly or were blocked. '
      : ' didn’t start: one of its scripts failed to load. ')
      + 'A content blocker (an ad or tracker blocker) is the most likely cause; allow stare.pub in it, then '));
    var retry = doc.createElement('a');
    retry.href = win.location.href;
    retry.textContent = 'reload the page';
    retry.addEventListener('click', function (e) {
      e.preventDefault();
      win.location.reload();
    });
    msg.appendChild(retry);
    msg.appendChild(doc.createTextNode('.'));
    var saved = Array.prototype.slice.call(el.childNodes);
    el.replaceChildren(msg);
    if (opts.errorClass) el.classList.add(opts.errorClass);
    state.shown = { el: el, msg: msg, saved: saved };
  }

  function onError(e) {
    if (state.ready) return;
    var t = e.target;
    if (t && t.tagName === 'SCRIPT') {
      // Another host's script is not the page's to start: Cloudflare Web Analytics' beacon,
      // which Cloudflare adds to every page and EasyPrivacy blocks, fails this way for
      // anyone running uBlock Origin. An inline module script's `src` is ''.
      var src = t.src || '';
      if (!src || src.indexOf(win.location.origin + '/') === 0) show(false);
      return;
    }
    // An uncaught error while a module evaluated: the page's own scripts (an inline module's
    // file is the page), not an extension's.
    var file = e.filename || '';
    if (e.error !== undefined && file.indexOf(win.location.origin + '/') === 0) show(false);
  }

  // Capturing, since a script element's error event doesn't bubble.
  win.addEventListener('error', onError, true);
  state.timer = win.setTimeout(function () { show(true); }, opts.timeout);

  win.stareBoot = {
    ready: function () {
      if (state.ready) return;
      state.ready = true;
      win.clearTimeout(state.timer);
      win.removeEventListener('error', onError, true);
      var s = state.shown;
      if (s && s.msg.parentNode === s.el) {
        s.el.replaceChildren.apply(s.el, s.saved);
        if (opts.errorClass) s.el.classList.remove(opts.errorClass);
      }
      state.shown = null;
    },
  };
}

/** The inline script's text for a page: `bootGuard` called with `opts`. */
export function bootGuardScript(opts) {
  return `(${bootGuard})(${JSON.stringify(opts)}, window);`;
}

/** How long the pages wait for `stareBoot.ready()`, in ms. */
export const BOOT_TIMEOUT_MS = 10_000;
