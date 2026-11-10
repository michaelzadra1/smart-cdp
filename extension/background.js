// smart-cdp's personal host (scripts/personal.ts) opens
// http://127.0.0.1:<port>/smart-cdp/<id> in this profile. That tab wakes this
// worker, which connects back on the port, checks the host knows the secret in
// secret.json (the host writes it), then attaches chrome.debugger to that one
// tab and carries its CDP messages both ways. chrome.debugger has no remote
// debugging prompt. A proof with background: true first gives focus back to
// what the user was using. Host control messages: {"type":"reset"} detaches and
// reattaches, which clears everything the last probe enabled;
// {"type":"close"} closes the tab.

const RUN_URL = /^http:\/\/127\.0\.0\.1:(\d+)\/smart-cdp\/([0-9a-f-]{36})$/;
const PING_MS = 20_000;
const runs = new Map();

async function hmac(message) {
  const { secret } = await fetch(chrome.runtime.getURL("secret.json")).then(
    (response) => response.json()
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Chrome brings a tab opened from its command line to the front, often in a
// new window of its own. Move it into the window of the tab the user used
// last (a window it empties closes) and reactivate that tab. macOS Chrome
// cannot send a window behind (windows.update focused: false).
async function restoreFocus(tabId) {
  const [previous] = (await chrome.tabs.query({ windowType: "normal" }))
    .filter((tab) => tab.id !== tabId)
    .sort((a, b) => b.lastAccessed - a.lastAccessed);
  if (!previous) return;
  await chrome.tabs.move(tabId, { windowId: previous.windowId, index: -1 });
  await chrome.tabs.update(previous.id, { active: true });
}

function start(tabId, url) {
  const [, port, id] = RUN_URL.exec(url);
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/smart-cdp/${id}/extension`
  );
  const challenge = crypto.randomUUID();
  const run = { socket, attached: false, resetting: false };
  const send = (message) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };
  run.send = send;
  // An open socket keeps the worker alive only while messages flow.
  const ping = setInterval(() => send({ type: "ping" }), PING_MS);
  run.stop = () => {
    clearInterval(ping);
    runs.delete(tabId);
    if (run.attached) chrome.debugger.detach({ tabId }).catch(() => {});
    socket.close();
  };
  const attach = async () => {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      send({ type: "error", message: String(error?.message ?? error) });
      return run.stop();
    }
    run.attached = true;
    const targets = await chrome.debugger.getTargets();
    send({
      type: "ready",
      targetId: targets.find((target) => target.tabId === tabId)?.id,
    });
  };
  runs.set(tabId, run);
  socket.onopen = () => send({ type: "hello", challenge });
  socket.onclose = run.stop;
  socket.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "proof") {
      if (message.proof !== (await hmac(`${challenge}:${id}`)))
        return run.stop();
      // Losing focus is better than losing the tab: never let this block it.
      if (message.background) await restoreFocus(tabId).catch(() => {});
      return attach();
    }
    if (message.type === "reset") {
      run.resetting = true;
      run.attached = false;
      await chrome.debugger.detach({ tabId }).catch(() => {});
      run.resetting = false;
      return attach();
    }
    if (message.type === "close") return chrome.tabs.remove(tabId);
    const { id: commandId, method, params, sessionId } = message;
    if (!run.attached)
      return send({
        id: commandId,
        error: { code: -32000, message: "smart-cdp is not attached" },
      });
    try {
      const result = await chrome.debugger.sendCommand(
        sessionId ? { tabId, sessionId } : { tabId },
        method,
        params
      );
      send({ id: commandId, result: result ?? {} });
    } catch (error) {
      send({
        id: commandId,
        error: { code: -32000, message: String(error?.message ?? error) },
      });
    }
  };
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && RUN_URL.test(change.url) && !runs.has(tabId))
    start(tabId, change.url);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const run = runs.get(source.tabId);
  run?.send({ method, params, sessionId: source.sessionId });
});

chrome.debugger.onDetach.addListener((source) => {
  const run = runs.get(source.tabId);
  if (run && !run.resetting) run.stop();
});
chrome.tabs.onRemoved.addListener((tabId) => runs.get(tabId)?.stop());
