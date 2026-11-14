import { expect, test } from "bun:test";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerWebSocket } from "bun";
import type { CdpClient } from "./cdp";
import { chromeBinary } from "./chrome";
import {
  activePortEndpoint,
  isAlive as alive,
  parseOptions,
  relayStatePath,
  runProbe,
  sessionStatePath,
  type WaitFor,
  waitForExit,
} from "./probe";

const probe = join(import.meta.dir, "probe.ts");

async function cli(
  code: string,
  args: string[] = [],
  entry = probe,
  prefix: string[] = [],
  env: Record<string, string> = {}
) {
  // A Bun.spawn child without env gets the startup environment.
  const child = Bun.spawn([...prefix, process.execPath, entry, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    stdin: new Blob([code]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, stdout, stderr };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

async function expectCleaned(result: { stderr: string }) {
  const owned = /Owned Chrome pid=(\d+) profile=(.+)/.exec(result.stderr);
  expect(owned, result.stderr).not.toBeNull();
  const [, pid = "", profile = ""] = owned ?? [];
  expect(alive(Number(pid))).toBe(false);
  // A Chrome helper that outlives its browser can recreate the profile.
  const processes = await new Response(
    Bun.spawn(["ps", "-axo", "command="]).stdout
  ).text();
  expect(processes).not.toContain(profile);
  expect(await exists(profile)).toBe(false);
}

const message = (error: Error) => error.message;

const pageLoaded = (cdp: CdpClient, sessionId: string) =>
  new Promise((resolve) =>
    cdp.once(`Page.loadEventFired.${sessionId}`, resolve)
  );

async function serve(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

// A click into a fresh cross-origin frame can miss (see CAPTCHA.md), so
// click until the frame reports the press.
async function clickUntilLanded(
  click: () => Promise<boolean>,
  waitFor: WaitFor
) {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (!(await click())) return { clicked: false, title: "" };
    const title = await waitFor(() => document.title, {
      timeoutMs: 200,
      intervalMs: 50,
    }).catch(() => "");
    if (title || Date.now() >= deadline) return { clicked: true, title };
  }
}

const portOf = (server: Server) => (server.address() as AddressInfo).port;
const close = (server: Server) =>
  new Promise((resolve) => server.close(resolve));

test("validates attachment boundaries and DevToolsActivePort", () => {
  for (const args of [
    ["--port", "9222"],
    ["--target", "unowned"],
    ["--port", "0", "--target", "x"],
    ["--port", "65536", "--target", "x"],
    ["--port", "9222", "--target", "x", "--headless"],
    ["--port", "9222", "--target", "x", "--profile", "/tmp/p"],
    ["--ws-url", "https://example.com", "--target", "x"],
    ["--ws-url", "ws://localhost:9222", "--port", "9222", "--target", "x"],
    ["--timeout-ms", "0"],
    ["--timeout-ms", "1.1"],
    ["--timeout-ms", "Infinity"],
    ["--session", "two words"],
    ["--session", "x", "--port", "9222", "--target", "t"],
    ["--session", "x", "--idle-ms", "-1"],
    ["--once", "--session", "x"],
    ["--once", "--idle-ms", "5000"],
    ["--once", "--port", "9222", "--target", "t"],
    ["--end-session", "x", "--headless"],
    ["--personal", "--once"],
    ["--personal", "--headless"],
    ["--personal", "--profile", "/tmp/p"],
    ["--personal", "--port", "9222", "--target", "t"],
    ["--personal-profile", "Work", "--once"],
    ["--background"],
    ["--app", "Slack", "--personal"],
    ["--app", "Slack", "--once"],
    ["--app", "Slack", "--headless"],
    ["--app", "Slack", "--profile", "/tmp/p"],
    ["--app", "Slack", "--port", "9222", "--target", "t"],
  ])
    expect(() => parseOptions(args)).toThrow();
  expect(parseOptions(["--port", "9222", "--target", "x"]).target).toBe("x");
  for (const ending of ["", "\n", "\r\n"]) {
    expect(
      activePortEndpoint(`12345\n/devtools/browser/abc-123${ending}`)
    ).toBe("ws://127.0.0.1:12345/devtools/browser/abc-123");
  }
  expect(() => activePortEndpoint("0\n/devtools/browser/id")).toThrow();
  expect(() => activePortEndpoint("12345\n/devtools/page/id")).toThrow();
});

test("runs through a global-style symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-cdp-link-test-"));
  try {
    const link = join(directory, "probe.ts");
    await symlink(probe, link);
    const result = await cli("", ["--help"], link);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Usage: bun/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("standalone Chrome extraction, attachment, failures, and cleanup", async () => {
  const server = await serve((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<title>Portable CDP</title><h1>Local fixture</h1>");
  });
  try {
    const url = `http://127.0.0.1:${portOf(server)}`;
    const [success, failure, timeout, stray, lost] = await Promise.all([
      cli(
        `
      await send("Page.enable");
      const loaded = new Promise(resolve => cdp.once(\`Page.loadEventFired.\${sessionId}\`, resolve));
      await send("Page.navigate", { url: ${JSON.stringify(url)} });
      await loaded;
      return await evaluate(suffix => ({ title: document.title, text: document.querySelector("h1").textContent + suffix, webdriver: navigator.webdriver }), "!");
    `,
        ["--once"]
      ),
      cli(
        'return await evaluate(() => { throw new Error("page failure"); });',
        ["--once"]
      ),
      cli("await new Promise(() => {});", ["--once", "--timeout-ms", "2000"]),
      // Like an attach listener awaiting a command on a paused popup: closing
      // Chrome rejects it, which used to crash cleanup and lose the result.
      cli(
        `
      (async () => { await send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }); })();
      Promise.reject(new Error("listener failure"));
      return "kept";
    `,
        ["--once"]
      ),
      cli(
        `
      const { processInfo } = await cdp.SystemInfo.getProcessInfo();
      process.kill(processInfo.find(p => p.type === "browser").id, "SIGKILL");
      await new Promise(() => {});
    `,
        ["--once", "--timeout-ms", "20000"]
      ),
    ]);
    expect(success.status, success.stderr).toBe(0);
    expect(JSON.parse(success.stdout)).toEqual({
      title: "Portable CDP",
      text: "Local fixture!",
      // Port 0 flips this to true and Google sign-in rejects the browser.
      webdriver: false,
    });
    expect(failure.status).toBe(1);
    expect(failure.stderr).toMatch(/page failure/);
    expect(timeout.status).toBe(1);
    expect(timeout.stderr).toMatch(/timed out/);
    expect(stray.status, stray.stderr).toBe(0);
    expect(JSON.parse(stray.stdout)).toBe("kept");
    expect(stray.stderr).toMatch(
      /Unhandled rejection in probe code: listener failure/
    );
    expect(stray.stderr).toMatch(
      /Unanswered CDP commands at shutdown: Runtime\.evaluate \(session \w+\)/
    );
    expect(stray.stderr).not.toMatch(/WebSocket connection closed/);
    expect(lost.status).toBe(1);
    expect(lost.stderr).toMatch(
      /Lost the browser connection .*: Chrome exited with SIGKILL/
    );
    await Promise.all(
      [success, failure, timeout, stray, lost].map(expectCleaned)
    );

    // A signed-in profile must survive relaunch: a signal-only shutdown drops
    // cookies set moments before, so the next launch lands on /login again.
    const profile = await mkdtemp(join(tmpdir(), "smart-cdp-profile-"));
    try {
      const visit = (body: string) =>
        cli(
          `
          await send("Page.enable");
          const loaded = new Promise(resolve => cdp.once(\`Page.loadEventFired.\${sessionId}\`, resolve));
          await send("Page.navigate", { url: ${JSON.stringify(url)} });
          await loaded;
          ${body}
        `,
          ["--once", "--profile", profile]
        );
      const signIn = await visit(
        'return await evaluate(() => { document.cookie = "session=1; max-age=3600"; return true; });'
      );
      expect(signIn.status, signIn.stderr).toBe(0);
      const again = await visit(
        "return await evaluate(() => document.cookie);"
      );
      expect(again.status, again.stderr).toBe(0);
      expect(JSON.parse(again.stdout)).toBe("session=1");
      expect(await exists(profile)).toBe(true);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }

    let relayPid = 0;
    let proxied = "";
    await runProbe(
      parseOptions(["--once"]),
      async ({ cdp, targetId, send }) => {
        // Chrome prompts per upstream WebSocket, so count them through a proxy.
        let upstreams = 0;
        let upstreamClosed: Promise<unknown> = Promise.resolve();
        const browserUrl = cdp.url;
        type Link = {
          browser: WebSocket;
          queued: string[];
          closed: () => void;
        };
        const clients = new Set<ServerWebSocket<Link>>();
        const proxy = Bun.serve<Link>({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (req, bun) =>
            bun.upgrade(req, {
              data: {
                browser: new WebSocket(browserUrl),
                queued: [],
                closed: () => {},
              },
            })
              ? undefined
              : new Response(null, { status: 426 }),
          websocket: {
            open(client) {
              upstreams++;
              clients.add(client);
              upstreamClosed = new Promise<void>((resolve) => {
                client.data.closed = resolve;
              });
              const { browser, queued } = client.data;
              browser.addEventListener("open", () => {
                for (const data of queued) browser.send(data);
              });
              browser.addEventListener("message", (event) =>
                client.send(String(event.data))
              );
              browser.addEventListener("close", () => client.close());
            },
            message(client, data) {
              const { browser, queued } = client.data;
              if (browser.readyState === WebSocket.OPEN)
                browser.send(String(data));
              else queued.push(String(data));
            },
            close(client) {
              clients.delete(client);
              client.data.browser.close();
              client.data.closed();
            },
          },
        });
        proxied = `ws://127.0.0.1:${proxy.port}/devtools/browser/test`;
        const attach = (code: string, target = targetId) =>
          cli(code, [
            "--ws-url",
            proxied,
            "--target",
            target,
            "--timeout-ms",
            "10000",
          ]);
        try {
          const version = await cdp.Browser.getVersion();
          // Browser-level state left behind must not reach the next probe:
          // a leaked Fetch.enable would pause its navigation forever.
          const first = await attach(`
            await cdp.Fetch.enable({ patterns: [{ urlPattern: "*" }] });
            return await evaluate(() => location.href);
          `);
          expect(first.status, first.stderr).toBe(0);
          expect(JSON.parse(first.stdout)).toBe("about:blank");
          relayPid = Number(/Started relay pid=(\d+)/.exec(first.stderr)?.[1]);
          expect(relayPid, first.stderr).toBeGreaterThan(0);
          const second = await attach(`
            await send("Page.enable");
            const loaded = new Promise(resolve => cdp.once(\`Page.loadEventFired.\${sessionId}\`, resolve));
            await send("Page.navigate", { url: ${JSON.stringify(url)} });
            await loaded;
            return await evaluate(() => document.title);
          `);
          expect(second.status, second.stderr).toBe(0);
          expect(JSON.parse(second.stdout)).toBe("Portable CDP");
          expect(second.stderr).toBe("");
          const missing = await attach("return true;", "missing-target");
          expect(missing.status).toBe(1);
          expect(upstreams).toBe(1);
          expect((await cdp.Browser.getVersion()).product).toBe(
            version.product
          );
          const sum = await send("Runtime.evaluate", {
            expression: "1+1",
            returnByValue: true,
          });
          expect(sum.result.value).toBe(2);

          // Stopping the relay must end the browser session and leave no files.
          process.kill(relayPid, "SIGTERM");
          await upstreamClosed;
        } finally {
          for (const client of clients) client.terminate();
          await proxy.stop(true);
        }
      }
    );
    expect(await waitForExit(relayPid, 1000)).toBe(true);
    expect(await exists(relayStatePath(proxied))).toBe(false);
  } finally {
    await close(server);
  }
}, 60000);

test("waitFor survives a page that replaces itself after load", async () => {
  // Redirects and bot-check reloads replace the document after load.
  const server = await serve((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      req.url === "/hop"
        ? '<title>Checking</title><script>onload = () => setTimeout(() => location.replace("/landed"), 300)</script>'
        : "<title>Landed</title>"
    );
  });
  try {
    const hop = `http://127.0.0.1:${portOf(server)}/hop`;
    const { longWait, landed, timedOut } = await runProbe(
      parseOptions(["--once"]),
      async ({ send, evaluate, waitFor }) => {
        await send("Page.navigate", { url: hop });
        const longWait = await evaluate(
          () => new Promise((resolve) => setTimeout(resolve, 3000))
        ).catch(message);
        await send("Page.navigate", { url: hop });
        const landed = await waitFor(
          () => document.title === "Landed" && location.pathname
        );
        const timedOut = await waitFor(
          () => {
            throw new Error("boom");
          },
          { timeoutMs: 300 }
        ).catch(message);
        return { longWait, landed, timedOut };
      }
    );
    expect(longWait).toMatch(
      /navigated or closed\. The page navigated while evaluate ran/
    );
    expect(landed).toBe("/landed");
    expect(timedOut).toMatch(
      /^waitFor timed out after 300ms on http:.*\/landed; last error: Error: boom$/
    );
  } finally {
    await close(server);
  }
}, 30000);

test("waitFor answers a DOM change as it happens and polls what no event announces", async () => {
  const server = await serve((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<title>Watch</title><script>
        setTimeout(() => { document.body.dataset.at = performance.now(); document.body.append(Object.assign(document.createElement("p"), { id: "late" })); }, 400);
        setTimeout(() => { window.ready = true; }, 300);
      </script>`
    );
  });
  try {
    const result = await runProbe(
      parseOptions(["--once"]),
      async ({ cdp, send, sessionId, evaluate, waitFor }) => {
        const page = pageLoaded(cdp, sessionId);
        await send("Page.navigate", {
          url: `http://127.0.0.1:${portOf(server)}`,
        });
        await page;
        const globals = await evaluate(
          () => Object.getOwnPropertyNames(window).length
        );
        // A 5-second poll: only the page's own report can answer within it.
        await waitFor(() => Boolean(document.getElementById("late")), {
          intervalMs: 5000,
        });
        const lag = await evaluate(
          () => performance.now() - Number(document.body.dataset.at)
        );
        // Script state changes no DOM: the poll answers it.
        const ready = await waitFor(() => Reflect.get(window, "ready"), {
          intervalMs: 100,
        });
        const after = await evaluate(
          () => Object.getOwnPropertyNames(window).length
        );
        // With scripts off the page reports nothing, and the poll still answers.
        await send("Emulation.setScriptExecutionDisabled", { value: true });
        const off = await waitFor(() => document.title, { timeoutMs: 2000 });
        const offTimeout = await waitFor(
          () => document.getElementById("never"),
          {
            timeoutMs: 300,
          }
        ).catch(message);
        return { lag, ready, newGlobals: after - globals - 1, off, offTimeout };
      }
    );
    // Well under the 5-second poll, with room for a loaded CPU.
    expect(result.lag).toBeLessThan(1000);
    expect(result.ready).toBe(true);
    expect(result.newGlobals).toBe(0);
    expect(result.off).toBe("Watch");
    expect(result.offTimeout).toMatch(/^waitFor timed out after 300ms/);
  } finally {
    await close(server);
  }
}, 30000);

