# High-throughput scraping

Read this before building or tuning anything that pulls many items through a
browser: dozens to thousands of requests or records in one run. It distills a
production CDP scraper that settles about 3,000 requests per run across five
large sites, each behind a different anti-bot vendor. The numbers are
measurements from those sites. They show the size of an effect, not constants
to copy: calibrate every rate, cap and limit on the site in front of you.

Here a **session** is one cookie jar plus the browser identity behind it; a
**CDP session** is a protocol connection to a target. For one-off inspection,
keep the page unmodified as [PROTOCOL.md](PROTOCOL.md) describes. To classify a
single failure, use [DIAGNOSIS.md](DIAGNOSIS.md).

## Contents

- [The shape of a fast run](#the-shape-of-a-fast-run)
- [Replay the site's API from inside the page](#replay-the-sites-api-from-inside-the-page)
- [Fan out with a capped, jittered scheduler](#fan-out-with-a-capped-jittered-scheduler)
- [Stream results out of the page](#stream-results-out-of-the-page)
- [Pace to the site's meter](#pace-to-the-sites-meter)
- [Batch only what an output diff proves](#batch-only-what-an-output-diff-proves)
- [Cut bytes and CPU](#cut-bytes-and-cpu)
- [Classify every answer](#classify-every-answer)
- [Deadlines and recovery](#deadlines-and-recovery)
- [Waits](#waits)
- [Scaling out](#scaling-out)
- [Measure a speed change](#measure-a-speed-change)
- [In-page programs](#in-page-programs)

## The shape of a fast run

The browser earns admission and lends its identity; it does not render one
page per item. A fast run:

1. Admits one session: a real navigation on the site that passes whatever
   challenge it shows ([CAPTCHA.md](CAPTCHA.md)). Block the app's own data
   calls during this load if they draw on the same quota as your items.
2. Gets a request template: built from constants when every field is known,
   otherwise captured once from the app's own traffic.
3. Parks the tab on a near-empty same-origin page.
4. Fans the items out from inside the page with a capped, jittered scheduler.
5. Streams finished items back to Node and validates each record.
6. Persists in the background while the next items dispatch.
7. Retries only unsettled items.

Rendering a page per item measured about 1.5 MB per item, against about 25 KB
for the same item replayed, and every navigation is another chance to meet a
challenge. Drive the UI only where no API exists: the admission step, an
interaction the site requires, or data present only in the DOM.

## Replay the site's API from inside the page

`fetch` from the page with `credentials: "include"` carries the session's
cookies, user agent, client hints and TLS fingerprint. A client outside the
browser carries none of them, and edges fingerprint TLS: on one CDN, curl got
403 where a client with a different TLS fingerprint got 200 for the same URL
from the same IP.

- **Stay on the target origin.** From `about:blank`, a credentialed request
  goes out with `Origin: null` and is refused even with a warm cookie jar.
- **Park on the lightest same-origin document**, such as `/robots.txt` (150–200
  ms to load). The app page keeps running its framework, sensors, polling and
  retries on the one main thread your fan-out needs. Measured costs of staying
  on it: a frozen fan-out evaluate on one site, about 98,000 blocked resource
  attempts competing with replay on a second, and part of the API quota quietly
  spent on a third.
- **When a sensor script must keep running** for the session to stay admitted,
  stay on the app page and move the dispatcher into a Web Worker (built from a
  Blob URL) to get off the busy main thread. Whether parking ends admission is
  a site fact: settle it with a matched A/B, not by assumption.

### Request templates

- Capture from `Network.requestWillBeSent`, with Network enabled before the app
  makes the call: URL, method, body and the app's own headers. Harvest session
  headers and keys from real traffic; never fabricate them.
- Strip headers the browser owns before replay: `host`, `cookie`,
  `content-length`, `origin`, `referer`, `user-agent` and `sec-*`. `fetch` sets
  them correctly; copied values are stale or rejected.
- Mint a fresh request or transaction ID per call (`crypto.randomUUID()` in the
  page) when the template carries one. Edges deduplicate on them.
- Change one field per item. Hard-code values you verified are static, such as
  a public API key or the query text, and build the whole template from
  constants when you can: 1.5 s versus 15 s to load the app and capture one.
- If the admission request can serve as the run's first item or its baseline
  query, use its answer instead of fetching it again.
- A template is bound to the session that produced it. Replayed from another
  session it was refused for every item. Drop it whenever the session changes,
  and never cache a failed capture.
- Parse what is identical across items (a reference list or catalog in every
  response) once per capture. One scraper spent 65% of its parse CPU
  re-parsing a 200 KB block that was identical in 179 of 180 responses.

## Fan out with a capped, jittered scheduler

An unbounded `Promise.all` burst is the quickest way to lose a run, and it often
fails silently. Measured outcomes include 200s with empty bodies, plausible but
inflated values, and a refusal that outlasted the burst. Route every fan-out
through one scheduler that caps requests in flight, waits a random offset
before each dispatch, stops dispatching at a wall-clock budget below the
evaluate's deadline, stops at the first denial, and gives each request its own
timeout (one dead pooled socket once pinned an evaluate for 120 s). The
[stream template](#stream-results-out-of-the-page) is such a scheduler.

Pace by dispatch rate, the offset, not by worker count. A fixed pool's rate
falls as the server slows: a 14-worker pool dropped to about 6 requests per
second on slow queries and took 3–4× longer than offset pacing. Past the knee,
concurrency only queues: at 16 slots the per-request median was 10–11 s versus
6.4–6.8 s at 8, with no throughput gain. Judge cap changes by per-request
latency, not total time.

Find the rate before the run, without spending the session:

1. Send a handful of requests one at a time and note latency and status.
2. Step the rate up (for example 3, 5, 8, 12 per second) with fixed-size
   probes of 30–60 requests, logging time and status per request. Stop each
   probe at the first refusal.
3. After a refusal, wait, then send one request to see whether the refusal
   cleared before resuming. Note how long it lasted.
4. Run at a step below the first refused rate, with a cap of 4–8.

Without a probe, start at a cap of 4–8 and a 150–400 ms offset (about 3–4
requests per second per origin). Safe rates measured from about 3 to 35 per
second per origin across five sites, so nothing transfers between sites. A
rate that passes a few sequential runs can still fail under concurrency: about
5 per second passed three runs, then left 3 of 10 runs partial in a 10-host
load test. Record the smallest offset that passed the load test as a named
constant.

## Stream results out of the page

One `evaluate` per batch waits for the batch's slowest request, then pays a
round trip before the next batch starts. Measured, that idle tail was 30 s of a
77 s run. Widening batches does not fix it, and a refusal then costs more items.
Instead, one evaluate starts a detached dispatcher that queues finished items
on a page global and returns at once. Node drains the queue and acknowledges by
cumulative index, so a drain can be repeated safely, including from a later
probe.

Start, inside the parked tab. Build `items` in Node from the template; `init`
must be JSON-safe (a string `body`, plain-object `headers`):

```js
const KEY = "__stream";
const items = []; // [{ id, url, init }]
const cfg = { cap: 6, offMin: 150, offSpan: 250, budgetMs: 60_000, fetchTimeoutMs: 20_000 };
await evaluate((key, items, cfg) => {
  globalThis[key]?.stop?.(); // A previous dispatcher keeps fetching unless stopped.
  const ctl = new AbortController();
  const q = (globalThis[key] = { done: [], taken: 0, finished: false, wake: null, stop: () => ctl.abort() });
  const settle = (entry) => { q.done.push(entry); q.wake?.(); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + cfg.budgetMs;
  let halted = false; // A denial halts dispatch; requests in flight still land.
  const stopped = () => halted || ctl.signal.aborted || Date.now() >= deadline;
  const denied = (entry) => { settle(entry); halted = true; };
  (async () => {
    let inFlight = 0;
    const tasks = [];
    try {
      for (let i = 0; i < items.length && !stopped(); i++) {
        while (inFlight >= cfg.cap && !stopped()) await sleep(40);
        if (i > 0) await sleep(cfg.offMin + Math.random() * cfg.offSpan);
        if (stopped()) break;
        const { id, url, init } = items[i];
        inFlight++;
        tasks.push((async () => {
          try {
            const signal = AbortSignal.any([ctl.signal, AbortSignal.timeout(cfg.fetchTimeoutMs)]);
            const r = await fetch(url, { ...init, credentials: "include", signal });
            const text = await r.text();
            if ([401, 403, 429, 444].includes(r.status)) return denied({ id, status: r.status, denied: true });
            if (!r.ok) return settle({ id, status: r.status, error: text.slice(0, 200) });
            let body;
            try {
              body = JSON.parse(text);
            } catch {
              return denied({ id, status: r.status, denied: true, error: text.slice(0, 200) }); // HTML on a JSON API: a challenge page.
            }
            settle({ id, status: r.status, data: body }); // Keep only the fields you read: this crosses CDP.
          } catch (e) {
            settle({ id, error: String(e) });
          } finally {
            inFlight--;
          }
        })());
      }
      await Promise.all(tasks);
    } finally {
      q.finished = true;
      q.wake?.();
    }
  })();
}, KEY, items, cfg);
```

Drain, in the same probe or a later one, and stop the dispatcher on every exit
path:

```js
const KEY = "__stream";
const drainInPage = (key, received, waitMs) => {
  const q = globalThis[key];
  if (!q) return { lost: true };
  const drop = received - q.taken;
  if (drop > 0) {
    q.done.splice(0, drop);
    q.taken += drop;
  }
  return new Promise((resolve) => {
    let timer;
    const answer = () => {
      clearTimeout(timer);
      if (q.wake === answer) q.wake = null;
      resolve({ from: q.taken, items: q.done.slice(), finished: q.finished, lost: false });
    };
    if (q.done.length > 0 || q.finished) return answer();
    timer = setTimeout(answer, waitMs);
    q.wake = answer;
  });
};
const results = new Map();
let received = 0;
try {
  for (;;) {
    const d = await evaluate(drainInPage, KEY, received, 1000);
    if (d.lost) throw new Error("stream lost: the page navigated or reloaded");
    for (const item of d.items) results.set(item.id, item);
    received = d.from + d.items.length;
    if (d.finished) break;
    if (d.items.length > 0) await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await evaluate((key) => globalThis[key]?.stop?.(), KEY).catch(() => {});
}
const settled = [...results.values()].filter((r) => r.data !== undefined);
const refusal = [...results.values()].find((r) => r.denied);
// Retry set: items with no `data` entry. Recover the session first if `refusal` is set.
```

Checked in Chrome against a local fixture: 200 items with a cap of 6 that the
server never saw exceeded, in 9 drains; a 429 on request 51, or an HTML
challenge on request 41, stopped dispatch while the requests in flight still
landed; a second start stopped the first dispatcher; a fresh agent using this template
collected a 300-item catalog behind a 10-requests-per-second meter with no
refusals.

- Run the whole stream inside one probe only with `--timeout-ms` above the
  setup time plus `budgetMs` plus `fetchTimeoutMs`. A probe that hits its
  deadline exits without its `finally`, so the next start stops the old
  dispatcher itself.
- Drain about once a second while items flow. The long poll (`waitMs`) returns
  as soon as an item lands, so the tail is not delayed; draining without the
  pause costs one round trip per item.
- A missing queue means the page navigated or reloaded, never that the run
  finished. Let a failed drain read throw: a loop that swallowed read failures
  spent 408 s on a dead browser.
- Keep finished bodies out of any per-task result array, or every body stays
  pinned in renderer memory. Trim each body in the page before settling it.
- With several sessions, hand each one small slices from a single Node-side
  queue, and return a refused session's unsettled items to it. Fixed halves
  left one tab idle 37–54 s while the other worked.
- Top a live stream up instead of starting a new one: let the page accept more
  items while it still dispatches, and refill when its undispatched backlog
  falls below about two caps. Start a helper session's admission and stream
  while the lead session is still admitting; run serially, that setup cost
  25–111 s per run.

## Pace to the site's meter

Protected APIs meter requests, and a refusal usually outlasts the burst that
earned it: one site served 36 items at about 26 per second, then refused every
later request even at a safe pace. Before tuning speed, learn what the meter
counts and what it is keyed to. Settle the key with a control on the same exit
IP: a second session (`--session <other>` in this skill, or a
`Target.createBrowserContext` context for a separate cookie jar in the same
browser) run alone and then alongside the first.

| Meter | Signature | What speeds it up |
| --- | --- | --- |
| Rate per origin or CDN edge | Refusals after a fast run of requests; clears after a pause | A lower rate per origin; a second origin or edge with its own meter, run at the full rate (129 s → 69 s, no refusals in 15 concurrent runs) |
| Fixed window, such as N per clock minute | 429 near the window's end; run time steps with the start second (identical runs 88, 113, 127 s) | Fewer requests: larger page sizes, a second quota key. Never sleeps or extra tabs |
| Reads per admitted session | Refused after about the same number of reads at any pace | Re-admit (a fresh real navigation, as in step 1) well before that count: without it a session was refused at read 39; re-admitting every 20 reads settled 80 of 80 |
| Keyed to exit IP | A second session on the same IP gets the leftovers (0 of 10, 4 of 10), or every session is refused within the same second | Nothing on that IP; one session per IP, and more IPs (4 hosts at 2 per second each, none refused, where 4 sessions on one host were refused in 3 s) |
| Keyed to cookie jar | A second session with its own jar on the same IP runs at full rate | Parallel sessions (two sessions 135 s versus 206 s on one) |

- Endpoints, origins and edges often have separate meters. Give each its own
  scheduler at the full cap and budget, and never split one cap among them.
  Within one session, run one stream per origin: a second stream from the same
  session drew 567 refusals.
- For a fixed window, reserve slots on a serialized promise chain so
  concurrent tasks cannot overbook it. Budget a little under the measured
  limit (123 measured, 120 budgeted), and release 1–2 s after the boundary, not
  on it: a release 250 ms after it drew 7 refusals.
- A wave of 429s is one event: back off once for the group, not per request.
  Retrying through a 5xx storm spends the quota too.
- After a refusal, wait `Retry-After` when the response has one. Otherwise
  wait about 20 s, send one request, and resume at half the cap once it passes:
  on one site retries 20 s or more after a denial were admitted 23 of 23, and
  those within 3 s were denied 6 of 6.
- Whether to retry on the same session or switch identity is a site fact. On
  one site the same session cleared 31 of 32 refusals while switching identity
  re-flagged 58%. Profile-state blocks, such as an unusual-traffic page, need
  the cold rotation in [DIAGNOSIS.md](DIAGNOSIS.md) instead. Settle it with a
  control.
- Hammering an exhausted session can escalate the block to the whole IP for
  tens of minutes. Pacing and re-admitting prevent it; waiting it out is the
  costly cure.
- A refusal can hide from the page: a cross-origin 429 sent without CORS
  headers reaches page `fetch` as `TypeError: Failed to fetch`, status 0. Read
  the real status and `Retry-After` in Node from
  `Network.responseReceivedExtraInfo`, matched by `requestId`.

## Batch only what an output diff proves

Packing several items into one request (array parameters, GraphQL aliases,
multi-value filters) looks like free speed and usually loses data silently.
Measured on real sites:

- An array parameter ran 4× faster and passed a 309-of-309 single-query probe,
  yet returned half the results across a full run (1,267 rows down to 463)
  while every status stayed green.
- A multi-value filter credited a shared result to the first item only.
- An edge that allows only the app's exact queries rejected aliased ones.
- Requests above an undocumented server cap on items per request returned 200
  with no results.

Before adopting any batching, diff the actual output of one item per request
against N per request on the same inputs, across several queries. A larger page
size that brings each item down to a single request is the one batching that
reliably pays; servers often clamp it, so read the returned count.

## Cut bytes and CPU

- Block with `Network.setBlockedURLs` URL patterns (`*` matches any run of
  characters across the full URL), scoped to the target host. Re-apply them
  after every `Network.enable` and in every probe: they live on the CDP session
  and reset when it detaches. Check the live protocol schema for the parameter
  name. Avoid `Fetch.enable` interception for this: it routes every request
  through Node and stalls the page whenever Node lags.
- Block third-party analytics, tag managers, ads, chat and session replay;
  images, fonts, video and `data:image/*`; and map tiles. One site went from
  3–4 MB to about 600 KB per item.
- Never block CSS or first-party JavaScript: an app that dispatched its API
  after layout returned no results without CSS.
- Never block the anti-bot vendor's sensor or its paired telemetry. Before
  adding a pattern, check that the script loads asynchronously (a third-party
  script loaded synchronously in `<head>` before first-party code is usually
  the sensor), that it sets no anti-bot cookie (such as `_abck`, `bm_*`,
  `ak_bmsc`, `_px*`, `datadome`, `cf_clearance`, `incap_ses_*`), and that the
  API payload is unchanged with it blocked.
- Count blocked requests per host (`Network.loadingFailed` with
  `blockedReason === "inspector"`). A runaway count means the page is retrying a
  blocked resource in a loop: blocking one map loader script caused about 1,270
  retries per second and livelocked the renderer. Unblock that resource.
- Keep the HTTP cache on. Assets are reused from the second item on, and a
  cacheless browser looks less like a person.
- Ask for less. Request only the fields you read (a GraphQL selection or a
  `fields` parameter took one response from 197 KB to 12 KB). Request exactly
  the page, radius or filter you keep. Trim each body in the page before it
  crosses CDP (154 KB down to 71 KB).
- Enable only the CDP domains whose events you consume. Network events from
  many busy tabs can starve the event loop of the Node process driving them.

## Classify every answer

A bulk run fails worst by storing a block as data. Classify each response
before persisting it:

| Answer | Treat as |
| --- | --- |
| 401, 403, 429 or 444, or a block marker in the body | Session refused: stop the stream, recover the session, retry the item; never a verdict on the item |
| 200 carrying HTML or a challenge page where JSON was expected | The same: session refused |
| 200 with an empty body, answered in a few milliseconds | The same: a silent refusal |
| 5xx, network error or timeout | Transient: retry the item. A timeout is unfinished work, not a refusal |
| 200 with the shape intact but the fields you read nulled or missing | Degraded: retry, and never store it as a real empty |
| 200 with an empty list and no rejection from the site | Degraded: retry. Count an empty answer as real only when the site says why (an explicit error or rejection code): an overloaded backend's empty 200s once stored 240 items as false negatives |
| A record marked pending or unknown (such as "may be available") | Ask for that record again once, after the main wave; still unknown is unsettled, never a negative |
| 200, valid and empty | The real answer, once a control item known to have results came back full |
| Some records malformed | Keep the readable ones and log the dropped paths, capped |
| Every record malformed | Schema drift: stop and fix the parser, never a verdict on the item |

Validate records one at a time, and only the fields you read: one null field in
one record once failed all 183 items of a run. Stop re-fetching a body once it
proves unreadable. Include a positive control in every run. Admission signals,
such as a 200 from a public endpoint, a solved anti-bot cookie or a sensor
acknowledgement, are prerequisites, not proof that the protected API will
answer: skipping admission because the jar already held a solved cookie lost
every item of a run.

## Deadlines and recovery

- Nest timeouts so the inner one fires first and returns a classifiable error:
  per request, then dispatch budget, then evaluate, then probe or run. Equal
  timers make the outcome a coin flip.
- Give every CDP command a timeout. A raw CDP client sets none per call, and a
  browser whose HTTP endpoint answers while its CDP layer is wedged hangs
  forever.
- Latch transport loss: after the first lost-connection error, fail every later
  call at once until a reconnect, rather than letting each burn its own timeout
  (one run burned 150 s twelve times and settled nothing).
- A 5 s `Runtime.evaluate` of `1` separates a dead connection from a stalled
  page. A tab can pass it and still be deaf to its fan-out, so also treat a
  stall past the healthy completion time (its p99) as dead.
- `Inspected target navigated or closed` means the site replaced the page's
  context mid-evaluate. The CDP session is still attached: wait about 1 s and
  retry, up to 3 times. A closed socket or `Session with given id not found`
  needs a reconnect first.
- Retry only unsettled items, in a bounded number of passes (four passes 3 s
  apart worked well).
- Re-ask an unanswered request (timeout, 5xx, empty 200) once inside the
  stream, appended to the work still dispatching, before failing its item into
  a recovery pass: a pass pays setup again and waits out the stream's tail.
- Persist as items settle, through a serial background queue: writes stay in
  order, the producer never awaits them, and the first failure stops the queue
  and is checked before the next chunk. Waiting on writes between batches cost
  about 9 s per run, and with background writes a dead session loses only what
  it had not yet written.
- When a few items stay slow past the p95 latency, hedge them with a second
  attempt (an alternate request shape or a cache-busting parameter) and abort
  the sibling at the first definitive answer.

## Waits

- In a hot loop, wait inside the page (a bounded promise on a DOM or global
  condition) rather than polling from Node; re-issue the wait when a navigation
  destroys the context. Each poll is a round trip: over a remote CDP link,
  polling every 250 ms cost about 6 s per step and timed out 21 times in 160.
  For single probes, `waitFor` in [PROTOCOL.md](PROTOCOL.md) remains the right
  tool.
- `load` may never fire on pages with slow third-party content (130 of 132
  waits ran out a 12 s timeout). Wait for the response or DOM state the next
  step needs.
- When a required interaction makes the app fire its own requests, cancel them
  rather than letting them run. One click fired 289 background requests, 268 of
  them refused, and burned the session.

## Scaling out

- Run time is setup plus the slowest stream. Each item on a metered stream
  adds permanent latency: a slope under a rate meter, a step under a fixed
  window. Split timings into setup and per-stream spans before judging a
  change.
- Reach for software levers before bigger machines: skip pages, send fewer
  requests, move fewer bytes, use a second meter.
- Add sessions only when the meter is keyed to the session (see the meter
  table) and one session's queue is the bottleneck, or when slow requests fill
  one connection's streams ([below](#when-slow-requests-fill-the-cap)). Tabs in one browser context
  share its cookie jar and often its renderer, so they are not independent
  sessions.
- Stagger streams that share a machine when a challenge solve is CPU-bound.

### When slow requests fill the cap

A request that carries N items waits on its slowest item: if a share p of
single lookups is slow, 1 − (1 − p)^N of requests are. A 3–4% per-item tail
made most 20-item requests take 8–10 s. Those requests hold every in-flight
slot, and one session's slots end at its HTTP/2 connection's stream limit.
Read the limit with Node, which needs no admission:
`node -e 'const s=require("http2").connect("https://<host>");s.on("remoteSettings",r=>{console.log(r.maxConcurrentStreams);s.close()})'`.

- A cap above that limit only queues inside the browser. Throughput is the
  limit divided by request latency, so a cap or batch-size change cannot fix it.
- Add a connection: a second session in another browser has its own jar and
  connection. On one site it lifted throughput from 3.9–4.2 to 7.7 items per
  second.
- Run the second session at half the first's pace, so the pair adds streams
  rather than rate. At full pace it drew 403s within about 41 s.
- Keep the second session best-effort. On any refusal it drops and returns its
  unsettled items to the shared queue, and the lead carries on.

## Measure a speed change

- Interleave control and treatment (C, T, C, T): two samples per arm, more
  only when they overlap. Discard or repeat the first pass after a capture: it
  pays cold connection setup and flatters whatever ran first.
- Log the varied value in each arm. Pools and caches can hand both arms the
  same value.
- Match the production unit of work and run past the ramp-up. A short wave
  measures startup.
- Judge by per-request latency and the distribution (median and tail), not one
  total. Server latency drifts by hour: identical runs measured a 2.0–6.3 s
  median. Compare only runs from the same hour.
- Before blaming your egress, browser or code for a slowdown, time the same
  endpoint from a different vantage in the same hour, such as a residential
  browser on the site's own search. When both slow together, the site is slow.
- Give each arm a fresh session, and a fresh host when the meter is keyed to
  the IP. One sustained arm (about 3,000 requests) burned its host to IP-wide
  429s, and every later arm on that host measured the refusal.
- Accept a change to the run path on several consecutive production-shape runs
  across different inputs of matched size, not repeats of one input.
- Diff the output, not counts or statuses: the same items and fields, one per
  request against N, with a positive control.
- Load-test a rate with concurrent sessions or hosts at production shape before
  calling it safe. Sequential runs miss refusals that strike one host in four
  or five.
- Run the winner for the full job before adopting it. A rate that passed 900 requests was refused at 337, 456 and 1,125 on later samples; the rate below it held 7,200.
- Test a meter's key above the single-session limit. Two sessions at a combined rate below it passed and looked keyed to the jar; four at twice it were refused together.
- Diff an alternate origin over hundreds of items. One served the same records with translated names on 18 of 300, after 30 of 30 looked identical.
- A denial ends the measurement; throughput after it is not data.

## In-page programs

Write page code as real functions, serialize them with `fn.toString()` (the
probe's `evaluate(fn, ...args)` does this), and pass every dependency as an
argument. A module-scope constant passes typechecking and then throws
`ReferenceError` in the page; one shipped that way and every request came back
status 0. In a codebase, guard every serialized function with one test that
rebuilds it from its source with `new Function`, calls it with stub inputs, and
scans the source for identifiers it uses but never declares. Wire types lie: a
numeric field that arrived as a string zeroed a whole run, so coerce with
`Number()` and check `Number.isFinite`.
