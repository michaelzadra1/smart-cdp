import { type ChildProcess, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browserEndpoint, connect } from "./cdp";

/** A launched Chrome, or Electron app, that this process owns. */
export type Chrome = {
  child: ChildProcess;
  profile: string;
  /** A --profile the caller keeps; otherwise a temp profile stopChrome removes. */
  kept: boolean;
  endpoint?: string;
  exited: Promise<unknown>;
  running: () => boolean;
};

export async function chromeBinary(): Promise<string> {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const path of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]) {
    try {
      await access(path);
      return path;
    } catch {
      /* next installed browser */
    }
  }
  throw new Error(
    "Chrome not found in /Applications; set CHROME_BIN to its executable"
  );
}

/** One of the user's own Chrome profiles: its directory and the label Chrome shows. */
export type ChromeProfile = { directory: string; name: string };

/** Chrome's first profile, used when no other is named. */
export const DEFAULT_PROFILE: ChromeProfile = {
  directory: "Default",
  name: "Default",
};

// Google Chrome's user data directory, whose Local State lists its profiles.
const CHROME_USER_DATA_DIR = join(
  homedir(),
  "Library/Application Support/Google/Chrome"
);

/** A name as people match it: ignoring case and punctuation. */
export const normalize = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Finds one of the user's Chrome profiles however they name it: the label in
 * Chrome's profile menu ("Alex (Work)", or "Alex Work"), the profile's own
 * name ("Work") or its directory ("Profile 2"), ignoring case and punctuation.
 */
export async function chromeProfile(
  wanted: string,
  userDataDir = CHROME_USER_DATA_DIR
): Promise<ChromeProfile> {
  // Explicit directories need no access to Chrome's protected app-data files.
  if (/^(?:Default|Profile [1-9]\d*)$/.test(wanted))
    return { directory: wanted, name: wanted };
  const path = join(userDataDir, "Local State");
  type Info = { name?: string; gaia_given_name?: string };
  let cache: Record<string, Info>;
  try {
    cache = JSON.parse(await readFile(path, "utf8")).profile.info_cache;
  } catch (cause) {
    throw new Error(
      `Cannot read Chrome's profile list in ${path}. Use an explicit directory such as "Profile 2" instead of a profile name.`,
      { cause }
    );
  }
  const profiles = Object.entries(cache).map(([directory, info]) => {
    const name = info.name ?? directory;
    // Chrome's menu shows a signed-in profile as "<given name> (<name>)".
    const label = info.gaia_given_name
      ? `${info.gaia_given_name} (${name})`
      : name;
    return {
      directory,
      name: label,
      matches: [label, name, directory].map(normalize),
    };
  });
  const found = profiles.find(({ matches }) =>
    matches.includes(normalize(wanted))
  );
  if (found) return { directory: found.directory, name: found.name };
  throw new Error(
    `Chrome has no profile named "${wanted}". Its profiles: ` +
      profiles
        .map(({ name, directory }) => `"${name}" (${directory})`)
        .join(", ")
  );
}

// A fixed port, never --remote-debugging-port=0: port 0 turns on Blink's
// AutomationControlled feature (navigator.webdriver === true), and Google
// sign-in rejects that browser as "not secure".
async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise((ok) => server.close(ok));
  return port;
}

/**
 * Turns off the password manager in the profile's preferences before launch.
 * Without --enable-automation (which sets navigator.webdriver) Chrome offers
 * "Save password?" after every scripted sign-in, and that bubble covers the
 * page in visible windows and screen captures. A kept profile's other
 * preferences are preserved.
 */
async function disablePasswordManager(profile: string) {
  const dir = join(profile, "Default");
  const path = join(dir, "Preferences");
  type Preferences = {
    credentials_enable_service?: boolean;
    profile?: Record<string, unknown>;
  };
  let prefs: Preferences = {};
  try {
    prefs = JSON.parse(await readFile(path, "utf8")) as Preferences;
  } catch {
    // No profile yet, or Chrome left it unreadable: start fresh.
  }
  prefs.credentials_enable_service = false;
  prefs.profile = {
    ...prefs.profile,
    password_manager_enabled: false,
    password_manager_leak_detection: false,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(prefs));
}

/**
 * Launches Chrome as this process's child on its own profile and proves the
 * CDP endpoint belongs to that child. The returned handle is the only cleanup
 * authority: stop it with stopChrome.
 */
