import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Server, ServerWebSocket } from "bun";
import {
  type Chrome,
  type ChromeProfile,
  launchChrome,
  profileDownloads,
  stopChrome,
  trackDownload,
} from "./chrome";
import { type ElectronApp, launchApp } from "./electron";

// A detached process that holds one CDP connection for the probes after it.
// Attachment: Chrome 144+ asks the user to allow every new CDP WebSocket to a
// personal browser, so attached probes share this one approved connection.
// Session: it launches and owns a Chrome, or a read-only copy of an Electron
// app (electron.ts), so the browser and its tab outlive each probe until
// --end-session or the idle timeout closes them.
// Each client gets its own browser session, so detaching it on disconnect
// clears that client's browser-level state as closing a connection would.

export type RelayConfig = {
  endpoint?: string;
  session?: string;
  launch?: { headless: boolean; profile?: string };
  /** A copy of this Electron app, launched on a copy of its profile. */
  app?: ElectronApp;
  /** Refuse the commands in READ_ONLY_REFUSED; app sessions set it, for now. */
  readOnly?: boolean;
  /** A tab in this one of the user's own Chrome profiles, hosted by personal.ts. */
  personal?: ChromeProfile;
  /** Hand focus back to the tab the user was on once the personal tab opens. */
  background?: boolean;
  idleMs?: number;
};

export type RelayState = {
  pid: number;
  url: string;
  session?: string;
  targetId?: string;
  chromePid?: number;
  chromeEndpoint?: string;
  profile?: string;
  keptProfile?: boolean;
  headless?: boolean;
  personal?: ChromeProfile;
  app?: ElectronApp;
  /** A personal tab's session ID: the host routes it to the tab itself. */
  sessionId?: string;
  idleMs?: number;
};

/**
 * What `GET <url>/status` answers. A WebSocket client cannot read the HTTP
 * status of a refused upgrade, so a refused probe asks here why.
 */
export type RelayStatus = { busy: boolean; closing: boolean };

// A read-only session refuses the commands that act on the page, as input,
// navigation, request interception, answering a dialog and opening or
// closing windows do, and leaves reading (evaluate, DOM, screenshots, network
// events) to the probe. Page JavaScript can still act, so read-only is a rule
// for probe code too (SKILL.md, Desktop apps).
const READ_ONLY_REFUSED =
  /^(?:Input|Fetch)\.|^Page\.(?:navigate|navigateToHistoryEntry|reload|close|setDocumentContent|handleJavaScriptDialog)$|^Target\.(?:createTarget|closeTarget)$|^Browser\.close$/;

type Command = {
  id?: number;
  method: string;
  sessionId?: string;
  params?: Record<string, unknown>;
};

type Message = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: { sessionId?: string; guid?: string; state?: string };
  result?: { sessionId?: string; targetId?: string };
  error?: { message: string };
};

type Client = {
  end: boolean;
  queued: string[];
  browserSession?: string;
};
type Socket = ServerWebSocket<Client>;
type Owner = { client: Socket; browserSession: string };
type Request =
  | { resolve: (message: Message) => void }
  | { client: Socket; id: number | undefined; browserSession: string };

const [statePath = "", rawConfig = "{}"] = process.argv.slice(2);
const config = JSON.parse(rawConfig) as RelayConfig;
const idleMs = config.idleMs ?? 5 * 60 * 1000;
const pending = new Map<number, Request>();
const owners = new Map<string, Owner>();
const clients = new Set<Socket>();
let chrome: Chrome | undefined;
let upstream: WebSocket;
let server: Server<Client> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let stopping: Promise<never> | undefined;
let nextId = 1;
let busy = false;

const send = (command: Command, request?: Request) => {
  const id = nextId++;
  if (request) pending.set(id, request);
  upstream.send(JSON.stringify({ ...command, id }));
};

const call = (command: Command) =>
  new Promise<Message>((resolve) => send(command, { resolve }));

const closeBrowser = () =>
  upstream?.readyState === WebSocket.OPEN
    ? call({ method: "Browser.close" })
    : Promise.resolve();

// Ends what this process owns: its launched Chrome (gracefully, so cookies are
// flushed), then the upstream connection, which ends Chrome's debugging banner.
const shutdown = (error?: unknown) => {
  stopping ??= (async () => {
    clearTimeout(idle);
    if (chrome)
      await stopChrome(chrome, {
        cancelDownload: (guid) =>
          call({ method: "Browser.cancelDownload", params: { guid } }),
        close: closeBrowser,
      });
    if (upstream && upstream.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((resolve) =>
        upstream.addEventListener("close", resolve, { once: true })
      );
      upstream.close();
      await Promise.race([closed, delay(1000)]);
    }
    if (error && process.send && process.connected) {
      const { message, code, syscall } = error as NodeJS.ErrnoException;
      await new Promise((resolve) =>
        process.send?.(
          { error: message ?? String(error), code, syscall },
          undefined,
          undefined,
          resolve
        )
      );
    }
    await rm(statePath, { force: true });
    process.exit(error ? 1 : 0);
  })();
  return stopping;
};

const armIdle = () => {
  clearTimeout(idle);
  if (idleMs && !clients.size) idle = setTimeout(() => void shutdown(), idleMs);
};

const detachAll = (client: Socket) => {
  for (const [sessionId, owner] of owners)
    if (owner.client === client) {
      owners.delete(sessionId);
      if (upstream.readyState === WebSocket.OPEN)
        send({ method: "Target.detachFromTarget", params: { sessionId } });
    }
};

