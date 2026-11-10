import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type ProtocolMappingApi from "devtools-protocol/types/protocol-mapping";
import {
  browserEndpoint,
  type CdpClient,
  CdpConnectionClosedError,
  CdpProtocolError,
  connect,
} from "./cdp";
import {
  type Chrome,
  type ChromeProfile,
  chromeProfile,
  DEFAULT_PROFILE,
  launchChrome,
  stopChrome,
} from "./chrome";
import { inPageCall, returnByValueInPage } from "./in-page";
import { clickPointInPage, type Point, press, pressAt, type } from "./input";
import { clickRecaptchaCheckbox } from "./recaptcha";
import type { RelayConfig, RelayState, RelayStatus } from "./relay";
import { clickTurnstileCheckbox } from "./turnstile";

type Commands = ProtocolMappingApi.Commands;

/** Sends a CDP command to the bound page. */
export type Send = <M extends keyof Commands>(
  method: M,
  params?: Commands[M]["paramsType"][0]
) => Promise<Commands[M]["returnType"]>;

/** Runs a self-contained page function with JSON arguments; returns its value. */
export type Evaluate = <A extends unknown[], R>(
  fn: (...args: A) => R,
  ...args: A
) => Promise<Awaited<R>>;

type PollOptions<A> = { args?: A; timeoutMs?: number; intervalMs?: number };

export type WaitFor = <A extends unknown[], R>(
  fn: (...args: A) => R,
  options?: PollOptions<A>
) => Promise<Awaited<R>>;

/** Waits for the element, then presses it with trusted CDP mouse input. */
export type Click = <A extends unknown[]>(
  target: string | ((...args: A) => Element | null | undefined),
  options?: PollOptions<A>
) => Promise<void>;

/** What a probe (stdin body or --file default export) receives. */
export type ProbeContext = {
  cdp: CdpClient;
  send: Send;
  sessionId: string;
  targetId: string;
  evaluate: Evaluate;
  waitFor: WaitFor;
  click: Click;
  type: (text: string) => Promise<void>;
  press: (key: string) => Promise<void>;
  clickRecaptchaCheckbox: () => Promise<boolean>;
  clickTurnstileCheckbox: () => Promise<boolean>;
};

export type Probe<T = unknown> = (context: ProbeContext) => Promise<T>;

const SESSION_IDLE_MS = 30 * 60 * 1000;

const POLL_OPTIONS = ["args", "timeoutMs", "intervalMs"];

// What returnByValueInPage sends back for a DOM node.
const NODE_MARK = "smart-cdp:returned-node";
class ReturnedNodeError extends Error {
  override message =
    "The page function returned a DOM element, which cannot leave the page: return its text or attributes, or a boolean such as !!document.querySelector(...)";
}

const usage = `Usage: bun <skill>/scripts/probe.ts [options] < probe.js
  --file <path>          Import a .ts/.js module exporting default async (context)
  --session <id>         Continue in the browser claimed under this ID (or claim
                         one with a name you choose); its tab keeps its page
  --end-session <id>     Release that browser: close its Chrome and temp profile
  --idle-ms <ms>         Release a newly claimed browser after this long with no
                         probe (default 1800000; 0 keeps it until --end-session)
  --once                 Launch a cold browser for this probe only and close it
  --headless             Headless instead of the visible default; bot-protected
                         sites usually block it, so use it for local fixtures only
  --profile <dir>        Launch on this persistent profile (kept; e.g. signed in)
  --timeout-ms <ms>      Whole probe deadline (default 120000)
  --ws-url <ws[s]://...> Attach to an authorized browser endpoint
  --port <port>          Attach to an authorized loopback endpoint
  --active-port-file <path>  Read an authorized DevToolsActivePort file
  --target <id>          Required for attachment; never chooses another tab
  --personal             Claim a tab in your own Chrome's Default profile, through
                         the smart-cdp extension: no remote-debugging prompt.
                         Only when the user asks for their own Chrome/profile
  --personal-profile <name>  --personal in another of your Chrome profiles, as
                         its profile menu labels it ("Alex (Work)", "Work") or
                         by directory ("Profile 2")
  --background           With a --personal claim: give focus back to the tab
                         the user was on, and drive this one behind it
  --help

By default a probe claims a new isolated Chrome, prints its ID, and leaves it
open: pass --session <id> to continue and --end-session <id> when done.
A --personal browser is a tab the extension drives; --end-session closes only
that tab, and cdp reaches only that tab (no Browser or Target domain).
Attachment goes through a per-browser relay that keeps one approved connection
open (idle exit after 5 minutes), so Chrome asks to allow debugging only once.
CHROME_BIN overrides executable discovery. Requires macOS, Bun and Chrome.
stdin is an async JavaScript function body. --file paths resolve from your cwd;
type a --file probe with the ProbeContext type exported by probe.ts.
Context: { cdp, send, sessionId, targetId, evaluate, waitFor, click, type, press,
  clickRecaptchaCheckbox, clickTurnstileCheckbox }
send(method, params) addresses the bound page. cdp is the browser-level CDP client.
evaluate(fn, ...args) serializes a self-contained page function and JSON arguments,
and returns its JSON value; a returned DOM element throws.
waitFor(fn, { args, timeoutMs = 30000, intervalMs = 250 }) re-evaluates fn until
it returns a truthy value, surviving redirects and reloads; throws on timeout.
click(selector | fn, { args, timeoutMs, intervalMs }) presses the element once it
is visible and uncovered; type(text) types into the focused element; press(key)
presses one key such as "Enter". All three send trusted input, unlike el.click().
Returns JSON on stdout. Lifecycle diagnostics go to stderr.
`;

