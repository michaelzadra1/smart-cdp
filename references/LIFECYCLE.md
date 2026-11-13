# Browser lifecycle

## Contents

- [Owned local browser](#owned-local-browser)
  - [Signing in](#signing-in)
- [Claimed browsers](#claimed-browsers)
- [Your own Chrome profile](#your-own-chrome-profile)
- [Authorized existing browser](#authorized-existing-browser)

## Owned local browser

The probe launches Chrome as a child process with a unique `mkdtemp` profile on
a freshly reserved loopback port, and proves the endpoint's browser PID is that
child before use; it never borrows a well-known port or existing profile. Never
pass `--remote-debugging-port=0`: it sets `navigator.webdriver` and Google
sign-in rejects the browser. The recorded child handle is the cleanup
authority. No process-name searches, port eviction, shared lock directory, or
repo launcher is needed.

A claimed browser continues across probes; see
[Claimed browsers](#claimed-browsers). A `--once` probe is a cold rotation with
a fresh profile that closes when it returns, so save screenshots or response
bodies before then. Do not add cookie clearing as a substitute for a cold
rotation when testing a noninteractive block. Preserve a pending visible
challenge long enough to interact with it and inspect the result.

For user interaction, tell the user the claimed window is ready and check its
state with later probes instead of one long wait. Do not change global desktop
or browser settings unless asked.

### Signing in

Claim a browser on a persistent, task-owned profile (`--profile <dir>`) with
`--idle-ms 0`, so the idle timeout cannot close it while the user works in it.
Open the login URL, let the user sign in, and release the browser yourself. The
profile is kept on release, so later claims with the same `--profile` start
signed in. Never automate the credential step.

Closing an owned browser uses CDP `Browser.close`, which flushes cookies, then
terminates the exact child if it is still running and removes only a generated
profile, never a `--profile` one. SIGKILL or a machine crash cannot run
cleanup: if the launcher is lost, report its recorded PID/profile and leave
uncertain ownership untouched. Do not introduce a broad kill/cleanup sweep.

## Claimed browsers

Claiming a browser (no `--session`, or an unused name) starts
`scripts/relay.ts` as a detached host. The host launches Chrome as above,
opens the browser's tab, and relays each probe's CDP connection through its own
connection to Chrome. Its private state file
(`$TMPDIR/smart-cdp-session-<hash>.json`, mode 0600) records the host PID, its
relay URL, the tab, the Chrome PID, the launch's browser endpoint and the
profile. A probe with that `--session` binds that tab. If the tab was closed,
it continues on another page in that browser or opens one.

A probe ending for any reason only disconnects. The host detaches the CDP
sessions that probe opened, which disables what it enabled, and leaves the tab
and its page as they are. `--headless`, `--profile` and `--idle-ms` take effect
when the browser is claimed. A later probe may leave out `--profile` and
`--idle-ms`, but a headless browser needs `--headless` on every probe: without
it the probe asks for a visible browser. A probe that asks for different
options is refused, and the refusal says how to continue.

`--end-session <id>` connects to the host's control path, which only the state
file names. The host closes its Chrome with `Browser.close`, removes a
generated profile and its state file, and exits. The idle timeout does the
same after the last probe, and so does Chrome quitting. A probe still running
is told its browser was released. A host killed with SIGKILL cannot close its
Chrome: the next probe or `--end-session` with that ID closes it only when the
recorded browser endpoint, unique to that launch, still answers with the
recorded PID; otherwise it reports the PID and profile and leaves them.

An `--app` session claims the same way, but its host launches a hidden copy
of a desktop app instead of Chrome; see [DESKTOP-APPS.md](DESKTOP-APPS.md).

This is the split Puppeteer draws between
[`disconnect()` and `close()`](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Browser.ts)
(`Browser.close`, then the process is killed if that fails), and how
[agent-browser](https://github.com/vercel-labs/agent-browser) keeps a daemon per
named session, with an explicit close and an idle timeout.

## Your own Chrome profile

`--personal` claims a session, as above, whose host is `scripts/personal.ts`
instead of `relay.ts`. The host serves a blank page at
`http://127.0.0.1:<port>/smart-cdp/<uuid>` and opens it with
`CHROME_BIN --profile-directory=<dir> <url>`, where `<dir>` is `Default` or
the profile `--personal-profile` named. An exact directory (`Default`,
`Profile 2`) is used as given. Otherwise that flag is matched, ignoring case
and punctuation, against each profile's menu label (`<gaia_given_name>
(<name>)` for a signed-in profile), its `name` and its directory, from
`profile.info_cache` in `~/Library/Application Support/Google/Chrome/Local State`.
Pass the directory from a process Chrome launched, such as a native messaging
host: macOS can block it from reading that file.
A running Chrome hands that URL to a window of that profile,
opening one if the profile has none. A closed Chrome starts detached, so it outlives the
host. The extension (`extension/background.js`) is loaded in that
profile, and in each other profile the user wants driven. The URL wakes it, it connects back on the same port, and the host
answers its challenge with an HMAC of the secret in
`extension/secret.json`. That file is gitignored, mode 0600, and the host
creates it on first use. Only then does the extension attach `chrome.debugger`
to that one tab. Without the secret, another local program cannot use the
extension to take over the browser.

Probes connect to the host one at a time. The host addresses the tab as
session `smart-cdp-tab`: `send`, `sessionId` and `cdp.on("<event>.<sessionId>")`
work as they do on a launched browser. After each probe the extension detaches
and reattaches, which clears every domain and `Fetch` pattern the probe
enabled. Each attach adds an empty virtual WebAuthn authenticator, so the
profile's passkeys never open Chrome's Touch ID sheet over the page. While the
tab is attached, Chrome shows its "started debugging this browser" bar.
Release, the idle timeout, the tab closing or Chrome quitting end the host.
Release and idle close the tab; the profile and every other tab stay as they
were.

Limits:
- `chrome.debugger` reaches only that tab and its child sessions. `Browser.*`,
  `Target.createTarget` and `Target.getTargets` are unavailable, and a
  `data:` URL cannot be opened in the tab.
- Without `--personal-profile` the profile is `Default`, Chrome's first
  profile. A session stays in the profile it claimed; `--personal-profile`
  naming another one is refused.
- Edits to `extension/` need a reload in `chrome://extensions`; the host and
  probe do not.

## Authorized existing browser

For the user's own profile, use `--personal` above: it never prompts. The
endpoint attachment below suits a browser the task owns that runs with a
debugging port.

Select one endpoint and the exact target ID supplied by its owner:

```bash
bun "$SMART_CDP_SKILL/scripts/probe.ts" \
  --ws-url 'ws://127.0.0.1:PORT/devtools/browser/ID' --target TARGET_ID < probe.js
```

Alternatives are `--port PORT` (loopback only) or
`--active-port-file /authorized/profile/DevToolsActivePort`.
The latter supports permission-based Chrome attachment even when `/json/version`
is unavailable; for the personal profile enabled at
`chrome://inspect/#remote-debugging` it is
`~/Library/Application Support/Google/Chrome/DevToolsActivePort`.

Chrome 144+ asks the user to allow **every new CDP WebSocket** to that browser
and offers no way to remember the choice
([Chrome blog](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session),
[declined request](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825)).
So every attachment goes through `scripts/relay.ts`, which holds one approved
connection for later probes: only the first prompts (stderr says
`Started relay pid=…`). Chrome's "controlled by automated test software" banner
stays while it is open; the relay closes it after 5 idle minutes or on SIGTERM
to that pid. A Chrome restart means one new prompt. Let the user approve the
prompt; never automate the approval.

Attachment only disconnects/detaches on exit: it does not terminate the browser,
delete a profile, close the user's tab, or create a replacement target. A missing
target is an error. The probe does not enumerate other tabs automatically.
When discovery is explicitly authorized, filter target metadata to the requested
domain before inspecting or reporting it.

Remote/mobile workflows must use their owner's target and launch configuration.
Do not replace launcher-hardened targets or interpret a desktop probe as mobile
production parity. Classic Chrome debugging requires a non-default profile.
