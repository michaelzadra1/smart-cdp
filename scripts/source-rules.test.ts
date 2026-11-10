import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Rules for the code in scripts/ that a scan can check; AGENTS.md states them.
const sources = await Promise.all(
  (await readdir(import.meta.dir))
    .filter((file) => file.endsWith(".ts") && file !== "source-rules.test.ts")
    .map(async (file) => ({
      file,
      source: await readFile(join(import.meta.dir, file), "utf8"),
    }))
);

// Every program that ships to Chrome's renderer as toString() output: each
// `*InPage` export. Found by scanning exports, so a new one cannot skip the
// guard, and imported only from modules that have one, since some modules
// run as scripts. A free variable in a program compiles here and fails only
// when the page calls it, so the real-Chrome tests call each of them too.
const transpiler = new Bun.Transpiler({ loader: "ts" });
const inPagePrograms = (
  await Promise.all(
    sources
      .filter(({ file }) => !file.includes(".test."))
      .map(async ({ file, source }) => {
        const names = transpiler
          .scan(source)
          .exports.filter((name) => name.endsWith("InPage"));
        if (!names.length) return [];
        const module = await import(join(import.meta.dir, file));
        return names.map(
          (name) =>
            [name, module[name] as (...args: never[]) => unknown] as const
        );
      })
  )
).flat();

// SCREAMING_SNAKE names the source uses but never declares: a module-scope
// constant, the one self-containment slip that type checking cannot see,
// because the page has no such binding. Comments are stripped first.
function freeModuleConstants(source: string) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[\s;{)])\/\/[^\n]*/gm, "$1");
  const NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";
  const declared = new Set(
    [
      ...code.matchAll(
        new RegExp(`(?:const|let|var|function)\\s+(${NAME})\\b`, "g")
      ),
    ].map((match) => match[1])
  );
  const used = [
    ...code.matchAll(new RegExp(`(?<![.\\w$"'])${NAME}\\b`, "g")),
  ].map((match) => match[0]);
  return [...new Set(used.filter((name) => !declared.has(name)))];
}

test("in-page programs are self-contained", () => {
  expect(inPagePrograms.length).toBeGreaterThan(0);
  const offenders: Record<string, string[]> = {};
  for (const [name, fn] of inPagePrograms) {
    const free = freeModuleConstants(fn.toString());
    if (free.length) offenders[name] = free;
    // new Function compiles with a global-only scope chain, as the page does;
    // a serialized method shorthand, for one, does not parse there.
    expect(() => new Function(`return (${fn})`)(), name).not.toThrow();
  }
  expect(offenders).toEqual({});
});

test("no code or test takes the user's focus from a launched Chrome", () => {
  // The CDP client opens new tabs in the background (cdp.ts); these are the
  // explicit ways to make Chrome the frontmost app (SKILL.md, Boundaries).
  // cdp.test.ts sends its background: false to a fake server, not Chrome.
  const offenders = sources
    .filter(({ file }) => file !== "cdp.test.ts")
    .flatMap(({ file, source }) =>
      [
        ...source.matchAll(/activateTarget|bringToFront|background: false/g),
      ].map((match) => `${file}: ${match[0]}`)
    );
  expect(offenders).toEqual([]);
});
