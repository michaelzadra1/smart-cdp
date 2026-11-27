import { setTimeout as delay } from "node:timers/promises";
import { inPageCall, type watchInPage } from "./in-page";
import type { Send } from "./probe";

/** A point in viewport CSS pixels, with whether the page has never painted. */
export type Point = { x: number; y: number; unpainted?: boolean };

const pause = (min: number, spread: number) =>
  delay(min + Math.random() * spread);

/** A capture makes Chrome produce a frame, even for a hidden page. */
export const forceFrame = (send: Send) =>
  send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 1,
    clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
  });

/** In page: whether the page was hidden before it ever painted. */
export function unpaintedInPage() {
  return (
    document.visibilityState !== "visible" &&
    !performance.getEntriesByType("paint").length
  );
}

/** Moves to the point and presses the left button there, as a person does. */
export async function pressAt(send: Send, { x, y, unpainted }: Point) {
  const button = { x, y, button: "left", clickCount: 1 } as const;
  // Chrome drops a press on a page that has never painted, and a page hidden
  // before its first frame never paints by itself. Reuse clickPointInPage's
  // check when present to save a round trip.
  const needsFrame =
    unpainted ??
    Boolean(
      (
        await send("Runtime.evaluate", {
          expression: inPageCall(unpaintedInPage),
          returnByValue: true,
        }).catch(() => undefined)
      )?.result.value
    );
  if (needsFrame) await forceFrame(send);
  // A hidden tab draws no frames, so Chrome holds a mouseMoved there until a
  // press flushes it, or for about 5 seconds: send both before awaiting.
  await Promise.all([
    send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
    send("Input.dispatchMouseEvent", { type: "mousePressed", ...button }),
  ]);
  // A human holds a button: an instant press-release dwell would be a tell.
  await pause(50, 50);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...button });
}

// In page: the center of the element `find` returns, scrolled into view, if
// it has a size, holds still and is topmost there; otherwise why not.
export async function clickPointInPage(
  find: (...args: unknown[]) => unknown,
  args: unknown[]
): Promise<Point | { miss: string }> {
  const element = find(...args);
  if (!(element instanceof Element)) return { miss: "matched no element" };
  let rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height)
    return { miss: "matched an element with no size" };
  if (
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= innerWidth ||
    rect.top >= innerHeight
  ) {
    element.scrollIntoView({ block: "center", inline: "center" });
    rect = element.getBoundingClientRect();
  }
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  // Inside a shadow root, the document reports only the shadow host.
  const root = element.getRootNode();
  const hit = (root instanceof ShadowRoot ? root : document).elementFromPoint(
    x,
    y
  );
  if (!hit) return { miss: "is outside the viewport" };
  if (hit !== element && !element.contains(hit)) {
    const name = `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}${
      typeof hit.className === "string" && hit.className.trim()
        ? `.${hit.className.trim().split(/\s+/).join(".")}`
        : ""
    }`;
    return { miss: `is covered by <${name.slice(0, 80)}>` };
  }
  const unpainted = !performance.getEntriesByType("paint").length;
  // A hidden tab paints nothing, yet takes input; pressAt forces its first frame.
  if (document.visibilityState !== "visible") return { x, y, unpainted };
  // One animation frame (raced with 80ms for an occluded macOS window whose
  // rAF is throttled) proves the box is not mid-animation.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 80);
  });
  const now = element.getBoundingClientRect();
  if (
    Math.abs(now.x - rect.x) > 0.5 ||
    Math.abs(now.y - rect.y) > 0.5 ||
    Math.abs(now.width - rect.width) > 0.5 ||
    Math.abs(now.height - rect.height) > 0.5
  )
    return { miss: "is still moving" };
  return { x, y, unpainted: !performance.getEntriesByType("paint").length };
}

/**
 * In page: event-driven watch for clickPointInPage to produce a clickable
 * point. Reuses watchInPage so DOM mutations and load events resolve click()
 * immediately instead of waiting for the next host poll.
 */
export function watchClickInPage(
  watch: typeof watchInPage,
  point: typeof clickPointInPage,
  find: (...args: unknown[]) => unknown,
  args: unknown[]
) {
  return watch(async () => {
    const res = await point(find, args);
    return res && "x" in res ? res : null;
  }, []);
}

const ALT = 1;
const CONTROL = 2;
const META = 4;
const SHIFT = 8;

const MODIFIER_BITS: Record<string, number> = {
  alt: ALT,
  option: ALT,
  control: CONTROL,
  ctrl: CONTROL,
  meta: META,
  cmd: META,
  command: META,
  shift: SHIFT,
};

// macOS Blink editing commands: CDP Input.dispatchKeyEvent with Meta+a/c/v/x/z
// requires explicit `commands` on macOS to trigger native text-editing actions.
const MAC_EDIT_COMMANDS: Record<string, string[]> = {
  [`${META}:a`]: ["selectAll"],
  [`${META}:c`]: ["copy"],
  [`${META}:x`]: ["cut"],
  [`${META}:v`]: ["paste"],
  [`${META}:z`]: ["undo"],
  [`${META | SHIFT}:z`]: ["redo"],
};

// Named keys as Chrome's US layout reports them: [keyCode, text]. Each
// key's code is its name, except Space's.
const NAMED_KEYS: Record<string, [number, string?]> = {
  Enter: [13, "\r"],
  Tab: [9],
  Escape: [27],
  Backspace: [8],
  Delete: [46],
  ArrowUp: [38],
  ArrowDown: [40],
  ArrowLeft: [37],
  ArrowRight: [39],
  Home: [36],
  End: [35],
  PageUp: [33],
  PageDown: [34],
  " ": [32, " "],
};

