import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeProfile } from "./chrome";

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
