import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
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
  normalize,
  profileDownloads,
  stopChrome,
  trackDownload,
} from "./chrome";
import { electronApp } from "./electron";
import {
  changedInPage,
  inPageCall,
  type PageSnapshot,
  pagePreviewInPage,
  returnByValueInPage,
  type ScrollResult,
  scrollInPage,
  snapshotInPage,
  stopWatchInPage,
  type WatchResult,
  watchInPage,
} from "./in-page";
import {
  clickPointInPage,
  type Point,
  press,
  pressAt,
  type,
  watchClickInPage,
} from "./input";
import { trackNetwork } from "./network";
import { holdPressAndHoldButton, type PressAndHoldResult } from "./press-hold";
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

type SettleOptions = {
  quietMs?: number;
  timeoutMs?: number;
  maxInFlight?: number;
};

/**
 * Waits event-driven until the document is parsed and at most `maxInFlight`
 * (default 0) non-streaming requests remain open for `quietMs`; false after
 * `timeoutMs`.
 */
export type Settle = (options?: SettleOptions) => Promise<boolean>;

type GotoWait = "settle" | "dom" | "load" | "none";
type GotoOptions = SettleOptions & { wait?: GotoWait };

/**
 * Navigates and waits according to `wait` (default `"settle"`). Use
 * `{ wait: "dom" }` when following immediately with `waitFor()` so you do not
 * wait for network quiet first. Throws when the navigation fails; returns
 * `{ url, status, settled }`.
 */
export type Goto = (
  url: string,
  options?: GotoOptions
) => Promise<{ url: string; status: number | undefined; settled: boolean }>;

type SnapshotOptions = {
  selector?: string;
  maxText?: number;
  maxElements?: number;
};

/** Compact page overview: normalized visible text + visible interactive controls with click() selectors. */
export type Snapshot = (options?: SnapshotOptions) => Promise<PageSnapshot>;

type TypeOptions = { fast?: boolean };

type FillOptions<A> = PollOptions<A> & { fast?: boolean; clear?: boolean };

/** Clicks the element, clears it with trusted Meta+a + Backspace (unless clear: false), then types text. */
export type Fill = <A extends unknown[]>(
  target: string | ((...args: A) => Element | null | undefined),
  text: string,
  options?: FillOptions<A>
) => Promise<void>;

export type ResponseMatch =
  | string
  | RegExp
  | ((info: {
      url: string;
      status: number;
      method?: string;
      mimeType: string;
    }) => boolean);

export type WaitForResponseOptions = {
  timeoutMs?: number;
  /** Default true. Set false when you only need status and headers. */
  body?: boolean;
};

export type CapturedResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  mimeType: string;
  body?: string;
  json?: unknown;
};

/** Event-driven capture of the next matching network response and its completed body. */
export type WaitForResponse = (
  match: ResponseMatch,
  options?: WaitForResponseOptions
) => Promise<CapturedResponse>;

type ScrollOptions = {
  x?: number;
  y?: number;
  to?: "top" | "bottom";
  selector?: string;
};

/**
 * Scrolls the page (or a container) immediately without hanging on hidden or
 * smooth-scroll background tabs. Pass a vertical pixel delta (`scroll(1500)`),
 * `"bottom"`/`"top"`, or `{ x, y, to, selector }`.
 */
export type Scroll = (
  target?: number | "top" | "bottom" | ScrollOptions
) => Promise<ScrollResult>;

/** Saves a .png, .jpg or .webp of the viewport, or the full page; returns the path. */
export type Screenshot = (
  path: string,
  options?: { fullPage?: boolean }
) => Promise<string>;

/** Page-bound helpers shared by the main tab and any background tab opened with `withTab`. */
export type PageContext = {
  send: Send;
  sessionId: string;
  targetId: string;
  evaluate: Evaluate;
  goto: Goto;
  settle: Settle;
  waitFor: WaitFor;
  waitForResponse: WaitForResponse;
  snapshot: Snapshot;
  scroll: Scroll;
  screenshot: Screenshot;
  click: Click;
  fill: Fill;
  type: (text: string, options?: TypeOptions) => Promise<void>;
  press: (key: string) => Promise<void>;
  clickRecaptchaCheckbox: () => Promise<boolean>;
  clickTurnstileCheckbox: () => Promise<boolean>;
  holdPressAndHoldButton: () => Promise<PressAndHoldResult | false>;
};

/** Opens a background tab in the same browser with full PageContext helpers and closes it in finally. */
export type WithTab = <T>(fn: (tab: PageContext) => Promise<T>) => Promise<T>;

/** What a probe (stdin body or --file default export) receives. */
export type ProbeContext = PageContext & {
  cdp: CdpClient;
  withTab: WithTab;
};

export type Probe<T = unknown> = (context: ProbeContext) => Promise<T>;

const SESSION_IDLE_MS = 30 * 60 * 1000;