type ProbeOptions = ReturnType<typeof parseOptions>;

export function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: "string" },
      headless: { type: "boolean" },
      profile: { type: "string" },
      session: { type: "string" },
      "idle-ms": { type: "string" },
      "end-session": { type: "string" },
      once: { type: "boolean" },
      personal: { type: "boolean" },
      "personal-profile": { type: "string" },
      background: { type: "boolean" },
      "timeout-ms": { type: "string", default: "120000" },
      "ws-url": { type: "string" },
      port: { type: "string" },
      "active-port-file": { type: "string" },
      target: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const timeout = Number(values["timeout-ms"]);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) {
    throw new Error("--timeout-ms must be a positive timer-safe integer");
  }
  if (values["end-session"] !== undefined) {
    validSessionName(values["end-session"]);
    if (
      Object.keys(values).some(
        (key) => !["end-session", "timeout-ms"].includes(key)
      )
    )
      throw new Error("--end-session takes no other options");
  }
  const endpoints = [
    values["ws-url"],
    values.port,
    values["active-port-file"],
  ].filter((v) => v !== undefined);
  const keeps = values.session !== undefined || values["idle-ms"] !== undefined;
  if (values.session !== undefined) validSessionName(values.session);
  if (keeps && values.once)
    throw new Error(
      "--once closes its browser, so it takes no --session or --idle-ms"
    );
  if ((keeps || values.once) && (endpoints.length || values.target))
    throw new Error(
      "--session, --idle-ms and --once launch Chrome; they cannot attach"
    );
  let idle = SESSION_IDLE_MS;
  if (values["idle-ms"] !== undefined) {
    idle = Number(values["idle-ms"]);
    if (!Number.isSafeInteger(idle) || idle < 0 || idle > 2147483647)
      throw new Error("--idle-ms must be a timer-safe integer, 0 or more");
  }
  const personal =
    Boolean(values.personal) || values["personal-profile"] !== undefined;
  if (
    personal &&
    (values.once ||
      values.headless ||
      values.profile ||
      endpoints.length ||
      values.target)
  )
    throw new Error(
      "--personal drives a tab in your own Chrome profile; it takes no --once, --headless, --profile or attachment options"
    );
  if (values.background && !personal)
    throw new Error("--background applies only to a --personal tab");
  if (endpoints.length > 1)
    throw new Error("Select exactly one attachment option");
  if (endpoints.length && (!values.target || values.headless)) {
    throw new Error("Attachment requires --target and cannot use --headless");
  }
  if (!endpoints.length && values.target)
    throw new Error("--target requires an attachment option");
  if (endpoints.length && values.profile)
    throw new Error("--profile only applies to a launched Chrome");
  if (values.port !== undefined) validPort(values.port);
  if (values["ws-url"] !== undefined) validWebSocket(values["ws-url"]);
  return { ...values, personal, timeout, idle };
}

function validSessionName(name: string) {
  if (!/^[\w.-]{1,64}$/.test(name))
    throw new Error("A session name is 1-64 letters, digits, '.', '_' or '-'");
}

