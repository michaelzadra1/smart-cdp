import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Chrome, launchBrowser, normalize } from "./chrome";

// An Electron desktop app, such as Slack, driven over CDP. An app exposes CDP
// only when launched with --remote-debugging-port, and apps now refuse that
// switch on their own profile (Slack: "--remote-debugging-port is not allowed
// against the default profile"), as Chrome 136 does. So a session never
// touches the running app: it copies the app's profile, signed-in state
// included, into a private temporary directory and starts a second instance
// on that copy. Electron's single-instance lock is per profile, so the copy
// runs beside the user's own window, which keeps running untouched.

/** An installed Electron app and the profile it keeps its state in. */
export type ElectronApp = {
  /** The bundle's name, as Finder shows it: "Slack". */
  name: string;
  executable: string;
  /** Electron's userData directory: Application Support/<CFBundleName>. */
  dataDir: string;
};

const isElectron = (bundle: string) =>
  lstat(join(bundle, "Contents/Frameworks/Electron Framework.framework")).then(
    () => true,
    () => false
  );

/**
 * Finds an installed Electron app however the user names it ("Slack",
 * "visual studio code"), in /Applications or ~/Applications, ignoring case
 * and punctuation.
 */
export async function electronApp(wanted: string): Promise<ElectronApp> {
  const folders = ["/Applications", join(homedir(), "Applications")];
  const bundles = (
    await Promise.all(
      folders.map((folder) =>
        readdir(folder).then(
          (names) =>
            names
              .filter((name) => name.endsWith(".app"))
              .map((name) => join(folder, name)),
          () => []
        )
      )
    )
  ).flat();
  const label = (bundle: string) => basename(bundle, ".app");
  const bundle = bundles.find(
    (path) => normalize(label(path)) === normalize(wanted)
  );
  if (!bundle || !(await isElectron(bundle))) {
    const electron = (
      await Promise.all(
        bundles.map(async (path) => ((await isElectron(path)) ? path : []))
      )
    ).flat();
    throw new Error(
      `${bundle ? `${label(bundle)} is not an Electron app` : `No app named "${wanted}" in ${folders.join(" or ")}`}. ` +
        `Electron apps installed: ${electron.map(label).join(", ") || "none"}`
    );
  }
  const plist = join(bundle, "Contents/Info.plist");
  const read = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", plist]);
  if (!read.success) throw new Error(`Cannot read ${plist}`);
  const info = JSON.parse(read.stdout.toString()) as Record<string, string>;
  // Electron's userData is Application Support/<app name>, and packagers
  // write that name, the package's productName, into CFBundleName.
  const dataDir = join(
    homedir(),
    "Library/Application Support",
    info.CFBundleName ?? label(bundle)
  );
  if (!(await lstat(dataDir).catch(() => undefined))?.isDirectory())
    throw new Error(
      `${label(bundle)} keeps no profile at ${dataDir}: open the app and sign in first`
    );
  return {
    name: label(bundle),
    executable: join(bundle, "Contents/MacOS", String(info.CFBundleExecutable)),
    dataDir,
  };
}

// Chromium's caches, rebuilt on demand, and crash and log output: most of a
// profile's size and none of its signed-in state.
const SKIPPED = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "GrShaderCache",
  "ShaderCache",
  "Service Worker/CacheStorage",
  "Service Worker/ScriptCache",
  "Crashpad",
  "logs",
]);

/**
 * Copies an app's profile into `target`, leaving out caches and every entry
 * that is not a plain file or directory. Those include the SingletonLock,
 * SingletonSocket and SingletonCookie links of the running app: copied, they
 * would make the new instance hand its launch to the user's window and quit.
 * Each entry is a native copy; a directory holding a skipped path is copied
 * entry by entry.
 */
async function copyProfile(source: string, target: string, prefix = "") {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (SKIPPED.has(path) || !(entry.isFile() || entry.isDirectory())) return;
      const [from, to] = [join(source, entry.name), join(target, entry.name)];
      if ([...SKIPPED].some((skipped) => skipped.startsWith(`${path}/`)))
        return copyProfile(from, to, path);
      // An entry the running app removed mid-copy is left out.
      await cp(from, to, { recursive: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        }
      );
    })
  );
}

// Keeps the app hidden for as long as it runs. Apps activate their own
// window at launch even when started in the background, and taking the
// user's focus is not allowed (SKILL.md, Boundaries); hiding an app gives
// focus back to the app the user was in. NSRunningApplication needs no
// Accessibility permission. The watcher exits when the app does, or after
// 30 seconds if no app with that PID ever registers.
const HIDE_WHILE_RUNNING = `
ObjC.import("AppKit");
function run([pid]) {
  const loop = $.NSRunLoop.currentRunLoop;
  let seen = false;
  for (let waited = 0; seen || waited < 30; waited += 0.1) {
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pid));
    if (app.isNil() || app.terminated) {
      if (seen) return;
    } else {
      seen = true;
      if (!app.hidden) app.hide;
    }
    loop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  }
}`;

function keepHidden(pid: number) {
  spawn(
    "osascript",
    ["-l", "JavaScript", "-e", HIDE_WHILE_RUNNING, String(pid)],
    { stdio: "ignore", detached: true }
  ).unref();
}

/**
 * Starts a hidden second instance of the app on a fresh copy of its profile,
 * with CDP on loopback. stopChrome closes it and removes the copy.
 */
export async function launchApp(app: ElectronApp): Promise<Chrome> {
  const profile = await mkdtemp(join(tmpdir(), "smart-cdp-app-"));
  try {
    await copyProfile(app.dataDir, profile);
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
  return launchBrowser({
    name: app.name,
    binary: app.executable,
    profile,
    onSpawn: keepHidden,
  });
}
