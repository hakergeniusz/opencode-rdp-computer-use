/**
 * opencode-rdp-computer-use
 *
 * Full desktop control for OpenCode V2 over RDP or VNC.
 *
 * The plugin never touches X11, the Wayland screencast portal or uinput: it
 * drives a headless Python bridge (bridge/rdp_bridge.py or
 * bridge/vnc_bridge.py) that receives the remote framebuffer as images for the
 * model and sends mouse/keyboard events back over the wire.
 *
 * This is a native OpenCode V2 plugin. It registers eight tools and one `/rdp`
 * slash command. See README.md for the mapping from the original Pi extension.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url))
const BRIDGE_DIR = join(EXTENSION_DIR, "..", "bridge")

/** Python packages each bridge needs; `uv run --with` installs them on the fly. */
const BRIDGE_DEPS: Record<string, string[]> = {
  rdp: ["aardwolf", "pillow"],
  vnc: ["pillow", "pycryptodomex"],
}

function bridgeScript(protocol: string): string {
  return join(BRIDGE_DIR, protocol === "vnc" ? "vnc_bridge.py" : "rdp_bridge.py")
}

const CONFIG_PATH = join(homedir(), ".config", "opencode-rdp-computer-use", "config.json")
/** The original Pi extension's config path, still honoured as a fallback. */
const LEGACY_CONFIG_PATH = join(homedir(), ".config", "pi-rdp-computer-use", "config.json")
const DEFAULT_TIMEOUT_MS = 60_000
const CONNECT_TIMEOUT_MS = 120_000
/** Ask the user for a decision for this long, then treat silence as a refusal. */
const CONSENT_TIMEOUT_MS = 180_000
const CONSENT_DECLINED =
  "The user did not grant consent (declined or no answer within the consent timeout). Nothing was sent to the desktop."

type Protocol = "rdp" | "vnc"
type ConsentMode = "session" | "action" | "off"

interface RdpConfig {
  /** "rdp" (default) or "vnc". Both expose the same tools. */
  protocol?: Protocol
  host?: string
  port?: number
  username?: string
  password?: string
  domain?: string
  width?: number
  height?: number
  /** Python used to run the bridge. Defaults to `uv run --with aardwolf`. */
  python?: string
  maxScreenshotWidth?: number
  /** Ask the user before acting on their desktop. */
  consent?: {
    /** "session" (default, one prompt per session), "action" (every action) or "off". */
    mode?: ConsentMode
    /** Legacy switch: false disables consent, true means "every action". */
    actions?: boolean
    /** Also ask before taking screenshots. Default: false. */
    screenshots?: boolean
    timeoutMs?: number
  }
}

interface BridgeResponse {
  id: number | null
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

function loadConfig(options: Record<string, unknown> = {}): RdpConfig {
  const config: RdpConfig = {}
  // Older file first so the new location wins when both exist.
  for (const path of [LEGACY_CONFIG_PATH, CONFIG_PATH]) {
    if (existsSync(path)) {
      try {
        Object.assign(config, JSON.parse(readFileSync(path, "utf8")) as RdpConfig)
      } catch {
        // A malformed config must not disable the plugin.
      }
    }
  }

  // Options come from the object form of the `plugins` entry in opencode.json(c).
  const fromOptions = options as RdpConfig
  if (fromOptions.consent && typeof fromOptions.consent === "object") {
    config.consent = { ...config.consent, ...fromOptions.consent }
    const { consent: _consent, ...rest } = fromOptions
    Object.assign(config, rest)
  } else {
    Object.assign(config, fromOptions)
  }

  const env = process.env
  if (env.PI_RDP_PROTOCOL === "rdp" || env.PI_RDP_PROTOCOL === "vnc") config.protocol = env.PI_RDP_PROTOCOL
  if (env.RDP_HOST) config.host = env.RDP_HOST
  if (env.RDP_PORT) config.port = Number(env.RDP_PORT)
  if (env.RDP_USERNAME) config.username = env.RDP_USERNAME
  if (env.RDP_PASSWORD) config.password = env.RDP_PASSWORD
  if (env.RDP_DOMAIN) config.domain = env.RDP_DOMAIN
  if (env.PI_RDP_PYTHON) config.python = env.PI_RDP_PYTHON
  if (env.PI_RDP_CONSENT === "session" || env.PI_RDP_CONSENT === "action" || env.PI_RDP_CONSENT === "off") {
    config.consent = { ...config.consent, mode: env.PI_RDP_CONSENT }
  }
  return config
}

/** Spawns and talks to the Python bridge over newline-delimited JSON. */
class Bridge {
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = ""
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private stderrLog: string[] = []
  private config: RdpConfig
  /** Bumped on every restart so a dying child's handlers cannot clobber the new one. */
  private generation = 0

  constructor(config: RdpConfig) {
    this.config = config
  }

  get protocol(): Protocol {
    return this.config.protocol === "vnc" ? "vnc" : "rdp"
  }

  get script(): string {
    return bridgeScript(this.protocol)
  }

  /** Drop the process so the next call re-reads the config (protocol switch). */
  restart(): void {
    const old = this.child
    this.child = undefined
    this.buffer = ""
    this.generation += 1
    if (this.pending.size > 0) {
      const reason = new Error("The desktop bridge was restarted; the request was cancelled.")
      for (const [, entry] of this.pending) entry.reject(reason)
      this.pending.clear()
    }
    old?.kill()
  }

