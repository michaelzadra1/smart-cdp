import { setTimeout as delay } from "node:timers/promises";
import type ProtocolApi from "devtools-protocol/types/protocol";
import type { Send } from "./probe";

type DomNode = ProtocolApi.DOM.Node;

/** What one press-and-hold attempt on a HUMAN challenge reports. */
export type PressAndHoldResult = {
  /** How long the button was held, in milliseconds. */
  heldMs: number;
  /** The challenge announced completion while the button was held. */
  completed: boolean;
  /** The challenge left the page (the URL moved or its frame is gone). */
  cleared: boolean;
};

// HUMAN (formerly PerimeterX) mounts its challenge as several iframes titled
// "Human verification challenge": one live, the rest display:none decoys,
// some inside a shadow root, and it hooks the page's geometry APIs — on a PX
// page getBoundingClientRect can return undefined. So nothing here measures
// through page JS: the DOM domain sees through shadow roots and page hooks,
// and a decoy has no box model, which is how the live frame is picked.
const FRAME_TITLE = "Human verification";
// The hold button ("Press & Hold Human Challenge", about 260px wide) shares
// its frame with the 40px "Accessible challenge" link; the wide one is it.
const BUTTON_MIN_WIDTH = 100;
// The challenge announces completion a few seconds into the hold; 12s covers
// a slow one. Validation runs on release: give it 15s to leave the page.
const MAX_HOLD_MS = 12_000;
const SETTLE_MS = 15_000;

const pause = (min: number, spread: number) =>
  delay(min + Math.random() * spread);

/** Every iframe whose title matches, however deep in shadow roots. */
function framesTitled(root: DomNode, titlePart: string): DomNode[] {
  const frames: DomNode[] = [];
  const walk = (node: DomNode) => {
    const attrs = node.attributes ?? [];
    const titleAt = attrs.indexOf("title");
    if (
      node.nodeName === "IFRAME" &&
      titleAt >= 0 &&
      attrs[titleAt + 1]?.includes(titlePart)
    )
      frames.push(node);
    for (const child of node.children ?? []) walk(child);
    for (const shadow of node.shadowRoots ?? []) walk(shadow);
  };
  walk(root);
  return frames;
}

type LiveChallenge = {
  frameId: number;
  buttonId: number;
};

/** The live challenge frame and its hold button, or null when there is none. */
async function liveChallenge(send: Send): Promise<LiveChallenge | null> {
  const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
  for (const frame of framesTitled(root, FRAME_TITLE)) {
    try {
      await send("DOM.getBoxModel", { nodeId: frame.nodeId });
    } catch {
      continue; // a display:none decoy has no box
    }
    const { node } = await send("DOM.describeNode", { nodeId: frame.nodeId });
    const doc = node.contentDocument;
    if (!doc) continue;
    const { nodeIds } = await send("DOM.querySelectorAll", {
      nodeId: doc.nodeId,
      selector: "[role=button]",
    });
    let best: { nodeId: number; width: number } | null = null;
    for (const nodeId of nodeIds) {
      try {
        const { model } = await send("DOM.getBoxModel", { nodeId });
        if (model.width >= BUTTON_MIN_WIDTH && model.width > (best?.width ?? 0))
          best = { nodeId, width: model.width };
      } catch {
        // A hidden candidate has no box.
      }
    }
    if (best) return { frameId: frame.nodeId, buttonId: best.nodeId };
  }
  return null;
}

type ChallengeState = "holding" | "completed" | "failed" | "gone";

/** The challenge's own report: its checkmark draws and an aria-live region
 *  announces "Human Challenge completed" (or a failure) inside the frame. */
