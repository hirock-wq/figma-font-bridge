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
| `broker/script-gate.js` | The opt-in gate for `script.run` (see "Script mode (opt-in)") |
| `broker/.token` | Auth token (per launch by default, reusable with `BRIDGE_REUSE_TOKEN=1`; gitignored, mode 600) |
| `launchd/` | Always-on template + `install.sh` (see "Always-on mode") |
| `broker/bridge.log` | Communication log |
| `plugin/manifest.json` `plugin/code.js` `plugin/ui.html` | The Figma development plugin |
| `test/script_run.test.js` | Node-only tests for script mode (no Figma, does not touch the running broker) |

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
| `script.run` | `code`, `args?`, `timeoutMs?` (default 60000) | the script's return value (JSON-safe) — **opt-in, rejected by default**; see "Script mode (opt-in)" |

`lineHeight.unit` is `AUTO` / `PIXELS` / `PERCENT`.

Responses are always `{"ok":true,"method":...,"data":{...}}` or
`{"ok":false,"error":"...","message":"..."}`. The plugin never throws — it returns
errors instead of crashing.

---

## Script mode (opt-in)

`script.run` executes arbitrary Plugin API JavaScript inside the Figma desktop plugin — a
**local-execution counterpart to `use_figma`**. Because it runs on your machine, it avoids the
weak spots of the cloud-side MCP:

- **Local fonts are visible** (`listAvailableFontsAsync` / `loadFontAsync` see Adobe Fonts, purchased and OS fonts)
- **No metadata lag** — reads reflect edits immediately (the cloud side can lag ~1 minute)
- **No all-or-nothing rollback** — each statement takes effect as it runs (a failure mid-script keeps earlier changes)
- **No page-switching restriction** — the plugin uses `documentAccess: "dynamic-page"`, so `await page.loadAsync()` / `figma.setCurrentPageAsync()` work

It is **off by default**: the broker rejects `script.run` with HTTP 403
`{"ok":false,"error":"script_disabled",...}` unless it was started with script mode enabled.
All other methods behave exactly as before, whatever the setting.

### Enabling

```bash
node broker/server.js --allow-script            # manual start, flag
BRIDGE_ALLOW_SCRIPT=1 node broker/server.js     # manual start, env
BRIDGE_ALLOW_SCRIPT=1 bash launchd/install.sh   # always-on mode (writes BRIDGE_ALLOW_SCRIPT=1 into the plist)
bash launchd/install.sh                         # re-run without it to switch back to disabled (0)
```

The broker logs `allow_script: true|false` at startup, and `/status` includes `"allow_script": true|false`.
The token is reused across the reinstall in always-on mode, so a remembered token keeps working.

### Calling it

`params`: `code` (string, required), `args` (any JSON, optional), `timeoutMs` (optional, default 60000, max 600000).
`code` is the body of `async function (figma, args, helpers) { ... }` — `return` a value and it comes back as `data`.

```bash
T=$(cat broker/.token)

# Bounds of every TEXT node on the current page
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"script.run","params":{"code":"return figma.currentPage.findAll(n => n.type === \"TEXT\").map(n => helpers.boundsOf(n))"}}' \
  http://127.0.0.1:3056/rpc

# Pass arguments: set a local font on one node
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"script.run","params":{"args":{"id":"123:456","family":"Mizolet","style":"Regular"},"code":"const n = await helpers.getNode(args.id, \"TEXT\"); await helpers.loadFontsOf(n); await figma.loadFontAsync({family: args.family, style: args.style}); n.fontName = {family: args.family, style: args.style}; return helpers.boundsOf(n)"}}' \
  http://127.0.0.1:3056/rpc
```

For longer scripts, write the JSON body to a file and send it with `curl ... --data-binary @body.json`.

### `helpers`

| helper | does |
|---|---|
| `getNode(nodeId, expectType?)` | node by id (throws if missing / wrong type) |
| `loadFontsOf(textNode)` | loads every font the text uses (incl. mixed ranges), returns them |
| `fontsOf(textNode)` | fonts used by the text, without loading |
| `boundsOf(node)` | `{id, name, x, y, width, height}` (rounded to 0.01) |
| `exportPng(nodeOrId, scale?)` | same as `node.export`: `{node, format, scale, bytes, base64}` (4096px / 8MB limits) |

### Results and errors

The return value is made JSON-safe: circular references → `"[Circular]"`, BigInt → string,
`undefined` / functions / symbols dropped (`null` inside arrays), `figma.mixed` → `"MIXED"`,
nodes returned directly → `{id, type, name}`, `Date` → ISO string, typed arrays → number arrays.
Returning nothing gives `data: null`.

| error | when |
|---|---|
| `script_disabled` (HTTP 403, from the broker) | script mode is off |
| `script_error` (`message`, `name`, `stack`) | the script threw, or has a syntax error |
| `script_timeout` (`timeoutMs`) | not finished within `timeoutMs` |
| `code_too_large` (`bytes`, `limit`) | `code` over 200KB (UTF-8) |
| `result_too_large` (`bytes`, `limit`) | JSON-encoded result over 2MB |
| `handler_error` | missing `code` or invalid `timeoutMs` |

The plugin never crashes on any of these.

### Limits

- Timeout: default 60s, max 10 min. On timeout the response is returned, but **the script itself cannot be
  cancelled** — it may keep running in the background, and whatever it already changed stays changed
- Sizes: `code` 200KB, result 2MB, HTTP body 2MB (unchanged)
- Requests are still processed one at a time (a script blocks other calls until it finishes or times out)
- The broker waits `timeoutMs + 5s` for `script.run` (existing methods keep the 30s wait)

### Security

Script mode is **arbitrary code execution** inside your Figma session: it can read and modify any open
file, and anything that can call the broker gets that power.

- Off by default; enable it only on your own machine, **never on a shared or public computer**
- The usual guards still apply: 127.0.0.1-only binding and the token on every request — but on a machine
  where script mode is on, treat `broker/.token` like a password
- Only let trusted callers (your own agent / scripts) use it; don't pipe untrusted text into `code`
- To turn it off again: restart the broker without the flag, or re-run `bash launchd/install.sh`

---

## Security

- Both WS (3055) and HTTP (3056) bind to **127.0.0.1 only** — unreachable from outside the machine
- A random token is issued per launch (or reused in always-on mode); both WS and HTTP verify the same token
- The plugin can only run the methods listed in `HANDLERS` in `code.js` (no `eval` — except the opt-in `script.run`, which the broker rejects unless started with `--allow-script` / `BRIDGE_ALLOW_SCRIPT=1`)
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

Script mode tests (Node only; they start their own brokers on free ports with a temp token dir,
so they never touch the running broker, ports 3055/3056 or `broker/.token`):

```bash
node test/script_run.test.js   # exit 0 = all passed
```

## Known limitations

- Closing the plugin panel disconnects the bridge (with "remember" on, reopening the plugin reconnects automatically; otherwise press Connect again)
- `text.setCharacters` replaces the whole text; mixed styles collapse to the first style (a warning is returned)
- Only one plugin can be connected to the broker at a time (the latest connection wins)