  get running(): boolean {
    return this.child !== undefined && !this.child.killed
  }

  recentStderr(): string[] {
    return this.stderrLog.slice(-12)
  }

  private start(): void {
    if (this.running) return
    const script = this.script
    if (!existsSync(script)) {
      throw new Error(`Bridge script missing: ${script}`)
    }

    const explicitPython = this.config.python ?? process.env.PI_RDP_PYTHON
    const command = explicitPython ?? "uv"
    const withArgs = (BRIDGE_DEPS[this.protocol] ?? []).flatMap((dep) => ["--with", dep])
    const args = explicitPython
      ? [script]
      : ["run", "--quiet", "--python", "3.13", ...withArgs, "--no-project", "--", "python", script]

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    }) as ChildProcessWithoutNullStreams
    const generation = this.generation

    child.stdout.setEncoding("utf8")
    child.stdout.on("error", () => {}) // the exit handler cleans up pending calls
    child.stdout.on("data", (chunk: string) => {
      if (generation !== this.generation) return
      this.onStdout(chunk)
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("error", () => {})
    child.stderr.on("data", (chunk: string) => {
      if (generation !== this.generation) return
      for (const line of chunk.split("\n")) {
        if (line.trim()) this.stderrLog.push(line.trim())
      }
      if (this.stderrLog.length > 200) this.stderrLog = this.stderrLog.slice(-100)
    })
    // A dead child rejects writes with EPIPE; without a handler Node raises it
    // as an unhandled 'error' event and the host process goes down.
    child.stdin.on("error", (error) => {
      if (generation !== this.generation) return
      const reason = new Error(`Desktop bridge pipe failed: ${error.message}`)
      for (const [, entry] of this.pending) entry.reject(reason)
      this.pending.clear()
    })
    child.on("exit", (code) => {
      if (generation !== this.generation) return // a restart replaced this child
      this.child = undefined
      const reason = new Error(
        `Desktop bridge exited (code ${code ?? "null"}).${this.recentStderr().length ? `\n${this.recentStderr().join("\n")}` : ""}`,
      )
      for (const [, entry] of this.pending) entry.reject(reason)
      this.pending.clear()
    })
    child.on("error", (error) => {
      if (generation !== this.generation) return
      this.child = undefined
      for (const [, entry] of this.pending) entry.reject(new Error(`Desktop bridge failed: ${error.message}`))
      this.pending.clear()
    })

    this.child = child
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf("\n")
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.onLine(line)
      index = this.buffer.indexOf("\n")
    }
  }

  private onLine(line: string): void {
    let response: BridgeResponse
    try {
      response = JSON.parse(line) as BridgeResponse
    } catch {
      return
    }
    if (response.id === null || response.id === undefined) return
    const entry = this.pending.get(response.id)
    if (!entry) return
    this.pending.delete(response.id)
    if (response.ok) entry.resolve(response.result ?? {})
    else entry.reject(new Error(response.error ?? "Unknown bridge error"))
  }

  async call<T = Record<string, unknown>>(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      const error = new Error("The desktop action was cancelled.")
      error.name = "AbortError"
      throw error
    }
    this.start()
    const id = this.nextId++
    const payload = `${JSON.stringify({ id, cmd, args })}\n`
    const child = this.child
    if (!child) throw new Error("Desktop bridge is not running")

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        const error = new Error("The desktop action was cancelled.")
        error.name = "AbortError"
        entry.reject(error)
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener("abort", onAbort)
        reject(new Error(`Desktop bridge timed out after ${Math.round(timeoutMs / 1000)}s on '${cmd}'`))
      }, timeoutMs)
      if (signal) signal.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", onAbort)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      child.stdin.write(payload)
    })
  }

  stop(): void {
    const child = this.child
    if (!child) return
    this.child = undefined
    // Close stdin first: the bridge leaves its read loop, closes the socket and
    // lets the server tear the session down cleanly. Killing it outright leaves
    // a half-open session; gnome-remote-desktop then refuses every new
    // connection with "Session creation inhibited" until the session ends.
    try {
      child.stdin.end()
    } catch {
      // The pipe may already be closed.
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        // Already gone.
      }
    }, 3000)
    timer.unref?.()
    child.once("exit", () => clearTimeout(timer))
  }
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string }

function text(value: string): ContentPart {
  return { type: "text", text: value }
}

/** OpenCode tool file content carries inline media as a base64 data URI. */
function image(dataBase64: string, mimeType: string): ContentPart {
  return {
    type: "file",
    uri: `data:${mimeType};base64,${dataBase64}`,
    mime: mimeType,
    name: mimeType === "image/jpeg" ? "screenshot.jpg" : "screenshot.png",
  }
}

interface Region {
  x: number
  y: number
  width: number
  height: number
}

interface CaptureInfo {
  region: Region | null
  scale: number
  desktop: { width: number; height: number } | null
}

/** Structural shape of the OpenCode tool execution context used here. */
interface ToolCtx {
  sessionID: string
  agent?: string
  messageID: string
  id: string
  signal?: AbortSignal
}

interface PermissionLike {
  assert(input: unknown): Promise<void>
  list(input: { sessionID: string }): Promise<readonly { id: string; action: string }[]>
  reply(input: { sessionID: string; requestID: string; decision: "once" | "always" | "reject" }): Promise<unknown>
}

