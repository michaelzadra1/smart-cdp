import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { returnByValueInPage } from "./in-page";
import { clickPointInPage } from "./input";
import { recaptchaCheckboxPointInPage } from "./recaptcha";
import { turnstileCheckboxPointInPage } from "./turnstile";

// Rules for the code in scripts/ that a scan can check; AGENTS.md states them.
const sources = await Promise.all(
  (await readdir(import.meta.dir))
    .filter((file) => file.endsWith(".ts"))
    .map(async (file) => ({
      file,
      source: await readFile(join(import.meta.dir, file), "utf8"),
    }))
);

// Every program that ships to Chrome's renderer as toString() output. A free
// variable in one compiles here and fails only when the page calls it, so the
// real-Chrome tests in probe.test.ts call each of them too.
const IN_PAGE_PROGRAMS: Record<string, (...args: never[]) => unknown> = {
  returnByValueInPage,
  clickPointInPage,
  recaptchaCheckboxPointInPage,
  turnstileCheckboxPointInPage,
};

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

test("in-page programs are self-contained and all registered", async () => {
  const offenders: Record<string, string[]> = {};
  for (const [name, fn] of Object.entries(IN_PAGE_PROGRAMS)) {
    const free = freeModuleConstants(fn.toString());
    if (free.length) offenders[name] = free;
    // new Function compiles with a global-only scope chain, as the page does.
    expect(() => new Function(`return (${fn})`)(), name).not.toThrow();
  }
  expect(offenders).toEqual({});

  // Scanned off disk, so a new module cannot skip the guard by not being
  // imported here.
  const exported: string[] = [];
  for (const { file, source } of sources) {
    if (file.includes(".test.")) continue;
    for (const match of source.matchAll(
      /^export (?:async )?function (\w*InPage)\b/gm
    ))
      exported.push(match[1] as string);
  }
  expect(exported.sort()).toEqual(Object.keys(IN_PAGE_PROGRAMS).sort());
});

test("no code or test takes the user's focus from a launched Chrome", () => {
  // Both make Chrome the frontmost app (SKILL.md, Boundaries).
  const offenders = sources.flatMap(({ file, source }) =>
    [...source.matchAll(/activateTarget|createTarget/g)]
      .filter(
        (match) =>
          match[0] === "activateTarget" ||
          !/background: true/.test(source.slice(match.index, match.index + 200))
      )
      .map((match) => `${file}: ${match[0]}`)
  );
  expect(offenders.filter((line) => !line.startsWith("source-rules."))).toEqual(
    []
  );
});
