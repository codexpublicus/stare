// The loading bar for the stare WASM (#73), for pages where someone can ask
// for something the WASM does before it has loaded: the case viewer and
// /check. It shows the download's real progress, goes away when the WASM is
// ready, and on a failure says so with a Retry button. It never covers or
// blocks the rest of the page.

import { onWasmProgress, progressFraction, retryWasm, wasmProgress } from './wasm.js';

let nextId = 0;
// The bar showing in each slot, so a second call reuses it.
const bars = new WeakMap();

function formatBytes(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
}

/**
 * Shows the bar in `slot`, an element the page keeps empty for it, unless the
 * WASM is already ready. `onRetryReady` runs when a load retried from this
 * bar succeeds, so the page can redo what failed. Returns a function that
 * removes the bar.
 */
export function showWasmProgress(slot, { onRetryReady } = {}) {
  if (!slot || wasmProgress().state === 'ready') return () => {};
  const shown = bars.get(slot);
  if (shown) {
    shown.onRetryReady = onRetryReady;
    return shown.remove;
  }

  const labelId = `wasm-progress-label-${++nextId}`;
  const bar = document.createElement('div');
  bar.className = 'wasm-progress';

  const label = document.createElement('div');
  label.className = 'wasm-progress-label';
  label.id = labelId;

  const track = document.createElement('div');
  track.className = 'wasm-progress-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-labelledby', labelId);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'wasm-progress-fill';
  track.append(fill);

  const error = document.createElement('div');
  error.className = 'wasm-progress-error';
  error.setAttribute('role', 'alert');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'wasm-progress-retry';
  retry.textContent = 'Retry';

  bar.append(label, track);
  slot.replaceChildren(bar);

  let retried = false;
  retry.addEventListener('click', () => {
    retried = true;
    retryWasm().catch(() => {});
  });

  let unsubscribe = () => {};
  const handle = { onRetryReady, remove: () => {} };
  const remove = () => {
    unsubscribe();
    bars.delete(slot);
    if (bar.isConnected) bar.remove();
  };
  handle.remove = remove;
  bars.set(slot, handle);

  function render(p) {
    if (p.state === 'ready') {
      remove();
      if (retried && handle.onRetryReady) handle.onRetryReady();
      return;
    }
    if (p.state === 'error') {
      error.replaceChildren("Couldn't load the citation parser. ", retry);
      bar.classList.add('wasm-progress-failed');
      bar.replaceChildren(error);
      return;
    }
    if (bar.classList.contains('wasm-progress-failed')) {
      bar.classList.remove('wasm-progress-failed');
      bar.replaceChildren(label, track);
    }
    const fraction = progressFraction(p);
    if (fraction == null) {
      label.textContent = 'Loading the citation parser…';
      track.removeAttribute('aria-valuenow');
      track.removeAttribute('aria-valuetext');
      bar.classList.add('wasm-progress-indeterminate');
      fill.style.transform = '';
    } else {
      const percent = Math.round(fraction * 100);
      label.textContent = `Loading the citation parser… ${percent}%`;
      track.setAttribute('aria-valuenow', String(percent));
      track.setAttribute('aria-valuetext', `${percent}% (${formatBytes(p.loaded)} of ${formatBytes(p.total)})`);
      bar.classList.remove('wasm-progress-indeterminate');
      fill.style.transform = `scaleX(${fraction})`;
    }
  }

  unsubscribe = onWasmProgress(render);
  return remove;
}
