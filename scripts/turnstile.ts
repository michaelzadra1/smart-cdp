import { pressAt } from "./input";
import type { Evaluate, Send } from "./probe";

// Page function: the checkbox point of a visible, uncovered Cloudflare
// Turnstile widget (a site-embedded one or a managed-challenge
// interstitial's), or null. The widget's checkbox sits about 30px from the
// widget box's left edge, vertically centered.
export function turnstileCheckboxPointInPage() {
  const candidates: { box: Element; x: number; y: number }[] = [];
  // Standard widgets embed a hidden response input inside the widget box;
  // this also holds for the managed-challenge interstitial. Its parent div
  // is the box to measure.
  for (const input of document.querySelectorAll<HTMLInputElement>(
    'input[name="cf-turnstile-response"]'
  )) {
    const box = input.parentElement;
    if (!box) continue;
    const rect = box.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 40) continue;
    candidates.push({
      box,
      x: rect.x + 30,
      y: rect.y + rect.height / 2,
    });
  }
  // A widget may render without the marker input (custom wrappers): its own
  // checkbox iframe is then the box.
  for (const frame of document.querySelectorAll("iframe")) {
    if (!/^https:\/\/challenges\.cloudflare\.com\/turnstile\//.test(frame.src))
      continue;
    const rect = frame.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 40) continue;
    candidates.push({
      box: frame,
      x: rect.x + 30,
      y: rect.y + rect.height / 2,
    });
  }
  for (const point of candidates) {
    // The widget itself must be topmost at the point: a hit inside the box
    // is fine (the checkbox iframe), a foreign overlay, such as a cookie
    // banner, rejects it.
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit && (hit === point.box || point.box.contains(hit)))
      return { x: point.x, y: point.y };
  }
  return null;
}

/** Click once; true means input was dispatched, not that the challenge cleared. */
export async function clickTurnstileCheckbox({
  send,
  evaluate,
}: {
  send: Send;
  evaluate: Evaluate;
}): Promise<boolean> {
  const point = await evaluate(turnstileCheckboxPointInPage);
  if (!point) return false;
  // Land near the measured point instead of on it every time, like the
  // published pure-CDP Turnstile solvers do.
  const jitter = () => Math.floor(Math.random() * 7) - 3;
  await pressAt(send, { x: point.x + jitter(), y: point.y + jitter() });
  return true;
}
