# AGENTS.md

- This repository is one agent skill: `SKILL.md` is what agents read, with
  details in `references/`, code in `scripts/` and the `--personal` extension
  in `extension/`. Keep the scripts free of runtime dependencies.
- Bun is the only runtime, package manager and test runner: write scripts and
  tests in TypeScript and test with `bun:test`.
- Validate code changes with `bun run format && bun run typecheck`, then
  `bun run test`; let Biome fix formatting-only issues.
- Keep the skill generic: nothing about one person's machine, profiles or
  projects. Users name a Chrome profile in their prompt; they configure
  nothing.
- After editing `extension/`, reload it at `chrome://extensions` in each
  profile that has it.
