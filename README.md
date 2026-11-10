# smart-cdp

An agent skill for Claude Code and Codex that inspects websites through the
Chrome DevTools Protocol, with no Puppeteer or Playwright. Agents use it to
read pages, take screenshots, capture network and API traffic, diagnose
scrapers and build fast browser-backed bulk scrapers. Each agent claims its own
isolated Chrome and releases it when done; on request it can instead drive a
tab in your own signed-in Chrome profile.

## Requirements

- macOS
- [Bun](https://bun.sh)
- Google Chrome (or Chromium) in `/Applications`

## Install

Clone it into your agent's skills directory:

```sh
# Claude Code
git clone https://github.com/michaelzadra1/smart-cdp ~/.claude/skills/smart-cdp
# Codex
git clone https://github.com/michaelzadra1/smart-cdp ~/.agents/skills/smart-cdp
```

To use both, clone once and symlink the clone into the other directory. Update
with `git pull`. The agent installs the one pinned dependency on first use.

Then ask for something browser-shaped, for example "open example.com with
smart-cdp and tell me what the page loads".

### Using your own Chrome profile (optional)

By default every agent gets a fresh, isolated Chrome and needs no setup. To let
an agent work in your own signed-in Chrome when you ask it to ("use my
browser", "use my Work profile"), load the bundled extension once in each
profile you want driven:

1. Open `chrome://extensions` in that profile and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension` folder of your clone.

Name the profile in your prompt the way Chrome's profile menu shows it, such
as "Alex (Work)" or just "Work". The extension uses `chrome.debugger` on the
one tab it opens, so Chrome shows no "Allow remote debugging?" prompt.

### WebFetch fallback hook (optional, Claude Code)

[SKILL.md](SKILL.md#webfetch-fallback-hook) has a hook that sends the agent
here when WebFetch is blocked or gets a 403.

## Development

```sh
bun install
bun run format && bun run typecheck && bun run test
```

The tests run offline against a local Chrome. See [AGENTS.md](AGENTS.md).