const forward = (client: Socket, data: string) => {
  const { browserSession } = client.data;
  if (!browserSession) return;
  const { id, ...command } = JSON.parse(data) as Command;
  if (config.readOnly && READ_ONLY_REFUSED.test(command.method))
    return client.send(
      JSON.stringify({
        id,
        error: {
          code: -32000,
          message: `${command.method} is refused: this session is read-only`,
        },
      })
    );
  command.sessionId ??= browserSession;
  send(command, { client, id, browserSession });
};

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void shutdown());
process.on("uncaughtException", (error) => void shutdown(error));
process.on("unhandledRejection", (error) => void shutdown(error));

try {
  if (config.launch) chrome = await launchChrome(config.launch);
  if (config.app) chrome = await launchApp(config.app);
} catch (error) {
  await shutdown(error);
}

upstream = new WebSocket(chrome?.endpoint ?? config.endpoint ?? "");
upstream.addEventListener("error", (event) => void shutdown(event), {
  once: true,
});
upstream.addEventListener(
  "close",
  () =>
    void shutdown(
      server
        ? undefined
        : new Error("Browser connection closed before the relay was ready")
    ),
  { once: true }
);
upstream.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as Message;
  if (message.id !== undefined) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (!request) return;
    if ("resolve" in request) return request.resolve(message);
    if (request.client.readyState !== WebSocket.OPEN) return;
    if (typeof message.result?.sessionId === "string")
      owners.set(message.result.sessionId, request);
    request.client.send(
      JSON.stringify({ ...message, id: request.id, sessionId: undefined })
    );
    return;
  }
  const guid = message.params?.guid;
  if (chrome && guid && message.method?.startsWith("Browser.download"))
    trackDownload(chrome, { guid, state: message.params?.state });
  const owner = message.sessionId ? owners.get(message.sessionId) : undefined;
  if (!owner) return;
  const child = message.params?.sessionId;
  if (message.method === "Target.attachedToTarget" && child)
    owners.set(child, owner);
  if (message.method === "Target.detachedFromTarget" && child)
    owners.delete(child);
  if (message.sessionId === owner.browserSession) delete message.sessionId;
  owner.client.send(JSON.stringify(message));
});

// The session's tab in an app is its main window: the first page that is not
// DevTools, which an app opens a moment after CDP is ready.
async function appWindow() {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
    const { result } = await call({ method: "Target.getTargets" });
    const { targetInfos = [] } = (result ?? {}) as {
      targetInfos?: { targetId: string; type: string; url: string }[];
    };
    const page = targetInfos.find(
      ({ type, url }) => type === "page" && !url.startsWith("devtools://")
    );
    if (page) return page.targetId;
    await delay(250);
  }
  throw new Error(`${config.app?.name} opened no window within 30 seconds`);
}

upstream.addEventListener(
  "open",
  async () => {
    try {
      const path = `/${randomUUID()}`;
      let targetId: string | undefined;
      if (config.app) targetId = await appWindow();
      else if (chrome) {
        await call({
          method: "Browser.setDownloadBehavior",
          params: profileDownloads(chrome),
        });
        // The session's tab: every probe in the session continues on it.
        const { result, error } = await call({
          method: "Target.createTarget",
          params: { url: "about:blank", background: true },
        });
        if (error) throw new Error(error.message);
        targetId = result?.targetId;
      }
      server = Bun.serve<Client>({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req, bun) {
          const { pathname } = new URL(req.url);
          if (pathname === `${path}/status`) {
            const status: RelayStatus = { busy, closing: Boolean(stopping) };
            return Response.json(status);
          }
          if (stopping) return new Response("Closing", { status: 503 });
          const end = pathname === `${path}/end`;
          if (!end && pathname !== path)
            return new Response(null, { status: 404 });
          // One tab, one driver: concurrent probes race on navigation and input.
          if (!end && chrome && busy)
            return new Response("Session busy", { status: 409 });
          if (bun.upgrade(req, { data: { end, queued: [] } })) {
            if (!end && chrome) busy = true;
            return;
          }
          return new Response("Expected a WebSocket upgrade", { status: 426 });
        },
        websocket: {
          async open(client) {
            if (client.data.end) {
              client.close(1000, "Session ending");
              return void shutdown();
            }
            clients.add(client);
            armIdle();
            const { result, error } = await call({
              method: "Target.attachToBrowserTarget",
            });
            if (error || !result?.sessionId)
              return client.close(1011, (error?.message ?? "").slice(0, 120));
            const browserSession = result.sessionId;
            client.data.browserSession = browserSession;
            owners.set(browserSession, { client, browserSession });
            if (client.readyState !== WebSocket.OPEN) return detachAll(client);
            for (const data of client.data.queued) forward(client, data);
            client.data.queued = [];
          },
          message(client, data) {
            const text = String(data);
            if (client.data.browserSession) forward(client, text);
            else client.data.queued.push(text);
          },
          close(client) {
            if (client.data.end) return;
            clients.delete(client);
            busy = false;
            detachAll(client);
            armIdle();
          },
        },
      });
      const state: RelayState = {
        pid: process.pid,
        url: `ws://127.0.0.1:${server.port}${path}`,
        ...(chrome && {
          session: config.session,
          targetId,
          chromePid: chrome.child.pid,
          // Unique to this launch: it proves a Chrome left by a killed host is ours.
          chromeEndpoint: chrome.endpoint,
          profile: chrome.profile,
          keptProfile: chrome.kept,
          headless: Boolean(config.launch?.headless),
          app: config.app,
          idleMs,
        }),
      };
      await writeFile(`${statePath}.tmp`, JSON.stringify(state), {
        mode: 0o600,
      });
      await rename(`${statePath}.tmp`, statePath);
      armIdle();
      process.send?.({ state });
      process.disconnect?.();
    } catch (error) {
      void shutdown(error);
    }
  },
  { once: true }
);
