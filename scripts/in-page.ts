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
 * again on DOM mutations, hashchange, popstate, readystatechange, and load or
 * error events (images included, caught in the capture phase). Rapid DOM
 * mutation storms are coalesced (immediate first check, then at most every
 * 50ms) so heavy SPA hydration never thrashes layout when `fn` reads innerText.
 * The host holds the returned object by reference rather than a page global,
 * awaits `changed` through changedInPage and ends the watch with
 * stopWatchInPage. Callbacks never run in a page with scripts disabled.
 */
export function watchInPage<A extends unknown[]>(
  fn: (...args: A) => unknown,
  args: A
) {
  let stop = () => {};
  const changed = new Promise<WatchResult>((resolve) => {
    const events = ["hashchange", "popstate", "load", "error"];
    let done = false;
    let running = false;
    let dirty = false;
    let lastRun = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function finish(result: WatchResult) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      observer.disconnect();
      for (const type of events) removeEventListener(type, schedule, true);
      document.removeEventListener("readystatechange", schedule);
      resolve(result);
    }

    const run = async () => {
      if (done) return;
      running = true;
      dirty = false;
      lastRun = performance.now();
      try {
        const value = await fn(...args);
        if (value) finish(value instanceof Node ? { node: true } : { value });
      } catch {
        // A document still loading can throw; the next change checks again.
      } finally {
        running = false;
        if (!done && dirty) schedule();
      }
    };

    const schedule = () => {
      if (done) return;
      if (running) {
        dirty = true;
        return;
      }
      const gap = performance.now() - lastRun;
      if (gap >= 50) {
        clearTimeout(timer);
        timer = undefined;
        void run();
      } else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          void run();
        }, 50 - gap);
      }
    };

    const observer = new MutationObserver(schedule);
    stop = () => finish(null);
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    for (const type of events) addEventListener(type, schedule, true);
    document.addEventListener("readystatechange", schedule);
    void run();
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

/** Compact visible interactive element reported by snapshot(). */
export type SnapshotElement = {
  tag: string;
  selector: string;
  role?: string;
  type?: string;
  text?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  href?: string;
  disabled?: boolean;
};

/** Compact page overview returned by snapshot(). */
export type PageSnapshot = {
  url: string;
  title: string;
  text: string;
  elements: SnapshotElement[];
  truncated?: { text?: boolean; elements?: number };
};

/**
 * In page: returns a compact, token-efficient summary of the page (or a scoped
 * container): normalized visible text plus visible interactive controls with
 * verified unique CSS selectors ready for click().
 */