function validPort(raw: string | undefined) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid CDP port");
  return port;
}

function validWebSocket(raw: string) {
  const url = new URL(raw);
  if (!["ws:", "wss:"].includes(url.protocol))
    throw new Error("CDP endpoint must use ws:// or wss://");
  return url.href;
}

export function activePortEndpoint(contents: string) {
  const [port, path] = contents.trim().split(/\r?\n/);
  if (!/^\/devtools\/browser\/[\w-]+$/.test(path ?? ""))
    throw new Error("Invalid DevToolsActivePort browser path");
  return `ws://127.0.0.1:${validPort(port)}${path}`;
}

const statePath = (kind: string, key: string) =>
  join(
    tmpdir(),
    `smart-cdp-${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`
  );
export const relayStatePath = (endpoint: string) =>
  statePath("relay", endpoint);
export const sessionStatePath = (name: string) => statePath("session", name);
// Outlives the host, which removes its state file when it exits, so a session
// claimed again by name stays in the profile it was first claimed in.
const sessionProfilePath = (name: string) => statePath("profile", name);

async function personalProfile(name: string, wanted: string | undefined) {
  const path = sessionProfilePath(name);
  const profile =
    wanted !== undefined
      ? await chromeProfile(wanted)
      : await readFile(path, "utf8")
          .then((text) => JSON.parse(text) as ChromeProfile)
          .catch(() => DEFAULT_PROFILE);
  await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
  return profile;
}

export const isAlive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until the process is gone; true if it exited within `ms`. */
export async function waitForExit(pid: number | undefined, ms: number) {
  for (let waited = 0; isAlive(pid); waited += 50) {
    if (waited >= ms) return false;
    await delay(50);
  }
  return true;
}

const readState = (path: string) =>
  readFile(path, "utf8")
    .then((text) => JSON.parse(text) as RelayState)
    .catch(() => undefined);

const liveState = async (path: string) => {
  const state = await readState(path);
  return state && isAlive(state.pid) ? state : undefined;
};

// The relay is detached so it outlives this probe; it removes its state file
// when it exits.
async function startRelay(
  path: string,
  config: RelayConfig,
  onSpawn?: (pid: number | undefined) => void
): Promise<RelayState> {
  const host = config.personal ? "personal.ts" : "relay.ts";
  const relay = spawn(
    process.execPath,
    [join(import.meta.dir, host), path, JSON.stringify(config)],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }
  );
  onSpawn?.(relay.pid);
  try {
    return await new Promise((resolveState, reject) => {
      relay.once("message", (reply) => {
        const { state, error, code, syscall } = reply as {
          state?: RelayState;
          error?: string;
          code?: string;
          syscall?: string;
        };
        if (state) resolveState(state);
        else reject(Object.assign(new Error(error), { code, syscall }));
      });
      relay.once("error", reject);
      relay.once("exit", () =>
        reject(new Error("Relay exited before it was ready"))
      );
    });
  } finally {
    relay.removeAllListeners();
    if (relay.connected) relay.disconnect();
    relay.unref();
  }
}

async function relayEndpoint(endpoint: string) {
  const path = relayStatePath(endpoint);
  const live = await liveState(path);
  if (live) return live.url;
  const state = await startRelay(path, { endpoint }, (pid) =>
    console.error(
      `Started relay pid=${pid}; approve Chrome's remote-debugging prompt if shown`
    )
  );
  return state.url;
}

