# Visible challenges

## Contents

- [reCAPTCHA checkbox](#recaptcha-checkbox)
- [Cloudflare Turnstile and the managed-challenge interstitial](#cloudflare-turnstile-and-the-managed-challenge-interstitial)
- [HUMAN (PerimeterX) Press & Hold](#human-perimeterx-press--hold)
- [Other layouts](#other-layouts)

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

Click once the widget shows on a screenshot, not straight after load. Visible
Chrome routes a click to a cross-origin frame only after compositing the frame
into the page, about half a second after the frame first paints (Chrome 157).
Until then the click lands on the page behind it, and no CDP event marks the
moment.
`true` means only that input was dispatched. Verify the original URL and real
content returned; a redirect can still be loading. Google may re-challenge
after the redirect: allow about three attempts, then stop and keep the browser
for inspection. Hidden, covered, compact, and transformed widgets return
`false`; use the general procedure for those.

## Cloudflare Turnstile and the managed-challenge interstitial

`clickTurnstileCheckbox()` (from `scripts/turnstile.ts`, in the probe context)
finds a visible, uncovered Cloudflare Turnstile widget — a site-embedded one or
the managed-challenge interstitial's checkbox — and clicks its checkbox: 30px
inside the widget box's left edge, vertically centered, after a mouse move and
with a 50–100ms press hold, the cadence the published pure-CDP Turnstile
solvers use. It scales to either widget layout by measuring the hidden
`input[name="cf-turnstile-response"]` box first, then the widget's
`challenges.cloudflare.com` iframe.

```js
if (!(await clickTurnstileCheckbox())) throw new Error("no clickable Turnstile widget");
```

The click must come after the widget has painted, exactly as for reCAPTCHA:
input into a cross-origin frame the moment it has size does not register
(observed live: the same click that never arrived before a settle arrived
after one). A page-side synthetic click (`el.click()`) is untrusted and
Turnstile ignores it; only `Input.dispatchMouseEvent` arrives as a real one.

`true` means input was dispatched. Then wait for the challenge's own success
signal instead of guessing:

- Embedded widget: the callback token fills the hidden response input. Wait
  for it, then submit it however the site's form takes it:
  ```js
  const token = await waitFor(
    () => document.querySelector('input[name="cf-turnstile-response"]')?.value,
    { timeoutMs: 15000 }
  );
  ```
- Managed-challenge interstitial: the page reloads itself and Chrome receives
  an HttpOnly `cf_clearance` cookie, invisible to `document.cookie`. Read it
  with `Network.getCookies` (`await send("Network.enable")` first), confirm
  the original URL, and verify real content.
- The non-interactive "Checking your browser..." interstitial has no widget
  and needs no click: staying on the visible browser while it runs its checks
  clears it, so wait for the reload rather than clicking around.

If clicks dispatch but the widget never clears, re-run against
`https://webscraper.io/bot-check`. Its cross-origin checkbox reports a
failure when clicks leak iframe-relative `screenX`/`screenY`, the Turnstile
tell of February 2025 (Chrome bug 40280325); a failure there means this
Chrome build still leaks, and a passing click needs input from outside the
browser (an OS-level click tool), which is out of this skill's reach. On
Chrome 157 the check passes. A passing bot-check with a still-failing site
points at host fingerprinting rather than the click; work through
[STEALTH.md](STEALTH.md) instead of re-clicking.

## HUMAN (PerimeterX) Press & Hold

`holdPressAndHoldButton()` (from `scripts/press-hold.ts`, in the probe
context) handles the "press and hold to verify" challenge HUMAN (formerly
PerimeterX) shows — walmart.ca's `/blocked` page ("We like real shoppers, not
robots!") is one. It finds the live `iframe[title*="Human verification"]`,
presses its wide `[role=button]` ("Press & Hold Human Challenge") at the
center with trusted mouse input, and holds — with a pixel of tremor, as a
held real mouse has — until the challenge announces completion (its
`#checkmark` draws and an aria-live region says "Human Challenge completed"),
then releases. It returns `{ heldMs, completed, cleared }`, or `false` when no
live challenge is on the page.

Two PX traits shape the helper; keep them in mind when probing these pages by
hand:

- PX mounts decoy copies of the challenge iframe, `display:none`, beside the
  live one, some inside a shadow root. The live one is the only one with a
  box model, and page JS cannot see inside any of them.
- PX hooks the page's geometry APIs: on these pages `getBoundingClientRect`
  can return `undefined` and `getComputedStyle` empty strings. Measure
  through the DOM domain (`DOM.getDocument({ depth: -1, pierce: true })`,
  `DOM.getBoxModel`), never page JS. Chrome reports box quads in viewport CSS
  pixels (they move with scroll), the coordinates `Input.dispatchMouseEvent`
  wants.

Validation runs on release, not during the hold: the URL stays on `/blocked`
while the button is held and navigates a few seconds after a successful
release. `cleared` means the URL moved or the challenge frame vanished within
15 seconds of the release. When `completed` is true but `cleared` is false,
wait a few more seconds before judging. Allow about three attempts, then stop
and work through [STEALTH.md](STEALTH.md).

## Other layouts

Capture `Page.captureScreenshot({ format: "png", captureBeyondViewport: false })`
and locate the actual visible control; never click an iframe's center blindly or
inject tokens. Input uses viewport CSS pixels, so scale screenshot measurements
by the viewport size. A press that lands before a cold background window's first
paint is dropped while its moves queue and flush; capture a screenshot first
to force the frame. `DOM.getDocument({ depth: -1, pierce: true })` inspects
shadow roots and same-process frames; an out-of-process frame needs its own
session ([PROTOCOL.md](PROTOCOL.md#targets-and-child-sessions)). Reinspect after
each action. An image or audio challenge opened by a checkbox is unsolved until
its own interaction succeeds: handle it or report it, never loop.

