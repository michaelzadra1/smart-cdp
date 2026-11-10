import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

// Run the actual extension worker against Chrome's event contract.
test("heartbeats and debugger events cannot send on a closing or closed WebSocket", async () => {
  let onUpdated: (tab: number, change: { url: string }) => void = () => {};
  let onEvent: (
    source: { tabId: number },
    method: string,
    params: unknown
  ) => void = () => {};
  let heartbeat = () => {};
  let sends = 0;
  let socket: FakeSocket | undefined;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      socket = this;
    }
    send() {
      if (this.readyState !== 1) throw new Error("WebSocket is closed");
      sends++;
    }
    close() {
      this.readyState = 3;
    }
  }
  const event = () => ({ addListener: () => {} });
  const chrome = {
    tabs: {
      onUpdated: {
        addListener: (fn: typeof onUpdated) => {
          onUpdated = fn;
        },
      },
      onRemoved: event(),
    },
    debugger: {
      onEvent: {
        addListener: (fn: typeof onEvent) => {
          onEvent = fn;
        },
      },
      onDetach: event(),
    },
  };
  runInNewContext(
    await readFile(join(import.meta.dir, "../extension/background.js"), "utf8"),
    {
      chrome,
      WebSocket: FakeSocket,
      crypto,
      setInterval: (fn: () => void) => {
        heartbeat = fn;
        return 1;
      },
      clearInterval: () => {},
    }
  );
  onUpdated(1, {
    url: "http://127.0.0.1:12345/smart-cdp/12345678-1234-1234-1234-123456789012",
  });
  heartbeat();
  onEvent({ tabId: 1 }, "Network.loadingFinished", {});
  expect(sends).toBe(2);
  for (const state of [2, 3]) {
    if (socket) socket.readyState = state;
    heartbeat();
    onEvent({ tabId: 1 }, "Network.loadingFinished", {});
  }
  expect(sends).toBe(2);
});

test("a background claim gives focus back to the tab or window the user used last", async () => {
  const secret = "s";
  const activated: number[] = [];
  const sentBehind: number[] = [];
  let onUpdated: (tab: number, change: { url: string }) => void = () => {};
  type Handler = (event?: { data: string }) => Promise<void> | void;
  const sockets: { onopen?: Handler; onmessage?: Handler; sent: string[] }[] =
    [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    constructor() {
      sockets.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
  }
  const event = () => ({ addListener: () => {} });
  const chrome = {
    runtime: { getURL: (path: string) => path },
    tabs: {
      onUpdated: {
        addListener: (fn: typeof onUpdated) => {
          onUpdated = fn;
        },
      },
      onRemoved: event(),
      // Tab 8 opened in a new window of its own; the others share window 7.
      get: async (id: number) => ({ id, windowId: id === 8 ? 9 : 7 }),
      query: async ({ windowId }: { windowId: number }) =>
        windowId === 9
          ? [{ id: 8, lastAccessed: 2000 }]
          : [
              { id: 2, lastAccessed: 300 },
              { id: 3, lastAccessed: 900 },
              { id: 4, lastAccessed: 100 },
              { id: 5, lastAccessed: 1000 },
            ],
      update: async (id: number) => activated.push(id),
    },
    windows: {
      update: async (id: number, { focused }: { focused: boolean }) =>
        focused || sentBehind.push(id),
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async () => {},
      getTargets: async () => [],
    },
  };
  runInNewContext(
    await readFile(join(import.meta.dir, "../extension/background.js"), "utf8"),
    {
      chrome,
      WebSocket: FakeSocket,
      crypto,
      TextEncoder,
      fetch: async () => ({ json: async () => ({ secret }) }),
      setInterval: () => 0,
      clearInterval: () => {},
    }
  );
  // The newest tab, 5, is the run tab itself: Chrome just activated it.
  for (const [tabId, background] of [
    [5, true],
    [6, false],
    [8, true],
  ] as const) {
    const id = `00000000-0000-4000-8000-00000000000${tabId}`;
    onUpdated(tabId, { url: `http://127.0.0.1:9/smart-cdp/${id}` });
    const socket = sockets.at(-1);
    await socket?.onopen?.();
    const { challenge } = JSON.parse(socket?.sent[0] ?? "{}");
    const proof = createHmac("sha256", secret)
      .update(`${challenge}:${id}`)
      .digest("hex");
    await socket?.onmessage?.({
      data: JSON.stringify({ type: "proof", proof, background }),
    });
  }
  expect(activated).toEqual([3]);
  expect(sentBehind).toEqual([9]);
});
