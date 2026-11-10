# Diagnosing failures

## Compare a working path with a failing one

Before blaming egress or fingerprinting:

1. Hold the request body and inputs constant.
2. Compare the visible interaction, target/tab, request order, URL, method,
   headers, cookies, initiator, and timing. The first bootstrap request differs
   from steady-state requests; a payload in another sequence position is not the
   same test.
3. Change one dimension at a time; record status, a body marker, and the cookie
   delta for both paths.

## Classify the failure

| Evidence | Likely class | Next check |
| --- | --- | --- |
| Visible checkbox challenge | Required interaction | [CAPTCHA.md](CAPTCHA.md) |
| Rate or unusual-traffic block, no actionable challenge | Profile state or remote block | Fresh `--once` launch in the same mode first; then cookies, exit IP, fingerprint |
| Other 403/429 | Session, IP, authorization, or challenge | Cookie delta, exit IP, request diff |
| URL matches but marker/parser fails | Response collision or schema drift | MIME type, top-level keys, stable body marker |
| Expected request never appears | Endpoint or interaction drift | Wider same-domain capture, visible UI state |
| `Not connected`, closed socket, missing CDP session | Transport or CDP session loss, or a claimed browser that was released | Browser owner, target existence, fresh attach; for a claimed browser, its idle timeout or `--end-session` |
| `Inspected target navigated or closed` | Redirect, reload or bot check replaced the page during a long `evaluate` | Poll with `waitFor` |
| Command never answers; listed as unanswered at shutdown | Target paused by `waitForDebuggerOnStart` | Resume it; [PROTOCOL.md](PROTOCOL.md#targets-and-child-sessions) |
| Body unavailable | Read before completion | Pair `requestId` with `Network.loadingFinished` |
| DOM action has no effect | Selector or event mismatch | Geometry, disabled state, real CDP input |

## Replay a request

Capture the natural request from the exact path under test first. Keep its URL,
method, headers, body shape, and session state; regenerate transaction/request
IDs when the site does. A template captured from another path can be accepted
while being wrong. Refresh the capture when session state may have expired.

## Traps that produce false evidence

| Trap | Instead |
| --- | --- |
| Trusting a success on a warm profile or claimed browser | Record cookies; repeat with `--once` when it matters |
| `Fetch.enable` handling `authRequired` but not every `requestPaused` | Continue, fulfill, or fail each paused request exactly once |
| Believing a zero because the page's text lacks the value | Read a few pages by hand: it may sit in a link's parameter, a frame, behind a scroll or a short link |
| Reporting a 403 as blocked, or a token match as a hit, from a fetch | Open the page in a browser and read it: a 403 hid a menu item that matched by accident, and the page had no such value |
| Turning every polling loop into an event wait | Keep loops whose body does work (scrolling, dwell) or that watch state with no CDP event |