export function snapshotInPage(
  rootSelector: string | null,
  maxText: number,
  maxElements: number
): PageSnapshot {
  const root = rootSelector
    ? document.querySelector(rootSelector)
    : document.body;

  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
  const blockTags = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "BR",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
  ]);
  const extractVisibleText = (start: Node | null, limit: number) => {
    if (!start || limit <= 0) return { text: "", truncated: false };
    const chunks: string[] = [];
    let len = 0;
    let truncated = false;
    const walk = (node: Node) => {
      if (truncated) return;
      if (node.nodeType === 3) {
        const piece = (node.nodeValue ?? "").replace(/[ \t\r\n]+/g, " ");
        if (piece.trim()) {
          if (chunks.length && chunks[chunks.length - 1] !== "\n") {
            chunks.push(" ");
            len += 1;
          }
          const trimmed = piece.trim();
          chunks.push(trimmed);
          len += trimmed.length;
          if (len > limit) truncated = true;
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as HTMLElement;
      if (skipTags.has(el.tagName) || el.hidden) return;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      const block = blockTags.has(el.tagName);
      if (block && chunks.length && chunks[chunks.length - 1] !== "\n") {
        chunks.push("\n");
        len += 1;
      }
      for (let child = el.firstChild; child; child = child.nextSibling) {
        walk(child);
        if (truncated) return;
      }
      if (block && chunks.length && chunks[chunks.length - 1] !== "\n") {
        chunks.push("\n");
        len += 1;
      }
    };
    walk(start);
    const joined = chunks
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const isTrunc = truncated || joined.length > limit;
    return {
      text: isTrunc ? joined.slice(0, limit) : joined,
      truncated: isTrunc,
    };
  };

  const { text, truncated: textTruncated } = extractVisibleText(root, maxText);

  const isUnique = (selector: string, el: Element) => {
    try {
      const list = document.querySelectorAll(selector);
      return list.length === 1 && list[0] === el;
    } catch {
      return false;
    }
  };

  const uniqueSelector = (el: Element): string => {
    if (el.id) {
      const idSel = `#${CSS.escape(el.id)}`;
      if (isUnique(idSel, el)) return idSel;
    }
    const tag = el.tagName.toLowerCase();
    for (const attr of [
      "data-testid",
      "data-test",
      "data-cy",
      "name",
      "aria-label",
      "placeholder",
    ]) {
      const val = el.getAttribute(attr);
      if (!val || val.length > 80) continue;
      const escaped = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const sel = `${tag}[${attr}="${escaped}"]`;
      if (isUnique(sel, el)) return sel;
    }
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && href.length <= 80 && !href.startsWith("javascript:")) {
        const escaped = href.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const sel = `a[href="${escaped}"]`;
        if (isUnique(sel, el)) return sel;
      }
    }
    if (tag === "label") {
      const forId = el.getAttribute("for");
      if (forId) {
        const escaped = forId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const sel = `label[for="${escaped}"]`;
        if (isUnique(sel, el)) return sel;
      }
    }
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.id) {
        const idSel = `#${CSS.escape(cur.id)}`;
        const candidate = [idSel, ...parts].join(" > ");
        if (isUnique(candidate, el)) return candidate;
      }
      const curTag = cur.tagName.toLowerCase();
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      const hasSameTagSib =
        idx > 1 ||
        (() => {
          let next = cur.nextElementSibling;
          while (next) {
            if (next.tagName === cur.tagName) return true;
            next = next.nextElementSibling;
          }
          return false;
        })();
      parts.unshift(hasSameTagSib ? `${curTag}:nth-of-type(${idx})` : curTag);
      const candidate = parts.join(" > ");
      if (isUnique(candidate, el)) return candidate;
      cur = cur.parentElement;
    }
    return parts.join(" > ") || tag;
  };

  const isVisible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const style = getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  };

  const interactiveQuery = [
    "a[href]",
    "button",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='option']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    "[role='textbox']",
    "[role='switch']",
    "[contenteditable='true']",
    "label[for]",
  ].join(",");

  const scope = root ?? document;
  const candidates = scope.querySelectorAll(interactiveQuery);
  const elements: SnapshotElement[] = [];
  let extraElements = 0;

  for (const el of candidates) {
    const tag = el.tagName.toLowerCase();
    // Skip labels whose target input is itself visible (avoid duplicate entries);
    // keep labels that front hidden styled radios/checkboxes so click() works.
    if (tag === "label") {
      const forId = el.getAttribute("for");
      const target = forId ? document.getElementById(forId) : null;
      if (!target || isVisible(target)) continue;
    }
    if (!isVisible(el)) continue;
    if (elements.length >= maxElements) {
      extraElements++;
      continue;
    }

    const entry: SnapshotElement = {
      tag,
      selector: uniqueSelector(el),
    };
    const role = el.getAttribute("role");
    if (role) entry.role = role;

    if (tag === "input") {
      const inp = el as HTMLInputElement;
      if (inp.type && inp.type !== "text") entry.type = inp.type;
      if (inp.placeholder) entry.placeholder = inp.placeholder.slice(0, 60);
      if (inp.type === "checkbox" || inp.type === "radio") {
        entry.checked = inp.checked;
      } else if (inp.type !== "password" && inp.value) {
        entry.value = inp.value.slice(0, 80);
      }
      if (inp.disabled) entry.disabled = true;
    } else if (tag === "textarea") {
      const ta = el as HTMLTextAreaElement;
      if (ta.placeholder) entry.placeholder = ta.placeholder.slice(0, 60);
      if (ta.value) entry.value = ta.value.slice(0, 80);
      if (ta.disabled) entry.disabled = true;
    } else if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opt = sel.selectedOptions[0]?.textContent?.trim();
      if (opt) entry.value = opt.slice(0, 80);
      if (sel.disabled) entry.disabled = true;
    } else if (tag === "label") {
      const forId = el.getAttribute("for");
      const target = forId
        ? (document.getElementById(forId) as HTMLInputElement | null)
        : null;
      if (target && (target.type === "checkbox" || target.type === "radio")) {
        entry.type = target.type;
        entry.checked = target.checked;
        if (target.disabled) entry.disabled = true;
      }
    } else {
      if ((el as HTMLButtonElement).disabled) entry.disabled = true;
      if (tag === "a") {
        const href = el.getAttribute("href");
        if (href) entry.href = href.slice(0, 120);
      }
    }

    const labelText = (
      el.getAttribute("aria-label") || extractVisibleText(el, 80).text
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (labelText) entry.text = labelText;

    elements.push(entry);
  }

  const out: PageSnapshot = {
    url: location.href,
    title: document.title,
    text,
    elements,
  };
  if (textTruncated || extraElements > 0) {
    out.truncated = {
      ...(textTruncated ? { text: true } : {}),
      ...(extraElements > 0 ? { elements: extraElements } : {}),
    };
  }
  return out;
}

