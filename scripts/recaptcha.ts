import type { Evaluate, Send } from "./probe";

// Page function: the checkbox point of a visible, uncovered, normal-size
// (304x78) reCAPTCHA anchor widget, or null.
function recaptchaCheckboxPoint() {
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
  const point = await evaluate(recaptchaCheckboxPoint);
  if (!point) return false;
  const click = { ...point, button: "left", clickCount: 1 } as const;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...click });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...click });
  return true;
}