// US keyboard punctuation keys: [code, keyCode, modifiers].
const PUNCTUATION_KEYS: Record<string, [string, number, number]> = {
  "-": ["Minus", 189, 0],
  _: ["Minus", 189, SHIFT],
  "=": ["Equal", 187, 0],
  "+": ["Equal", 187, SHIFT],
  "[": ["BracketLeft", 219, 0],
  "{": ["BracketLeft", 219, SHIFT],
  "]": ["BracketRight", 221, 0],
  "}": ["BracketRight", 221, SHIFT],
  "\\": ["Backslash", 220, 0],
  "|": ["Backslash", 220, SHIFT],
  ";": ["Semicolon", 186, 0],
  ":": ["Semicolon", 186, SHIFT],
  "'": ["Quote", 222, 0],
  '"': ["Quote", 222, SHIFT],
  ",": ["Comma", 188, 0],
  "<": ["Comma", 188, SHIFT],
  ".": ["Period", 190, 0],
  ">": ["Period", 190, SHIFT],
  "/": ["Slash", 191, 0],
  "?": ["Slash", 191, SHIFT],
  "`": ["Backquote", 192, 0],
  "~": ["Backquote", 192, SHIFT],
  "!": ["Digit1", 49, SHIFT],
  "@": ["Digit2", 50, SHIFT],
  "#": ["Digit3", 51, SHIFT],
  $: ["Digit4", 52, SHIFT],
  "%": ["Digit5", 53, SHIFT],
  "^": ["Digit6", 54, SHIFT],
  "&": ["Digit7", 55, SHIFT],
  "*": ["Digit8", 56, SHIFT],
  "(": ["Digit9", 57, SHIFT],
  ")": ["Digit0", 48, SHIFT],
};

function keyOf(key: string) {
  const named = NAMED_KEYS[key];
  if (named) {
    const [keyCode, text] = named;
    const code = key === " " ? "Space" : key;
    return { key, code, keyCode, text, modifiers: 0 };
  }
  const punct = PUNCTUATION_KEYS[key];
  if (punct) {
    const [code, keyCode, modifiers] = punct;
    return { key, code, keyCode, text: key, modifiers };
  }
  if (!/^[a-z\d]$/i.test(key)) return undefined;
  const upper = key.toUpperCase();
  return {
    key,
    code: /\d/.test(key) ? `Digit${key}` : `Key${upper}`,
    keyCode: upper.charCodeAt(0),
    text: key,
    modifiers: key === key.toLowerCase() ? 0 : SHIFT,
  };
}

async function stroke(
  send: Send,
  key: NonNullable<ReturnType<typeof keyOf>>,
  extraModifiers = 0,
  commands?: string[]
) {
  const modifiers = key.modifiers | extraModifiers;
  // A chord with Meta/Control/Alt suppresses text insertion unless it's a pure Shift.
  const hasNonShiftMod = Boolean(modifiers & (ALT | CONTROL | META));
  const text = hasNonShiftMod ? undefined : key.text;
  const common = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers,
  };
  // Chrome types the text of a keyDown; a key without text is a rawKeyDown.
  await send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    ...common,
    text,
    unmodifiedText: text,
    ...(commands ? { commands } : {}),
  });
  await pause(10, 15);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

function parseChord(input: string) {
  if (input.length <= 1 || !input.includes("+")) {
    const known = keyOf(input);
    return known
      ? { key: known, modifiers: 0, commands: undefined }
      : undefined;
  }
  // Support chords like "Meta+a", "Shift+Tab", "Meta+Shift+z", or "Meta++".
  const parts = input.endsWith("++")
    ? [...input.slice(0, -2).split("+"), "+"]
    : input.split("+");
  const baseName = parts.pop();
  if (!baseName || !parts.length) return undefined;
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (!bit) return undefined;
    modifiers |= bit;
  }
  const known = keyOf(baseName);
  if (!known) return undefined;
  const commands =
    MAC_EDIT_COMMANDS[
      `${modifiers | known.modifiers}:${known.key.toLowerCase()}`
    ];
  return { key: known, modifiers, commands };
}

/**
 * Presses one key or modifier chord: a named key ("Enter"), US layout character
 * ("-"), or chord ("Meta+a", "Shift+Tab", "Control+c").
 */
export async function press(send: Send, key: string) {
  const parsed = parseChord(key);
  if (!parsed)
    throw new Error(
      `press: unknown key ${JSON.stringify(key)}; use a US key character, chord (e.g. "Meta+a"), or one of ${Object.keys(
        NAMED_KEYS
      )
        .map((name) => JSON.stringify(name))
        .join(", ")}`
    );
  await stroke(send, parsed.key, parsed.modifiers, parsed.commands);
}

/**
 * Types text into the focused element. Default sends one trusted keystroke per
 * character with human-like pacing; `{ fast: true }` inserts text directly via
 * trusted Input.insertText (like pasting), pressing Enter on newlines.
 */
export async function type(
  send: Send,
  text: string,
  options?: { fast?: boolean }
) {
  if (options?.fast) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line) await send("Input.insertText", { text: line });
      if (i < lines.length - 1) await press(send, "Enter");
    }
    return;
  }
  for (const char of text) {
    const known = char === "\n" ? keyOf("Enter") : keyOf(char);
    // A character with no key on the layout is inserted as text: the page
    // sees input events but no keydown.
    if (known) await stroke(send, known);
    else await send("Input.insertText", { text: char });
    await pause(15, 25);
  }
}
