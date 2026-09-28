# figma-font-bridge — Local Font Bridge for Figma

> 日本語版: [README.ja.md](README.ja.md)

Figma's MCP tools (`use_figma`) execute remotely — in the cloud — so they cannot see
fonts installed on your machine (Adobe Fonts, purchased fonts, even OS-bundled ones).
Meanwhile, **a Figma desktop development plugin has full access to local fonts**
(measured: 11,095 font records visible, all loadable via `loadFontAsync`, vs. ~8,900
Google-Fonts-centric records from the cloud side).

This tool bridges that gap. An AI agent (or any script) on the same Mac calls a local
HTTP endpoint, and the request is relayed to a Figma plugin that performs the text
operation with real local fonts.

```
Agent (curl) --HTTP 127.0.0.1:3056--> broker --WS 127.0.0.1:3055--> plugin UI --postMessage--> code.js (Plugin API, local fonts OK)
```

## Layout

| Path | Role |
|---|---|
| `broker/server.js` | The broker (Node.js, zero dependencies) |
| `broker/ws-min.js` | Minimal WebSocket server implementation (avoids the `ws` package) |
| `broker/mock-plugin.js` | Mock plugin to test the wiring without launching Figma |
| `broker/.token` | Auth token (per launch by default, reusable with `BRIDGE_REUSE_TOKEN=1`; gitignored, mode 600) |
| `launchd/` | Always-on template + `install.sh` (see "Always-on mode") |
| `broker/bridge.log` | Communication log |
| `plugin/manifest.json` `plugin/code.js` `plugin/ui.html` | The Figma development plugin |

---

## Setup (manual steps)

### 1. Start the broker (terminal on this Mac)

```bash
cd /path/to/figma-font-bridge  # wherever you cloned this repo
node broker/server.js
```

On launch it prints a **32-char token** (also written to `broker/.token`).
Keep this terminal open.

### 2. Import the plugin into Figma (first time only)

In the Figma desktop app:

1. Menu (Figma logo, top left) → **Plugins** → **Development** → **Import plugin from manifest…**
2. Select `plugin/manifest.json` from this repo
3. "Local Font Bridge" now appears under your development plugins

### 3. Open the target file and run the plugin

With the Figma file you want to work on open:
Menu → **Plugins** → **Development** → **Local Font Bridge**

### 4. Paste the token and connect

Paste the token from step 1 into the plugin UI and press **Connect**.
A green dot with "connected (idle)" means it's ready.

> Closing the plugin panel kills the bridge. Keep it open while working.

---

## Always-on mode (launchd, optional)

Skip the "start broker → copy token → paste" routine. After a one-time setup, you only
**open the plugin in the target file and it connects automatically**.

### Install (once)

```bash
cd /path/to/figma-font-bridge
bash launchd/install.sh
```

The script fills in your paths (repo, absolute `node` path incl. nvm, `~/Library/Logs`)
from `launchd/com.example.figma-font-bridge.plist.template`, writes
`~/Library/LaunchAgents/com.<your-user>.figma-font-bridge.plist`, stops any manually
started broker, and loads the job (`RunAtLoad` + `KeepAlive`, `ThrottleInterval` 30s).
The job name can be changed with `BRIDGE_LABEL=...`. It prints the token at the end.

Then in the plugin, paste the token once, tick **「トークンを記憶して、次回から自動で接続する」**
(remember token & auto-connect) and press Connect. From now on the plugin connects on open,
and reconnects every 5s if the broker restarts.

### Fixed token (opt-in)

The job runs the broker with `BRIDGE_REUSE_TOKEN=1` (same as `node broker/server.js --reuse-token`):
an existing valid `broker/.token` is reused instead of regenerated, so restarts don't
invalidate the remembered token. Without the flag, behavior is unchanged (new token per launch).

Security is practically equivalent: both ports still bind to 127.0.0.1 only, `.token` stays
mode 600 (owner-only), and the remembered copy lives in Figma's `clientStorage` for this plugin
on this machine only. The trade-off is that the token no longer expires on restart —
**to rotate it**, delete `broker/.token` and restart the job, then paste the new token.

### Stop / uninstall / restart

```bash
launchctl bootout gui/$(id -u)/com.$(id -un).figma-font-bridge    # stop (older syntax: launchctl unload ~/Library/LaunchAgents/com.$(id -un).figma-font-bridge.plist)
bash launchd/install.sh uninstall                                 # stop + remove the plist
launchctl kickstart -k gui/$(id -u)/com.$(id -un).figma-font-bridge  # restart
```

### Troubleshooting (always-on)

