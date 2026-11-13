# Desktop apps (Electron)

## Contents

- [How a session works](#how-a-session-works)
- [Why a copy](#why-a-copy)
- [Reading the app](#reading-the-app)
- [Slack](#slack)
- [Limits](#limits)
- [Read-only, and what changing it takes](#read-only-and-what-changing-it-takes)

Use `--app` only when the user explicitly asks to read a desktop app.

## How a session works

`--app <name>` claims a session, as in
[LIFECYCLE.md](LIFECYCLE.md#claimed-browsers), whose host launches the app
instead of Chrome (`scripts/electron.ts`):

1. It finds `<name>.app` in `/Applications` or `~/Applications`, ignoring
   case and punctuation, and requires `Electron Framework.framework` in it;
   otherwise the error lists the Electron apps installed.
2. It copies the app's profile, `~/Library/Application Support/<CFBundleName>`,
   into a fresh `$TMPDIR/smart-cdp-app-*` (mode 0700), without Chromium's
   caches or the running app's `Singleton*` links.
3. It starts the app's executable on that copy with CDP on a reserved
   loopback port, proves the endpoint is that child, as for Chrome, and keeps
   the app hidden so it never takes the user's focus.
4. The session's tab is the app's first page target that is not DevTools:
   its main window.

`--end-session`, the idle timeout and the app quitting end the host, which
quits the copy with `Browser.close` and deletes the copied profile. A killed
host's copy is closed as a killed host's Chrome is
([LIFECYCLE.md](LIFECYCLE.md#claimed-browsers)).

## Why a copy

An Electron app exposes CDP only when it is launched with
`--remote-debugging-port`, and the switch cannot be added to a running app.
Community recipes, such as agent-browser's Electron skill, quit the app and
relaunch it with the switch. That stops working as apps adopt Chrome 136's
rule: Slack 4.53 exits with `Refusing to launch: --remote-debugging-port is
not allowed against the default profile` unless `--user-data-dir` points
elsewhere. Signing in to a fresh profile does not work either, because
Slack's sign-in finishes in the browser and returns through a `slack://`
link that macOS hands to the user's running Slack.

A copy works for every Electron app. Electron's single-instance lock is per
profile, so the copy runs beside the user's window and never restarts it.
The user's real profile is never exposed on a debugging port. The copy
decrypts its cookies with the same Keychain item as the app (`<App> Safe
Storage`), so it starts signed in.

## Reading the app

The page is the app's web client: `evaluate`, `waitFor`, `send` and `cdp`
work as they do on a site. Electron has no `Browser.getWindowForTarget` or
`Browser.setWindowBounds`, so it has no window states. `Page.captureScreenshot`
works while the app is hidden. Other windows and webviews are targets of their
own: list them with `cdp.Target.getTargets()` and attach with
`cdp.Target.attachToTarget({ targetId, flatten: true })`.

The copy opens the view the app last saved, which is usually what the user
last looked at. A read-only session cannot click to another view, so read
the data the client already holds. Most apps persist their model in
IndexedDB or `localStorage`, and reading them changes nothing. List them
first:

```js
return await evaluate(async () => ({
  databases: (await indexedDB.databases()).map((db) => db.name),
  localStorage: Object.keys(localStorage),
}));
```

## Slack

Slack's desktop client keeps one persisted Redux state per signed-in user
and workspace in the IndexedDB database `reduxPersistence`, store
`reduxPersistenceStore`, key `persist:slack-client-<team>-<user>`.
Its `channels` map has every conversation the client knows, with `name`,
`is_member`, `is_private`, `is_archived`, `is_im` and `is_mpim`; `is_file`
marks the conversation behind a List or canvas, which is not in the sidebar.
`mutedChannels` and `starredChannels` are keyed by channel ID. The channels
the sidebar lists are the ones the user is a member of. A fresh copy takes
some seconds to boot, and IndexedDB is denied until the client page loads, so
wait for it first:

```js
await waitFor(() => location.pathname.startsWith("/client/"), { timeoutMs: 60000 });
return await evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("reduxPersistence");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const store = db
    .transaction("reduxPersistenceStore", "readonly")
    .objectStore("reduxPersistenceStore");
  const read = (request) =>
    new Promise((resolve) => (request.onsuccess = () => resolve(request.result)));
  const [key] = await read(store.getAllKeys());
  const state = await read(store.get(key));
  db.close();
  const parse = (value) => (typeof value === "string" ? JSON.parse(value) : value);
  const muted = parse(state.mutedChannels) ?? {};
  return Object.values(parse(state.channels))
    .filter((c) => (c.is_channel || c.is_group) && !c.is_im && !c.is_mpim && !c.is_file)
    .filter((c) => c.is_member && !c.is_archived)
    .map((c) => ({ name: c.name, private: c.is_private, muted: c.id in muted }))
    .sort((a, b) => a.name.localeCompare(b.name));
});
```

With several workspaces signed in, `getAllKeys()` returns one key per
workspace. `document.title` ends with `<workspace> - Slack`. The
`channelSections` order is persisted, but which channel sits in which section
is not: it loads live.

## Limits

- macOS only, and only apps built on Electron. An app that keeps its
  `userData` somewhere other than `Application Support/<CFBundleName>` is not
  found; the error names the path it looked in.
- The copy is a second client signed in as the user. While it runs it can
  show a second Dock icon and repeat the app's notifications. Release it as
  soon as the task is done.
- While a session runs, any local process could drive the copy through its
  loopback port, and the copy holds the user's session cookies until it is
  deleted.
- A Mac App Store build keeps its profile in its sandbox container and is not
  supported.

## Read-only, and what changing it takes

App sessions are read-only for now: probe.ts claims them with `readOnly`, and
the host refuses every command matching `READ_ONLY_REFUSED` in
`scripts/relay.ts`. The rule for probe code in SKILL.md covers the rest,
because page JavaScript can act too. Allowing changes later means claiming
without `readOnly` for a session the user authorizes to act. It also means deciding how a change
made in the copy should reach the user's own app: messages sync through the
server, but local state such as drafts does not.