const POLL_OPTIONS = ["args", "timeoutMs", "intervalMs"];
const SETTLE_OPTIONS = ["quietMs", "timeoutMs", "maxInFlight"];
const GOTO_OPTIONS = ["wait", "quietMs", "timeoutMs", "maxInFlight"];
const GOTO_WAITS = new Set<GotoWait>(["settle", "dom", "load", "none"]);
const SNAPSHOT_OPTIONS = ["selector", "maxText", "maxElements"];
const SCROLL_OPTIONS = ["x", "y", "to", "selector"];
const TYPE_OPTIONS = ["fast"];
const FILL_OPTIONS = ["args", "timeoutMs", "intervalMs", "fast", "clear"];
const RESPONSE_OPTIONS = ["timeoutMs", "body"];
const SCREENSHOT_FORMATS: Record<string, "png" | "jpeg" | "webp"> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
};

function knownOptions(name: string, options: object, known: string[]) {
  const unknown = Object.keys(options).filter((key) => !known.includes(key));
  if (unknown.length)
    throw new Error(
      `${name}: unknown option ${unknown.join(", ")}; it takes ${known.join(", ")}`
    );
}

class ReturnedNodeError extends Error {
  override message =
    "The page function returned a DOM element, which cannot leave the page: return its text or attributes, or a boolean such as !!document.querySelector(...)";
}

