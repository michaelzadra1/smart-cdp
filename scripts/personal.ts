import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Server, ServerWebSocket } from "bun";
import { type ChromeProfile, chromeBinary } from "./chrome";
import type { RelayConfig, RelayState, RelayStatus } from "./relay";

// A detached host for a --personal session: one tab in the user's own Chrome,
// in the profile probe.ts names, driven through the extension in ../extension.
// chrome.debugger has no "Allow remote debugging?" prompt, which Chrome 144+
// shows for every new connection to the debugging port and cannot remember.
// The host serves a blank page on a loopback port and opens it in that
// profile; the extension, loaded there, connects back on the same port,
// and once the host proves it knows the shared secret, attaches to that one
// tab. Probes connect to the host one at a time. Their root commands and
// events carry ROOT_SESSION, so probe code addresses the tab as it would a
// flattened target session. Between probes the extension reattaches, which
// clears every domain the last probe enabled, as a fresh session would.

const EXTENSION_DIR = join(import.meta.dir, "../extension");
const ROOT_SESSION = "smart-cdp-tab";
const SECRET_PATH = join(EXTENSION_DIR, "secret.json");
const ATTACH_TIMEOUT_MS = 20_000;

type Message = {
  id?: number;
  type?: string;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
  challenge?: string;
  targetId?: string;
  message?: string;
};

type Data = { role: "extension" | "probe" | "end" };
type Socket = ServerWebSocket<Data>;
type Request =
  | { client: Socket; id: number | undefined }
  | { resolve: (message: Message) => void };

const [statePath = "", rawConfig = "{}"] = process.argv.slice(2);
const config = JSON.parse(rawConfig) as RelayConfig;
const profile = config.personal as ChromeProfile;
const idleMs = config.idleMs ?? 30 * 60 * 1000;
const tabPath = `/smart-cdp/${randomUUID()}`;
const probePath = `/${randomUUID()}`;
const pending = new Map<number, Request>();
const attached = Promise.withResolvers<string | undefined>();
let server: Server<Data> | undefined;
let extension: Socket | undefined;
let client: Socket | undefined;
let ready = false;
let busy = true;
let idle: ReturnType<typeof setTimeout> | undefined;
let stopping: Promise<never> | undefined;
let nextId = 1;

/** The secret the extension checks the host with, created on first use. */
async function secret(): Promise<string> {
  try {
    return (
      JSON.parse(await readFile(SECRET_PATH, "utf8")) as { secret: string }
    ).secret;
  } catch {
    const value = randomUUID();
    await writeFile(SECRET_PATH, JSON.stringify({ secret: value }), {
      mode: 0o600,
    });
    await chmod(SECRET_PATH, 0o600);
    return value;
  }
}

const toExtension = (message: Message, request?: Request) => {
  const id = nextId++;
  if (request) pending.set(id, request);
  extension?.send(JSON.stringify({ ...message, id }));
};

const call = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Message>((resolve) =>
    toExtension({ method, params }, { resolve })
  );