/** In page: compact title + visible text preview for actionable timeout errors. */
export function pagePreviewInPage(): { title: string; text: string } {
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
  const parts: string[] = [];
  let len = 0;
  const walk = (node: Node) => {
    if (len >= 220) return;
    if (node.nodeType === 3) {
      const s = (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
      if (s) {
        parts.push(s);
        len += s.length + 1;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    if (skipTags.has(el.tagName) || el.hidden) return;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    for (let child = el.firstChild; child; child = child.nextSibling) {
      walk(child);
      if (len >= 220) return;
    }
  };
  if (document.body) walk(document.body);
  return {
    title: document.title,
    text: parts.join(" ").trim().slice(0, 200),
  };
}

/** Current scroll geometry reported by scroll(). */
export type ScrollResult = {
  x: number;
  y: number;
  width: number;
  height: number;
  atBottom: boolean;
};

/**
 * In page: instant, non-blocking scroll safe in both visible and hidden
 * background tabs. Avoids Chrome's smooth-scroll Promise (which hangs on
 * hidden tabs with `scroll-behavior: smooth`).
 */
export function scrollInPage(
  selector: string | null,
  x: number | null,
  y: number | null,
  to: "top" | "bottom" | null
): ScrollResult {
  const el = selector ? document.querySelector(selector) : null;
  if (selector && !el) {
    throw new Error(`scroll: ${selector} matched no element`);
  }
  if (el) {
    const targetTop =
      to === "top"
        ? 0
        : to === "bottom"
          ? el.scrollHeight
          : el.scrollTop + (y ?? 0);
    const targetLeft = to === "top" ? 0 : el.scrollLeft + (x ?? 0);
    el.scrollTo({ left: targetLeft, top: targetTop, behavior: "instant" });
    return {
      x: Math.round(el.scrollLeft),
      y: Math.round(el.scrollTop),
      width: el.scrollWidth,
      height: el.scrollHeight,
      atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
    };
  }
  const doc = document.scrollingElement ?? document.documentElement;
  const targetTop =
    to === "top"
      ? 0
      : to === "bottom"
        ? doc.scrollHeight
        : window.scrollY + (y ?? 0);
  const targetLeft = to === "top" ? 0 : window.scrollX + (x ?? 0);
  window.scrollTo({ left: targetLeft, top: targetTop, behavior: "instant" });
  return {
    x: Math.round(window.scrollX),
    y: Math.round(window.scrollY),
    width: doc.scrollWidth,
    height: doc.scrollHeight,
    atBottom: window.scrollY + window.innerHeight >= doc.scrollHeight - 2,
  };
}