const usage = `Usage: bun <skill>/scripts/probe.ts [options] < probe.js
  --file <path>          Import a .ts/.js module exporting default async (context)
  --session <id>         Continue in the browser claimed under this ID (or claim
                         one with a name you choose); its tab keeps its page
  --end-session <id>     Release that browser: close its Chrome and temp profile
  --release              With --session: release the browser once this probe
                         succeeds; a failed probe keeps it
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
  --app <name>           Read an Electron desktop app such as Slack: a hidden copy
                         of the app on a copy of its profile, read-only. Only
                         when the user explicitly asks to read that app
  --help

By default a probe claims a new isolated Chrome, prints its ID, and leaves it
open: pass --session <id> to continue and --end-session <id> when done.
A --personal browser is a tab the extension drives; --end-session closes only
that tab, and cdp reaches only that tab (no Browser or Target domain).
An --app session binds the app's main window; it refuses input, navigation and
request interception, and --end-session quits the copy and deletes its profile.
Attachment goes through a per-browser relay that keeps one approved connection
open (idle exit after 5 minutes), so Chrome asks to allow debugging only once.
CHROME_BIN overrides executable discovery. Requires macOS, Bun and Chrome.
stdin is an async JavaScript function body. --file paths resolve from your cwd;
type a --file probe with the ProbeContext type exported by probe.ts.
Context: { cdp, send, sessionId, targetId, evaluate, goto, settle, waitFor,
  waitForResponse, snapshot, scroll, screenshot, click, fill, type, press,
  withTab, clickRecaptchaCheckbox, clickTurnstileCheckbox, holdPressAndHoldButton }
send(method, params) addresses the bound page. cdp is the browser-level CDP client.
evaluate(fn, ...args) serializes a self-contained page function and JSON arguments,
and returns its JSON value; a returned DOM element throws.
goto(url, { wait = "settle", quietMs, timeoutMs, maxInFlight }) navigates and waits:
  "settle" (default: event-driven DOM + quiet network), "dom" (DOMContentLoaded,
  fast before waitFor), "load" (load event), or "none". Returns { url, status, settled }.
settle({ quietMs = 300, timeoutMs = 5000, maxInFlight = 0 }) waits event-driven
until the document is parsed and at most maxInFlight non-streaming requests remain
open for quietMs; false on timeout.
waitForResponse(match, { timeoutMs = 15000, body = true }) waits event-driven for a
matching network response to finish loading and returns { url, status, headers, mimeType, body, json }.
snapshot({ selector, maxText = 3000, maxElements = 60 }) returns normalized page
text plus visible interactive elements with verified CSS selectors for click().
screenshot(path, { fullPage }) saves a .png, .jpg or .webp, creating its folder,
and returns its path.
waitFor(fn, { args, timeoutMs = 15000, intervalMs = 250 }) returns fn's first truthy
value, event-driven on DOM/page changes with host fallback; survives redirects.
click(selector | fn, { args, timeoutMs = 10000, intervalMs = 150 }) waits event-driven
until visible and uncovered, then sends trusted mouse input.
fill(selector | fn, text, { args, timeoutMs, fast, clear }) clicks, clears with
trusted Meta+a + Backspace, and types text.
type(text, { fast }) sends trusted keystrokes (or instant Input.insertText with fast: true).
press(key) presses a named key ("Enter"), US char ("-"), or chord ("Meta+a", "Shift+Tab").
withTab(async (tab) => ...) opens a background tab with the same page helpers for
parallel multi-URL work and closes it in finally.
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
      release: { type: "boolean" },
      once: { type: "boolean" },
      personal: { type: "boolean" },
      "personal-profile": { type: "string" },
      background: { type: "boolean" },
      app: { type: "string" },
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
      throw new Error(
        "--end-session takes no other options (leave out --personal, --session, --app, etc., or pass --release on your last probe instead)"
      );
  }
  const endpoints = [
    values["ws-url"],
    values.port,
    values["active-port-file"],
  ].filter((v) => v !== undefined);
  const keeps = values.session !== undefined || values["idle-ms"] !== undefined;
  if (values.session !== undefined) validSessionName(values.session);
  if (values.release && values.session === undefined)
    throw new Error(
      "--release ends a --session browser; for one probe in its own browser use --once"
    );
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
  // Options that shape a launched Chrome or an attachment.
  const chromeOnly =
    values.once ||
    values.headless ||
    values.profile ||
    endpoints.length ||
    values.target;
  if (personal && chromeOnly)
    throw new Error(
      "--personal drives a tab in your own Chrome profile; it takes no --once, --headless, --profile or attachment options"
    );
  if (values.app !== undefined && (personal || chromeOnly))
    throw new Error(
      "--app launches a copy of a desktop app; it takes no --personal, --once, --headless, --profile or attachment options"
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
  for (let waited = 0; isAlive(pid); waited += 20) {
    if (waited >= ms) return false;
    await delay(20);
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
    const kind = (s: { personal?: unknown; app?: unknown }) =>
      s.personal ? "personal" : s.app ? "app" : "chrome";
    if (kind(options) !== kind(live))
      throw new Error(
        live.personal
          ? `Session ${name} is a tab in your own Chrome: pass --personal to continue in it`
          : live.app
            ? `Session ${name} is a read-only copy of ${live.app.name}: pass --app "${live.app.name}" to continue in it`
            : `Session ${name} is an isolated Chrome: leave out ${options.personal ? "--personal" : "--app"} to continue in it`
      );
    if (
      live.app &&
      options.app &&
      normalize(options.app) !== normalize(live.app.name)
    )
      throw new Error(
        `Session ${name} is a copy of ${live.app.name}. To use ${options.app}, ` +
          `release it with --end-session ${name} or use another name`
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
      : options.app
        ? {
            session: name,
            app: await electronApp(options.app),
            readOnly: true,
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
    : state.app
      ? `a hidden, read-only copy of ${state.app.name} pid=${state.chromePid} profile=${state.profile}`
      : `Chrome pid=${state.chromePid} profile=${state.profile}`;
  console.error(
    `Claimed browser ${name}: ${what}. ` +
      `Continue with --session ${name}; release it with --end-session ${name} (or --release on the last probe) when done.${idle}`
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
  const openTabs = new Set<{
    targetId: string;
    sessionId?: string;
    dispose?: () => void;
  }>();
  // A launched Chrome stops with the probe; a session's Chrome and tab stay,
  // but any child tabs opened by withTab are closed so timeouts never leak them.
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
      if (client && openTabs.size) {
        const tabs = [...openTabs];
        openTabs.clear();
        await Promise.race([
          Promise.all(
            tabs.map(async (tab) => {
              tab.dispose?.();
              if (tab.sessionId)
                await client.Target.detachFromTarget({
                  sessionId: tab.sessionId,
                }).catch(() => {});
              await client.Target.closeTarget({
                targetId: tab.targetId,
              }).catch(() => {});
            })
          ),
          delay(2000, undefined, { ref: false }),
        ]);
      }
      if (chrome)
        await stopChrome(
          chrome,
          client && {
            cancelDownload: (guid) => client.Browser.cancelDownload({ guid }),
            close: () => client.Browser.close(),
          }
        );
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
        keepClient: true,
        log: console.error,
      });
      endpoint = chrome.endpoint ?? "";
    }
    try {
      cdp = chrome?.client ?? (await connect(validWebSocket(endpoint)));
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
    if (chrome) {
      const launched = chrome;
      client.on("Browser.downloadWillBegin", (event) =>
        trackDownload(launched, event)
      );
      client.on("Browser.downloadProgress", (event) =>
        trackDownload(launched, event)
      );
      await client.Browser.setDownloadBehavior(profileDownloads(launched));
    }
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
    // as session.sessionId. For a regular session, attach directly to the
    // recorded tab to avoid an extra Target.getTargets round trip on every
    // warm probe; fall back to sessionTab only if that tab was closed.
    const personal = session?.personal ? session : undefined;
    let targetId: string;
    let sessionId: string;
    if (personal?.sessionId) {
      targetId = options.target ?? personal.targetId ?? "";
      sessionId = personal.sessionId;
    } else if (options.target) {
      targetId = options.target;
      ({ sessionId } = await client.Target.attachToTarget({
        targetId,
        flatten: true,
      }));
    } else if (session?.targetId) {
      try {
        targetId = session.targetId;
        ({ sessionId } = await client.Target.attachToTarget({
          targetId,
          flatten: true,
        }));
      } catch {
        targetId = await sessionTab(client, session.targetId);
        ({ sessionId } = await client.Target.attachToTarget({
          targetId,
          flatten: true,
        }));
      }
    } else if (session) {
      targetId = await sessionTab(client, session.targetId);
      ({ sessionId } = await client.Target.attachToTarget({
        targetId,
        flatten: true,
      }));
    } else {
      ({ targetId } = await client.Target.createTarget({
        url: "about:blank",
        background: true,
      }));
      ({ sessionId } = await client.Target.attachToTarget({
        targetId,
        flatten: true,
      }));
    }
    // Builds all page-bound helpers for a target session (both the main tab
    // and any background tab opened with `withTab`). `dispose` cleans up all
    // CDP listeners registered on `client` for that session.
    const bindPage = async (
      boundTargetId: string,
      boundSessionId: string,
      isPersonal: boolean,
      emulateFocus = false
    ): Promise<{ page: PageContext; dispose: () => void }> => {
      const send: Send = (method, params) =>
        client.send(method, params ?? {}, boundSessionId);
      const disposers = new Set<() => void>();
      // "Leave site?" blocks Page.navigate and every command after it until
      // someone answers, and a real CDP click is enough to arm it. A personal
      // session's host answers for its tab, including while the tab closes.
      const onDialog = ({ type: dialogType }: { type: string }) => {
        if (dialogType === "beforeunload")
          void send("Page.handleJavaScriptDialog", { accept: true }).catch(
            () => {}
          );
      };
      if (!isPersonal) {
        client.on(`Page.javascriptDialogOpening.${boundSessionId}`, onDialog);
      }
      const [network] = await Promise.all([
        trackNetwork(client, send, boundSessionId),
        !isPersonal && send("Page.enable"),
        // Background tabs (withTab) have visibilityState === "hidden" and pause
        // requestAnimationFrame, stalling React Suspense / Next.js streaming;
        // focus emulation keeps rAF running without taking OS window focus.
        emulateFocus &&
          send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(
            () => {}
          ),
      ]);
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
        return result.result.value;
      };
      const evaluateValue = async <A extends unknown[]>(
        fn: (...args: A) => unknown,
        args: A
      ) => {
        const result = await evaluateOnce(
          inPageCall(returnByValueInPage, fn, args)
        );
        if (result.node) throw new ReturnedNodeError();
        return result.value;
      };
      const evaluate: Evaluate = (fn, ...args) =>
        evaluateValue(fn, args).catch((error: Error) => {
          if (
            error instanceof CdpProtocolError &&
            navigated.test(error.message)
          )
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
          targetInfos.find((target) => target.targetId === boundTargetId)
            ?.url ??
          (await Promise.race([
            evaluate(() => location.href).catch(() => null),
            delay(2000, null, { ref: false }),
          ]));
        return typeof url === "string" ? url : "a closed page";
      };
      const pagePreview = async () => {
        const preview = (await Promise.race([
          evaluateOnce(inPageCall(pagePreviewInPage)).catch(() => null),
          delay(1000, null, { ref: false }),
        ])) as { title?: unknown; text?: unknown } | null;
        if (!preview || typeof preview.title !== "string") return "";
        const text = typeof preview.text === "string" ? preview.text : "";
        if (!preview.title && !text) return "";
        const parts = [
          preview.title ? `title=${JSON.stringify(preview.title)}` : "",
          text ? `text=${JSON.stringify(text)}` : "",
        ].filter(Boolean);
        return `; page ${parts.join(" ")}`;
      };
      const visibleControlsHint = async () => {
        const snap = (await Promise.race([
          evaluateOnce(inPageCall(snapshotInPage, null, 0, 10)).catch(
            () => null
          ),
          delay(1000, null, { ref: false }),
        ])) as PageSnapshot | null;
        if (!snap || !Array.isArray(snap.elements) || !snap.elements.length)
          return "";
        const items = snap.elements.map((el) => {
          const label = el.text ?? el.placeholder ?? el.type ?? "";
          return label
            ? `${el.tag} ${JSON.stringify(label.slice(0, 40))} (${el.selector})`
            : `${el.tag} (${el.selector})`;
        });
        return `; visible controls: ${items.join(", ")}`;
      };
      // Tries from the host with short evaluations until `done` accepts a
      // value: a redirect or reload between tries costs one retry, where one
      // long in-page wait fails outright. Resolves with that value as `found`,
      // or at the deadline with the last value or page error.
      const until = async (
        attempt: () => Promise<unknown>,
        timeoutMs: number,
        intervalMs: number,
        done: (value: unknown) => boolean,
        /** Ends it quietly, with undefined: something else answered. */
        stopped?: AbortSignal,
        initial?: { delayMs?: number; last?: unknown; lastError?: Error }
      ) => {
        const deadline = Date.now() + timeoutMs;
        const late = Symbol("late");
        let last: unknown = initial?.last;
        let lastError: Error | undefined = initial?.lastError;
        if (initial?.delayMs && initial.delayMs > 0) {
          const wait = Math.min(
            initial.delayMs,
            Math.max(deadline - Date.now(), 0)
          );
          if (wait > 0)
            await delay(wait, undefined, { signal: stopped }).catch(() => {});
        }
        for (;;) {
          if (stopped?.aborted) return undefined;
          const remaining = Math.max(deadline - Date.now(), 0);
          if (
            remaining === 0 &&
            (last !== undefined || lastError !== undefined)
          )
            break;
          const trying = attempt();
          trying.catch(() => {});
          try {
            const value = await Promise.race([
              trying,
              delay(remaining, late, { ref: false }),
            ]);
            if (value === late) break;
            if (done(value)) return { found: value };
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
          await delay(intervalMs, undefined, { signal: stopped }).catch(
            () => {}
          );
        }
        return { last, lastError };
      };
      // `until`, for waitFor and click: throws at the deadline, and `explain`
      // words the last value or page error.
      const poll = async (
        name: string,
        attempt: () => Promise<unknown>,
        opts: PollOptions<unknown[]>,
        defaults: { timeoutMs: number; intervalMs: number },
        done: (value: unknown) => boolean,
        explain: (
          last: unknown,
          lastError?: string
        ) => Promise<string> | string,
        stopped?: AbortSignal,
        initial?: { delayMs?: number; last?: unknown; lastError?: Error }
      ) => {
        const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs;
        const intervalMs = opts.intervalMs ?? defaults.intervalMs;
        const result = await until(
          attempt,
          timeoutMs,
          intervalMs,
          done,
          stopped,
          initial
        );
        if (!result || "found" in result) return result?.found;
        throw new Error(
          `${name} timed out after ${timeoutMs}ms on ${await pageUrl()}` +
            (await explain(
              result.last,
              result.lastError?.message.split("\n")[0]
            ))
        );
      };
      // Settles with the watch expression's first truthy value from the page,
      // which re-checks on DOM changes and page events, unless the host poll
      // gets there first. A new document ends a watch, so it is re-installed.
      const watch = async (
        expression: string,
        ended: AbortSignal
      ): Promise<{ value: unknown } | undefined> => {
        while (!ended.aborted) {
          let objectId: string | undefined;
          const stopWatch = () => {
            if (objectId)
              void send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: String(stopWatchInPage),
              }).catch(() => {});
          };
          try {
            const handle = await send("Runtime.evaluate", { expression });
            objectId = handle.result.objectId;
            if (handle.exceptionDetails || !objectId) break;
            ended.addEventListener("abort", stopWatch, { once: true });
            if (ended.aborted) stopWatch();
            const { result } = await send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: String(changedInPage),
              awaitPromise: true,
              returnByValue: true,
            });
            const outcome: WatchResult = result.value;
            if (outcome && "node" in outcome) throw new ReturnedNodeError();
            if (outcome) return { value: outcome.value };
            break;
          } catch (error) {
            if (error instanceof ReturnedNodeError) throw error;
            if (
              !(error instanceof CdpProtocolError) ||
              !navigated.test(error.message)
            )
              break;
            await delay(50);
          } finally {
            ended.removeEventListener("abort", stopWatch);
            if (objectId)
              await send("Runtime.releaseObject", { objectId }).catch(() => {});
          }
        }
        return undefined;
      };
      // Answers as the page changes, through watch; the host poll still covers
      // what no event announces, such as script state or a page with scripts off.
      const waitFor: WaitFor = async (fn, opts = {}) => {
        knownOptions("waitFor", opts, POLL_OPTIONS);
        const args = opts.args ?? ([] as never);
        const timeoutMs = opts.timeoutMs ?? 15000;
        const intervalMs = opts.intervalMs ?? 250;
        const ended = new AbortController();
        const watching = watch(inPageCall(watchInPage, fn, args), ended.signal);
        // Without a watch, as on a page with scripts off, the poll alone answers.
        const changed = watching.then((found) =>
          found ? found.value : new Promise<never>(() => {})
        );
        changed.catch(() => {});
        try {
          return (await Promise.race([
            poll(
              "waitFor",
              () => evaluateValue(fn, args),
              opts,
              { timeoutMs: 15000, intervalMs: 250 },
              Boolean,
              async (_, error) =>
                error ? `; last error: ${error}` : await pagePreview(),
              ended.signal,
              { delayMs: Math.min(intervalMs, Math.floor(timeoutMs / 2)) }
            ),
            changed,
          ])) as never;
        } finally {
          ended.abort();
          await Promise.race([
            watching.catch(() => {}),
            delay(1000, undefined, { ref: false }),
          ]);
        }
      };
      const waitForResponse: WaitForResponse = (match, opts = {}) => {
        knownOptions("waitForResponse", opts, RESPONSE_OPTIONS);
        const { timeoutMs = 15000, body: wantBody = true } = opts;
        const matches = (info: {
          url: string;
          status: number;
          method?: string;
          mimeType: string;
        }) =>
          typeof match === "string"
            ? info.url.includes(match)
            : match instanceof RegExp
              ? match.test(info.url)
              : Boolean(match(info));
        const describeMatch = () =>
          typeof match === "string"
            ? JSON.stringify(match)
            : match instanceof RegExp
              ? String(match)
              : "matching response";

        return new Promise<CapturedResponse>((resolve, reject) => {
          const methods = new Map<string, string>();
          const finished = new Set<string>();
          const pendingMatch = new Map<
            string,
            {
              url: string;
              status: number;
              headers: Record<string, string>;
              mimeType: string;
            }
          >();
          let done = false;

          const cleanupListeners = () => {
            clearTimeout(deadline);
            disposers.delete(onDispose);
            client.off(`Network.requestWillBeSent.${boundSessionId}`, onReq);
            client.off(`Network.responseReceived.${boundSessionId}`, onResp);
            client.off(`Network.loadingFinished.${boundSessionId}`, onFin);
            client.off(`Network.loadingFailed.${boundSessionId}`, onFail);
          };

          const finish = (
            outcome: { ok: CapturedResponse } | { err: Error }
          ) => {
            if (done) return;
            done = true;
            cleanupListeners();
            if ("ok" in outcome) resolve(outcome.ok);
            else reject(outcome.err);
          };

          const onDispose = () =>
            finish({ err: new Error("waitForResponse: tab closed") });

          const readAndResolve = async (
            requestId: string,
            info: {
              url: string;
              status: number;
              headers: Record<string, string>;
              mimeType: string;
            }
          ) => {
            if (!wantBody) return finish({ ok: info });
            try {
              const raw = await send("Network.getResponseBody", { requestId });
              const text = raw.base64Encoded
                ? Buffer.from(raw.body, "base64").toString("utf8")
                : raw.body;
              let json: unknown;
              if (text.trim()) {
                try {
                  json = JSON.parse(text);
                } catch {
                  // non-JSON body
                }
              }
              finish({
                ok: {
                  ...info,
                  body: text,
                  ...(json !== undefined ? { json } : {}),
                },
              });
            } catch {
              // 204/304 or empty response body has no stored resource.
              finish({ ok: { ...info, body: "" } });
            }
          };

          const onReq = ({
            requestId,
            request,
          }: {
            requestId: string;
            request: { method: string };
          }) => {
            methods.set(requestId, request.method);
            finished.delete(requestId);
          };

          const onResp = ({
            requestId,
            response,
          }: {
            requestId: string;
            response: {
              url: string;
              status: number;
              headers: Record<string, string>;
              mimeType: string;
            };
          }) => {
            if (done) return;
            const method = methods.get(requestId);
            const info = {
              url: response.url,
              status: response.status,
              headers: response.headers ?? {},
              mimeType: response.mimeType ?? "",
            };
            if (!matches({ ...info, method })) return;
            if (!wantBody || finished.has(requestId)) {
              void readAndResolve(requestId, info);
            } else {
              pendingMatch.set(requestId, info);
            }
          };

          const onFin = ({ requestId }: { requestId: string }) => {
            if (done) return;
            finished.add(requestId);
            const info = pendingMatch.get(requestId);
            if (info) {
              pendingMatch.delete(requestId);
              void readAndResolve(requestId, info);
            }
          };

          const onFail = ({
            requestId,
            errorText: reason,
          }: {
            requestId: string;
            errorText?: string;
          }) => {
            if (done) return;
            const info = pendingMatch.get(requestId);
            if (info) {
              pendingMatch.delete(requestId);
              finish({
                err: new Error(
                  `waitForResponse: ${info.url} failed (${reason || "network error"})`
                ),
              });
            }
          };

          const deadline = setTimeout(
            () =>
              finish({
                err: new Error(
                  `waitForResponse timed out after ${timeoutMs}ms waiting for ${describeMatch()}`
                ),
              }),
            timeoutMs
          );
          disposers.add(onDispose);
          client.on(`Network.requestWillBeSent.${boundSessionId}`, onReq);
          client.on(`Network.responseReceived.${boundSessionId}`, onResp);
          client.on(`Network.loadingFinished.${boundSessionId}`, onFin);
          client.on(`Network.loadingFailed.${boundSessionId}`, onFail);
        });
      };
      const settle: Settle = async (opts = {}) => {
        knownOptions("settle", opts, SETTLE_OPTIONS);
        const { quietMs = 300, timeoutMs = 5000, maxInFlight = 0 } = opts;
        return network.waitQuiet(
          quietMs,
          timeoutMs,
          () =>
            evaluateValue(() => document.readyState !== "loading", []).then(
              Boolean
            ),
          maxInFlight
        );
      };
      const goto: Goto = async (url, opts = {}) => {
        knownOptions("goto", opts, GOTO_OPTIONS);
        const wait: GotoWait = opts.wait ?? "settle";
        if (!GOTO_WAITS.has(wait))
          throw new Error(
            `goto: unknown wait ${JSON.stringify(wait)}; use "settle", "dom", "load" or "none"`
          );
        let settled = false;
        let loaderId: string | undefined;
        if (wait === "dom" || wait === "load") {
          let onDom: (() => void) | undefined;
          let onLoad: (() => void) | undefined;
          const fired = new Promise<boolean>((resolve) => {
            onLoad = () => resolve(true);
            client.once(`Page.loadEventFired.${boundSessionId}`, onLoad);
            if (wait === "dom") {
              onDom = () => resolve(true);
              client.once(`Page.domContentEventFired.${boundSessionId}`, onDom);
            }
          });
          const cleanupWait = () => {
            if (onDom)
              client.off(`Page.domContentEventFired.${boundSessionId}`, onDom);
            if (onLoad)
              client.off(`Page.loadEventFired.${boundSessionId}`, onLoad);
          };
          try {
            const navigation = await send("Page.navigate", { url });
            if (navigation.errorText)
              throw new Error(`goto ${url}: ${navigation.errorText}`);
            loaderId = navigation.loaderId;
            settled = !loaderId
              ? true
              : await Promise.race([
                  fired,
                  delay(opts.timeoutMs ?? 15000, false, { ref: false }),
                ]);
          } finally {
            cleanupWait();
          }
        } else {
          const navigation = await send("Page.navigate", { url });
          if (navigation.errorText)
            throw new Error(`goto ${url}: ${navigation.errorText}`);
          loaderId = navigation.loaderId;
          if (wait === "settle") {
            const settleOpts: SettleOptions = {};
            if (opts.quietMs !== undefined) settleOpts.quietMs = opts.quietMs;
            if (opts.timeoutMs !== undefined)
              settleOpts.timeoutMs = opts.timeoutMs;
            if (opts.maxInFlight !== undefined)
              settleOpts.maxInFlight = opts.maxInFlight;
            settled = await settle(settleOpts);
          }
        }
        return {
          url: await evaluateValue(() => location.href, []).catch(pageUrl),
          status: network.status(loaderId),
          settled,
        };
      };
      const snapshot: Snapshot = async (opts = {}) => {
        knownOptions("snapshot", opts, SNAPSHOT_OPTIONS);
        const { selector = null, maxText = 3000, maxElements = 60 } = opts;
        return (await evaluateOnce(
          inPageCall(snapshotInPage, selector, maxText, maxElements)
        )) as PageSnapshot;
      };
      const scroll: Scroll = async (target = 1000) => {
        let selector: string | null = null;
        let x: number | null = null;
        let y: number | null = null;
        let to: "top" | "bottom" | null = null;
        if (typeof target === "number") {
          y = target;
        } else if (target === "top" || target === "bottom") {
          to = target;
        } else if (typeof target === "object" && target !== null) {
          knownOptions("scroll", target, SCROLL_OPTIONS);
          selector = target.selector ?? null;
          x = target.x ?? null;
          y = target.y ?? null;
          if (target.to !== undefined) {
            if (target.to !== "top" && target.to !== "bottom")
              throw new Error(
                `scroll: unknown to ${JSON.stringify(target.to)}; use "top" or "bottom"`
              );
            to = target.to;
          }
        } else {
          throw new Error(
            'scroll: pass a pixel delta, "top", "bottom", or { x, y, to, selector }'
          );
        }
        return (await evaluateOnce(
          inPageCall(scrollInPage, selector, x, y, to)
        )) as ScrollResult;
      };
      const screenshot: Screenshot = async (path, opts = {}) => {
        knownOptions("screenshot", opts, ["fullPage"]);
        const format = SCREENSHOT_FORMATS[extname(path).toLowerCase()];
        if (!format)
          throw new Error(
            `screenshot: ${path} must end in ${Object.keys(SCREENSHOT_FORMATS).join(", ")}`
          );
        const clip = opts.fullPage
          ? {
              ...(await send("Page.getLayoutMetrics")).cssContentSize,
              scale: 1,
            }
          : undefined;
        const file = resolve(path);
        const [{ data }] = await Promise.all([
          send("Page.captureScreenshot", {
            format,
            captureBeyondViewport: Boolean(clip),
            clip,
          }),
          mkdir(dirname(file), { recursive: true }),
        ]);
        await writeFile(file, Buffer.from(data, "base64"));
        return file;
      };
      const click: Click = async (target, opts = {}) => {
        knownOptions("click", opts, POLL_OPTIONS);
        const [find, args, label] =
          typeof target === "string"
            ? [
                (selector: string) => {
                  const all = document.querySelectorAll(selector);
                  for (const el of all) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return el;
                  }
                  return all[0] ?? null;
                },
                [target],
                target,
              ]
            : [target, opts.args ?? [], "the element"];
        const checkPoint = () =>
          evaluateOnce(
            inPageCall(
              clickPointInPage,
              find as (...args: unknown[]) => unknown,
              args
            )
          );
        const isPoint = (value: unknown) =>
          typeof value === "object" && value !== null && "x" in value;
        let initialLast: unknown;
        let initialError: Error | undefined;
        try {
          const immediate = await checkPoint();
          if (isPoint(immediate)) {
            await pressAt(send, immediate as Point);
            return;
          }
          initialLast = immediate;
        } catch (error) {
          const failure = error as Error;
          if (
            failure instanceof CdpProtocolError &&
            !navigated.test(failure.message)
          )
            throw failure;
          initialError = failure;
        }
        const timeoutMs = opts.timeoutMs ?? 10000;
        const intervalMs = opts.intervalMs ?? 150;
        const ended = new AbortController();
        const watching = watch(
          inPageCall(
            watchClickInPage,
            watchInPage,
            clickPointInPage,
            find as (...args: unknown[]) => unknown,
            args
          ),
          ended.signal
        );
        const changed = watching.then((found) =>
          found ? found.value : new Promise<never>(() => {})
        );
        changed.catch(() => {});
        let point: unknown;
        try {
          point = await Promise.race([
            poll(
              "click",
              checkPoint,
              opts,
              { timeoutMs: 10000, intervalMs: 150 },
              isPoint,
              async (last, error) => {
                const miss = (last as { miss?: string } | undefined)?.miss;
                const hint =
                  miss === "matched no element"
                    ? await visibleControlsHint()
                    : "";
                return `: ${label} ${miss ?? `failed: ${error}`}${hint}`;
              },
              ended.signal,
              {
                delayMs: Math.min(intervalMs, Math.floor(timeoutMs / 2)),
                last: initialLast,
                lastError: initialError,
              }
            ),
            changed,
          ]);
        } finally {
          ended.abort();
          await Promise.race([
            watching.catch(() => {}),
            delay(1000, undefined, { ref: false }),
          ]);
        }
        await pressAt(send, point as Point);
      };
      const fill: Fill = async (target, value, opts = {}) => {
        knownOptions("fill", opts, FILL_OPTIONS);
        const { fast, clear = true, ...pollOpts } = opts;
        await click(target, pollOpts);
        if (clear) {
          await press(send, "Meta+a");
          await press(send, "Backspace");
        }
        if (value) await type(send, value, fast ? { fast } : undefined);
      };
      const page: PageContext = {
        send,
        sessionId: boundSessionId,
        targetId: boundTargetId,
        evaluate,
        goto,
        settle,
        waitFor,
        waitForResponse,
        snapshot,
        scroll,
        screenshot,
        click,
        fill,
        type: (text, typeOptions) => {
          if (typeOptions) knownOptions("type", typeOptions, TYPE_OPTIONS);
          return type(send, text, typeOptions);
        },
        press: (key) => press(send, key),
        clickRecaptchaCheckbox: () =>
          clickRecaptchaCheckbox({ send, evaluate }),
        clickTurnstileCheckbox: () =>
          clickTurnstileCheckbox({ send, evaluate }),
        holdPressAndHoldButton: () => holdPressAndHoldButton({ send }),
      };
      const dispose = () => {
        for (const fn of [...disposers]) fn();
        network.dispose();
        if (!isPersonal)
          client.off(
            `Page.javascriptDialogOpening.${boundSessionId}`,
            onDialog
          );
      };
      return { page, dispose };
    };

    const main = await bindPage(targetId, sessionId, Boolean(personal));
    const withTab: WithTab = async (fn) => {
      if (personal)
        throw new Error(
          "withTab is unavailable in --personal sessions (chrome.debugger reaches only one tab)"
        );
      const { targetId: childTargetId } = await client.Target.createTarget({
        url: "about:blank",
        background: true,
      });
      const entry: {
        targetId: string;
        sessionId?: string;
        dispose?: () => void;
      } = { targetId: childTargetId };
      openTabs.add(entry);
      try {
        const { sessionId: childSessionId } =
          await client.Target.attachToTarget({
            targetId: childTargetId,
            flatten: true,
          });
        entry.sessionId = childSessionId;
        const bound = await bindPage(
          childTargetId,
          childSessionId,
          false,
          true
        );
        entry.dispose = bound.dispose;
        return await fn(bound.page);
      } finally {
        openTabs.delete(entry);
        entry.dispose?.();
        if (entry.sessionId)
          await client.Target.detachFromTarget({
            sessionId: entry.sessionId,
          }).catch(() => {});
        await client.Target.closeTarget({ targetId: childTargetId }).catch(
          () => {}
        );
      }
    };
    const context: ProbeContext = {
      cdp: client,
      ...main.page,
      withTab,
    };
    let run: Probe<T>;
    if (typeof snippet === "string") {
      try {
        // The block lets a probe declare its own names, such as a helper
        // called click, over the context's.
        run = new AsyncFunction(
          `{ ${Object.keys(context)} }`,
          `{\n${snippet}\n}`
        ) as Probe<T>;
      } catch (error) {
        if (error instanceof SyntaxError && /^\s*import\s+/m.test(snippet)) {
          throw new SyntaxError(
            'stdin probe code is an async function body, so static `import` statements are not allowed: use `await import("node:fs/promises")`, `Bun.file()`/`Bun.write()`, or `--file`'
          );
        }
        throw error;
      }
    } else {
      run = snippet;
    }
    try {
      return (await run(context)) as T;
    } catch (error) {
      if (
        error instanceof ReferenceError &&
        /\b(?:document|window|location)\b is not defined/.test(error.message)
      ) {
        error.message +=
          " (probe code runs in Bun, not the browser page — wrap DOM access in evaluate(() => ...))";
      }
      throw error;
    } finally {
      main.dispose();
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

/** Ends a session and says what that closed. */
async function release(name: string) {
  const state = await endSession(name);
  if (state?.personal)
    console.error(
      `Released browser ${state.session}: closed its tab in your Chrome`
    );
  else if (state?.app)
    console.error(
      `Released browser ${state.session}: quit the copy of ${state.app.name} pid=${state.chromePid} and removed ${state.profile}`
    );
  else if (state)
    console.error(
      `Released browser ${state.session}: closed Chrome pid=${state.chromePid}` +
        (state.keptProfile
          ? `; kept profile ${state.profile}`
          : ` and removed ${state.profile}`)
    );
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (options["end-session"]) return release(options["end-session"]);
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
  if (options.release && options.session) await release(options.session);
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