export async function launchChrome({
  headless,
  profile: keptProfile,
  log,
}: {
  headless?: boolean;
  profile?: string;
  log?: (line: string) => void;
}): Promise<Chrome> {
  const makeProfile = async () => {
    if (!keptProfile) return mkdtemp(join(tmpdir(), "smart-cdp-"));
    const path = resolve(keptProfile);
    await mkdir(path, { recursive: true });
    return path;
  };
  const [binary, profile] = await Promise.all([chromeBinary(), makeProfile()]);
  await disablePasswordManager(profile);
  return launchBrowser({
    name: "Chrome",
    binary,
    profile,
    kept: Boolean(keptProfile),
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      ...(headless ? ["--headless=new"] : []),
      "--no-startup-window",
    ],
    log,
  });
}

/**
 * Spawns a Chromium-based executable (Chrome, or an Electron app) as this
 * process's child on `profile`, with CDP on a reserved loopback port, and
 * proves the endpoint belongs to that child. The returned handle is the only
 * cleanup authority: stop it with stopChrome.
 */
export async function launchBrowser({
  name,
  binary,
  profile,
  kept = false,
  args = [],
  log,
  onSpawn,
}: {
  /** What log lines and errors call it: "Chrome", or the app's name. */
  name: string;
  binary: string;
  profile: string;
  /** A profile the caller keeps; otherwise stopChrome removes it. */
  kept?: boolean;
  args?: string[];
  log?: (line: string) => void;
  onSpawn?: (pid: number) => void;
}): Promise<Chrome> {
  const port = await reserveLoopbackPort();
  const child = spawn(
    binary,
    [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // A window behind the user's must work like a front one: without these,
      // Chromium throttles a covered or hidden window's renderer and its
      // timers, and on a loaded machine delays or drops the input a probe
      // sends it. Puppeteer launches with the same three.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      ...args,
    ],
    // Its own process group, so stopChrome can reach the helpers too.
    { stdio: "ignore", detached: true }
  );
  let spawnError: Error | undefined;
  const chrome: Chrome = {
    child,
    profile,
    kept,
    exited: new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
      child.once("error", (error) => {
        spawnError = error;
        resolveExit();
      });
    }),
    running: () => child.exitCode === null && child.signalCode === null,
  };
  if (child.pid) onSpawn?.(child.pid);
  log?.(`Owned ${name} pid=${child.pid} profile=${profile}`);
  try {
    while (!chrome.endpoint) {
      if (spawnError) throw spawnError;
      if (!chrome.running())
        throw new Error(
          `${name} exited before CDP became ready (profile already open?)`
        );
      try {
        chrome.endpoint = await browserEndpoint(port);
      } catch {
        await delay(50);
      }
    }
    // The reserved port was briefly free: prove the endpoint is our child.
    const check = await connect(chrome.endpoint);
    try {
      const { processInfo } = await check.SystemInfo.getProcessInfo();
      if (processInfo.find((p) => p.type === "browser")?.id !== child.pid)
        throw new Error(`Port ${port} belongs to another browser`);
    } finally {
      await check.close();
    }
    return chrome;
  } catch (error) {
    await stopChrome(chrome);
    throw error;
  }
}

/**
 * Stops a launched Chrome or app and removes its generated profile, never a
 * kept one.
 * Browser.close is a graceful shutdown: it flushes cookies to disk, which a
 * signal can drop (a fresh sign-in vanishes on the next launch).
 */
export async function stopChrome(
  chrome: Chrome,
  closeBrowser?: () => Promise<unknown>
): Promise<void> {
  if (chrome.running() && closeBrowser) {
    await Promise.race([
      closeBrowser().catch(() => {}),
      delay(3000, undefined, { ref: false }),
    ]);
    await Promise.race([chrome.exited, delay(5000, undefined, { ref: false })]);
  }
  if (chrome.running()) {
    chrome.child.kill("SIGTERM");
    await Promise.race([chrome.exited, delay(3000, undefined, { ref: false })]);
    if (chrome.running()) chrome.child.kill("SIGKILL");
    await chrome.exited;
  }
  // A browser killed by a signal orphans its helpers, and a surviving one can
  // recreate the profile after rm. Puppeteer kills the group the same way.
  try {
    if (chrome.child.pid) process.kill(-chrome.child.pid, "SIGKILL");
  } catch {}
  if (!chrome.kept) await rm(chrome.profile, { recursive: true, force: true });
}