test("explains a sandbox that blocks loopback sockets", async () => {
  const { status, stderr } = await cli("return 1;", [], probe, [
    "sandbox-exec",
    "-p",
    "(version 1)(allow default)(deny network*)",
  ]);
  expect(status).toBe(1);
  expect(stderr).toMatch(
    /EPERM.*a sandbox blocked the loopback socket.*network or escalated permission/
  );
}, 30000);

test("a probe claims a browser by default and keeps it until released", async () => {
  // The probe declares a name the context also has: stdin code may.
  const claimed = await cli(
    'const click = "mine"; await send("Page.navigate", { url: "data:text/html,<title>claimed</title>" }); return click;',
    []
  );
  expect(claimed.status, claimed.stderr).toBe(0);
  expect(JSON.parse(claimed.stdout)).toBe("mine");
  const [, id, chromePid] =
    /Claimed browser (b-[0-9a-f]{6}): Chrome pid=(\d+)/.exec(claimed.stderr) ??
    [];
  expect(id, claimed.stderr).toBeDefined();
  expect(claimed.stderr).toMatch(
    new RegExp(
      `Continue with --session ${id}; release it with --end-session ${id}`
    )
  );
  try {
    expect(alive(Number(chromePid))).toBe(true);
    const next = await cli("return await evaluate(() => document.title);", [
      "--session",
      id ?? "",
    ]);
    expect(next.status, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toBe("claimed");
  } finally {
    const released = await cli("", ["--end-session", id ?? ""]);
    expect(released.stderr).toMatch(
      new RegExp(`Released browser ${id}: closed Chrome pid=${chromePid}`)
    );
  }
  expect(alive(Number(chromePid))).toBe(false);
}, 30000);

// Stands in for Chrome and the extension in ../extension: CHROME_BIN starts
// it on the URL the host opens, and it speaks the extension's side of the
// handshake and relay, answering every CDP command itself.
const fakeExtension = `
const url = process.argv.at(-1);
const [, port, id] = /127\\.0\\.0\\.1:(\\d+)\\/smart-cdp\\/([0-9a-f-]{36})$/.exec(url);
const { secret } = await Bun.file(${JSON.stringify(join(import.meta.dir, "../extension/secret.json"))}).json();
const { createHmac } = await import("node:crypto");
const socket = new WebSocket("ws://127.0.0.1:" + port + "/smart-cdp/" + id + "/extension");
const send = (message) => socket.send(JSON.stringify(message));
const ready = () => send({ type: "ready", targetId: "TAB" });
let resets = 0;
socket.onopen = () => send({ type: "hello", challenge: "c" });
socket.onclose = () => process.exit(0);
socket.onmessage = async ({ data }) => {
  const message = JSON.parse(data);
  if (message.type === "proof") {
    await Bun.write(process.env.FAKE_BACKGROUND, String(message.background));
    const expected = createHmac("sha256", secret).update("c:" + id).digest("hex");
    return message.proof === expected ? ready() : socket.close();
  }
  if (message.type === "reset") return resets++, ready();
  if (message.type === "close") {
    await Bun.write(process.env.FAKE_TAB_CLOSED, "closed");
    return socket.close();
  }
  if (message.method === "Page.enable")
    setTimeout(() => send({ method: "Page.loadEventFired", params: {} }), 50);
  // chrome.debugger refuses the Target domain on a tab, as the real host reports.
  if (message.method?.startsWith("Target."))
    return send({ id: message.id, error: { code: -32000, message: "Not allowed" } });
  const expression = message.params?.expression ?? "";
  const value = expression.includes("location.href")
    ? "https://tab.test/page"
    : expression.includes("NOT_YET")
      ? null
      : { sessionId: message.sessionId ?? null, resets };
  // The page's returnByValueInPage wraps every value.
  send({ id: message.id, result: { result: { type: "object", value: { value } } } });
};
`;

test("a personal session drives one extension tab until released", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-cdp-personal-test-"));
  const chromeBin = join(directory, "chrome");
  const closed = join(directory, "closed");
  const opened = join(directory, "opened");
  await writeFile(join(directory, "extension.ts"), fakeExtension);
  await writeFile(
    chromeBin,
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${opened}"\n"${process.execPath}" "${join(directory, "extension.ts")}" "$@" &\n`
  );
  await chmod(chromeBin, 0o755);
  // Chrome's profile list, where chromeProfile looks for it, under a stub HOME.
  const userData = join(directory, "Library/Application Support/Google/Chrome");
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Personal", gaia_given_name: "Alex" },
          "Profile 8": { name: "Work", gaia_given_name: "Alex" },
        },
      },
    })
  );
  const env = {
    CHROME_BIN: chromeBin,
    FAKE_TAB_CLOSED: closed,
    FAKE_BACKGROUND: join(directory, "background"),
    HOME: directory,
  };
  const background = () => readFile(env.FAKE_BACKGROUND, "utf8");
  const openedWith = async () =>
    (await readFile(opened, "utf8")).split("\n")[0];
  const unknown = await cli(
    "return 1;",
    ["--personal-profile", "Travel"],
    probe,
    [],
    env
  );
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toMatch(
    /no profile named "Travel"\. Its profiles: "Alex \(Personal\)" \(Default\), "Alex \(Work\)" \(Profile 8\)/
  );
  let id: string | undefined;
  try {
    const claimed = await cli(
      `const loaded = new Promise((resolve) =>
         cdp.once("Page.loadEventFired." + sessionId, () => resolve(true)));
       await send("Page.enable");
       return { tab: await evaluate(() => 1), loaded: await loaded, targetId, sessionId };`,
      ["--personal-profile", "alex work"],
      probe,
      [],
      env
    );
    expect(claimed.status, claimed.stderr).toBe(0);
    id =
      /Claimed browser (b-[0-9a-f]{6}): a tab in your Chrome's Alex \(Work\) profile/.exec(
        claimed.stderr
      )?.[1];
    expect(id, claimed.stderr).toBeDefined();
    expect(await openedWith()).toBe("--profile-directory=Profile 8");
    expect(await background()).toBe("false");
    // The host strips its root session before the extension sees a command,
    // and tags the tab's events with it on the way back.
    expect(JSON.parse(claimed.stdout)).toEqual({
      tab: { sessionId: null, resets: 0 },
      loaded: true,
      targetId: "TAB",
      sessionId: "smart-cdp-tab",
    });
    const next = await cli(
      "return await evaluate(() => 1);",
      ["--session", id ?? "", "--personal"],
      probe,
      [],
      env
    );
    expect(next.status, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toEqual({ sessionId: null, resets: 1 });
    // The tab has no Target domain to name its URL, so a timeout asks the page.
    const waited = await cli(
      'return await waitFor(() => "NOT_YET" && null, { timeoutMs: 300 }).catch(e => e.message);',
      ["--session", id ?? "", "--personal"],
      probe,
      [],
      env
    );
    expect(waited.status, waited.stderr).toBe(0);
    expect(JSON.parse(waited.stdout)).toBe(
      "waitFor timed out after 300ms on https://tab.test/page"
    );
    const mismatch = await cli("return 1;", ["--session", id ?? ""]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toMatch(/pass --personal to continue/);
    const otherProfile = await cli(
      "return 1;",
      ["--session", id ?? "", "--personal-profile", "Personal"],
      probe,
      [],
      env
    );
    expect(otherProfile.status).toBe(1);
    expect(otherProfile.stderr).toMatch(
      /Alex \(Work\) profile\. To continue in it, leave out --personal-profile/
    );
  } finally {
    const released = await cli("", ["--end-session", id ?? ""]);
    expect(released.stderr).toMatch(/closed its tab in your Chrome/);
  }
  expect(await readFile(closed, "utf8")).toBe("closed");
  // Claimed again by name once its host is gone, the session stays in its
  // profile instead of falling back to Default.
  try {
    const reclaimed = await cli(
      "return 1;",
      ["--session", id ?? "", "--personal", "--background"],
      probe,
      [],
      env
    );
    expect(reclaimed.status, reclaimed.stderr).toBe(0);
    expect(await background()).toBe("true");
    expect(reclaimed.stderr).toMatch(
      /Claimed browser b-[0-9a-f]{6}: a tab in your Chrome's Alex \(Work\) profile/
    );
    expect(await openedWith()).toBe("--profile-directory=Profile 8");
  } finally {
    await cli("", ["--end-session", id ?? ""]);
  }
  await rm(directory, { recursive: true, force: true });
}, 30000);