const NAMESPACE = {
  name: "desktop",
  description:
    "Control a remote desktop: connect, capture the screen (full or a region with the cursor highlighted), click, scroll, type, disconnect.",
  instructions: [
    "Capture the screen with rdp_screenshot before acting, read pixel positions off the image,",
    "then act with rdp_mouse / rdp_keyboard. Coordinates are desktop pixels: a region capture",
    "reports the origin of the crop so image pixels can be converted to desktop pixels.",
    "Always rdp_disconnect when you are done with the desktop.",
  ].join(" "),
}

const regionSchema = {
  type: "object" as const,
  properties: {
    x: { type: "number" as const, description: "Left edge in desktop pixels" },
    y: { type: "number" as const, description: "Top edge in desktop pixels" },
    width: { type: "number" as const, description: "Width in desktop pixels" },
    height: { type: "number" as const, description: "Height in desktop pixels" },
  },
  required: ["x", "y", "width", "height"],
  additionalProperties: false as const,
}

export default Plugin.define({
  id: "opencode-rdp-computer-use",
  async setup(ctx) {
    const config = loadConfig(ctx.options as Record<string, unknown>)
    const bridge = new Bridge(config)

    /** Credentials of the live session, so a dropped connection can be restored. */
    let liveConnection: {
      host: string
      port: number
      protocol: Protocol
      username?: string
      password?: string
      domain?: string
      width?: number
      height?: number
    } | null = null
    /** Geometry of the last capture, used to map image pixels to desktop pixels. */
    let lastCapture: CaptureInfo | null = null
    /** Sessions that already granted control. */
    const sessionConsent = new Set<string>()

    const permission = ctx.permission as unknown as PermissionLike

    const consentMode = (): ConsentMode => {
      const configured = config.consent?.mode
      if (configured === "session" || configured === "action" || configured === "off") return configured
      // Legacy config: consent.actions === false used to disable the gate.
      if (config.consent?.actions === false) return "off"
      if (config.consent?.actions === true) return "action"
      return "session"
    }

    /**
     * Ask the user before touching their desktop through OpenCode's permission
     * system. An unanswered prompt auto-declines, so a forgotten prompt can
     * never turn into unattended remote control.
     */
    const requireConsent = async (
      toolCtx: ToolCtx,
      action: string,
      title: string,
      detail: string,
    ): Promise<void> => {
      const timeout = config.consent?.timeoutMs ?? CONSENT_TIMEOUT_MS
      const input = {
        sessionID: toolCtx.sessionID,
        agent: toolCtx.agent,
        action,
        resources: [detail],
        save: [],
        metadata: { title, detail },
        source: { type: "tool", messageID: toolCtx.messageID, id: toolCtx.id },
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(async () => {
          // Retract the still-pending permission request so no dialog lingers.
          try {
            const pending = await permission.list({ sessionID: toolCtx.sessionID })
            for (const request of pending) {
              if (request.action === action) {
                await permission.reply({
                  sessionID: toolCtx.sessionID,
                  requestID: request.id,
                  decision: "reject",
                })
              }
            }
          } catch {
            // Best effort; the timeout still refuses the action.
          }
          reject(new Error(CONSENT_DECLINED))
        }, timeout)
      })
      try {
        await Promise.race([permission.assert(input), expired])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    /** Gate an action according to the configured consent mode. */
    const gate = async (
      toolCtx: ToolCtx,
      kind: "actions" | "screenshots",
      title: string,
      detail: string,
    ): Promise<void> => {
      const mode = consentMode()
      if (mode === "off") return
      const action = kind === "screenshots" ? "desktop.screenshot" : "desktop.control"
      if (kind === "screenshots") {
        if (!config.consent?.screenshots) return
        await requireConsent(toolCtx, action, title, detail)
        return
      }
      if (mode === "session") {
        if (sessionConsent.has(toolCtx.sessionID)) return
        await requireConsent(toolCtx, action, title, detail)
        sessionConsent.add(toolCtx.sessionID)
        return
      }
      await requireConsent(toolCtx, action, title, detail)
    }

    const resolveTarget = (params: { host?: string; port?: number }): {
      host: string
      port: number
      explicitPort: boolean
    } => {
      const host = params.host ?? config.host
      if (!host) {
        throw new Error(
          `No desktop host configured. Pass host, set RDP_HOST, or create ${CONFIG_PATH} with {"host","username","password"}.`,
        )
      }
      const protocol: Protocol = config.protocol === "vnc" ? "vnc" : "rdp"
      return {
        host,
        port: params.port ?? config.port ?? (protocol === "vnc" ? 5900 : 3389),
        explicitPort: params.port !== undefined || config.port !== undefined,
      }
    }

    /** Open a session, falling back to the other transport when the first fails. */
    const openSession = async (
      target: { host: string; port: number; explicitPort: boolean },
      credentials: {
        username?: string
        password?: string
        domain?: string
        width?: number
        height?: number
      },
      requested?: Protocol,
    ): Promise<{ result: Record<string, unknown>; protocol: Protocol; port: number }> => {
      const primary: Protocol = config.protocol === "vnc" ? "vnc" : "rdp"
      const order: Protocol[] = requested ? [requested] : primary === "rdp" ? ["rdp", "vnc"] : ["vnc", "rdp"]
      let lastError: unknown
      for (const protocol of order) {
        // A fallback transport uses its own default port unless one was set explicitly.
        const port =
          protocol === primary || target.explicitPort
            ? target.port
            : protocol === "vnc"
              ? 5900
              : 3389
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            config.protocol = protocol
            bridge.restart()
            const result = await bridge.call(
              "connect",
              {
                host: target.host,
                port,
                username: credentials.username ?? "",
                password: credentials.password ?? "",
                domain: credentials.domain,
                width: credentials.width,
                height: credentials.height,
              },
              CONNECT_TIMEOUT_MS,
            )
            return { result, protocol, port }
          } catch (error) {
            lastError = error
            const message = error instanceof Error ? error.message : String(error)
            // The server may still be tearing down the previous session
            // ("Session creation inhibited"): wait and try again.
            const transient = /reset|inhibited|connection lost|refused|timed out/i.test(message)
            if (!transient || attempt === 3) break
            await new Promise((resolve) => setTimeout(resolve, 4000 * attempt))
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError))
    }

    /** Re-open the session after the bridge or the server dropped it. */
    const ensureSession = async (): Promise<void> => {
      if (!liveConnection) {
        throw new Error("No desktop session. Call rdp_connect first.")
      }
      await openSession(
        { host: liveConnection.host, port: liveConnection.port, explicitPort: true },
        {
          username: liveConnection.username,
          password: liveConnection.password,
          domain: liveConnection.domain,
          width: liveConnection.width,
          height: liveConnection.height,
        },
        liveConnection.protocol,
      )
      lastCapture = null
    }

    /** Run a bridge command, transparently reconnecting once if the session died. */
    const call = async <T = Record<string, unknown>>(
      cmd: string,
      args: Record<string, unknown> = {},
      timeoutMs = DEFAULT_TIMEOUT_MS,
      signal?: AbortSignal,
    ): Promise<T> => {
      try {
        return await bridge.call<T>(cmd, args, timeoutMs, signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const lost = /not connected|no desktop session|connection lost|bridge exited|bridge failed|pipe failed/i.test(
          message,
        )
        if (!lost || !liveConnection) throw error
        await ensureSession()
        return bridge.call<T>(cmd, args, timeoutMs, signal)
      }
    }

    const screenshotContent = (result: Record<string, unknown>) => {
      const data = result.image_base64 as string | undefined
      const mimeType = (result.mime_type as string) ?? "image/png"
      const desktop = result.desktop as { width: number; height: number } | undefined
      const region = (result.region as Region | null) ?? null
      const scale = Number(result.scale ?? 1) || 1
      const cursor = result.cursor as { x: number | null; y: number | null; visible: boolean } | undefined
      const ocr = result.ocr_text as string | null | undefined

      const lines: string[] = []
      if (ocr) {
        lines.push(`Text on screen (OCR):\n${ocr}`)
      } else if (result.ocr_error) {
        lines.push(`OCR unavailable: ${result.ocr_error}`)
      }
      if (region) {
        lines.push(
          `Region ${region.width}x${region.height} of the ${desktop?.width}x${desktop?.height} desktop, origin at desktop (${region.x}, ${region.y}).`,
        )
        lines.push(
          `Image pixel (ix, iy) = desktop (${region.x} + ix/${scale}, ${region.y} + iy/${scale}). Use those desktop coordinates for rdp_mouse.`,
        )
      } else {
        lines.push(
          `Full desktop ${result.width}x${result.height}${scale !== 1 ? ` (downscaled from ${desktop?.width}x${desktop?.height}, scale ${scale})` : ""}.`,
        )
        lines.push(`Image pixel (ix, iy) = desktop (ix/${scale}, iy/${scale}).`)
      }
      if (cursor && cursor.x !== null && cursor.y !== null) {
        lines.push(
          cursor.visible
            ? `Mouse cursor at desktop (${cursor.x}, ${cursor.y}), marked with a magenta crosshair.`
            : `Mouse cursor at desktop (${cursor.x}, ${cursor.y}), outside this capture.`,
        )
      }

      const content: ContentPart[] = []
      if (data) content.push(image(data, mimeType))
      content.push(text(lines.join("\n")))
      return {
        content,
        metadata: {
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          desktop,
          region,
          scale,
          cursor,
        },
      }
    }

    /** Convert a coordinate pair from the model's space into desktop pixels. */
    const toDesktop = (
      x: number,
      y: number,
      space: "desktop" | "image",
    ): { x: number; y: number; clamped: boolean } => {
      let desktopX = x
      let desktopY = y
      if (space === "image" && lastCapture) {
        const originX = lastCapture.region?.x ?? 0
        const originY = lastCapture.region?.y ?? 0
        desktopX = originX + x / (lastCapture.scale || 1)
        desktopY = originY + y / (lastCapture.scale || 1)
      }
      let clamped = false
      const width = lastCapture?.desktop?.width
      const height = lastCapture?.desktop?.height
      if (width && desktopX >= width) {
        desktopX = width - 1
        clamped = true
      }
      if (height && desktopY >= height) {
        desktopY = height - 1
        clamped = true
      }
      if (desktopX < 0) {
        desktopX = 0
        clamped = true
      }
      if (desktopY < 0) {
        desktopY = 0
        clamped = true
      }
      return { x: Math.round(desktopX), y: Math.round(desktopY), clamped }
    }

    /** Report a slash-command result as a synthetic session message. */
    const notify = async (sessionID: string, message: string): Promise<void> => {
      await ctx.session.synthetic({ sessionID, text: message })
    }

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.namespace({ name: NAMESPACE.name, description: NAMESPACE.description })

      editor.add({
        name: "rdp_connect",
        description:
          "Open a remote desktop session (RDP or VNC) so the screen can be captured and the mouse and keyboard driven. " +
          "Returns the desktop size in pixels, which is the coordinate space for rdp_mouse.",
        input: {
          type: "object",
          properties: {
            host: { type: "string", description: "Desktop server host, e.g. 192.168.1.20 or localhost" },
            port: { type: "number", description: "Server port (default 3389 for RDP, 5900 for VNC)" },
            protocol: {
              type: "string",
              enum: ["rdp", "vnc"],
              description: "Transport to use. Default: the configured one, falling back to the other if it fails.",
            },
            username: { type: "string", description: "Account name on the remote desktop (RDP only)" },
            password: { type: "string", description: "Account password (prefer RDP_PASSWORD or the config file)" },
            domain: { type: "string", description: "Optional NTLM domain" },
            width: { type: "number", description: "Requested desktop width (default 1920)" },
            height: { type: "number", description: "Requested desktop height (default 1080)" },
          },
          additionalProperties: false,
        },
        options: { namespace: NAMESPACE.name, codemode: true },
        execute: async (input, context) => {
          const params = input as Record<string, any>
          Object.assign(config, loadConfig(ctx.options as Record<string, unknown>))
          const target = resolveTarget(params)
          const username = params.username ?? config.username
          let password = params.password ?? config.password
          const requested = params.protocol as Protocol | undefined
          if (password === undefined) {
            // VNC servers may run without authentication (security type
            // "None"); RDP always needs credentials.
            const effective: Protocol = requested ?? (config.protocol === "vnc" ? "vnc" : "rdp")
            if (effective === "vnc") password = ""
            else throw new Error("Missing desktop password (parameter, RDP_PASSWORD, or the config file).")
          }

          await gate(
            context,
            "actions",
            "Allow remote desktop control?",
            `OpenCode wants to open a desktop session to ${target.host}:${target.port}.`,
          )

          const { result, protocol, port } = await openSession(
            target,
            {
              username,
              password,
              domain: params.domain ?? config.domain,
              width: params.width ?? config.width,
              height: params.height ?? config.height,
            },
            requested,
          )

          liveConnection = {
            host: target.host,
            port,
            protocol,
            username,
            password,
            domain: params.domain ?? config.domain,
            width: params.width ?? config.width,
            height: params.height ?? config.height,
          }
          sessionConsent.add(context.sessionID)
          lastCapture = null

          const desktop = result.desktop as { width: number; height: number } | undefined
          return {
            content: [
              text(
                `Connected to ${target.host}:${port} over ${protocol.toUpperCase()}` +
                  `${username ? ` as ${username}` : ""}. ` +
                  (desktop
                    ? `The desktop is ${desktop.width}x${desktop.height} pixels; those are the coordinates rdp_mouse uses.`
                    : "The desktop size is not known yet; take a screenshot to learn it."),
              ),
            ],
            metadata: { ...result, password: undefined, protocol },
          }
        },
      })

      editor.add({
        name: "rdp_screenshot",
        description:
          "Capture the remote desktop as an image: the whole screen, or just a region (part of the screen) by passing " +
          "region {x, y, width, height}. The mouse cursor is highlighted with a magenta crosshair. " +
          "The result states the crop origin and scale so image pixels can be converted to desktop pixels for rdp_mouse. " +
          "Take a screenshot before every decision that depends on what is on screen, and read pixel positions off the image.",
        input: {
          type: "object",
          properties: {
            region: { ...regionSchema, description: "Capture only this part of the screen. Omit for the full desktop." },
            mark_region: {
              ...regionSchema,
              description: "Outline this area on a full-desktop capture, to show where to look.",
            },
            highlight_cursor: { type: "boolean", description: "Draw a magenta crosshair at the mouse cursor (default true)" },
            cursor_x: { type: "number", description: "Cursor x in desktop pixels, if it is known" },
            cursor_y: { type: "number", description: "Cursor y in desktop pixels, if it is known" },
            max_width: { type: "number", description: "Downscale so the image is at most this wide" },
            max_height: { type: "number", description: "Downscale so the image is at most this tall" },
            format: { type: "string", enum: ["png", "jpeg"], description: "Image format (default png)" },
            quality: { type: "number", description: "JPEG quality, 20-95 (default 85)" },
            ocr: { type: "boolean", description: "Also return the text on screen, read with tesseract" },
            ocr_lang: { type: "string", description: "tesseract language, e.g. 'eng' (default)" },
            full_refresh: {
              type: "boolean",
              description: "Ask the VNC server for the whole framebuffer instead of only what changed (ignored on RDP)",
            },
            timeout: { type: "number", description: "Seconds to wait for a fresh frame (default 6)" },
          },
          additionalProperties: false,
        },
        options: { namespace: NAMESPACE.name, codemode: true },
        execute: async (input, context) => {
          const params = input as Record<string, any>
          await gate(context, "screenshots", "Allow a screenshot?", "OpenCode wants to capture a screenshot of your desktop.")
          const result = await call(
            "screenshot",
            {
              region: params.region,
              mark_region: params.mark_region,
              highlight_cursor: params.highlight_cursor ?? true,
              cursor_x: params.cursor_x,
              cursor_y: params.cursor_y,
              max_width: params.max_width ?? config.maxScreenshotWidth,
              max_height: params.max_height,
              format: params.format ?? "png",
              quality: params.quality ?? 85,
              ocr: params.ocr ?? false,
              ocr_lang: params.ocr_lang ?? "eng",
              full_refresh: params.full_refresh ?? false,
              timeout: params.timeout ?? 6,
            },
            DEFAULT_TIMEOUT_MS,
            context.signal,
          )
          lastCapture = {
            region: (result.region as Region | null) ?? null,
            scale: Number(result.scale ?? 1) || 1,
            desktop: (result.desktop as { width: number; height: number }) ?? null,
          }
          return screenshotContent(result)
        },
      })

      editor.add({
        name: "rdp_mouse",
        description:
          "Control the mouse on the remote desktop: left, right or middle click at any desktop pixel position, move the pointer, " +
          "drag from one point to another, press or release a held button, or scroll the wheel up, down, left or right. " +
          "Coordinates are desktop pixels, as reported by rdp_connect and rdp_screenshot. " +
          "Pass space: 'image' to interpret x/y in the pixel space of the last screenshot.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["click", "move", "drag", "scroll", "down", "up"],
              description: "What to do (default click)",
            },
            x: { type: "number", description: "Desktop x pixel" },
            y: { type: "number", description: "Desktop y pixel" },
            button: {
              type: "string",
              enum: ["left", "right", "middle"],
              description: "Mouse button (default left)",
            },
            clicks: { type: "number", description: "Number of clicks, 2 for a double click" },
            direction: {
              type: "string",
              enum: ["up", "down", "left", "right"],
              description: "Scroll direction (default down). left/right need the VNC transport",
            },
            amount: { type: "number", description: "Scroll ticks (default 3)" },
            x1: { type: "number", description: "Drag start x in desktop pixels" },
            y1: { type: "number", description: "Drag start y in desktop pixels" },
            x2: { type: "number", description: "Drag end x in desktop pixels" },
            y2: { type: "number", description: "Drag end y in desktop pixels" },
            space: {
              type: "string",
              enum: ["desktop", "image"],
              description: "Coordinate space of x and y: 'desktop' pixels, or 'image' pixels of the last screenshot (default desktop)",
            },
            capture_after: { type: "boolean", description: "Return a fresh screenshot after the action" },
          },
          additionalProperties: false,
        },
        options: { namespace: NAMESPACE.name, codemode: true },
        execute: async (input, context) => {
          const params = input as Record<string, any>
          const action = params.action ?? "click"
          const button = params.button ?? "left"
          const space = params.space ?? "desktop"
          await gate(context, "actions", "Allow this mouse action?", `OpenCode wants to ${action} on the remote desktop.`)

          let result: Record<string, unknown> = {}
          let message = ""
          let clamped = false

          if (action === "scroll") {
            const direction = params.direction ?? "down"
            const amount = params.amount ?? 3
            if ((direction === "left" || direction === "right") && bridge.protocol === "rdp") {
              throw new Error("Horizontal scrolling needs the VNC transport; over RDP the wheel is vertical only.")
            }
            // Without an explicit position the bridge scrolls at the current pointer location.
            const at =
              params.x !== undefined && params.y !== undefined ? toDesktop(params.x, params.y, space) : null
            clamped = at?.clamped ?? false
            result = await call("scroll", { direction, amount, ...(at ? { x: at.x, y: at.y } : {}) }, DEFAULT_TIMEOUT_MS, context.signal)
            message = at
              ? `Scrolled ${direction} ${amount} tick(s) at (${at.x}, ${at.y}).`
              : `Scrolled ${direction} ${amount} tick(s).`
          } else if (action === "drag") {
            if (params.x1 === undefined || params.y1 === undefined || params.x2 === undefined || params.y2 === undefined) {
              throw new Error("A drag needs x1, y1, x2 and y2.")
            }
            const from = toDesktop(params.x1, params.y1, space)
            const to = toDesktop(params.x2, params.y2, space)
            clamped = from.clamped || to.clamped
            result = await call("drag", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, button, steps: 12 }, DEFAULT_TIMEOUT_MS, context.signal)
            message = `Dragged the ${button} button from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).`
          } else if (action === "move") {
            if (params.x === undefined || params.y === undefined) {
              throw new Error("A move needs x and y.")
            }
            const at = toDesktop(params.x, params.y, space)
            clamped = at.clamped
            result = await call("move", { x: at.x, y: at.y }, DEFAULT_TIMEOUT_MS, context.signal)
            message = `Moved the pointer to (${at.x}, ${at.y}).`
          } else if (action === "down" || action === "up") {
            if (params.x === undefined || params.y === undefined) {
              throw new Error(`${action} needs x and y.`)
            }
            const at = toDesktop(params.x, params.y, space)
            clamped = at.clamped
            result = await call("button", { x: at.x, y: at.y, button, action }, DEFAULT_TIMEOUT_MS, context.signal)
            message = `${action === "down" ? "Pressed" : "Released"} the ${button} button at (${at.x}, ${at.y}).`
          } else {
            if (params.x === undefined || params.y === undefined) {
              throw new Error("A click needs x and y.")
            }
            const at = toDesktop(params.x, params.y, space)
            clamped = at.clamped
            result = await call("click", { x: at.x, y: at.y, button, clicks: params.clicks ?? 1 }, DEFAULT_TIMEOUT_MS, context.signal)
            message = `Clicked the ${button} button ${params.clicks ?? 1} time(s) at (${at.x}, ${at.y}).`
          }
          if (clamped) {
            message += " The requested coordinates were outside the desktop; they were clamped to its bounds."
          }

          if (params.capture_after) {
            const shot = await call("screenshot", { highlight_cursor: true, timeout: 6 }, DEFAULT_TIMEOUT_MS, context.signal)
            lastCapture = {
              region: (shot.region as Region | null) ?? null,
              scale: Number(shot.scale ?? 1) || 1,
              desktop: (shot.desktop as { width: number; height: number }) ?? null,
            }
            const content: ContentPart[] = []
            if (shot.image_base64) content.push(image(shot.image_base64 as string, (shot.mime_type as string) ?? "image/png"))
            content.push(text(message))
            return { content, metadata: { ...result, capture: { width: shot.width, height: shot.height } } }
          }

          return { content: [text(message)], metadata: result }
        },
      })

      editor.add({
        name: "rdp_keyboard",
        description:
          "Type text into the focused window on the remote desktop, or press a named key or key combination such as " +
          "'enter', 'tab', 'escape', 'f5', 'ctrl+c', 'ctrl+shift+t' or 'alt+tab'. Text is sent as Unicode key events, " +
          "so it works with any keyboard layout.",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type. Newlines press Enter, tabs press Tab." },
            key: { type: "string", description: "Named key or combination, e.g. 'enter', 'escape', 'ctrl+c', 'alt+tab'" },
            action: {
              type: "string",
              enum: ["press", "down", "up"],
              description: "press (default), or hold down/up separately",
            },
            interval: { type: "number", description: "Delay between keystrokes in seconds (default 0.01)" },
            capture_after: { type: "boolean", description: "Return a fresh screenshot after typing" },
          },
          additionalProperties: false,
        },
        options: { namespace: NAMESPACE.name, codemode: true },
        execute: async (input, context) => {
          const params = input as Record<string, any>
          if (params.text === undefined && params.key === undefined) {
            throw new Error("Give text to type, a key to press, or both.")
          }
          await gate(
            context,
            "actions",
            "Allow typing?",
            params.text !== undefined
              ? `OpenCode wants to type ${String(params.text).length} characters into the focused window.`
              : `OpenCode wants to press ${params.key}.`,
          )

          const parts: string[] = []
          let result: Record<string, unknown> = {}
          if (params.text !== undefined) {
            result = await call("type", { text: params.text, interval: params.interval ?? 0.01 }, DEFAULT_TIMEOUT_MS, context.signal)
            parts.push(`Typed ${String(params.text).length} characters`)
          }
          if (params.key !== undefined) {
            result = await call("key", { key: params.key, action: params.action ?? "press" }, DEFAULT_TIMEOUT_MS, context.signal)
            parts.push(`pressed ${params.key}`)
          }

          if (params.capture_after) {
            const shot = await call("screenshot", { highlight_cursor: true, timeout: 6 }, DEFAULT_TIMEOUT_MS, context.signal)
            lastCapture = {
              region: (shot.region as Region | null) ?? null,
              scale: Number(shot.scale ?? 1) || 1,
              desktop: (shot.desktop as { width: number; height: number }) ?? null,
            }
            const content: ContentPart[] = []
            if (shot.image_base64) content.push(image(shot.image_base64 as string, (shot.mime_type as string) ?? "image/png"))
            content.push(text(`${parts.join(", ")}.`))
            return { content, metadata: { ...result, capture: { width: shot.width, height: shot.height } } }
          }

          return { content: [text(`${parts.join(", ")}.`)], metadata: result }
        },
      })

      editor.add({
        name: "rdp_wait",
        description:
          "Wait until the remote screen changes, or until the timeout expires. Use it after an action that should " +
          "trigger a UI update instead of sleeping blindly, so the agent continues as soon as the screen updates.",
        input: {
          type: "object",
          properties: {
            timeout: { type: "number", description: "Seconds to wait at most (default 10)" },
            region: { ...regionSchema, description: "Only watch this part of the screen" },
          },
          additionalProperties: false,
        },
        options: { namespace: NAMESPACE.name, codemode: true },
        execute: async (input, context) => {
          const params = input as Record<string, any>
          await gate(context, "screenshots", "Allow watching the screen?", "OpenCode wants to wait for the screen to change.")
          const result = await call(
            "wait",
            { timeout: params.timeout ?? 10, region: params.region },
            Math.round((params.timeout ?? 10) * 1000) + 15_000,
            context.signal,
          )
          const changed = Boolean(result.changed)
          return {
            content: [
              text(
                changed
                  ? `The screen changed after ${result.waited_ms} ms.`
                  : `The screen did not change within ${params.timeout ?? 10} s.`,
              ),
            ],
            metadata: result,
          }
        },
      })

      editor.add({
        name: "rdp_disconnect",
        description: "Close the remote desktop session and stop the bridge process.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: NAMESPACE.name, codemode: true },
        execute: async () => {
          if (!liveConnection && !bridge.running) {
            return { content: [text("No desktop session was open.")], metadata: { connected: false } }
          }
          let result: Record<string, unknown> = { connected: false }
          try {
            result = await call("disconnect", {}, 30_000)
          } finally {
            bridge.stop()
            liveConnection = null
            lastCapture = null
            sessionConsent.clear()
          }
          return { content: [text("Desktop session closed.")], metadata: result }
        },
      })

      editor.add({
        name: "rdp_status",
        description:
          "Report the state of the remote desktop session: whether it is connected, which transport is in use, " +
          "the desktop size and the last error.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: NAMESPACE.name, codemode: true },
        execute: async () => {
          if (!bridge.running) {
            // Do not spawn a bridge just to be told there is no session.
            const result = {
              connected: false,
              protocol: bridge.protocol,
              session: liveConnection
                ? {
                    host: liveConnection.host,
                    port: liveConnection.port,
                    protocol: liveConnection.protocol,
                    note: "The bridge is not running; the next tool call reconnects with the stored credentials.",
                  }
                : { note: "No session yet. Call rdp_connect." },
            }
            return { content: [text(JSON.stringify(result, null, 2))], metadata: result }
          }
          const result = await call("status", {}, 20_000)
          return { content: [text(JSON.stringify(result, null, 2))], metadata: result }
        },
      })

      editor.add({
        name: "rdp_clipboard",
        description:
          "Read the remote clipboard, or set it by passing text (VNC transport only). Setting the clipboard and then " +
          "pressing ctrl+v is far faster and more reliable than typing long text with rdp_keyboard. Reading requires " +
          "the VNC transport too: only it receives clipboard updates from the server.",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "Set the remote clipboard to this text instead of reading it (VNC only)" },
          },
          additionalProperties: false,
        },
        options: { namespace: NAMESPACE.name, codemode: true },
        execute: async (input, context) => {
          const params = input as Record<string, any>
          if (params.text !== undefined && bridge.protocol === "rdp") {
            throw new Error("Setting the clipboard requires the VNC transport (ClientCutText) — it is not available over RDP.")
          }
          const result = await call("clipboard", params.text === undefined ? {} : { text: params.text }, 20_000, context.signal)
          if (params.text !== undefined) {
            const length = Number(result.length ?? String(params.text).length)
            return {
              content: [text(`Set the remote clipboard to ${length} characters. Paste it in a remote window with rdp_keyboard key "ctrl+v".`)],
              metadata: { set: true, length },
            }
          }
          const value = (result.text as string) ?? ""
          return {
            content: [text(value || "The remote clipboard is empty or not available on this transport.")],
            metadata: { set: false, length: value.length },
          }
        },
      })
    })

    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: "rdp",
        description:
          "RDP computer use: /rdp connect [host] | status | doctor | shot [path] | region x y w h [path] | disconnect",
        execute: async ({ sessionID, prompt }) => {
          const [subcommand, ...rest] = String(prompt.text ?? "").trim().split(/\s+/)
          try {
            switch (subcommand) {
              case "connect": {
                const target = resolveTarget({ host: rest[0] })
                const password = config.password ?? (config.protocol === "vnc" ? "" : undefined)
                if (password === undefined) {
                  throw new Error("No password configured. Set RDP_PASSWORD or the config file.")
                }
                const { protocol, port } = await openSession(target, {
                  username: config.username,
                  password,
                  domain: config.domain,
                  width: config.width,
                  height: config.height,
                })
                liveConnection = {
                  host: target.host,
                  port,
                  protocol,
                  username: config.username,
                  password,
                  domain: config.domain,
                  width: config.width,
                  height: config.height,
                }
                sessionConsent.add(sessionID)
                await notify(sessionID, `Connected to ${target.host}:${port} over ${protocol.toUpperCase()}.`)
                return
              }
              case "status": {
                const status = await call("status", {}, 20_000)
                await notify(sessionID, `RDP status: ${JSON.stringify(status)}`)
                return
              }
              case "doctor": {
                const doctor = await call("doctor", {}, 30_000)
                await notify(sessionID, `RDP doctor:\n${JSON.stringify(doctor, null, 2)}`)
                return
              }
              case "shot": {
                const result = await call("screenshot", { highlight_cursor: true, timeout: 6 })
                const target = rest[0] ?? join("/tmp", `rdp-shot-${Date.now()}.png`)
                writeFileSync(target, Buffer.from(result.image_base64 as string, "base64"))
                await notify(sessionID, `Saved ${result.width}x${result.height} screenshot to ${target}`)
                return
              }
              case "region": {
                const [x, y, width, height] = rest.map((value) => Number(value))
                if ([x, y, width, height].some((value) => !Number.isFinite(value))) {
                  throw new Error("Usage: /rdp region x y width height [path]")
                }
                const result = await call("screenshot", {
                  region: { x, y, width, height },
                  highlight_cursor: true,
                  timeout: 6,
                })
                const target = rest[4] ?? join("/tmp", `rdp-region-${Date.now()}.png`)
                writeFileSync(target, Buffer.from(result.image_base64 as string, "base64"))
                await notify(sessionID, `Saved ${result.width}x${result.height} region to ${target}`)
                return
              }
              case "disconnect": {
                await call("disconnect", {}, 30_000)
                bridge.stop()
                liveConnection = null
                lastCapture = null
                sessionConsent.clear()
                await notify(sessionID, "Desktop session closed.")
                return
              }
              default:
                await notify(
                  sessionID,
                  "Usage: /rdp connect [host] | status | doctor | shot [path] | region x y w h [path] | disconnect",
                )
            }
          } catch (error) {
            await notify(sessionID, `RDP: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
      })
    })

    // Fold the original namespace guidance into the model's system instructions.
    const contextRegistration = await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: NAMESPACE.instructions })
    })

    return async () => {
      bridge.stop()
      await Promise.allSettled([
        toolRegistration.dispose(),
        commandRegistration.dispose(),
        contextRegistration.dispose(),
      ])
    }
  },
})
