// Which case load is the current one (#267). Each load of a case (a search, prev/next, a
// hash change, back) starts a new one, and the one before it is over: its `signal` is
// aborted and `current()` is false from then on. Every async step of a load checks
// `current()` before it touches the DOM or the reader's state, so a late result from a
// case already replaced can't overwrite the case on screen.

export function generations() {
  let latest = null;
  return {
    // A new load, ending the one before it.
    start() {
      latest?.controller.abort();
      const controller = new AbortController();
      const load = {
        signal: controller.signal,
        current: () => latest === entry,
      };
      const entry = { controller, load };
      latest = entry;
      return load;
    },
    // End the current load without starting another (back to the landing).
    cancel() {
      latest?.controller.abort();
      latest = null;
    },
  };
}
