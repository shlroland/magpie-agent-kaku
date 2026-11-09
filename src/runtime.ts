import fs from "node:fs"
import path from "node:path"

import { BridgeError, publicError, redact } from "./errors.js"
import {
  ensurePrivateDir,
  existingMode,
  readBridge,
  readText,
  sha256,
  tightenPrivate,
  writeText,
  type BridgeView,
} from "./io.js"
import { parseRoleOptions, type RoleOptions } from "./options.js"
import { resolvePaths, runtimeHome, type BridgePaths } from "./paths.js"
import { loadState, sameState, serializeState, stateSecrets, type SavedState } from "./state.js"
import { project, type Intent, type SyncReport } from "./sync.js"

const PRIVATE = 0o600

export interface Runtime {
  flush(): void
  stop(): void
  updateOptions(options: unknown): void
  report(): SyncReport
}

export interface RuntimeOptions {
  options?: unknown
  home?: string
  env?: NodeJS.ProcessEnv
  debounceMs?: number
  log?: (line: string) => void
}

interface Pending {
  previous: SavedState
  next: SavedState
  previousHash: string
  nextHash: string
}

export function startBridge(settings: RuntimeOptions = {}): Runtime {
  let options = settings.options
  const env = settings.env ?? process.env
  const home = settings.home ?? runtimeHome(env)
  const ignoreXdg = settings.home !== undefined || Boolean(env.MAGPIE_KAKU_HOME)
  const debounceMs = settings.debounceMs ?? 150
  let lastLog = ""
  const emit = settings.log ?? ((line: string) => console.error(line))
  const log = (line: string) => {
    if (line === lastLog) return
    lastLog = line
    emit(line)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let locked = false
  let rerun = false
  let lastReport: SyncReport = {
    action: "noop",
    wroteConfig: false,
    wroteState: false,
    conflicts: [],
    connected: false,
  }
  const watchers: fs.FSWatcher[] = []
  const watched = new Set<string>()

  const run = (mode: "auto" | "sync" | "restore"): SyncReport => {
    if (locked) {
      rerun = true
      return lastReport
    }
    locked = true
    try {
      let spins = 0
      do {
        rerun = false
        lastReport = runOnce(mode, options, home, env, log, ignoreXdg)
        spins += 1
      } while (rerun && spins < 3)
      return lastReport
    } finally {
      locked = false
    }
  }

  const schedule = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      try {
        run("auto")
      } catch {
        // runOnce already logs and fails closed.
      }
    }, debounceMs)
    timer.unref?.()
  }

  const arm = (directory: string) => {
    if (watched.has(directory) || !fs.existsSync(directory)) return
    try {
      const watcher = fs.watch(directory, schedule)
      watcher.on("error", () => {})
      watcher.unref?.()
      watchers.push(watcher)
      watched.add(directory)
    } catch {
      log("kaku: config directory could not be watched")
    }
  }

  try {
    run("auto")
  } catch {
    // The first pass logs its own failure.
  }
  const paths = safePaths(options, home, env, ignoreXdg)
  if (paths) {
    ensurePrivateDir(paths.directory)
    arm(paths.directory)
    arm(path.dirname(paths.config))
    arm(path.dirname(paths.bridge))
  }

  return {
    flush() {
      if (timer) clearTimeout(timer)
      timer = undefined
      run("auto")
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
    updateOptions(next: unknown) {
      options = next
      this.flush()
    },
    report: () => lastReport,
  }
}

export function commandSync(settings: RuntimeOptions, command: "sync" | "restore" | "status"): SyncReport {
  const env = settings.env ?? process.env
  const home = settings.home ?? runtimeHome(env)
  const ignoreXdg = settings.home !== undefined || Boolean(env.MAGPIE_KAKU_HOME)
  const log = settings.log ?? (() => {})
  if (command === "status") return inspect(settings.options, home, env, ignoreXdg)
  return runOnce(command, settings.options, home, env, log, ignoreXdg)
}

function inspect(options: unknown, home: string, env: NodeJS.ProcessEnv, ignoreXdg = false): SyncReport {
  const paths = safePaths(options, home, env, ignoreXdg)
  if (!paths) {
    return { action: "blocked", wroteConfig: false, wroteState: false, conflicts: [], connected: false, reason: "config path" }
  }
  const bridge = readBridge(readOptional(paths.bridge))
  return {
    action: "noop",
    wroteConfig: false,
    wroteState: false,
    conflicts: [],
    connected: bridge.status === "connected",
    reason: bridge.status,
  }
}

