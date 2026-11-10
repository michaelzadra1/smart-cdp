import { setTimeout as delay } from "node:timers/promises";
import type { Send } from "./probe";

/** A point in viewport CSS pixels. */
export type Point = { x: number; y: number };

const pause = (min: number, spread: number) =>
  delay(min + Math.random() * spread);

/** Moves to the point and presses the left button there, as a person does. */
export async function pressAt(send: Send, { x, y }: Point) {
  const button = { x, y, button: "left", clickCount: 1 } as const;
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
  // Two animation frames with the box unmoved: the press cannot land on
  // something in motion, and the page is painting, which matters because
  // Chrome drops a press that comes before the first paint. A hidden tab
  // paints nothing, yet takes input.
  if (document.visibilityState === "visible") {
    const painted = await new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      setTimeout(() => resolve(false), 200);
    });
    if (!painted) return { miss: "is on a page that is not painting" };
    const now = element.getBoundingClientRect();
    if (JSON.stringify(now) !== JSON.stringify(rect))
      return { miss: "is still moving" };
  }
  return { x, y };
}

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

const SHIFT = 8;

function keyOf(key: string) {
  const named = NAMED_KEYS[key];
  if (named) {
    const [keyCode, text] = named;
    const code = key === " " ? "Space" : key;
    return { key, code, keyCode, text, modifiers: 0 };
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

async function stroke(send: Send, key: NonNullable<ReturnType<typeof keyOf>>) {
  const common = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers: key.modifiers,
  };
  // Chrome types the text of a keyDown; a key without text is a rawKeyDown.
  await send("Input.dispatchKeyEvent", {
    type: key.text ? "keyDown" : "rawKeyDown",
    ...common,
    text: key.text,
    unmodifiedText: key.text,
  });
  await pause(20, 40);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/** Presses one key: a named key such as "Enter", or a letter, digit or space. */
export async function press(send: Send, key: string) {
  const known = keyOf(key);
  if (!known)
    throw new Error(
      `press: unknown key ${JSON.stringify(key)}; use a letter, digit or one of ${Object.keys(
        NAMED_KEYS
      )
        .map((name) => JSON.stringify(name))
        .join(", ")}`
    );
  await stroke(send, known);
}

/** Types text into the focused element, one keystroke per character. */
export async function type(send: Send, text: string) {
  for (const char of text) {
    const known = char === "\n" ? keyOf("Enter") : keyOf(char);
    // A character with no key on the layout is inserted as text: the page
    // sees input events but no keydown.
    if (known) await stroke(send, known);
    else await send("Input.insertText", { text: char });
    await pause(30, 70);
  }
}