// Why a relay refused a connection; undefined when it cannot say.
async function relayStatus(url: string): Promise<RelayStatus | undefined> {
  try {
    const response = await fetch(`${url.replace(/^ws/, "http")}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok ? ((await response.json()) as RelayStatus) : undefined;
  } catch {
    return undefined;
  }
}

// An unused ID under which to claim a new browser.
async function claimName() {
  for (;;) {
    const name = `b-${randomBytes(3).toString("hex")}`;
    if (!(await readState(sessionStatePath(name)))) return name;
  }
}

async function sessionState(options: ProbeOptions) {
  const name = options.session ?? (await claimName());
  const path = sessionStatePath(name);
  const recorded = await readState(path);
  const live = recorded && isAlive(recorded.pid) ? recorded : undefined;
  if (recorded && !live) await closeOrphan(name, recorded);
  if (live) {
    const profile = options.profile && resolve(options.profile);
    if (Boolean(options.personal) !== Boolean(live.personal))
      throw new Error(
        live.personal
          ? `Session ${name} is a tab in your own Chrome: pass --personal to continue in it`
          : `Session ${name} is an isolated Chrome: leave out --personal to continue in it`
      );
    const wanted = options["personal-profile"];
    if (
      live.personal &&
      wanted !== undefined &&
      (await chromeProfile(wanted)).directory !== live.personal.directory
    )
      throw new Error(
        `Session ${name} is a tab in your Chrome's ${live.personal.name} profile. ` +
          `To continue in it, leave out --personal-profile. To use ${wanted}, ` +
          `release it with --end-session ${name} or use another name`
      );
    if (
      Boolean(options.headless) !== Boolean(live.headless) ||
      (profile && profile !== live.profile) ||
      (options["idle-ms"] !== undefined && options.idle !== live.idleMs)
    )
      throw new Error(
        `Session ${name} runs ${live.headless ? "headless" : "visible"} Chrome on ${live.profile} ` +
          `with --idle-ms ${live.idleMs}. To continue in it, ${live.headless ? "pass" : "leave out"} ` +
          `--headless and leave out --profile and --idle-ms. To start over, release it with ` +
          `--end-session ${name} or use another name`
      );
    return live;
  }
  const state = await startRelay(
    path,
    options.personal
      ? {
          session: name,
          personal: await personalProfile(name, options["personal-profile"]),
          background: Boolean(options.background),
          idleMs: options.idle,
        }
      : {
          session: name,
          launch: {
            headless: Boolean(options.headless),
            profile: options.profile,
          },
          idleMs: options.idle,
        }
  );
  const idleMs = state.idleMs ?? 0;
  const [amount, unit] =
    idleMs >= 60000 ? [idleMs / 60000, "minute"] : [idleMs / 1000, "second"];
  const idle = idleMs
    ? ` It closes itself after ${amount} idle ${unit}${amount === 1 ? "" : "s"}.`
    : "";
  const what = state.personal
    ? `a tab in your Chrome's ${state.personal.name} profile`
    : `Chrome pid=${state.chromePid} profile=${state.profile}`;
  console.error(
    `Claimed browser ${name}: ${what}. ` +
      `Continue with --session ${name}; release it with --end-session ${name} when done.${idle}`
  );
  return state;
}