- Check the job: `launchctl list | grep figma-font-bridge` (a PID in the first column = running)
- Logs: `~/Library/Logs/figma-font-bridge.err.log` / `.out.log`, and `broker/bridge.log`
- `port 3056 is already in use` in the log: another broker is running (e.g. one started by hand).
  Stop it; launchd retries at most every 30s, so this never becomes a tight restart loop.
  A broker that fails on a port conflict does not overwrite `broker/.token`
- "Token mismatch" in the plugin: `.token` was deleted/regenerated — paste `cat broker/.token` again
- Plugin connected but acting on the wrong file: see "Troubleshooting connection" below
  (only one plugin connection; the latest one wins)
- If you moved the repo or switched Node versions, re-run `bash launchd/install.sh`

---

## Calling the bridge (curl)

```bash
cd /path/to/figma-font-bridge  # wherever you cloned this repo
T=$(cat broker/.token)

# Connection check
curl -s -H "X-Bridge-Token: $T" http://127.0.0.1:3056/status

# Probe the font environment
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"fonts.probe"}' http://127.0.0.1:3056/rpc

# Get the nodeId of the current selection in Figma
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"selection.get"}' http://127.0.0.1:3056/rpc

# Reflow text at width 768 (height auto)
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"text.reflow","params":{"nodeId":"123:456","width":768,"autoResize":"HEIGHT"}}' \
  http://127.0.0.1:3056/rpc

# Swap a placeholder font for the real one
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"text.setFont","params":{"nodeId":"123:456","family":"Mizolet","style":"Regular"}}' \
  http://127.0.0.1:3056/rpc
```

### Methods

| method | params | returns |
|---|---|---|
| `fonts.probe` | `match?` (regex string) | available font count, matching families, file names |
| `selection.get` | — | id / type / bounds of selected nodes |
| `node.get` | `nodeId` | type and bounds; for TEXT also characters / fontName(s) / fontSize / lineHeight / textAutoResize |
| `text.reflow` | `nodeId`, `width?`, `autoResize` (`HEIGHT`\|`NONE`\|`WIDTH_AND_HEIGHT`\|`TRUNCATE`) | before / after bounds |
| `text.setStyle` | `nodeId`, `fontSize?`, `lineHeight?{value,unit}`, `letterSpacing?` | before / after bounds and applied values |
| `text.setFont` | `nodeId`, `family`, `style` | before / after; warning if styles were mixed |
| `text.setCharacters` | `nodeId`, `characters` | before / after; mixed-style warning |
| `node.export` | `nodeId`, `scale?` (default 1) | PNG as Base64 (limits: 4096px per side, 8MB) |
| `node.move` | `nodeId`, `x`, `y` | bounds |
| `node.resize` | `nodeId`, `w`, `h` | bounds |

`lineHeight.unit` is `AUTO` / `PIXELS` / `PERCENT`.

Responses are always `{"ok":true,"method":...,"data":{...}}` or
`{"ok":false,"error":"...","message":"..."}`. The plugin never throws — it returns
errors instead of crashing.

---

## Security

- Both WS (3055) and HTTP (3056) bind to **127.0.0.1 only** — unreachable from outside the machine
- A random token is issued per launch (or reused in always-on mode); both WS and HTTP verify the same token
- The plugin can only run the methods listed in `HANDLERS` in `code.js` (no `eval`)
- Scope is limited to **the currently open file and the explicitly given nodeId** — no whole-document scans, no delete operations
- Requests are processed one at a time, with limits on text length (20,000 chars), export size (4096px / 8MB), and HTTP body (2MB)
- The token is stored in `clientStorage` only when you tick "remember" (off by default; unticking deletes it)

## Troubleshooting connection

- **By default the token changes on every broker launch** (not in always-on mode). After restarting the broker, the old token fails auth — print the current one with `cat broker/.token` and paste it again
- If you closed the plugin panel, reopen it and paste the latest token (closing the panel drops the WS connection)
- Health check: `curl -s -H "X-Bridge-Token: $(cat broker/.token)" http://127.0.0.1:3056/status` — `plugin_connected: true` means ready

## Stopping

1. Close the Figma plugin panel (or press "Disconnect" in the UI)
2. `Ctrl+C` in the terminal (`broker/.token` is overwritten on next launch)

## Wiring test (without Figma)

```bash
node broker/server.js          # in one terminal
node broker/mock-plugin.js     # connects as a dummy plugin
# If the curl examples above return {"ok":true,...,"data":{"mock":true,...}}, the wiring is fine
```

## Known limitations

- Closing the plugin panel disconnects the bridge (with "remember" on, reopening the plugin reconnects automatically; otherwise press Connect again)
- `text.setCharacters` replaces the whole text; mixed styles collapse to the first style (a warning is returned)
- Only one plugin can be connected to the broker at a time (the latest connection wins)
