import { expect, test } from "bun:test";
import type { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerWebSocket } from "bun";
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
  expect(await exists(profile)).toBe(false);
}

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
    const result = await cli(
      `
      await send("Page.navigate", { url: ${JSON.stringify(hop)} });
      const longWait = await evaluate(() => new Promise(r => setTimeout(r, 3000))).catch(e => e.message);
      await send("Page.navigate", { url: ${JSON.stringify(hop)} });
      const landed = await waitFor(() => document.title === "Landed" && location.pathname);
      const timedOut = await waitFor(() => { throw new Error("boom"); }, { timeoutMs: 300 }).catch(e => e.message);
      return { longWait, landed, timedOut };
    `,
      ["--once"]
    );
    expect(result.status, result.stderr).toBe(0);
    const { longWait, landed, timedOut } = JSON.parse(result.stdout);
    expect(longWait).toMatch(
      /navigated or closed\. The page navigated while evaluate ran/
    );
    expect(landed).toBe("/landed");
    expect(timedOut).toMatch(
      /^waitFor timed out after 300ms on http:.*\/landed; last error: Error: boom$/
    );
    await expectCleaned(result);
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
  const claimed = await cli(
    'await send("Page.navigate", { url: "data:text/html,<title>claimed</title>" }); return 1;',
    []
  );
  expect(claimed.status, claimed.stderr).toBe(0);
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
  send({ id: message.id, result: { result: { type: "object", value } } });
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
    const result = await cli(
      `
      // A probe may name its own helpers after the context's.
      const click = (target, options) => arguments[0].click(target, options);
      await send("Page.navigate", { url: ${JSON.stringify(url)} });
      await waitFor(() => document.readyState === "complete");
      const front = await cdp.Target.createTarget({ url: "about:blank" });
      await cdp.Target.activateTarget({ targetId: front.targetId });
      await waitFor(() => document.visibilityState === "hidden");
      // A hidden tab holds a mouseMoved for about 5 seconds, so a click that
      // waited on one would take that long.
      const started = Date.now();
      await click("#year");
      // The option renders 400ms later and below the fold.
      await click((text) => [...document.querySelectorAll("[role=option]")].find((o) => o.textContent === text), { args: ["2024"] });
      await click("#field");
      const clickMs = Date.now() - started;
      await type("Ab1 .");
      await press("Enter");
      const failures = await Promise.all([
        click("#under", { timeoutMs: 300 }),
        click("#missing", { timeoutMs: 300 }),
        press("F13"),
        waitFor(() => true, { timeout: 5000 }),
        waitFor(() => document.body),
      ].map((p) => p.then(() => "resolved", (e) => e.message)));
      return {
        clickMs,
        failures,
        ...(await evaluate(() => ({ title: document.title, value: field.value, events }))),
      };
    `,
      ["--once", "--timeout-ms", "25000"]
    );
    expect(result.status, result.stderr).toBe(0);
    const { clickMs, failures, title, value, events } = JSON.parse(
      result.stdout
    );
    expect(clickMs).toBeLessThan(3000);
    expect(title).toBe("picked 2024");
    expect(value).toBe("Ab1 .");
    expect(events.filter(([, trusted]: [string, boolean]) => !trusted)).toEqual(
      []
    );
    const on = (id: string) =>
      events
        .filter((event: unknown[]) => event[2] === id && event[0] !== "keydown")
        .map(([type]: string[]) => type);
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
        .filter(([type]: string[]) => type === "keydown")
        .map((event: unknown[]) => event.slice(3))
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

test("clicks only a visible normal-size reCAPTCHA checkbox", async () => {
  const widget = (extra = "") =>
    `<iframe src="https://www.google.com/recaptcha/api2/anchor?k=test" ${extra}
      style="border:0;position:absolute;left:40px;top:60px"></iframe>`;
  const pages: Record<string, string> = {
    "/normal": widget('width="304" height="78"'),
    "/covered": `${widget('width="304" height="78"')}<div style="position:absolute;left:40px;top:60px;width:304px;height:78px"></div>`,
    "/compact": widget('width="164" height="144"'),
  };
  const server = await serve((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `${pages[req.url ?? ""]}<script>addEventListener("message", e => { if (e.data === "painted") window.painted = true; else document.title = e.data; })</script>`
    );
  });
  // Input reaches a cross-origin frame only after it has painted, which a
  // visible challenge already has; clicking right after load can miss it.
  const anchor = Buffer.from(
    "<script>onmousedown = () => parent.postMessage('clicked', '*');" +
      "requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage('painted', '*')))</script>"
  ).toString("base64");
  try {
    const results = await runProbe(
      parseOptions(["--once"]),
      async ({ cdp, send, sessionId, waitFor, clickRecaptchaCheckbox }) => {
        cdp.on("Fetch.requestPaused", ({ requestId }) =>
          cdp.Fetch.fulfillRequest({
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html" }],
            body: anchor,
          })
        );
        await cdp.Fetch.enable({
          patterns: [{ urlPattern: "https://www.google.com/recaptcha/*" }],
        });
        await send("Page.enable");
        const results: Record<string, { clicked: boolean; title: string }> = {};
        for (const path of Object.keys(pages)) {
          const loaded = new Promise((resolve) =>
            (cdp as unknown as EventEmitter).once(
              `Page.loadEventFired.${sessionId}`,
              resolve
            )
          );
          await send("Page.navigate", {
            url: `http://127.0.0.1:${portOf(server)}${path}`,
          });
          await loaded;
          await waitFor(
            () => (window as unknown as { painted?: boolean }).painted
          );
          results[path] = await clickUntilLanded(
            clickRecaptchaCheckbox,
            waitFor
          );
        }
        return results;
      }
    );
    expect(results).toEqual({
      "/normal": { clicked: true, title: "clicked" },
      "/covered": { clicked: false, title: "" },
      "/compact": { clicked: false, title: "" },
    });
  } finally {
    await close(server);
  }
}, 30000);

