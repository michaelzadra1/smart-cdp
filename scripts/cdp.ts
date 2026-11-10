import type ProtocolMappingApi from "devtools-protocol/types/protocol-mapping";
import type { ProtocolProxyApi } from "devtools-protocol/types/protocol-proxy-api";

type Commands = ProtocolMappingApi.Commands;
type Events = ProtocolMappingApi.Events;

const CONNECT_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** The DOM lib types `WebSocket` without Bun's constructor options and
 *  `terminate()`; both exist at runtime. */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions
) => Bun.WebSocket;

/** Chrome answered a command with a protocol error. */
export class CdpProtocolError extends Error {
  override name = "CdpProtocolError";
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    data?: string
  ) {
    super(data ? `${message} (${data})` : message);
  }
}

/** The connection closed before the command was answered. */
export class CdpConnectionClosedError extends Error {
  override name = "CdpConnectionClosedError";
}

/** Reads `webSocketDebuggerUrl` from a loopback `/json/version`. */
export async function browserEndpoint(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`/json/version returned ${res.status}`);
  const { webSocketDebuggerUrl } = (await res.json()) as {
    webSocketDebuggerUrl?: string;
  };
  if (!webSocketDebuggerUrl)
    throw new Error(`Port ${port} exposes no browser WebSocket`);
  return webSocketDebuggerUrl;
}

type EventListener = (params: never, sessionId?: string) => void;

type Api = ProtocolProxyApi.ProtocolApi;
type OptionalParams<F> = F extends (params: infer P) => infer R
  ? (params?: P) => R
  : F;
/** `cdp.Browser.getVersion()` and friends: browser-level commands. */
type DomainApi = {
  [D in keyof Api]: {
    [C in Exclude<keyof Api[D], "on">]: OptionalParams<Api[D][C]>;
  };
};

/** `Network.responseReceived` or `Network.responseReceived.<sessionId>`
 *  → `Network.responseReceived`. */
type EventName<S extends string> = S extends `${infer D}.${infer M}.${string}`
  ? `${D}.${M}`
  : S;
type Listener<S extends string> = (
  params: EventName<S> extends keyof Events ? Events[EventName<S>][0] : unknown,
  sessionId?: string
) => void;

export interface CdpClient extends DomainApi {
  /** The browser WebSocket this client is connected to. */
  readonly url: string;
  /** Settles once the connection has closed, for any reason. */
  readonly closed: Promise<void>;
  send<M extends keyof Commands>(
    method: M,
    params?: Commands[M]["paramsType"][0],
    sessionId?: string
  ): Promise<Commands[M]["returnType"]>;
  /** `event` is a method name, or `<method>.<sessionId>` for one session. */
  on<S extends string>(event: S, listener: Listener<S>): void;
  once<S extends string>(event: S, listener: Listener<S>): void;
  off(event: string, listener: (...args: never[]) => void): void;
  /** Commands sent but not yet answered, for shutdown diagnostics. */
  unanswered(): string[];
  close(): Promise<void>;
}

interface Pending {
  label: string;
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  readonly closed: Promise<void>;
  readonly url: string;

  constructor(private readonly ws: Bun.WebSocket) {
    this.url = ws.url;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.closed = promise;
    ws.addEventListener("message", (event) => this.receive(event.data));
    ws.addEventListener("close", () => {
      const err = new CdpConnectionClosedError("CDP connection closed");
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      resolve();
    });
  }

  send(
    method: string,
    params: object = {},
    sessionId?: string
  ): Promise<unknown> {
    if (this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new CdpConnectionClosedError(`CDP connection closed before ${method}`)
      );
    // Chrome's own default opens a new tab in front, taking the user's focus
    // (SKILL.md, Boundaries); a caller that wants that passes false.
    if (method === "Target.createTarget")
      params = { background: true, ...params };
    const id = this.nextId++;
    const label = sessionId ? `${method} (session ${sessionId})` : method;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.pending.set(id, { label, method, resolve, reject });
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return promise;
  }

  on(event: string, listener: EventListener): void {
    const set = this.listeners.get(event) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(event, set);
  }

  once(event: string, listener: EventListener): void {
    const wrapped: EventListener = (params, sessionId) => {
      this.off(event, wrapped);
      listener(params, sessionId);
    };
    this.on(event, wrapped);
  }

  off(event: string, listener: EventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  unanswered(): string[] {
    return [...this.pending.values()].map(({ label }) => label);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    const timer = setTimeout(() => this.ws.terminate(), CLOSE_TIMEOUT_MS);
    await this.closed;
    clearTimeout(timer);
  }

  private receive(data: unknown): void {
    // Chrome sends CDP as text frames only.
    const message = JSON.parse(data as string) as {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string; data?: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const { code, message: text, data: detail } = message.error;
        pending.reject(
          new CdpProtocolError(pending.method, code, text, detail)
        );
      } else pending.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    const { method, params, sessionId } = message;
    const events = sessionId ? [method, `${method}.${sessionId}`] : [method];
    for (const event of events)
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        try {
          listener(params as never, sessionId);
        } catch (error) {
          console.error(
            `Event listener for ${event} threw: ${(error as Error)?.message ?? error}`
          );
        }
      }
  }
}

/** Opens a CDP WebSocket. Bounded, because a wedged browser can accept TCP
 *  and never finish the upgrade. */
export function connect(
  url: string,
  timeoutMs = CONNECT_TIMEOUT_MS
): Promise<CdpClient> {
  const ws = new BunWebSocket(url, { perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const fail = (reason: string) => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error(`CDP connection to ${url} failed: ${reason}`));
    };
    const onError = (event: ErrorEvent) => fail(event.message);
    const timer = setTimeout(
      () => fail(`no handshake within ${timeoutMs}ms`),
      timeoutMs
    );
    ws.addEventListener("error", onError);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      ws.removeEventListener("error", onError);
      const connection = new Connection(ws);
      const domains = new Map<string, unknown>();
      resolve(
        new Proxy(connection, {
          get(target, key, receiver) {
            if (typeof key !== "string" || !/^[A-Z]/.test(key))
              return Reflect.get(target, key, receiver);
            let domain = domains.get(key);
            if (!domain) {
              domain = new Proxy(
                {},
                {
                  get: (_, command) =>
                    typeof command === "string"
                      ? (params?: object) =>
                          target.send(`${key}.${command}`, params)
                      : undefined,
                }
              );
              domains.set(key, domain);
            }
            return domain;
          },
        }) as unknown as CdpClient
      );
    });
  });
}
