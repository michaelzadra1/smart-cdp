import { pressAt } from "./input";
import type { Evaluate, Send } from "./probe";

// Page function: the checkbox point of a visible, uncovered, normal-size
// (304x78) reCAPTCHA anchor widget, or null.
export function recaptchaCheckboxPointInPage() {
  for (const frame of document.querySelectorAll("iframe")) {
    if (
      !/^https:\/\/(?:www\.google\.com|www\.recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/anchor\?/.test(
        frame.src
      )
    )
      continue;
    const rect = frame.getBoundingClientRect();
    if (Math.abs(rect.width - 304) > 1 || Math.abs(rect.height - 78) > 1)
      continue;
    const x = rect.x + 28;
    const y = rect.y + 38;
    if (document.elementFromPoint(x, y) === frame) return { x, y };
  }
  return null;
}

/** Click once; true means input was dispatched, not that the challenge cleared. */
export async function clickRecaptchaCheckbox({
  send,
  evaluate,
}: {
  send: Send;
  evaluate: Evaluate;
}): Promise<boolean> {
  const point = await evaluate(recaptchaCheckboxPointInPage);
  if (!point) return false;
  await pressAt(send, point);
  return true;
}