test("an app session reads a hidden copy of an Electron app until released", async () => {
  const home = await mkdtemp(join(tmpdir(), "smart-cdp-app-test-"));
  const server = await serve((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<title>Fixture App</title><h1>Signed in</h1>");
  });
  // A stand-in Electron app in ~/Applications whose executable is Chrome,
  // headless so that it opens no window: a test must not take the user's
  // focus, and only the hide watcher keeps a real app's window from doing so.
  // It inherits the stub HOME, where macOS finds no keychain and asks the user
  // to reset theirs: the mock keychain keeps Chrome away from the Keychain.
  const bundle = join(home, "Applications/Smart CDP Fixture.app/Contents");
  await mkdir(join(bundle, "Frameworks/Electron Framework.framework"), {
    recursive: true,
  });
  await mkdir(join(bundle, "MacOS"));
  await mkdir(join(home, "Applications/Plain.app/Contents"), {
    recursive: true,
  });
  await writeFile(
    join(bundle, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundleName</key><string>Fixture Data</string>
</dict></plist>`
  );
  await writeFile(
    join(bundle, "MacOS/fixture"),
    `#!/bin/bash\nexec "${await chromeBinary()}" --headless=new --use-mock-keychain --no-first-run --no-default-browser-check "$@" "http://127.0.0.1:${portOf(server)}/"\n`
  );
  await chmod(join(bundle, "MacOS/fixture"), 0o755);
  // The app's profile: signed-in state, a cache and a link to leave behind.
  const data = join(home, "Library/Application Support/Fixture Data");
  await mkdir(join(data, "Cache"), { recursive: true });
  await mkdir(join(data, "state"));
  await writeFile(join(data, "state/session.json"), "signed in");
  await writeFile(join(data, "Cache/entry"), "cached");
  await mkdir(join(data, "Service Worker/CacheStorage"), { recursive: true });
  await mkdir(join(data, "Service Worker/Database"));
  await writeFile(join(data, "Service Worker/CacheStorage/entry"), "cached");
  await writeFile(join(data, "Service Worker/Database/entry"), "registered");
  await symlink("host-1234", join(data, "fixture-link"));
  const env = { HOME: home };
  const run = (code: string, args: string[]) => cli(code, args, probe, [], env);
  let id: string | undefined;
  try {
    const [unknown, plain] = await Promise.all([
      run("return 1;", ["--app", "No Such App"]),
      run("return 1;", ["--app", "plain"]),
    ]);
    expect(unknown.stderr).toMatch(
      /No app named "No Such App" in \/Applications or .+\. Electron apps installed: .*Smart CDP Fixture/
    );
    expect(plain.stderr).toMatch(/Plain is not an Electron app/);
    const claimed = await run(
      `const attempt = (fn) => fn().then(() => "allowed", (e) => e.message);
       return {
         title: await waitFor(() => document.title),
         press: await attempt(() => press("Enter")),
         navigate: await attempt(() => send("Page.navigate", { url: "about:blank" })),
         screenshot: (await send("Page.captureScreenshot")).data.length > 0,
       };`,
      ["--app", "smart cdp fixture"]
    );
    expect(claimed.status, claimed.stderr).toBe(0);
    const [, name, pid, copy = ""] =
      /Claimed browser (b-[0-9a-f]{6}): a hidden, read-only copy of Smart CDP Fixture pid=(\d+) profile=(\S+)\. /.exec(
        claimed.stderr
      ) ?? [];
    id = name;
    expect(id, claimed.stderr).toBeDefined();
    expect(JSON.parse(claimed.stdout)).toEqual({
      title: "Fixture App",
      press: "Input.dispatchKeyEvent is refused: this session is read-only",
      navigate: "Page.navigate is refused: this session is read-only",
      screenshot: true,
    });
    expect(await readFile(join(copy, "state/session.json"), "utf8")).toBe(
      "signed in"
    );
    expect(await exists(join(copy, "Cache/entry"))).toBe(false);
    expect(
      await readFile(join(copy, "Service Worker/Database/entry"), "utf8")
    ).toBe("registered");
    expect(await exists(join(copy, "Service Worker/CacheStorage/entry"))).toBe(
      false
    );
    expect(await exists(join(copy, "fixture-link"))).toBe(false);
    const [next, withoutApp] = await Promise.all([
      run("return await evaluate(() => location.pathname);", [
        "--session",
        id ?? "",
        "--app",
        "Smart CDP Fixture",
      ]),
      run("return 1;", ["--session", id ?? ""]),
    ]);
    expect(next.status, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toBe("/");
    expect(withoutApp.stderr).toMatch(
      /is a read-only copy of Smart CDP Fixture: pass --app "Smart CDP Fixture" to continue in it/
    );
    const released = await run("", ["--end-session", id ?? ""]);
    id = undefined;
    expect(released.stderr).toMatch(
      new RegExp(
        `quit the copy of Smart CDP Fixture pid=${pid} and removed ${copy}`
      )
    );
    expect(alive(Number(pid))).toBe(false);
    expect(await exists(copy)).toBe(false);
    // The app's own profile is never changed.
    expect(await exists(join(data, "Cache/entry"))).toBe(true);
  } finally {
    if (id) await run("", ["--end-session", id]);
    await close(server);
    await rm(home, { recursive: true, force: true });
  }
}, 60000);

test("a session keeps Chrome and its tab across probes until ended", async () => {
  const server = await serve((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<title>${req.url}</title>`);
  });
  const name = `test-${process.pid}`;
  const inSession = ["--session", name];
  try {
    const url = `http://127.0.0.1:${portOf(server)}/kept`;
    const first = await cli(
      `await send("Page.navigate", { url: ${JSON.stringify(url)} });
       return await waitFor(() => document.title === "/kept" && (window.marker = 1));`,
      inSession
    );
    expect(first.status, first.stderr).toBe(0);
    const started = /Claimed browser .*Chrome pid=(\d+) profile=(\S+)\./.exec(
      first.stderr
    );
    expect(started, first.stderr).not.toBeNull();
    const chromePid = Number(started?.[1]);
    const profile = started?.[2] ?? "";

    // A probe that throws ends itself, not the browser or the page.
    const failed = await cli(
      'await evaluate(() => { window.marker = 2; }); throw new Error("probe bug");',
      inSession
    );
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/probe bug/);

    // One tab, one driver: a second probe waits its turn instead of racing.
    const holder = cli(
      "await new Promise(r => setTimeout(r, 1500)); return 1;",
      inSession
    );
    await delay(500);
    const refused = await cli("return 1;", inSession);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/is busy: another probe is running in it/);
    expect((await holder).status).toBe(0);

    const later = await cli(
      `const { processInfo } = await cdp.SystemInfo.getProcessInfo();
       return { browser: processInfo.find(p => p.type === "browser").id,
         page: await evaluate(() => [location.pathname, window.marker]) };`,
      inSession
    );
    expect(later.status, later.stderr).toBe(0);
    expect(JSON.parse(later.stdout)).toEqual({
      browser: chromePid,
      page: ["/kept", 2],
    });

    // Adding --headless asks for another browser; the refusal says how to continue.
    const headless = await cli("return 1;", ["--session", name, "--headless"]);
    expect(headless.status).toBe(1);
    expect(headless.stderr).toMatch(
      /runs visible Chrome .*To continue in it, leave out --headless/
    );

    const ended = await cli("", ["--end-session", name]);
    expect(ended.status, ended.stderr).toBe(0);
    expect(ended.stderr).toMatch(
      new RegExp(
        `Released browser ${name}: closed Chrome pid=${chromePid} and removed`
      )
    );
    expect(alive(chromePid)).toBe(false);
    expect(await exists(profile)).toBe(false);
    expect(await exists(sessionStatePath(name))).toBe(false);
    expect((await cli("", ["--end-session", name])).stderr).toMatch(
      /No claimed browser/
    );

    // A host killed outright leaves Chrome running; the next probe proves it is
    // the session's own launch before closing it.
    const orphaned = await cli("return 1;", inSession);
    const orphan = JSON.parse(await readFile(sessionStatePath(name), "utf8"));
    process.kill(orphan.pid, "SIGKILL");
    await waitForExit(orphan.pid, 5000);
    expect(alive(orphan.chromePid), orphaned.stderr).toBe(true);
    const recovered = await cli("return 1;", inSession);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stderr).toMatch(
      new RegExp(`Closed Chrome pid=${orphan.chromePid} left running`)
    );
    expect(alive(orphan.chromePid)).toBe(false);
    expect(await exists(orphan.profile)).toBe(false);
    // --end-session does the same for a host that died.
    const second = JSON.parse(await readFile(sessionStatePath(name), "utf8"));
    process.kill(second.pid, "SIGKILL");
    await waitForExit(second.pid, 5000);
    const endedOrphan = await cli("", ["--end-session", name]);
    expect(endedOrphan.status, endedOrphan.stderr).toBe(0);
    expect(endedOrphan.stderr).toMatch(
      new RegExp(`Closed Chrome pid=${second.chromePid} left running`)
    );
    expect(alive(second.chromePid)).toBe(false);
    expect(await exists(sessionStatePath(name))).toBe(false);

    // Forgotten sessions close themselves.
    const idle = await cli("return 1;", [...inSession, "--idle-ms", "500"]);
    expect(idle.status, idle.stderr).toBe(0);
    const idlePid = Number(/Chrome pid=(\d+)/.exec(idle.stderr)?.[1]);
    // The host removes its state file last, after Chrome and its profile.
    for (let i = 0; i < 100 && (await exists(sessionStatePath(name))); i++)
      await delay(100);
    expect(await exists(sessionStatePath(name))).toBe(false);
    expect(alive(idlePid)).toBe(false);
  } finally {
    await cli("", ["--end-session", name]);
    await close(server);
  }
}, 60000);