// A host killed outright (SIGKILL) cannot close its Chrome. A PID alone does
// not prove ownership, but the recorded browser endpoint is unique to that
// launch: only the session's own Chrome answers on it with that PID.
async function closeOrphan(name: string, state: RelayState) {
  // Deletes only a profile the host generated, never a --profile one.
  const removeProfile = async () => {
    if (
      !state.keptProfile &&
      state.profile?.startsWith(join(tmpdir(), "smart-cdp-"))
    )
      await rm(state.profile, { recursive: true, force: true });
  };
  let browser: CdpClient;
  try {
    browser = await connect(validWebSocket(state.chromeEndpoint ?? ""));
  } catch {
    if (isAlive(state.chromePid))
      return console.error(
        `Browser ${name}'s host died and Chrome pid=${state.chromePid} on ${state.profile} ` +
          "does not answer on its recorded endpoint; it was left untouched."
      );
    // Chrome is gone too, so nothing uses the profile it recorded.
    return removeProfile();
  }
  try {
    const { processInfo } = await browser.SystemInfo.getProcessInfo();
    if (
      state.chromePid === undefined ||
      processInfo.find((p) => p.type === "browser")?.id !== state.chromePid
    )
      return;
    await Promise.race([
      browser.Browser.close().catch(() => {}),
      delay(3000, undefined, { ref: false }),
    ]);
    if (!(await waitForExit(state.chromePid, 5000)))
      process.kill(state.chromePid, "SIGKILL");
    await removeProfile();
    console.error(
      `Closed Chrome pid=${state.chromePid} left running by browser ${name}'s killed host` +
        (state.keptProfile ? "" : ` and removed ${state.profile}`)
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

// The session's tab keeps its page between probes. If a probe closed it,
// continue on a page left in the session's browser, or open one.
async function sessionTab(cdp: CdpClient, recorded: string | undefined) {
  const { targetInfos } = await cdp.Target.getTargets();
  const pages = targetInfos.filter((target) => target.type === "page");
  if (recorded && pages.some((target) => target.targetId === recorded))
    return recorded;
  const open = (params: { newWindow?: boolean } = {}) =>
    cdp.Target.createTarget({
      url: "about:blank",
      background: true,
      ...params,
    });
  const targetId =
    pages[0]?.targetId ??
    (
      await open().catch((error: Error) => {
        if (!/no browser is open/i.test(error.message)) throw error;
        return open({ newWindow: true });
      })
    ).targetId;
  console.error(`Claimed tab ${recorded} is gone; continuing on ${targetId}`);
  return targetId;
}

async function endSession(name: string) {
  const path = sessionStatePath(name);
  const state = await readState(path);
  if (!state) throw new Error(`No claimed browser named ${name}`);
  if (!isAlive(state.pid)) {
    await closeOrphan(name, state);
    await rm(path, { force: true });
    return;
  }
  // The control path is secret to the private state file, which proves this
  // caller may end the session; the host then stops only its own Chrome.
  await new Promise((resolveEnd, reject) => {
    const control = new WebSocket(`${state.url}/end`);
    control.addEventListener("close", resolveEnd, { once: true });
    control.addEventListener("error", reject, { once: true });
  });
  if (await waitForExit(state.pid, 15000)) return state;
  throw new Error(`Session ${name} is still closing (host pid=${state.pid})`);
}

const AsyncFunction = (async () => {}).constructor as new (
  ...args: string[]
) => Probe;

const errorText = (error: unknown) =>
  error instanceof CdpProtocolError
    ? `${error.method}: ${error.message}`
    : ((error as Error)?.message ?? String(error));

// Chrome's errors when the document behind an evaluation was replaced.
const navigated =
  /navigated or closed|context was destroyed|Cannot find (default execution )?context/;

/** Runs a typed probe, or stdin code (the CLI's only), in the browser. */
export async function runProbe<T = unknown>(
  options: ProbeOptions,
  snippet: string | Probe<T>
): Promise<T> {
  let chrome: Chrome | undefined;
  let session: RelayState | undefined;
  let cdp: CdpClient | undefined;
  let cleaning: Promise<void> | undefined;
  let closing = false;
  // A launched Chrome stops with the probe; a session's Chrome and tab stay.
  const cleanup = () => {
    cleaning ??= (async () => {
      closing = true;
      // A command Chrome never answered usually names why a probe hung: a
      // target paused by waitForDebuggerOnStart answers nothing until resumed.
      const waiting = cdp?.unanswered() ?? [];
      if (waiting.length)
        console.error(
          `Unanswered CDP commands at shutdown: ${waiting.join(", ")}. ` +
            "A target paused by waitForDebuggerOnStart answers only after Runtime.runIfWaitingForDebugger; " +
            "an awaitPromise evaluation answers only when its promise settles."
        );
      const client = cdp;
      if (chrome)
        await stopChrome(chrome, client && (() => client.Browser.close()));
      await client?.close().catch(() => {});
    })();
    return cleaning;
  };
  const stop = async (code: number, message: string) => {
    console.error(message);
    try {
      await cleanup();
    } finally {
      process.exit(code);
    }
  };
  const interrupt = () => {
    void stop(130, "Probe interrupted");
  };
  const terminate = () => {
    void stop(143, "Probe terminated");
  };
  // An async event listener rejects outside the probe's await chain. The
  // runtime would exit on it mid-run or mid-cleanup, losing the result and the
  // temp profile. Closing the transport rejects every unanswered command;
  // cleanup lists those.
  const unhandled = (error: unknown) => {
    if (closing && error instanceof CdpConnectionClosedError) return;
    console.error(`Unhandled rejection in probe code: ${errorText(error)}`);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.on("unhandledRejection", unhandled);
  const timer = setTimeout(() => {
    void stop(1, `Probe timed out after ${options.timeout}ms`);
  }, options.timeout);
  try {
    let endpoint = options["ws-url"];
    if (options["active-port-file"])
      endpoint = activePortEndpoint(
        await readFile(options["active-port-file"], "utf8")
      );
    if (options.port) endpoint = await browserEndpoint(validPort(options.port));
    if (endpoint) endpoint = await relayEndpoint(validWebSocket(endpoint));
    else if (!options.once) {
      session = await sessionState(options);
      endpoint = session.url;
    }
    if (!endpoint) {
      chrome = await launchChrome({
        headless: options.headless,
        profile: options.profile,
        log: console.error,
      });
      endpoint = chrome.endpoint ?? "";
    }
    try {
      cdp = await connect(validWebSocket(endpoint));
    } catch (error) {
      const status = session && (await relayStatus(session.url));
      if (session && status?.closing)
        throw new Error(
          `Browser ${session.session} is closing; run the probe again to claim a new one`
        );
      if (session && status?.busy)
        throw new Error(
          `Browser ${session.session} is busy: another probe is running in it. ` +
            "Wait for that probe to finish, or use another session name"
        );
      throw error;
    }
    const client = cdp;
    // Without this, a lost browser reads as a hang until the probe deadline.
    void client.closed.then(async () => {
      if (closing) return;
      if (chrome)
        await Promise.race([
          chrome.exited,
          delay(2000, undefined, { ref: false }),
        ]);
      const cause = session
        ? `browser ${session.session} was released or its Chrome quit`
        : !chrome
          ? "the endpoint closed it"
          : chrome.running()
            ? "Chrome is still running"
            : `Chrome exited with ${chrome.child.signalCode ?? `code ${chrome.child.exitCode}`}`;
      void stop(
        1,
        `Lost the browser connection before the probe finished: ${cause}`
      );
    });
    // A personal session's host already holds its one tab, and addresses it
    // as session.sessionId.
    const personal = session?.personal ? session : undefined;
    const targetId =
      options.target ??
      personal?.targetId ??
      (session
        ? await sessionTab(client, session.targetId)
        : (
            await client.Target.createTarget({
              url: "about:blank",
              background: true,
            })
          ).targetId);
    const { sessionId } = personal?.sessionId
      ? { sessionId: personal.sessionId }
      : await client.Target.attachToTarget({ targetId, flatten: true });
    const send: Send = (method, params) =>
      client.send(method, params ?? {}, sessionId);
    // "Leave site?" blocks Page.navigate and every command after it until
    // someone answers, and a real CDP click is enough to arm it. A personal
    // session's host answers for its tab, including while the tab closes.
    if (!personal) {
      client.on(
        `Page.javascriptDialogOpening.${sessionId}`,
        ({ type }: { type: string }) => {
          if (type === "beforeunload")
            void send("Page.handleJavaScriptDialog", { accept: true }).catch(
              () => {}
            );
        }
      );
      await send("Page.enable");
    }
    const call = (fn: (...args: never[]) => unknown, args: unknown[]) =>
      inPageCall(
        returnByValueInPage,
        fn as (...args: unknown[]) => unknown,
        args,
        NODE_MARK
      );
    const evaluateOnce = async (expression: string) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text
        );
      if (result.result.value === NODE_MARK) throw new ReturnedNodeError();
      return result.result.value;
    };
    const evaluate: Evaluate = (fn, ...args) =>
      evaluateOnce(call(fn, args)).catch((error: Error) => {
        if (error instanceof CdpProtocolError && navigated.test(error.message))
          error.message +=
            ". The page navigated while evaluate ran; wait for the new page with waitFor()";
        throw error;
      });
    const pageUrl = async () => {
      const { targetInfos } = await client.Target.getTargets().catch(() => ({
        targetInfos: [],
      }));
      // A personal tab's host has no Target domain to ask, so ask the page;
      // only a page that cannot answer either has closed.
      const url =
        targetInfos.find((target) => target.targetId === targetId)?.url ??
        (await Promise.race([
          evaluateOnce(call(() => location.href, [])).catch(() => null),
          delay(2000, null, { ref: false }),
        ]));
      return typeof url === "string" ? url : "a closed page";
    };
    // Polls from the host with short evaluations: a redirect or reload between
    // polls costs one retry, where one long in-page wait fails outright.
    // Resolves with the first value `done` accepts; on timeout, `explain`
    // words the last value or page error.
    const poll = async (
      name: string,
      expression: string,
      options: PollOptions<unknown[]>,
      done: (value: unknown) => boolean,
      explain: (last: unknown, lastError?: string) => string
    ) => {
      const unknown = Object.keys(options).filter(
        (key) => !POLL_OPTIONS.includes(key)
      );
      if (unknown.length)
        throw new Error(
          `${name}: unknown option ${unknown.join(", ")}; it takes ${POLL_OPTIONS.join(", ")}`
        );
      const { timeoutMs = 30000, intervalMs = 250 } = options;
      const deadline = Date.now() + timeoutMs;
      const late = Symbol("late");
      let last: unknown;
      let lastError: Error | undefined;
      for (;;) {
        const attempt = evaluateOnce(expression);
        attempt.catch(() => {});
        try {
          const remaining = Math.max(deadline - Date.now(), 0);
          const value = await Promise.race([
            attempt,
            delay(remaining, late, { ref: false }),
          ]);
          if (value === late) break;
          if (done(value)) return value;
          last = value;
          lastError = undefined;
        } catch (error) {
          const failure = error as Error;
          // A page exception, often a document still loading, is not a
          // protocol error.
          if (
            failure instanceof ReturnedNodeError ||
            (failure instanceof CdpProtocolError &&
              !navigated.test(failure.message))
          )
            throw failure;
          lastError = failure;
        }
        if (Date.now() >= deadline) break;
        await delay(intervalMs);
      }
      throw new Error(
        `${name} timed out after ${timeoutMs}ms on ${await pageUrl()}` +
          explain(last, lastError?.message.split("\n")[0])
      );
    };
    const waitFor: WaitFor = (fn, options = {}) =>
      poll(
        "waitFor",
        call(fn, options.args ?? []),
        options,
        Boolean,
        (_, error) => (error ? `; last error: ${error}` : "")
      ) as Promise<never>;
    const click: Click = async (target, options = {}) => {
      const [find, args, label] =
        typeof target === "string"
          ? [
              (selector: string) => document.querySelector(selector),
              [target],
              target,
            ]
          : [target, options.args ?? [], "the element"];
      const point = await poll(
        "click",
        inPageCall(
          clickPointInPage,
          find as (...args: unknown[]) => unknown,
          args
        ),
        options,
        (value) => typeof value === "object" && value !== null && "x" in value,
        (last, error) =>
          `: ${label} ${(last as { miss?: string } | undefined)?.miss ?? `failed: ${error}`}`
      );
      await pressAt(send, point as Point);
    };
    const context: ProbeContext = {
      cdp: client,
      send,
      sessionId,
      targetId,
      evaluate,
      waitFor,
      click,
      type: (text) => type(send, text),
      press: (key) => press(send, key),
      clickRecaptchaCheckbox: () => clickRecaptchaCheckbox({ send, evaluate }),
      clickTurnstileCheckbox: () => clickTurnstileCheckbox({ send, evaluate }),
    };
    const run =
      typeof snippet === "string"
        ? // The block lets a probe declare its own names, such as a helper
          // called click, over the context's.
          new AsyncFunction(`{ ${Object.keys(context)} }`, `{\n${snippet}\n}`)
        : snippet;
    try {
      return (await run(context)) as T;
    } finally {
      if (!personal)
        await client.Target.detachFromTarget({ sessionId }).catch(() => {});
    }
  } finally {
    await cleanup();
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("unhandledRejection", unhandled);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (options["end-session"]) {
    const state = await endSession(options["end-session"]);
    if (state?.personal)
      console.error(
        `Released browser ${state.session}: closed its tab in your Chrome`
      );
    else if (state)
      console.error(
        `Released browser ${state.session}: closed Chrome pid=${state.chromePid}` +
          (state.keptProfile
            ? `; kept profile ${state.profile}`
            : ` and removed ${state.profile}`)
      );
    return;
  }
  let snippet: string | Probe;
  if (options.file) {
    const probe: unknown = (
      await import(pathToFileURL(resolve(options.file)).href)
    ).default;
    if (typeof probe !== "function")
      throw new Error("Probe module must default-export a function");
    snippet = probe as Probe;
  } else {
    const code = await Bun.stdin.text();
    if (!code.trim()) throw new Error("Provide probe code on stdin or --file");
    snippet = code;
  }
  const result = await runProbe(options, snippet);
  if (result !== undefined) console.log(JSON.stringify(result));
}

if (import.meta.main) {
  main().catch((error: Error & { code?: string; syscall?: string }) => {
    const sandboxed =
      ["EPERM", "EACCES"].includes(error.code ?? "") &&
      ["listen", "connect"].includes(error.syscall ?? "");
    console.error(
      sandboxed
        ? `${error.code} ${error.syscall}: ${error.message}: a sandbox blocked the loopback socket the probe uses to reach Chrome. ` +
            "Rerun the probe with network or escalated permission."
        : errorText(error)
    );
    process.exitCode = 1;
  });
}
