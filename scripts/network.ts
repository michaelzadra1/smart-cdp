import type { CdpClient } from "./cdp";
import type { Send } from "./probe";

// Streaming, push and fire-and-forget resource types that never mark a page
// as still loading. Including them made settle() burn its full timeout on SSE
// apps, HMR dev servers, audio/video streams and analytics beacons.
const IGNORED_TYPES = new Set([
  "EventSource",
  "WebSocket",
  "Media",
  "Ping",
  "CSPViolationReport",
  "Prefetch",
]);

function isEventStream(response: {
  mimeType?: string;
  headers?: Record<string, string>;
}) {
  if (response.mimeType?.toLowerCase().includes("text/event-stream"))
    return true;
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    if (
      name.toLowerCase() === "content-type" &&
      String(value).toLowerCase().includes("text/event-stream")
    )
      return true;
  }
  return false;
}

/**
 * Follows the bound page's requests and document lifecycle events so settle()
 * and goto() wait event-driven instead of polling or sleeping. Every probe has
 * it: an action's request can start before a later settle() could enable
 * Network, and following costs about 70 microseconds a request.
 */
export async function trackNetwork(
  cdp: CdpClient,
  send: Send,
  sessionId: string
) {
  const inFlight = new Set<string>();
  const documentStatus = new Map<string, number>();
  const waiters = new Set<() => void>();
  const disposers = new Set<() => void>();
  let lastActivity = Date.now();
  let domReady = false;

  const notify = () => {
    for (const wake of waiters) wake();
  };

  const ended = ({ requestId }: { requestId: string }) => {
    if (!inFlight.delete(requestId)) return;
    lastActivity = Date.now();
    notify();
  };

  const onRequest = ({
    requestId,
    type,
  }: {
    requestId: string;
    type?: string;
  }) => {
    if (type && IGNORED_TYPES.has(type)) return;
    inFlight.add(requestId);
    lastActivity = Date.now();
    notify();
  };

  const onResponse = ({
    requestId,
    type,
    response,
  }: {
    requestId: string;
    type?: string;
    response: {
      status: number;
      mimeType?: string;
      headers?: Record<string, string>;
    };
  }) => {
    if (type === "Document") documentStatus.set(requestId, response.status);
    // fetch()-based SSE streams start as type "Fetch" and only announce
    // text/event-stream when headers arrive.
    if ((type && IGNORED_TYPES.has(type)) || isEventStream(response)) {
      if (inFlight.delete(requestId)) {
        lastActivity = Date.now();
        notify();
      }
    }
  };

  // Chrome reports no end for the requests a replaced document left
  // unfinished, so a new main document resets the count and waits for its DOM.
  const onNavigated = ({ frame }: { frame: { parentId?: string } }) => {
    if (!frame.parentId) {
      inFlight.clear();
      domReady = false;
      lastActivity = Date.now();
      notify();
    }
  };

  const markDomReady = () => {
    domReady = true;
    notify();
  };

  cdp.on(`Network.requestWillBeSent.${sessionId}`, onRequest);
  cdp.on(`Network.responseReceived.${sessionId}`, onResponse);
  cdp.on(`Page.frameNavigated.${sessionId}`, onNavigated);
  cdp.on(`Page.domContentEventFired.${sessionId}`, markDomReady);
  cdp.on(`Page.loadEventFired.${sessionId}`, markDomReady);
  cdp.on(`Network.loadingFinished.${sessionId}`, ended);
  cdp.on(`Network.loadingFailed.${sessionId}`, ended);

  await send("Network.enable");

  return {
    /**
     * Event-driven wait until the document is parsed and at most `maxInFlight`
     * tracked requests remain open for `quietMs` (counted from the call's start
     * at the earliest, so a request an action triggers moments later is still
     * caught). Resolves `false` on `timeoutMs`.
     */
    waitQuiet: (
      quietMs: number,
      timeoutMs: number,
      checkDomReady: () => Promise<boolean>,
      maxInFlight = 0
    ): Promise<boolean> =>
      new Promise((resolve) => {
        const began = Date.now();
        let done = false;
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        let recheckTimer: ReturnType<typeof setTimeout> | undefined;
        let checkingDom = false;

        const finish = (settled: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(quietTimer);
          clearTimeout(recheckTimer);
          clearTimeout(deadlineTimer);
          waiters.delete(schedule);
          disposers.delete(cancel);
          resolve(settled);
        };

        const cancel = () => finish(false);

        const schedule = () => {
          if (done) return;
          clearTimeout(quietTimer);
          quietTimer = undefined;
          if (inFlight.size > maxInFlight) return;
          const elapsed = Date.now() - Math.max(lastActivity, began);
          const wait = Math.max(0, quietMs - elapsed);
          quietTimer = setTimeout(() => {
            quietTimer = undefined;
            if (done || inFlight.size > maxInFlight) return;
            if (domReady) return finish(true);
            if (checkingDom) return;
            checkingDom = true;
            checkDomReady()
              .then((ready) => {
                checkingDom = false;
                if (done) return;
                if (ready) {
                  domReady = true;
                  if (inFlight.size <= maxInFlight) finish(true);
                } else {
                  // Still parsing: domContentEventFired wakes schedule();
                  // this fallback covers a probe that disabled Page events.
                  clearTimeout(recheckTimer);
                  recheckTimer = setTimeout(schedule, 200);
                }
              })
              .catch(() => {
                checkingDom = false;
                if (!done) {
                  clearTimeout(recheckTimer);
                  recheckTimer = setTimeout(schedule, 100);
                }
              });
          }, wait);
        };

        const deadlineTimer = setTimeout(() => finish(false), timeoutMs);
        waiters.add(schedule);
        disposers.add(cancel);
        schedule();
      }),
    /** The HTTP status of the document a navigation loaded, by its loaderId. */
    status: (loaderId: string | undefined) =>
      loaderId === undefined ? undefined : documentStatus.get(loaderId),
    /** Removes all CDP listeners and cancels pending waiters (for child tabs). */
    dispose: () => {
      for (const cancel of [...disposers]) cancel();
      cdp.off(`Network.requestWillBeSent.${sessionId}`, onRequest);
      cdp.off(`Network.responseReceived.${sessionId}`, onResponse);
      cdp.off(`Page.frameNavigated.${sessionId}`, onNavigated);
      cdp.off(`Page.domContentEventFired.${sessionId}`, markDomReady);
      cdp.off(`Page.loadEventFired.${sessionId}`, markDomReady);
      cdp.off(`Network.loadingFinished.${sessionId}`, ended);
      cdp.off(`Network.loadingFailed.${sessionId}`, ended);
    },
  };
}