test("click, type and press send trusted input, in a hidden tab too", async () => {
  // Sites such as payroll apps sign the user out on untrusted (page-script)
  // events, so the page records every event's isTrusted.
  const server = await serve((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<button id="year" style="position:absolute;left:40px;top:40px">Year</button>
      <input id="field" style="position:absolute;left:40px;top:100px">
      <button id="under" style="position:absolute;left:40px;top:160px">Under</button>
      <div id="overlay" style="position:absolute;left:30px;top:150px;width:200px;height:50px"></div>
      <script>
        window.events = [];
        for (const type of ["mousemove", "pointerdown", "mousedown", "mouseup", "click", "keydown", "input"])
          addEventListener(type, (e) => events.push([type, e.isTrusted, e.target.id, e.key ?? null, e.keyCode ?? null, e.shiftKey ?? null]), true);
        year.onclick = () => setTimeout(() => {
          const option = document.createElement("div");
          option.role = "option";
          option.textContent = "2024";
          option.style = "position:absolute;left:40px;top:2000px;width:80px;height:20px";
          option.onclick = () => (document.title = "picked " + option.textContent);
          document.body.append(option);
        }, 400);
      </script>`);
  });
  try {
    const url = `http://127.0.0.1:${portOf(server)}`;
    const { clickMs, failures, title, value, events } = await runProbe(
      parseOptions(["--once"]),
      async ({
        cdp,
        send,
        targetId,
        evaluate,
        waitFor,
        click,
        type,
        press,
      }) => {
        await send("Page.navigate", { url });
        await waitFor(() => document.readyState === "complete");
        // Hide the tab without taking focus (SKILL.md, Boundaries).
        const { windowId } = await cdp.Browser.getWindowForTarget({
          targetId,
        });
        await cdp.Browser.setWindowBounds({
          windowId,
          bounds: { windowState: "minimized" },
        });
        await waitFor(() => document.visibilityState === "hidden", {
          intervalMs: 50,
        });
        // A hidden tab holds a mouseMoved for at least 5 seconds, so a click
        // that waited on one would take that long, however loaded the machine.
        const started = Date.now();
        await click("#year", { timeoutMs: 10000 });
        const clickMs = Date.now() - started;
        // The option renders 400ms later and below the fold.
        await click(
          (text: string) =>
            [...document.querySelectorAll("[role=option]")].find(
              (option) => option.textContent === text
            ),
          { args: ["2024"], timeoutMs: 10000 }
        );
        await click("#field", { timeoutMs: 10000 });
        await type("Ab1 .");
        await press("Enter");
        const failures = await Promise.all(
          [
            click("#under", { timeoutMs: 300 }),
            click("#missing", { timeoutMs: 300 }),
            press("F13"),
            // @ts-expect-error stdin probes are not type-checked
            waitFor(() => true, { timeout: 5000 }),
            waitFor(() => document.body),
          ].map((done) => done.then(() => "resolved", message))
        );
        const page = await evaluate(() => ({
          title: document.title,
          value: document.querySelector<HTMLInputElement>("#field")?.value,
          events: (window as unknown as { events: unknown[][] }).events,
        }));
        return { clickMs, failures, ...page };
      }
    );
    expect(clickMs).toBeLessThan(4000);
    expect(title).toBe("picked 2024");
    expect(value).toBe("Ab1 .");
    expect(events.filter(([, trusted]) => !trusted)).toEqual([]);
    const on = (id: string) =>
      events
        .filter((event) => event[2] === id && event[0] !== "keydown")
        .map(([type]) => type);
    // The move a hidden tab holds still arrives, before the press.
    expect(on("year")).toEqual([
      "mousemove",
      "pointerdown",
      "mousedown",
      "mouseup",
      "click",
    ]);
    expect(
      events
        .filter(([type]) => type === "keydown")
        .map((event) => event.slice(3))
    ).toEqual([
      ["A", 65, true],
      ["b", 66, false],
      ["1", 49, false],
      [" ", 32, false],
      ["Enter", 13, false],
    ]);
    expect(failures[0]).toMatch(
      /^click timed out after 300ms on http:.*: #under is covered by <div#overlay>$/
    );
    expect(failures[1]).toMatch(/: #missing matched no element$/);
    expect(failures[2]).toMatch(/^press: unknown key "F13"; use a letter/);
    expect(failures[3]).toBe(
      "waitFor: unknown option timeout; it takes args, timeoutMs, intervalMs"
    );
    expect(failures[4]).toMatch(/^The page function returned a DOM element/);
  } finally {
    await close(server);
  }
}, 30000);

test("clicks only a visible, uncovered reCAPTCHA or Turnstile checkbox", async () => {
  const recaptcha = (size: string) =>
    `<iframe src="https://www.google.com/recaptcha/api2/anchor?k=test" ${size}
      style="border:0;position:absolute;left:40px;top:60px"></iframe>`;
  const turnstileFrame = (style: string) =>
    `<iframe src="https://challenges.cloudflare.com/turnstile/v0/site/test/none/normal/fbE/new/hidden"
      style="border:0;${style}"></iframe>`;
  // A real Turnstile box: the hidden response input's parent div, with the
  // checkbox iframe inside it. A 300x65 box puts the clickable point 30px
  // from the left, vertically centered.
  const turnstile = `<div style="position:absolute;left:40px;top:60px;width:300px;height:65px">
      <input name="cf-turnstile-response" type="hidden">${turnstileFrame("width:100%;height:100%")}</div>`;
  const cover = (width: number, height: number) =>
    `<div style="position:absolute;left:40px;top:60px;width:${width}px;height:${height}px"></div>`;
  const pages: Record<string, string> = {
    "/recaptcha/normal": recaptcha('width="304" height="78"'),
    "/recaptcha/covered": recaptcha('width="304" height="78"') + cover(304, 78),
    "/recaptcha/compact": recaptcha('width="164" height="144"'),
    // Standard layout: the response input's parent is the widget box.
    "/turnstile/widget": turnstile,
    // A custom wrapper that renders no marker input: only the iframe is
    // there to find.
    "/turnstile/unmarked": turnstileFrame(
      "position:absolute;left:40px;top:60px;width:300px;height:65px"
    ),
    // A foreign overlay over the box must not be clicked through.
    "/turnstile/covered": turnstile + cover(300, 65),
  };
  const server = await serve((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `${pages[req.url ?? ""]}<script>addEventListener("message", e => { if (e.data === "painted") window.painted = true; else document.title = e.data; })</script>`
    );
  });
  // Stands in for both challenge frames: it reports a press and its first
  // paint to the page.
  const anchor = Buffer.from(
    "<script>onmousedown = () => parent.postMessage('clicked', '*');" +
      "requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage('painted', '*')))</script>"
  ).toString("base64");
  try {
    const results = await runProbe(
      parseOptions(["--once"]),
      async ({
        cdp,
        send,
        sessionId,
        waitFor,
        clickRecaptchaCheckbox,
        clickTurnstileCheckbox,
      }) => {
        cdp.on("Fetch.requestPaused", ({ requestId }) =>
          cdp.Fetch.fulfillRequest({
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html" }],
            body: anchor,
          })
        );
        await cdp.Fetch.enable({
          patterns: [
            { urlPattern: "https://www.google.com/recaptcha/*" },
            { urlPattern: "https://challenges.cloudflare.com/*" },
          ],
        });
        await send("Page.enable");
        const results: Record<string, { clicked: boolean; title: string }> = {};
        for (const path of Object.keys(pages)) {
          const loaded = pageLoaded(cdp, sessionId);
          await send("Page.navigate", {
            url: `http://127.0.0.1:${portOf(server)}${path}`,
          });
          await loaded;
          await waitFor(
            () => (window as unknown as { painted?: boolean }).painted,
            { intervalMs: 50 }
          );
          results[path] = await clickUntilLanded(
            path.startsWith("/recaptcha/")
              ? clickRecaptchaCheckbox
              : clickTurnstileCheckbox,
            waitFor
          );
        }
        return results;
      }
    );
    expect(results).toEqual({
      "/recaptcha/normal": { clicked: true, title: "clicked" },
      "/recaptcha/covered": { clicked: false, title: "" },
      "/recaptcha/compact": { clicked: false, title: "" },
      "/turnstile/widget": { clicked: true, title: "clicked" },
      "/turnstile/unmarked": { clicked: true, title: "clicked" },
      "/turnstile/covered": { clicked: false, title: "" },
    });
  } finally {
    await close(server);
  }
}, 30000);

test("holds a HUMAN Press & Hold button until the challenge completes", async () => {
  // The live challenge frame, as PX serves it: a wide role=button whose hold
  // timer draws the checkmark and announces completion; release after that
  // clears the challenge. Mouse events and the press timing go to the page.
  const frame = `<body style="margin:1px">
    <div role="button" aria-label="Press &amp; Hold Human Challenge" id="hold"
      style="width:260px;height:100px;border:2px solid">Press &amp; Hold
      <div id="checkmark"></div><span aria-live="assertive" id="live"></span></div>
    <script>
      const hold = document.getElementById("hold");
      let timer = 0, done = false;
      hold.addEventListener("mousedown", (e) => {
        parent.postMessage(["mousedown", e.isTrusted], "*");
        timer = setTimeout(() => {
          done = true;
          document.getElementById("checkmark").className = "draw";
          document.getElementById("live").textContent = "Human Challenge completed, please wait";
        }, 1500);
      });
      hold.addEventListener("mouseup", (e) => {
        parent.postMessage(["mouseup", e.isTrusted], "*");
        clearTimeout(timer);
        if (done) parent.postMessage(["cleared", true], "*");
      });
      addEventListener("mousemove", (e) => parent.postMessage(["mousemove", e.isTrusted], "*"));
    </script></body>`;
  const challenge = (visible: boolean) =>
    `<iframe title="Human verification challenge" src="/px-frame"
      style="${visible ? "" : "display:none;"}width:100%;height:102px;border:0"></iframe>`;
  // As on walmart.ca: the challenge sits in a shadow root, below the fold,
  // next to display:none decoys of itself.
  const page = (frames: string) => `
    <body><div style="height:3000px"></div><div id="px-captcha"></div>
    <script>
      const host = document.getElementById("px-captcha");
      host.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(frames)};
      window.events = [];
      addEventListener("message", (e) => {
        if (!Array.isArray(e.data)) return;
        window.events.push(e.data);
        if (e.data[0] === "cleared") { host.remove(); document.title = "cleared"; }
      });
    </script></body>`;
  const server = await serve((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      req.url === "/px-frame"
        ? frame
        : req.url === "/challenge"
          ? page(challenge(false) + challenge(false) + challenge(true))
          : page(challenge(false) + challenge(false))
    );
  });
  try {
    const result = await runProbe(
      parseOptions(["--once"]),
      async ({ cdp, send, sessionId, evaluate, holdPressAndHoldButton }) => {
        const base = `http://127.0.0.1:${portOf(server)}`;
        await send("Page.enable");
        let loaded = pageLoaded(cdp, sessionId);
        await send("Page.navigate", { url: `${base}/challenge` });
        await loaded;
        const held = await holdPressAndHoldButton();
        const events = await evaluate(
          () => (window as unknown as { events: [string, boolean][] }).events
        );
        const title = await evaluate(() => document.title);
        loaded = pageLoaded(cdp, sessionId);
        await send("Page.navigate", { url: `${base}/decoys-only` });
        await loaded;
        const decoys = await holdPressAndHoldButton();
        return { held, events, title, decoys };
      }
    );
    expect(typeof result.held).toBe("object");
    const held = result.held as {
      heldMs: number;
      completed: boolean;
      cleared: boolean;
    };
    // Held until the frame's 1.5s timer was seen at the next poll, then
    // released well before the 12s cap.
    expect(held.heldMs).toBeGreaterThanOrEqual(1400);
    expect(held.heldMs).toBeLessThan(8000);
    expect(held.completed).toBe(true);
    expect(held.cleared).toBe(true);
    expect(result.title).toBe("cleared");
    const types = result.events.map(([type]) => type);
    expect(result.events.filter(([, trusted]) => !trusted)).toEqual([]);
    expect(types).toContain("mousedown");
    expect(types).toContain("mouseup");
    // The approach and the in-hold tremble both move the mouse.
    expect(types.filter((t) => t === "mousemove").length).toBeGreaterThan(2);
    expect(result.decoys).toBe(false);
  } finally {
    await close(server);
  }
}, 30000);

