import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootGuard, bootGuardScript } from '../src/lib/bootguard.js';

// Just enough of a DOM and window for bootGuard.
class FakeNode {
  constructor(tag, text = null) {
    this.tagName = tag;
    this.text = text;
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.classes = new Set();
    this.visible = true;
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  replaceChildren(...nodes) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    for (const n of nodes) this.appendChild(n);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  getClientRects() { return this.visible ? [{}] : []; }
  set textContent(t) { this.replaceChildren(new FakeNode('#text', t)); }
  get textContent() { return this.text ?? this.childNodes.map((n) => n.textContent).join(''); }
}

function fakeWindow(ids, { readyState = 'interactive' } = {}) {
  const els = Object.fromEntries(ids.map((id) => [id, new FakeNode('DIV')]));
  const timers = [];
  const listeners = [];
  const docListeners = {};
  const win = {
    reloaded: 0,
    location: { href: 'https://stare.pub/#a2d/31/647-01', origin: 'https://stare.pub', reload() { win.reloaded += 1; } },
    document: {
      readyState,
      getElementById: (id) => els[id] || null,
      createElement: (tag) => new FakeNode(tag.toUpperCase()),
      createTextNode: (t) => new FakeNode('#text', t),
      addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
    },
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms, live: true }) - 1,
    clearTimeout: (id) => { if (timers[id]) timers[id].live = false; },
  };
  return {
    win, els, timers, listeners,
    fire: (event) => listeners.filter((l) => l.type === 'error').forEach((l) => l.fn(event)),
    elapse: () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }),
    domReady: () => { win.document.readyState = 'interactive'; (docListeners.DOMContentLoaded || []).forEach((f) => f()); },
  };
}

const OPTS = { targets: ['status-bar', 'landing-status'], what: 'The reader', errorClass: 'error', timeout: 10_000 };
const message = (el) => el.childNodes.find((n) => n.attrs?.['data-boot-guard']);

test('a script that fails to load shows the message at once, in the first target on screen', () => {
  const f = fakeWindow(['status-bar', 'landing-status']);
  bootGuard(OPTS, f.win);
  assert.equal(f.timers[0].ms, 10_000);
  assert.ok(f.listeners.some((l) => l.type === 'error' && l.capture === true));
  f.fire({ target: { tagName: 'SCRIPT' } });
  const msg = message(f.els['status-bar']);
  assert.ok(msg, 'no message in #status-bar');
  assert.equal(msg.attrs['data-boot-guard'], 'error');
  assert.equal(msg.attrs.role, 'alert');
  assert.match(msg.textContent, /The reader didn.t start: one of its scripts failed to load\. A content blocker/);
  assert.ok(f.els['status-bar'].classes.has('error'));
  const link = msg.childNodes.find((n) => n.tagName === 'A');
  assert.equal(link.textContent, 'reload the page');
  link.listeners.click[0]({ preventDefault() {} });
  assert.equal(f.win.reloaded, 1);
});

test('a hidden target is passed over', () => {
  const f = fakeWindow(['status-bar', 'landing-status']);
  f.els['status-bar'].visible = false;
  bootGuard(OPTS, f.win);
  f.fire({ target: { tagName: 'SCRIPT' } });
  assert.ok(!message(f.els['status-bar']));
  assert.ok(message(f.els['landing-status']));
});

test('ready() before anything goes wrong: no message, no timer, errors ignored', () => {
  const f = fakeWindow(['status-bar']);
  bootGuard(OPTS, f.win);
  f.win.stareBoot.ready();
  assert.equal(f.timers[0].live, false);
  assert.equal(f.listeners.length, 0);
  f.elapse();
  f.fire({ target: { tagName: 'SCRIPT' } });
  assert.equal(f.els['status-bar'].childNodes.length, 0);
});

test('no ready() within the timeout shows the slow message, and a late ready() takes it down', () => {
  const f = fakeWindow(['status-bar']);
  f.els['status-bar'].textContent = 'Fetching...';
  bootGuard(OPTS, f.win);
  f.elapse();
  const msg = message(f.els['status-bar']);
  assert.equal(msg.attrs['data-boot-guard'], 'timeout');
  assert.match(msg.textContent, /hasn.t started after 10 seconds/);
  f.win.stareBoot.ready();
  assert.equal(f.els['status-bar'].textContent, 'Fetching...');
  assert.ok(!f.els['status-bar'].classes.has('error'));
});

test('an uncaught error from the site before ready() counts; one from elsewhere, or a failed image, does not', () => {
  const f = fakeWindow(['status-bar']);
  bootGuard(OPTS, f.win);
  f.fire({ target: { tagName: 'IMG' } });
  f.fire({ filename: 'chrome-extension://abc/content.js', error: new Error('x') });
  assert.ok(!message(f.els['status-bar']));
  f.fire({ filename: 'https://stare.pub/js/ui.js', error: new TypeError('x is not a function') });
  assert.ok(message(f.els['status-bar']));
});

test('an error before the body is parsed waits for it', () => {
  const f = fakeWindow(['status-bar'], { readyState: 'loading' });
  bootGuard(OPTS, f.win);
  f.fire({ target: { tagName: 'SCRIPT' } });
  assert.ok(!message(f.els['status-bar']));
  f.domReady();
  assert.ok(message(f.els['status-bar']));
});

test('the inline script runs on its own', () => {
  const f = fakeWindow(['status-bar']);
  // eslint-disable-next-line no-new-func
  new Function('window', bootGuardScript(OPTS))(f.win);
  assert.equal(typeof f.win.stareBoot.ready, 'function');
  f.fire({ target: { tagName: 'SCRIPT' } });
  assert.ok(message(f.els['status-bar']));
});
