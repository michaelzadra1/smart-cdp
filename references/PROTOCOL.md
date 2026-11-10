# Probe recipes

The transport is `scripts/cdp.ts`, a small client on Bun's native WebSocket.
`cdp` addresses the browser; `send(method, params)` addresses the bound
page's flattened session. Browser and Target commands use `cdp.send` or its
domain methods (`cdp.Target.getTargets()`). `cdp.on`, `cdp.once` and `cdp.off`
take an event name, or `<event>.<sessionId>` for one session, and the listener
gets `(params, sessionId)`. A protocol error is a `CdpProtocolError` with
Chrome's `code` and the `method`; a closed connection rejects pending commands
with `CdpConnectionClosedError`.

## Contents

- [Navigate and extract](#navigate-and-extract)
- [Capture responses](#capture-responses)
- [Screenshots and input](#screenshots-and-input)
- [Targets and child sessions](#targets-and-child-sessions)
  - [Popups and new tabs](#popups-and-new-tabs)

## Navigate and extract

Wait for the page state the next step needs. `waitFor(fn, { args, timeoutMs,
intervalMs })` re-evaluates a page predicate from Node, every 250 ms for up to
30 s by default, and returns its first truthy value. Each poll is a short
evaluation, so a redirect, reload or bot check that replaces the document costs
one retry. One long `evaluate`, such as an in-page polling loop, fails with
`Inspected target navigated or closed` when that happens, even after the load
event. Match the block page as well as the content, so a challenge returns
instead of timing out:

```js
const navigation = await send("Page.navigate", { url: "https://example.com/search" });
if (navigation.errorText) throw new Error(navigation.errorText);
return await waitFor(() => {
  const text = document.body?.innerText ?? "";
  if (!/results|access denied|verify you are human/i.test(text)) return null;
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, 4000),
    images: [...document.images].map((img) => ({
      src: img.currentSrc,
      loaded: img.complete && img.naturalWidth > 0,
    })),
  };
}, { timeoutMs: 45000 });
```

When an event marks readiness exactly, register it before navigating:
`Page.loadEventFired` (after `Page.enable`) for a document,
`Page.lifecycleEvent` (after `Page.setLifecycleEventsEnabled`) for a milestone,
or `Network.loadingFinished` for a response body.

`evaluate` serializes the function and JSON arguments, awaits its promise, and
throws on page exceptions. Keep each evaluation short. Closures, module imports, and Node globals are not
available inside the page function. Use `send("Runtime.callFunctionOn", ...)`
for remote objects; release retained handles after use.

## Capture responses

Enable Network before navigation. Correlate responses and completion by request
ID, and filter by the bound session. Capture only task-relevant URLs:

```js
await send("Network.enable");
const responses = new Map();
const completed = new Set();
const onResponse = ({ requestId, response }) => {
  if (response.url.includes("/api/")) responses.set(requestId, response);
};
const onFinished = ({ requestId }) => completed.add(requestId);
cdp.on(`Network.responseReceived.${sessionId}`, onResponse);
cdp.on(`Network.loadingFinished.${sessionId}`, onFinished);
// Navigate and wait for the specific application response here.
// For each matching completed request:
// const body = await send("Network.getResponseBody", { requestId });
// Decode body.body with Buffer.from(body.body, "base64") if body.base64Encoded.
// Remove both listeners in finally when continuing with other work.
```

`responseReceived` does not prove the body is complete. Check
`Network.loadingFailed` separately, including `blockedReason === "inspector"`
for requests blocked by CDP. Redirects may reuse request IDs. Do not add broad
request blocking/interception by default: it changes the page being measured.
Bulk runs that only read an API are the exception; see
[THROUGHPUT.md](THROUGHPUT.md#cut-bytes-and-cpu).

## Screenshots and input

```js
const { writeFile } = await import("node:fs/promises");
const { data } = await send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
});
await writeFile("/absolute/task/path/page.png", Buffer.from(data, "base64"));
```

Inspect the screenshot before acting on visual controls. Input coordinates are
viewport CSS pixels, not necessarily image pixels. `click`, `type` and `press`
cover presses and typing. For a hover, drag or scroll, measure visible bounds
and send `mouseMoved`, `mousePressed`, `mouseReleased` or `mouseWheel` through
`send("Input.dispatchMouseEvent", ...)`, then inspect the actual resulting
state.

## Targets and child sessions

Use `cdp.Target.attachToTarget({ targetId, flatten: true })` for an authorized
OOPIF or worker. Its commands use `cdp.send(method, params, childSessionId)`;
its events use the `method.childSessionId` event name. A worker has no DOM.
`DOM.getDocument({ depth: -1, pierce: true })` cannot substitute for attaching an
out-of-process frame. Detach child sessions in finally.

To follow every OOPIF or worker as it appears, call
`cdp.send("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: true }, sessionId)`.
That page-level call does not report popups or new tabs.

Auto-attach rules, observed on Chrome 154:

- Register the `Target.attachedToTarget` listener before calling
  `setAutoAttach`. Existing targets are reported before the command returns.
- A target attached while waiting (`waitingForDebugger: true`) answers no
  Page, Network or Runtime command until `Runtime.runIfWaitingForDebugger`.
  Awaiting `Network.enable` before resuming never returns. Send the setup
  commands and the resume together, then await them all.
- Resume every paused target you are not using. Detaching does not resume it.
- An `async` listener's errors escape the probe's `await` chain. Catch them
  inside the listener.

Puppeteer's
[TargetManager](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/TargetManager.ts)
works the same way: it sends setup and the resume in one `Promise.all`, and
resumes a target before detaching it.

### Popups and new tabs

A link with `target=_blank` or `window.open` creates a new page target. When
only its final state matters, call `Target.setDiscoverTargets`, wait for
`Target.targetCreated` whose `targetInfo.openerId` is the probe's `targetId`,
then `Target.attachToTarget({ targetId, flatten: true })`.

To capture the popup's first request, such as its navigation `Referer`, pause it
with browser-level auto-attach: `cdp.send` without a session. Without a filter
this attaches every extension worker, browser UI page and existing tab, so
filter to pages. Pick the popup by `openerId`, which is set even for
`rel=noopener`. Both the on and off calls need `flatten: true`, and turning it
off detaches every session it opened, so finish with the popup first:

```js
const { setTimeout: sleep } = await import("node:timers/promises");
let onAttach;
const popup = new Promise((resolve, reject) => {
  onAttach = ({ sessionId: sid, targetInfo, waitingForDebugger }) => {
    const resume = () => cdp.send("Runtime.runIfWaitingForDebugger", {}, sid);
    if (targetInfo.openerId !== targetId) {
      if (waitingForDebugger) resume().catch(() => {});
      return;
    }
    // Subscribe to `${event}.${sid}` here, before it resumes.
    Promise.all([cdp.send("Network.enable", {}, sid), resume()]).then(
      () => resolve({ sid, popupId: targetInfo.targetId }),
      reject,
    );
  };
  cdp.on("Target.attachedToTarget", onAttach);
});
await cdp.send("Target.setAutoAttach", {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: "page" }],
});
// Open it with click(): a page-script el.click() is popup-blocked.
const opened = await Promise.race([popup, sleep(10000)]);
// Read the popup with cdp.send(method, params, opened.sid), then close it.
cdp.off("Target.attachedToTarget", onAttach);
await cdp.send("Target.setAutoAttach", {
  autoAttach: false,
  waitForDebuggerOnStart: false,
  flatten: true,
});
if (opened) await cdp.send("Target.closeTarget", { targetId: opened.popupId });
```

If creating an additional task-owned target, use `background: true`, record its
ID, and close only that target when finished. If `Target.createTarget` fails
with "no browser is open" because no window is left, pass `newWindow: true`.
For storage isolation between jobs, create a target inside
`Target.createBrowserContext` and dispose that context when done; disposal skips
`beforeunload`, so save output first. Keep one mutating driver per target:
concurrent sessions race on navigation, input, and emulation. Navigation does not itself require
reattachment. On actual target/transport loss, diagnose before replaying actions.

Check `cdp.Browser.getVersion()` and the live protocol schema before using
experimental methods; CDP capabilities vary with the installed browser.

## Dialogs

Chrome stops a tab's commands while a JavaScript dialog is open, so an unanswered
one looks like a hang. The probe and the personal host accept `beforeunload`
("Leave site?") themselves, because the driver has already decided to leave. A
real CDP click is a user gesture, and that is what arms it. `alert`, `confirm` and
`prompt` carry a decision or a message, so a probe that may meet one handles it:

```js
await send("Page.enable");
cdp.on(`Page.javascriptDialogOpening.${sessionId}`, ({ type, message }) => {
  if (type === "beforeunload") return;
  console.error("Dialog:", type, message);
  void send("Page.handleJavaScriptDialog", { accept: false });
});
```