test("a launched Chrome downloads into its profile and closes mid-download at once", async () => {
  // A file still downloading when the probe ends, as a receipt link or an
  // export button leaves behind.
  const server = await serve((req, res) => {
    if (req.url !== "/file") return res.end("<title>Home</title>");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="smart-cdp-slow.pdf"'
    );
    const timer = setInterval(() => res.write(Buffer.alloc(1000)), 200);
    res.on("close", () => clearInterval(timer));
  });
  const profile = await mkdtemp(join(tmpdir(), "smart-cdp-downloads-"));
  const userDownloads = join(homedir(), "Downloads");
  const before = new Set(await readdir(userDownloads).catch(() => []));
  try {
    let ended = 0;
    const saved = await runProbe(
      parseOptions(["--once", "--profile", profile]),
      async ({ cdp, send }) => {
        const receiving = new Promise((resolve) =>
          cdp.on("Browser.downloadProgress", ({ receivedBytes }) => {
            if (receivedBytes > 0) resolve(receivedBytes);
          })
        );
        await send("Page.navigate", {
          url: `http://127.0.0.1:${portOf(server)}/file`,
        }).catch(() => {});
        await receiving;
        const files = await readdir(join(profile, "Downloads"));
        ended = Date.now();
        return files;
      }
    );
    // Without cancelling it first, Browser.close waits on Chrome's
    // "Download is in progress" prompt until the kill, about 8 seconds.
    expect(Date.now() - ended).toBeLessThan(3000);
    expect(saved.some((name) => name.endsWith(".crdownload"))).toBe(true);
    const added = (await readdir(userDownloads).catch(() => [])).filter(
      (name) =>
        !before.has(name) &&
        /smart-cdp-slow|\.crdownload$|^\.com\.google\.Chrome\./.test(name)
    );
    expect(added).toEqual([]);
  } finally {
    await close(server);
    await rm(profile, { recursive: true, force: true });
  }
}, 30000);

test('a "Leave site?" dialog cannot block navigation', async () => {
  const server = await serve((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      req.url === "/next"
        ? "<title>Next</title>"
        : `<title>Guarded</title><button style="position:fixed;inset:0">x</button>
           <script>addEventListener("beforeunload", e => { e.preventDefault(); e.returnValue = ""; });</script>`
    );
  });
  try {
    const url = `http://127.0.0.1:${portOf(server)}`;
    const result = await runProbe(
      parseOptions(["--once"]),
      async ({ cdp, send, sessionId, evaluate, click }) => {
        let page = pageLoaded(cdp, sessionId);
        await send("Page.navigate", { url });
        await page;
        const opened: string[] = [];
        cdp.on(`Page.javascriptDialogOpening.${sessionId}`, ({ type }) =>
          opened.push(type)
        );
        await click("button");
        page = pageLoaded(cdp, sessionId);
        await send("Page.navigate", { url: `${url}/next` });
        await page;
        return { title: await evaluate(() => document.title), opened };
      }
    );
    expect(result).toEqual({ title: "Next", opened: ["beforeunload"] });
  } finally {
    await close(server);
  }
});
