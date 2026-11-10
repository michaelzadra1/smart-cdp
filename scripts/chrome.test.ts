import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Chrome, chromeProfile, stopChrome } from "./chrome";

test("explicit Chrome directories work when Chrome's profile list is unreadable", async () => {
  const unreadable = "/nonexistent/chrome-user-data";
  expect(await chromeProfile("Profile 2", unreadable)).toEqual({
    directory: "Profile 2",
    name: "Profile 2",
  });
  await expect(chromeProfile("Work", unreadable)).rejects.toThrow(
    'Use an explicit directory such as "Profile 2"'
  );
});

test("a profile matches its menu label, its own name or its directory", async () => {
  const userData = await mkdtemp(join(tmpdir(), "smart-cdp-profiles-"));
  try {
    await writeFile(
      join(userData, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Personal", gaia_given_name: "Alex" },
            "Profile 3": { name: "Side Projects" },
          },
        },
      })
    );
    const side = { directory: "Profile 3", name: "Side Projects" };
    for (const wanted of ["side projects", "Side-Projects", "profile 3"])
      expect(await chromeProfile(wanted, userData)).toEqual(side);
    const personal = { directory: "Default", name: "Alex (Personal)" };
    for (const wanted of ["Alex (Personal)", "alex personal", "Personal"])
      expect(await chromeProfile(wanted, userData)).toEqual(personal);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("stopping a crashed browser stops the helpers it orphaned", async () => {
  const profile = await mkdtemp(join(tmpdir(), "smart-cdp-orphan-"));
  // A stand-in browser whose helper keeps writing to the profile, as Chrome's
  // renderer can for a moment after its browser is killed.
  const child = spawn(
    "/bin/sh",
    ["-c", 'while :; do mkdir -p "$0"; sleep 0.02; done & wait', profile],
    { stdio: "ignore", detached: true }
  );
  const chrome: Chrome = {
    child,
    profile,
    kept: false,
    exited: new Promise((resolve) => child.once("exit", resolve)),
    running: () => child.exitCode === null && child.signalCode === null,
  };
  try {
    await delay(100);
    child.kill("SIGKILL");
    await stopChrome(chrome);
    await delay(200);
    expect(
      await access(profile).then(
        () => true,
        () => false
      )
    ).toBe(false);
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
    await rm(profile, { recursive: true, force: true });
  }
});