test("clicks only a visible Cloudflare Turnstile widget", async () => {
  // A real widget box: the hidden response input's parent div, with the
  // challenges.cloudflare.com checkbox iframe inside it. A 300x65 box puts
  // the clickable point at +30px from the left, vertically centered.
  const widget = (inner: string) =>
    `<div style="position:absolute;left:40px;top:60px;width:300px;height:65px">
      <input name="cf-turnstile-response" type="hidden">${inner}</div>`;
  const frames = {
    iframe: `<iframe src="https://challenges.cloudflare.com/turnstile/v0/site/test/none/normal/fbE/new/hidden"
      style="border:0;width:100%;height:100%"></iframe>`,
  };
  const pages: Record<string, string> = {
    // Standard layout: the response input's parent is the widget box.
    "/widget": widget(frames.iframe),
    // A custom wrapper that renders no marker input: only the widget iframe
    // is there to find.
    "/unmarked": `<iframe src="https://challenges.cloudflare.com/turnstile/v0/site/test/none/normal/fbE/new/hidden"
      style="border:0;position:absolute;left:40px;top:60px;width:300px;height:65px"></iframe>`,
    // A foreign overlay over the box must not be clicked through.
    "/covered": `${widget(frames.iframe)}<div style="position:absolute;left:40px;top:60px;width:300px;height:65px"></div>`,
  };
  const server = await serve((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `${pages[req.url ?? ""]}<script>addEventListener("message", e => { if (e.data === "painted") window.painted = true; else document.title = e.data; })</script>`
    );
  });
  const anchor = Buffer.from(
    "<script>onmousedown = () => parent.postMessage('clicked', '*');" +
      "requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage('painted', '*')))</script>"
  ).toString("base64");
  try {
    const results = await runProbe(
      parseOptions(["--once"]),
      async ({ cdp, send, sessionId, waitFor, clickTurnstileCheckbox }) => {
        cdp.on("Fetch.requestPaused", ({ requestId }) =>
          cdp.Fetch.fulfillRequest({
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html" }],
            body: anchor,
          })
        );
        await cdp.Fetch.enable({
          patterns: [{ urlPattern: "https://challenges.cloudflare.com/*" }],
        });
        await send("Page.enable");
        const results: Record<string, { clicked: boolean; title: string }> = {};
        for (const path of Object.keys(pages)) {
          const loaded = new Promise((resolve) =>
            (cdp as unknown as EventEmitter).once(
              `Page.loadEventFired.${sessionId}`,
              resolve
            )
          );
          await send("Page.navigate", {
            url: `http://127.0.0.1:${portOf(server)}${path}`,
          });
          await loaded;
          await waitFor(
            () => (window as unknown as { painted?: boolean }).painted
          );
          results[path] = await clickUntilLanded(
            clickTurnstileCheckbox,
            waitFor
          );
        }
        return results;
      }
    );
    expect(results).toEqual({
      "/widget": { clicked: true, title: "clicked" },
      "/unmarked": { clicked: true, title: "clicked" },
      "/covered": { clicked: false, title: "" },
    });
  } finally {
    await close(server);
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
    const result = await cli(
      `
      const loaded = () => new Promise(resolve => cdp.once(\`Page.loadEventFired.\${sessionId}\`, resolve));
      let page = loaded();
      await send("Page.navigate", { url: ${JSON.stringify(url)} });
      await page;
      const opened = [];
      cdp.on(\`Page.javascriptDialogOpening.\${sessionId}\`, ({ type }) => opened.push(type));
      await click("button");
      page = loaded();
      await send("Page.navigate", { url: ${JSON.stringify(`${url}/next`)} });
      await page;
      return { title: await evaluate(() => document.title), opened };
    `,
      ["--once", "--timeout-ms", "20000"]
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      title: "Next",
      opened: ["beforeunload"],
    });
  } finally {
    server.close();
  }
});
