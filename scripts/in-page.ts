/**
 * The CDP wire form of calling `fn` in the page: each function serialized with
 * toString(), every other argument as JSON. The arguments are type-checked
 * against `fn`'s parameters.
 */
export function inPageCall<A extends unknown[]>(
  fn: (...args: A) => unknown,
  ...args: A
): string {
  const serialized = args.map((arg) =>
    typeof arg === "function" ? `(${arg})` : JSON.stringify(arg)
  );
  return `(${fn})(${serialized.join(", ")})`;
}

/**
 * In page: `fn`'s value, or `{ node: true }` when it is a DOM node, which
 * cannot leave the page by value. Chrome returns {} for most nodes and fails
 * on one with cyclic expandos, such as a React-rendered element.
 */
export async function returnByValueInPage<A extends unknown[]>(
  fn: (...args: A) => unknown,
  args: A
): Promise<{ node: true } | { value: unknown }> {
  const value = await fn(...args);
  return value instanceof Node ? { node: true } : { value };
}

/** What watchInPage settles with: the truthy value, a DOM node, or null once stopped. */
export type WatchResult = { node: true } | { value: unknown } | null;

/**
 * In page: watches for `fn` to return a truthy value, checking it now and
 * again on every DOM mutation, on each hashchange, popstate and
 * readystatechange, and on any load or error event (images included, caught
 * in the capture phase). No timer: it answers as the page changes. The host
 * holds the returned object by reference rather than a page global, awaits
 * `changed` through changedInPage and ends the watch with stopWatchInPage.
 * Callbacks never run in a page with scripts disabled.
 */
export function watchInPage<A extends unknown[]>(
  fn: (...args: A) => unknown,
  args: A
) {
  let stop = () => {};
  const changed = new Promise<WatchResult>((resolve) => {
    const events = ["hashchange", "popstate", "load", "error"];
    let done = false;
    const check = async () => {
      try {
        const value = await fn(...args);
        if (value) finish(value instanceof Node ? { node: true } : { value });
      } catch {
        // A document still loading can throw; the next change checks again.
      }
    };
    const observer = new MutationObserver(() => void check());
    function finish(result: WatchResult) {
      if (done) return;
      done = true;
      observer.disconnect();
      for (const type of events) removeEventListener(type, check, true);
      document.removeEventListener("readystatechange", check);
      resolve(result);
    }
    stop = () => finish(null);
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    for (const type of events) addEventListener(type, check, true);
    document.addEventListener("readystatechange", check);
    void check();
  });
  return { changed, stop: () => stop() };
}

/** In page, on watchInPage's object: its result once it settles. */
export function changedInPage(this: { changed: Promise<WatchResult> }) {
  return this.changed;
}

/** In page, on watchInPage's object: ends the watch, settling it with null. */
export function stopWatchInPage(this: { stop: () => void }) {
  this.stop();
}
