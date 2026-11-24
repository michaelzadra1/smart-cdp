import type { CdpClient } from "./cdp";
import type { Send } from "./probe";

/**
 * Follows the bound page's requests, so a probe can wait for the network to go
 * quiet rather than sleep. Every probe has it: an action's request can start
 * before a later settle() could enable Network, and following costs about 70
 * microseconds a request.
 */
export async function trackNetwork(
  cdp: CdpClient,
  send: Send,
  sessionId: string
) {
  const inFlight = new Set<string>();
  const documentStatus = new Map<string, number>();
  let lastActivity = Date.now();
  const ended = ({ requestId }: { requestId: string }) => {
    inFlight.delete(requestId);
    lastActivity = Date.now();
  };
  cdp.on(`Network.requestWillBeSent.${sessionId}`, ({ requestId }) => {
    inFlight.add(requestId);
    lastActivity = Date.now();
  });
  cdp.on(
    `Network.responseReceived.${sessionId}`,
    ({ requestId, type, response }) => {
      if (type === "Document") documentStatus.set(requestId, response.status);
    }
  );
  // Chrome reports no end for the requests a replaced document left
  // unfinished, so a new document starts the count again.
  cdp.on(`Page.frameNavigated.${sessionId}`, ({ frame }) => {
    if (!frame.parentId) inFlight.clear();
  });
  cdp.on(`Network.loadingFinished.${sessionId}`, ended);
  cdp.on(`Network.loadingFailed.${sessionId}`, ended);
  await send("Network.enable");
  return {
    /**
     * How long no request has been in flight, counted from `since` at the
     * earliest: an action's request starts a moment after the action returns.
     */
    quietMs: (since: number) =>
      inFlight.size ? 0 : Date.now() - Math.max(lastActivity, since),
    /** The HTTP status of the document a navigation loaded, by its loaderId. */
    status: (loaderId: string | undefined) =>
      loaderId === undefined ? undefined : documentStatus.get(loaderId),
  };
}
