# Installing and optional setup

Read this when the user asks to install the skill for another agent host, to
check an install, or to set up the WebFetch fallback hook. Loading the
`--personal` extension is in
[LIFECYCLE.md](LIFECYCLE.md#your-own-chrome-profile).

## Install locations

The repository is the skill. Clone it, or symlink one clone, into each host's
skill discovery directory: `~/.claude/skills/smart-cdp` for Claude Code and
`~/.agents/skills/smart-cdp` for Codex, which follows symlinks
([skill discovery documentation](https://learn.chatgpt.com/docs/build-skills)).
Update with `git pull`. Its dependencies are exact pins, and nothing in it
reaches another repo.

## Verify

Run `bun test "$SMART_CDP_SKILL"` for the offline checks and the real local
Chrome smoke test. The tests serve their own pages and make no external
requests. Also check discovery through the host's skill listing from the
intended repo: a readable SKILL.md alone is not proof that `$smart-cdp` can be
selected.

## WebFetch fallback hook (Claude Code)

`scripts/webfetch-fallback.ts` tells any agent or subagent to open a page here
when WebFetch cannot read it. A hook adds this as context and does not grant
permission: without an `autoMode.allow` entry for this fallback, auto mode's
classifier can deny the probe as bot-check circumvention, and then the agent
stops and reports it. It needs both events in the Claude Code user settings,
because a blocked domain arrives as `PostToolUseFailure` and an HTTP 403 as a
successful `PostToolUse`:

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "WebFetch", "hooks": [{ "type": "command", "command": "bun \"$HOME/.claude/skills/smart-cdp/scripts/webfetch-fallback.ts\"" }] }],
    "PostToolUseFailure": [{ "matcher": "WebFetch", "hooks": [{ "type": "command", "command": "bun \"$HOME/.claude/skills/smart-cdp/scripts/webfetch-fallback.ts\"" }] }]
  }
}
```

Settings are the user's: show the change and add it only when they ask.
