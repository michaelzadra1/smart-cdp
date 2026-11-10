# AGENTS.md

- This repository is one agent skill: `SKILL.md` is what agents read, with
  details in `references/`, code in `scripts/` and the `--personal` extension
  in `extension/`. Keep the scripts free of runtime dependencies.
- Bun is the only runtime, package manager and test runner: write scripts and
  tests in TypeScript and test with `bun:test`.
- Validate code changes with `bun run format && bun run typecheck`, then
  `bun run test`; let Biome fix formatting-only issues.
- Test against visible Chrome, the mode the skill runs in almost every time.
  Pass `--headless` only in a test of the `--headless` option itself. Tests
  and debugging probes follow the focus rule in `SKILL.md` (Boundaries): none
  activates a tab or opens one in the foreground. The suite runs
  concurrently; mark a test that delivers trusted input `test.serial`, because
  Chrome delays or drops input to background windows on a loaded machine.
- Never send CDP code as a source string. Node-side code, tests included, is
  a typed function passed to `runProbe`; only the probe CLI compiles stdin
  code, and only a test of the CLI sends it. An in-page program is a typed
  function named `*InPage`, serialized with `inPageCall` (`scripts/in-page.ts`),
  with every dependency passed in as a parameter. Register each one in
  `scripts/source-rules.test.ts`, which proves it self-contained and checks
  the focus rule.
- Keep the skill generic: nothing about one person's machine, profiles or
  projects. Users name a Chrome profile in their prompt; they configure
  nothing.
- After editing `extension/`, reload it at `chrome://extensions` in each
  profile that has it.