function runOnce(
  mode: "auto" | "sync" | "restore",
  options: unknown,
  home: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  ignoreXdg = false,
): SyncReport {
  const paths = safePaths(options, home, env, ignoreXdg)
  if (!paths) {
    log("kaku: configPath must name assistant.toml")
    return blocked("config path")
  }
  const secrets: string[] = []
  try {
    ensurePrivateDir(paths.directory)
    recoverPending(paths)
    if (fs.existsSync(paths.bridge)) tightenPrivate(paths.bridge)
    const bridgeText = readOptional(paths.bridge)
    const bridge = readBridge(bridgeText)
    const bridgeHash = sha256(bridgeText ?? "")
    if (bridge.status === "connected") secrets.push(bridge.link.apiKey, bridge.link.baseURL)
    let state = readState(paths.state)
    secrets.push(...stateSecrets(state))
    if (bridge.status === "invalid") {
      log("kaku: bridge JSON is incomplete; assistant.toml was not changed")
      return blocked("bridge")
    }
    const roles = rolesFor(options, bridge.status === "connected" && mode !== "restore")
    const intent = intentFor(mode, bridge, roles, state, bridgeHash)
    if (intent.type === "apply" && state.pause && state.pause.bridgeHash !== bridgeHash) {
      state = { ...state, pause: null }
    }
    if (intent.type === "paused") {
      return { action: "paused", wroteConfig: false, wroteState: false, conflicts: [], connected: true }
    }
    const current = readOptional(paths.config)
    const planned = project(current, () => readOptional(paths.config), state, intent)
    let nextState = planned.state
    if (mode === "restore" && bridge.status === "connected") {
      nextState = { ...nextState, pause: { bridgeHash } }
    }
    if (mode === "sync") nextState = { ...nextState, pause: null }
    if (bridge.status === "disconnected") nextState = { ...nextState, pause: null }
    const wroteConfig = planned.source !== (current ?? "")
    if (wroteConfig) {
      const before = current ?? ""
      if ((readOptional(paths.config) ?? "") !== before) throw new BridgeError("assistant.toml changed during sync")
      const pending: Pending = {
        previous: state,
        next: nextState,
        previousHash: sha256(before),
        nextHash: sha256(planned.source),
      }
      writeText(pendingPath(paths), `${JSON.stringify(pending)}\n`, PRIVATE)
      const modeBits = existingMode(paths.config) ?? PRIVATE
      writeText(paths.config, planned.source, modeBits)
    }
    const wroteState = !sameState(state, nextState) || wroteConfig
    if (wroteState) writeText(paths.state, serializeState(nextState), PRIVATE)
    if (wroteConfig) fs.rmSync(pendingPath(paths), { force: true })
    const report: SyncReport = { ...planned.report, wroteConfig, wroteState }
    if (report.action !== "noop" && report.action !== "paused") {
      const conflict = report.conflicts.length > 0 ? ` conflicts:${report.conflicts.join(",")}` : ""
      log(`kaku: ${report.action}${conflict}`)
    }
    return report
  } catch (error) {
    const safe = publicError(error, secrets)
    log(`kaku: ${redact(safe.message, secrets)}`)
    return blocked("error")
  }
}

function intentFor(
  mode: "auto" | "sync" | "restore",
  bridge: BridgeView,
  roles: RoleOptions | null,
  state: SavedState,
  bridgeHash: string,
): Intent {
  if (bridge.status === "invalid") throw new BridgeError("bridge JSON is incomplete or invalid")
  if (mode === "restore" || bridge.status === "disconnected") return { type: "restore" }
  if (!roles) throw new BridgeError("plugin options simple and deep are required")
  if (mode === "auto" && state.pause?.bridgeHash === bridgeHash) return { type: "paused" }
  return { type: "apply", roles, baseURL: bridge.link.baseURL, apiKey: bridge.link.apiKey }
}

function rolesFor(options: unknown, required: boolean): RoleOptions | null {
  if (!required) {
    try {
      return parseRoleOptions(options)
    } catch {
      return null
    }
  }
  return parseRoleOptions(options)
}

function recoverPending(paths: BridgePaths): void {
  const file = pendingPath(paths)
  const text = readOptional(file)
  if (text === null) return
  let pending: Pending
  try {
    pending = JSON.parse(text) as Pending
  } catch {
    throw new BridgeError("bridge recovery state is invalid")
  }
  if (!pending?.previousHash || !pending.nextHash || !pending.next) {
    throw new BridgeError("bridge recovery state is invalid")
  }
  const current = readOptional(paths.config) ?? ""
  const hash = sha256(current)
  if (hash === pending.nextHash) {
    writeText(paths.state, serializeState(loadState(JSON.stringify(pending.next))), PRIVATE)
    fs.rmSync(file, { force: true })
    return
  }
  if (hash === pending.previousHash) {
    fs.rmSync(file, { force: true })
    return
  }
  throw new BridgeError("assistant.toml changed during recovery; state was kept")
}

function readState(file: string): SavedState {
  return loadState(readOptional(file))
}

function safePaths(options: unknown, home: string, env: NodeJS.ProcessEnv, ignoreXdg = false): BridgePaths | null {
  try {
    const configPath = configPathOf(options)
    return resolvePaths(home, configPath, env, ignoreXdg)
  } catch {
    return null
  }
}

function configPathOf(options: unknown): string | null {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null
  const value = (options as Record<string, unknown>).configPath
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") throw new BridgeError("plugin option configPath must be a string")
  return value
}

function pendingPath(paths: BridgePaths): string {
  return `${paths.state}.pending`
}

function readOptional(file: string): string | null {
  return readText(file)
}

function blocked(reason: string): SyncReport {
  return { action: "blocked", wroteConfig: false, wroteState: false, conflicts: [], connected: false, reason }
}
