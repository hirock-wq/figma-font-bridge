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
| `broker/.token` | Per-launch auth token (gitignored, mode 600) |
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
- A random token is issued per launch; both WS and HTTP verify the same token
- The plugin can only run the methods listed in `HANDLERS` in `code.js` (no `eval`)
- Scope is limited to **the currently open file and the explicitly given nodeId** — no whole-document scans, no delete operations
- Requests are processed one at a time, with limits on text length (20,000 chars), export size (4096px / 8MB), and HTTP body (2MB)
- The token is never stored in `clientStorage` (paste it manually on each launch)

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

- Closing the plugin panel disconnects the bridge (no auto-reconnect — press Connect again)
- `text.setCharacters` replaces the whole text; mixed styles collapse to the first style (a warning is returned)
- Only one plugin can be connected to the broker at a time (the latest connection wins)
