# opencode-rdp-computer-use

Full desktop control for [OpenCode V2](https://opencode.ai) over **RDP or VNC**: the agent sees a remote desktop as images and drives it with mouse and keyboard events.

This is a native OpenCode V2 plugin rewritten from [`pi-rdp-computer-use`](https://github.com/hakergeniusz/pi-rdp-computer-use). It needs no X11 tooling, screencast portal or `uinput`: it speaks the remote desktop protocol directly through a headless Python bridge.

| Protocol | Bridge | Use when |
| --- | --- | --- |
| `rdp` (default) | `bridge/rdp_bridge.py` (aardwolf) | Windows, `xrdp`, any NLA-capable server |
| `vnc` | `bridge/vnc_bridge.py` (own RFB 3.8 client) | GNOME Remote Desktop, `x11vnc`, wayvnc, TigerVNC — and when RDP auth is broken server-side |

## How it works

```
OpenCode plugin (src/index.ts)
        │  newline-delimited JSON over stdio
        ▼
Python bridge (bridge/*.py)  ── RDP (aardwolf) or RFB 3.8 ──▶  desktop server
        │                                   ▲
        │  bitmap updates → PNG             │  input events
        ▼                                   │
   model sees an image                 click / type / scroll / drag
```

The bridge is a headless process: no window is opened, so this works on headless machines and under Wayland alike. Observation is the remote framebuffer returned as a PNG (or JPEG); input is sent as RDP fastpath input events or RFB pointer/key events. Screenshots are returned to the model as OpenCode tool `file` content with a `data:<mime>;base64,...` URI.

The plugin tracks server-ignored resolutions, reconnect transparently with stored credentials when a session drops, and closes the bridge stdin first on disconnect so the server tears the session down cleanly.

## Install / load

Add the plugin in `opencode.json(c)` (or drop the directory into `.opencode/plugins/` for automatic loading):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-rdp-computer-use"]
}
```

Local checkout while developing:

```jsonc
{
  "plugins": ["/home/hakergeniusz/Projects/opencode-rdp-computer-use"]
}
```

Options can be passed with the object form; they override the config file but are overridden by environment variables:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-rdp-computer-use",
      "options": {
        "protocol": "vnc",
        "host": "127.0.0.1",
        "port": 5900,
        "consent": { "mode": "session", "timeoutMs": 180000 }
      }
    }
  ]
}
```

Credential resolution order: **tool parameter → environment variable → plugin option → config file**. Prefer `RDP_PASSWORD` or a `chmod 600` config file over passing passwords in tool arguments: passwords appear in session transcripts. The plugin never logs the password and strips it from tool metadata.

## Tools

All eight tools are registered in the `desktop` tool namespace:

| Tool | What it does |
| --- | --- |
| `rdp_connect` | Open a session (RDP or VNC) and report the desktop size. Falls back to the other transport if the first fails. |
| `rdp_screenshot` | Capture the full desktop **or a region** of it, with the mouse cursor highlighted by a magenta crosshair. |
| `rdp_mouse` | Left, right or middle click at any desktop pixel, move, drag, press/release a held button, or scroll up/down (left/right on VNC only). |
| `rdp_keyboard` | Type text (Unicode, layout independent) or press a named key or combination (`enter`, `tab`, `escape`, `f5`, `ctrl+c`, `alt+tab`). |
| `rdp_wait` | Wait until the screen changes, instead of sleeping blindly. |
| `rdp_disconnect` | Close the session and stop the bridge. |
| `rdp_status` | Session state, transport, geometry, last error. |
| `rdp_clipboard` | Read the remote clipboard, or set it with `text` (VNC transport only). |

Screenshot options: `region`, `mark_region`, `highlight_cursor`, `cursor_x`/`cursor_y`, `max_width`/`max_height`, `format` (`png`/`jpeg`), `quality`, `ocr`/`ocr_lang`, `full_refresh`, `timeout`.

### Coordinates

Every coordinate is a **desktop pixel** (origin at the top-left of the whole screen). A screenshot reports the mapping back to desktop pixels, including the crop origin and any downscale factor. `rdp_mouse` also accepts `space: "image"` to interpret coordinates in the pixel space of the last screenshot.

The same guidance is injected into the model's system context on each agent-loop request, so the agent knows to screenshot first and disconnect when done.

### Consent

| Setting | Environment | Config / option |
| --- | --- | --- |
| protocol | `PI_RDP_PROTOCOL` | `protocol` |
| host | `RDP_HOST` | `host` |
| port | `RDP_PORT` | `port` (default `3389` RDP, `5900` VNC) |
| username | `RDP_USERNAME` | `username` (RDP only) |
| password | `RDP_PASSWORD` | `password` |
| domain | `RDP_DOMAIN` | `domain` |
| geometry | – | `width`, `height` |
| screenshot cap | – | `maxScreenshotWidth` |
| python | `PI_RDP_PYTHON` | `python` |
| consent | `PI_RDP_CONSENT` | `consent.mode`, `consent.screenshots`, `consent.timeoutMs` |

Config file: `~/.config/opencode-rdp-computer-use/config.json` (the legacy `~/.config/pi-rdp-computer-use/config.json` is read as a fallback).

```json
{
  "protocol": "vnc",
  "host": "127.0.0.1",
  "port": 5900,
  "password": "secret12",
  "consent": { "mode": "session", "timeoutMs": 180000 }
}
```

`consent.mode` works like the original:

| Mode | Behaviour |
| --- | --- |
| `session` (default) | One confirmation when the session is opened, then free rein for that session. |
| `action` | A confirmation before every click, drag, scroll and keystroke. |
| `off` | Never ask. |

Consent uses OpenCode's `ctx.permission.assert` with the custom actions `desktop.control` and `desktop.screenshot`. Unknown actions resolve to `ask` by default; you can add explicit rules (e.g. `{"desktop.control": "deny"}`) in `opencode.json(c)` to forbid desktop control entirely. A prompt that nobody answers within `consent.timeoutMs` (default 3 minutes) is retracted and counted as a refusal, so a forgotten dialog can never turn into unattended remote control. Set `consent.screenshots: true` to also gate screenshots and `rdp_wait`. The legacy `consent.actions` boolean is honoured (`false` → `off`, `true` → `action`).

## Slash command

`/rdp connect [host] | status | doctor | shot [path] | region x y w h [path] | disconnect`

Results are posted back to the session as synthetic messages instead of Pi's `ui.notify` toast.

## Mapping from the Pi original and known gaps

- `pi.registerTool` → `ctx.tool.transform` with JSON-Schema `input` and `execute(input, context)`. Context cancellation uses `context.signal`.
- Pi `details` → OpenCode tool `metadata`; Pi `content` arrays → OpenCode `content` parts (`text` and `file` with a base64 data URI).
- `pi.registerCommand` → `ctx.command.transform`; `ctx.ui.notify` → `ctx.session.synthetic`.
- `ctx.ui.confirm` consent → `ctx.permission.assert` (+ `list`/`reply` for the auto-decline timeout).
- `NAMESPACE.instructions` → `ctx.session.hook("context")` system-prompt injection; `NAMESPACE` itself → `editor.namespace`.
- `session_shutdown` bridge cleanup → the plugin's `setup` cleanup function.

Intentional gaps / differences:

- Pi's `exposure: "deferred"` and automatic `tool_search` activation have no V2 equivalent. All desktop tools are registered normally and are always available to the model.
- Pi's `label`, `promptSnippet`, `promptGuidelines` and `executionMode: "sequential"` have no V2 equivalents; the useful guidance was folded into each tool's `description`.
- OpenCode's permission UI controls the prompt's visual appearance; there is no Pi-style countdown rendered in the dialog. The plugin uses its own timer to retract unanswered requests and refuse the action.
- The plugin's `setup` is per loaded location, not per conversation session, so the bridge lives until the plugin unloads (or `rdp_disconnect` is called), rather than ending on every Pi `session_shutdown`.
- No TUI part: there is no terminal status widget or custom renderer, matching the non-TUI-focused original.
- Tools opt into Code Mode (`options.codemode: true`), which is the recommended V2 default.

## Troubleshooting

- **RDP connects but clicks are ignored** — the server is in view-only mode: `grdctl rdp disable-view-only` (and `gsettings set org.gnome.desktop.remote-desktop.vnc view-only false` for VNC).
- **VNC connects but the banner never arrives** — `gsettings set org.gnome.desktop.remote-desktop.vnc auth-method password`.
- **NLA rejects every client** — a known gnome-remote-desktop bug; the VNC transport is the workaround and `rdp_connect` falls back to it automatically.
- **"Session creation inhibited"** — the server still holds a session from an earlier client: `systemctl --user restart gnome-remote-desktop.service`.
- **The screen looks frozen** — `full_refresh: true` asks the VNC server for the whole framebuffer.

## Tests

The original extension had no automated tests, so none were ported. The Python bridge scripts are copied verbatim from the original project so the plugin is self-contained at runtime.

## License

MIT — 2026 hakergeniusz
