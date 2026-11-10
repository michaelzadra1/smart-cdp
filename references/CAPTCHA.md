# Visible challenges

Try a visible challenge in the same session before rotating or discarding it.
A challenge page is not proof that the IP must cool down, and it is never an
empty result.

## reCAPTCHA checkbox

`clickRecaptchaCheckbox()` (from `scripts/recaptcha.ts`, in the probe context)
finds a visible, uncovered, normal-size (304×78) reCAPTCHA anchor iframe from
`www.google.com` or `www.recaptcha.net` and sends mouse move, press, and release
at its checkbox in viewport CSS pixels.

```js
if (!(await clickRecaptchaCheckbox())) throw new Error("no clickable checkbox");
// Wait up to ~10s for the page you actually wanted, then verify its content.
```

Click once the widget shows on a screenshot, not straight after load: input
sent to a cross-origin frame before it has painted can miss it.
`true` means only that input was dispatched. Verify the original URL and real
content returned; a redirect can still be loading. Google may re-challenge
after the redirect: allow about three attempts, then stop and keep the browser
for inspection. Hidden, covered, compact, and transformed widgets return
`false`; use the general procedure for those.

## Other layouts

Capture `Page.captureScreenshot({ format: "png", captureBeyondViewport: false })`
and locate the actual visible control; never click an iframe's center blindly or
inject tokens. Input uses viewport CSS pixels, so scale screenshot measurements
by the viewport size. `DOM.getDocument({ depth: -1, pierce: true })` inspects
shadow roots and same-process frames; an out-of-process frame needs its own
session ([PROTOCOL.md](PROTOCOL.md#targets-and-child-sessions)). Reinspect after
each action. An image or audio challenge opened by a checkbox is unsolved until
its own interaction succeeds: handle it or report it, never loop.