// The profile's own passkeys open Chrome's passkey sheet (Touch ID), which
// nothing in the page can close. An empty virtual authenticator answers the
// tab's passkey requests instead, so they fail at once, as on a device with no
// passkey, and the site offers another way in. Reattaching drops it.
async function prepareTab() {
  // Lets the host answer "Leave site?": it blocks navigation and closing the tab.
  await call("Page.enable");
  await call("WebAuthn.enable", { enableUI: false });
  await call("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

// Ends what this host owns: its tab (the extension closes it), then itself.
const shutdown = (error?: unknown) => {
  stopping ??= (async () => {
    clearTimeout(idle);
    client?.close(1001, "Browser released");
    const tab = extension;
    if (tab && tab.readyState === WebSocket.OPEN) {
      tab.send(JSON.stringify({ type: "close" }));
      for (let waited = 0; tab.readyState === WebSocket.OPEN; waited += 50) {
        if (waited >= 2000) break;
        await delay(50);
      }
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
    server?.stop(true);
    await rm(statePath, { force: true });
    process.exit(error ? 1 : 0);
  })();
  return stopping;
};

const armIdle = () => {
  clearTimeout(idle);
  if (idleMs && !client) idle = setTimeout(() => void shutdown(), idleMs);
};

async function fromExtension(socket: Socket, message: Message, key: string) {
  if (message.type === "hello") {
    const proof = createHmac("sha256", key)
      .update(`${message.challenge}:${tabPath.split("/").pop()}`)
      .digest("hex");
    return socket.send(
      JSON.stringify({ type: "proof", proof, background: config.background })
    );
  }
  if (message.type === "ready") {
    await prepareTab();
    busy = false;
    if (!ready) {
      ready = true;
      attached.resolve(message.targetId);
    }
    return armIdle();
  }
  if (message.type === "error")
    return void shutdown(
      new Error(`Chrome refused the tab: ${message.message}`)
    );
  if (message.type) return;
  if (message.id !== undefined) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (!request) return;
    if ("resolve" in request) return request.resolve(message);
    if (request.client.readyState === WebSocket.OPEN)
      request.client.send(JSON.stringify({ ...message, id: request.id }));
    return;
  }
  const dialog = message.params as { type?: string } | undefined;
  if (
    message.method === "Page.javascriptDialogOpening" &&
    dialog?.type === "beforeunload"
  )
    void call("Page.handleJavaScriptDialog", { accept: true });
  if (client?.readyState === WebSocket.OPEN)
    client.send(
      JSON.stringify({
        ...message,
        sessionId: message.sessionId ?? ROOT_SESSION,
      })
    );
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void shutdown());
process.on("uncaughtException", (error) => void shutdown(error));
process.on("unhandledRejection", (error) => void shutdown(error));

try {
  const key = await secret();
  server = Bun.serve<Data>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      const { pathname } = new URL(request.url);
      if (pathname === tabPath) return new Response("");
      if (pathname === `${probePath}/status`) {
        const status: RelayStatus = { busy, closing: Boolean(stopping) };
        return Response.json(status);
      }
      if (stopping) return new Response("Closing", { status: 503 });
      const role =
        pathname === `${tabPath}/extension`
          ? "extension"
          : pathname === probePath
            ? "probe"
            : pathname === `${probePath}/end`
              ? "end"
              : undefined;
      if (!role) return new Response(null, { status: 404 });
      if (role === "extension" && extension)
        return new Response("Tab taken", { status: 409 });
      // One tab, one driver: concurrent probes race on navigation and input.
      if (role === "probe" && (busy || client))
        return new Response("Session busy", { status: 409 });
      if (bun.upgrade(request, { data: { role } })) {
        if (role === "probe") busy = true;
        return;
      }
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      open(socket) {
        const { role } = socket.data;
        if (role === "end") {
          socket.close(1000, "Session ending");
          return void shutdown();
        }
        if (role === "extension") extension = socket;
        else {
          client = socket;
          clearTimeout(idle);
        }
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as Message;
        if (socket === extension)
          return void fromExtension(socket, message, key);
        if (socket !== client) return;
        const { id, ...command } = message;
        if (command.sessionId === ROOT_SESSION) delete command.sessionId;
        toExtension(command, { client: socket, id });
      },
      close(socket) {
        if (socket === extension) {
          extension = undefined;
          return void shutdown(
            ready ? undefined : new Error("The extension closed the connection")
          );
        }
        if (socket !== client) return;
        client = undefined;
        // Busy until the extension has reattached and the tab is clean.
        extension?.send(JSON.stringify({ type: "reset" }));
      },
    },
  });
  const url = `http://127.0.0.1:${server.port}${tabPath}`;
  // A running Chrome hands the URL to its open instance and this process
  // exits; a closed one starts here, detached, so it outlives the host.
  spawn(
    await chromeBinary(),
    [`--profile-directory=${profile.directory}`, url],
    { detached: true, stdio: "ignore" }
  ).unref();
  const timeout = setTimeout(
    () =>
      attached.reject(
        new Error(
          `The smart-cdp extension did not take the tab in Chrome's ${profile.name} profile (${profile.directory}). ` +
            `Open chrome://extensions in that profile, turn on Developer mode, click Load unpacked and pick ${EXTENSION_DIR}`
        )
      ),
    ATTACH_TIMEOUT_MS
  );
  const targetId = await attached.promise.finally(() => clearTimeout(timeout));
  const state: RelayState = {
    pid: process.pid,
    url: `ws://127.0.0.1:${server.port}${probePath}`,
    session: config.session,
    targetId,
    personal: profile,
    sessionId: ROOT_SESSION,
    idleMs,
  };
  await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
  process.send?.({ state });
  process.disconnect?.();
} catch (error) {
  await shutdown(error);
}
