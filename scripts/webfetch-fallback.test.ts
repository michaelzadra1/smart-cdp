import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = join(import.meta.dir, "webfetch-fallback.ts");

async function runHook(input: unknown) {
  const child = Bun.spawn(["bun", hook], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  return stdout;
}

test.each([
  [
    "a thrown error",
    {
      hook_event_name: "PostToolUseFailure",
      error: "Claude Code is unable to fetch from web.archive.org",
      is_interrupt: false,
    },
    "unable to fetch from web.archive.org",
  ],
  [
    "an HTTP error status",
    {
      hook_event_name: "PostToolUse",
      tool_response: { code: 403, codeText: "Forbidden" },
    },
    "HTTP 403 Forbidden",
  ],
])(
  "%s adds guidance that names the event and reason",
  async (_, event, reason) => {
    const { hookSpecificOutput } = JSON.parse(
      await runHook({ ...event, tool_input: { url: "https://x.test/" } })
    );
    expect(hookSpecificOutput.hookEventName).toBe(event.hook_event_name);
    expect(hookSpecificOutput.additionalContext).toContain(reason);
  }
);

test.each([
  [
    "a success",
    { hook_event_name: "PostToolUse", tool_response: { code: 200 } },
  ],
  [
    "a redirect",
    { hook_event_name: "PostToolUse", tool_response: { code: 301 } },
  ],
  [
    "an interrupt",
    { hook_event_name: "PostToolUseFailure", error: "x", is_interrupt: true },
  ],
])("%s adds nothing", async (_, event) => {
  expect(
    await runHook({ ...event, tool_input: { url: "https://x.test/" } })
  ).toBe("");
});

test("the suggested command runs a probe with a hostile URL intact", async () => {
  const url = `https://x.test/a'b"c$(touch BAD)\`touch BAD\``;
  const output = await runHook({
    hook_event_name: "PostToolUse",
    tool_input: { url },
    tool_response: { code: 403, codeText: "Forbidden" },
  });
  const context: string =
    JSON.parse(output).hookSpecificOutput.additionalContext;
  const command = context.slice(context.indexOf("bun "));

  const directory = await mkdtemp(join(tmpdir(), "webfetch-fallback-test-"));
  try {
    const stub = join(directory, "bun");
    await writeFile(
      stub,
      '#!/bin/bash\nprintf "%s\\n" "$@" > args\ncat > probe.js\n'
    );
    await chmod(stub, 0o700);
    const child = Bun.spawn(["/bin/bash", "-c", command], {
      cwd: directory,
      env: { PATH: `${directory}:/usr/bin:/bin` },
    });
    expect(await child.exited).toBe(0);
    expect(await Bun.file(join(directory, "BAD")).exists()).toBe(false);
    expect(await readFile(join(directory, "args"), "utf8")).toBe(
      `${join(import.meta.dir, "probe.ts")}\n--once\n`
    );

    const body = await readFile(join(directory, "probe.js"), "utf8");
    const AsyncFunction = (async () => undefined).constructor as new (
      ...args: string[]
    ) => (...values: unknown[]) => Promise<unknown>;
    const navigated: unknown[] = [];
    await new AsyncFunction("send", "waitFor", body)(
      (_method: string, params: { url: string }) => {
        navigated.push(params.url);
        return {};
      },
      () => undefined
    );
    expect(navigated).toEqual([url]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
