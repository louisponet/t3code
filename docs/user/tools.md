# Tools

Tools put the dashboards you keep open next to your agents into the sidebar. A
**terminal tool** runs a command such as `lazygit` or `htop` in a terminal. A
**browser tool** opens a page, such as a dev server or Grafana, in a browser.
A **web app tool** renders an app on your device, including
WebAssembly apps such as an egui dashboard. A tool can also show a small status badge, such as how
many pull requests are waiting.

Each tool belongs to one environment. Terminal tools run on that environment's
machine, and so do browser tools unless the desktop app opens them (see below).
Every device sees the same terminal session, so you can start `lazygit` on your
desktop and pick it up from a laptop or phone browser. The native mobile app does
not show tools yet.

## Add a tool

Open **Settings → Tools**, or choose **Add tool…** in the command palette. Once an
environment has a tool, it is listed in the sidebar's **Tools** section. Agents can
list tools and refresh their badges, and with full access they can also add, edit,
and remove them.

Leaving a terminal or browser tool's page, closing the window, or losing the connection does not stop
its session. Use **Stop** to end it, and **Restart** to run it again. Edits to a
running terminal tool apply the next time it starts.
When a terminal tool exits, press **Enter** to run it again or **Esc** to go back.
Restarting the environment server ends terminal tools.

Web app tools open a separate view on each device. Leaving the page closes that
view. Use **Reload** to load the app again. T3 Code does not start or stop the
app's server.

## Edit settings.json

Tools are stored under `tools` in the environment's `settings.json`, in its
`userdata` directory. You can edit them there; changes apply on every device.

```json
{
  "tools": {
    "lazygit": {
      "kind": "terminal",
      "name": "lazygit",
      "command": "lazygit",
      "cwd": "~/code/my-app"
    },
    "prs": {
      "kind": "terminal",
      "name": "Pull requests",
      "command": "gtc prs",
      "status": { "command": "gtc prs --badge", "intervalSeconds": 120 }
    },
    "grafana": {
      "kind": "browser",
      "name": "Grafana",
      "target": { "kind": "environment-port", "port": 3000, "path": "/d/home" }
    },
    "dashboard": {
      "kind": "web",
      "name": "Dashboard",
      "target": { "kind": "environment-port", "port": 9877, "path": "/ui/" }
    }
  }
}
```

Each key is the tool's id: lowercase letters, digits, and dashes, starting with a
letter, up to 24 characters. Tools appear in the order they are listed. A
`description` is optional for every tool.

- A **terminal tool** runs `command` the way a T3 Code terminal would, so your
  shell's aliases and functions work. `cwd` is optional and defaults to your home
  directory (`~`).
- A **browser tool** opens `target`. Use `{ "kind": "environment-port", "port": 3000 }`
  for a server on the environment's machine, with an optional `path` and
  `"protocol": "https"`. It opens `localhost` on that machine, so it works over the
  local network, Tailscale, and T3 Connect alike. Use `{ "kind": "url", "url": "…" }`
  for any other page.
- A **web app tool** uses the same `target` options. Requests pass through the
  environment, so a host-local app works from remote devices too. The app runs on
  your device and uses its GPU for WebGL.

An entry T3 Code can't use is listed in **Settings → Tools** with the reason, and
every other tool keeps working. "Needs a newer T3 Code" means the entry uses a
kind this environment's version does not know.

When the desktop app connects to another machine's environment, a browser tool
with a `url` target opens in the desktop app's own browser on your computer, with
the desktop app's sign-ins. That session is separate from the one web clients
see, and **Restart** restarts only the desktop's; **Stop** ends both. The address must resolve from
your computer: for a server on the environment's machine, use an
`environment-port` target. In web clients, in the desktop app's own
environment, and for port or `localhost` targets, browser tools use the
environment's browser, so sign-ins persist between visits.
The first browser tab downloads a headless Chrome, and some Linux hosts need
[browser setup](./remote-access.md#browser-host-setup). On a server without the
desktop app, a browser tool left unwatched may close after a while; it reopens when
you return to it.

Choose **Web app** for apps that use relative URLs for their assets, API calls,
and WebSocket connections. Configure the target as the app's root directory,
such as `/ui/`, or its entry file. URLs hard-coded to `localhost`, another port,
or the server root need to be made relative in the app. Web app tools isolate
the app from T3 Code's session and do not support cookies or browser storage.
Use a browser tool for sites that need a persistent sign-in.

Every device and agent connected to the environment can read tool definitions.
Never put tokens or passwords in a command. Let the command read them from its own
configuration on the host instead.

## Status badges

Add `status` to show a badge next to a tool. Its `command` runs on the host every
`intervalSeconds` (default 60, from 10 to 3600) and must print one JSON object:

```json
{
  "tone": "warn",
  "glyph": "●",
  "headline": "3 PRs waiting",
  "detail": ["2 need review", "1 failing"],
  "items": [{ "tone": "alert", "text": "#412 CI failing" }],
  "total": 12
}
```

Only `headline` is required. `tone` is one of `good`, `info`, `warn`, `alert`, or
`muted`, the default. `detail` lines and `items` appear in the badge's tooltip, and
`total` counts all items when the command prints only some of them. Long text is
shortened: the headline to 60 characters, up to 5 detail lines of 80, and up to 8
items of 100.

If the command fails, the badge's tooltip shows the last line the command wrote to
stderr. A command that takes longer than `timeoutSeconds` (default 30, up to 120)
counts as failed.

The status command runs non-interactively in the tool's `cwd`, or your home
directory for a browser or web app tool. Your `PATH` is available, but shell aliases and
functions are not. Status commands run only while T3 Code is open on some device,
following the environment's **Background activity** setting. A badge also refreshes
when a terminal tool exits and when you leave its page.

## Keyboard

While a terminal tool has focus, it receives every key, including Esc and
shortcuts T3 Code would otherwise use, such as Ctrl+B. Press `mod+shift+k` to open
the command palette, or click outside the terminal to use other shortcuts again.
The desktop app on Windows and Linux has two exceptions: Ctrl+Q stays the
[quit shortcut](./keybindings.md#desktop-quit-shortcut), and holding Ctrl+W sends it
only once. Rules with `"when": "toolFocus"` in [keybindings](./keybindings.md) run while a
tool has focus.

Web app tools also keep keyboard input inside the app. Press `mod+shift+k` to
open T3 Code's command palette, or click outside the app to use T3 Code shortcuts.

To open a tool with a shortcut, bind its `tool.{id}.open` command:

```json
{ "key": "mod+alt+g", "command": "tool.lazygit.open" }
```

When more than one environment has a tool with that id, the command palette opens
so you can choose.
