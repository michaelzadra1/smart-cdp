# smart-cdp

An agent skill for Claude Code and Codex that drives Chrome through the Chrome
DevTools Protocol, with no Puppeteer or Playwright. Agents use it to read
pages, take screenshots, capture network traffic, diagnose scrapers and build
fast browser-backed bulk scrapers, each in its own isolated Chrome.

Requires macOS, [Bun](https://bun.sh) and Google Chrome. Install by cloning
into your agent's skills directory:

```sh
git clone https://github.com/michaelzadra1/smart-cdp ~/.claude/skills/smart-cdp
```

Then ask for something browser-shaped, such as "open example.com with
smart-cdp and tell me what the page loads". [SKILL.md](SKILL.md) is what the
agent reads; ask the agent to set up anything optional. Contributors: see
[AGENTS.md](AGENTS.md).