async function challengeState(send: Send): Promise<ChallengeState> {
  let root: DomNode;
  try {
    ({ root } = await send("DOM.getDocument", { depth: -1, pierce: true }));
  } catch {
    return "holding"; // a mid-navigation read says nothing; keep holding
  }
  let live: DomNode | null = null;
  for (const frame of framesTitled(root, FRAME_TITLE)) {
    try {
      await send("DOM.getBoxModel", { nodeId: frame.nodeId });
      live = frame;
      break;
    } catch {
      // decoy
    }
  }
  if (!live) return "gone";
  let state: ChallengeState = "holding";
  const walk = (node: DomNode) => {
    const attrs = node.attributes ?? [];
    const attr = (name: string) => {
      const at = attrs.indexOf(name);
      return at >= 0 ? (attrs[at + 1] ?? "") : "";
    };
    const text = (n: DomNode): string =>
      (n.children ?? []).map((c) => c.nodeValue ?? text(c)).join(" ");
    if (attr("id") === "checkmark" && attr("class").trim()) state = "completed";
    if (attr("aria-live") || attr("role") === "alert") {
      const said = text(node);
      if (/completed/i.test(said)) state = "completed";
      else if (/failed|try again|went wrong/i.test(said)) state = "failed";
    }
    for (const child of node.children ?? []) walk(child);
    for (const shadow of node.shadowRoots ?? []) walk(shadow);
    if (node.contentDocument) walk(node.contentDocument);
  };
  walk(live);
  return state;
}

/** location.href, or "" while the page is mid-navigation. */
async function pageUrl(send: Send): Promise<string> {
  try {
    const { result } = await send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    return String(result.value ?? "");
  } catch {
    return "";
  }
}

/**
 * Presses and holds the HUMAN (PerimeterX) "Press & Hold" button with trusted
 * mouse input until the challenge completes, then releases. Returns false when
 * no live challenge is on the page; otherwise what the attempt observed.
 * `cleared` means the challenge left the page within 15s of the release —
 * HUMAN validates on release, so a completed hold still needs that wait.
 */
export async function holdPressAndHoldButton({
  send,
}: {
  send: Send;
}): Promise<PressAndHoldResult | false> {
  await send("DOM.enable");
  const found = await liveChallenge(send);
  if (!found) return false;
  await send("DOM.scrollIntoViewIfNeeded", { nodeId: found.buttonId }).catch(
    () => {}
  );
  const { model } = await send("DOM.getBoxModel", { nodeId: found.buttonId });
  // Chrome reports box quads in viewport CSS pixels — they move with
  // scroll — exactly the coordinates Input.dispatchMouseEvent wants.
  const jitter = () => Math.floor(Math.random() * 7) - 3;
  // border is the quad [x1,y1, x2,y2, x3,y3, x4,y4]; 1 and 3 are opposite.
  const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.border;
  const x = (x1 + x3) / 2 + jitter();
  const y = (y1 + y3) / 2 + jitter();
  const button = { x, y, button: "left", clickCount: 1 } as const;
  // A cold background window drops a press that lands before its first
  // paint (moves queue and flush, the press goes nowhere). Capturing a shot
  // forces the compositor to produce a frame, and the settle lets Chrome
  // start routing input into the frame.
  await send("Page.captureScreenshot", { format: "jpeg", quality: 30 });
  await pause(350, 150);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: x - 70,
    y: y - 50,
  });
  await pause(80, 80);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...button });
  const startUrl = await pageUrl(send);
  const t0 = Date.now();
  let state: ChallengeState = "holding";
  while (Date.now() - t0 < MAX_HOLD_MS) {
    await pause(250, 250);
    // A held real mouse still trembles; a frozen cursor is a tell. Keep the
    // jitter to a pixel so the press never leaves the button.
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x + Math.random() * 2 - 1,
      y: y + Math.random() * 2 - 1,
    }).catch(() => {});
    state = await challengeState(send);
    if (state !== "holding") break;
    if ((await pageUrl(send)) !== startUrl) {
      state = "gone";
      break;
    }
  }
  const heldMs = Date.now() - t0;
  // "Completed, please wait" registers before the release should come.
  if (state === "completed") await pause(500, 500);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...button });
  let cleared = state === "gone";
  if (state !== "failed") {
    const deadline = Date.now() + SETTLE_MS;
    while (!cleared && Date.now() < deadline) {
      await delay(600);
      cleared =
        (await pageUrl(send)) !== startUrl ||
        (await challengeState(send)) === "gone";
    }
  }
  return { heldMs, completed: state === "completed", cleared };
}
