import path from "node:path"

import { BridgeError } from "./errors.js"
import { readText } from "./io.js"
import { bridgeDirectory, runtimeHome } from "./paths.js"
import { commandSync } from "./runtime.js"
import { loadState } from "./state.js"

export function main(argv: readonly string[]): number {
  const command = argv[0]
  if (command !== "status" && command !== "sync" && command !== "restore") {
    console.error("usage: magpie-kaku status|sync|restore [--home DIR]")
    return 2
  }
  const homeFlag = argv.indexOf("--home")
  const home = homeFlag >= 0 ? argv[homeFlag + 1] : undefined
  if (homeFlag >= 0 && !home) {
    console.error("magpie-kaku: --home needs a directory")
    return 2
  }
  const isolated = home !== undefined
  let options: unknown
  try {
    options = loadHostOptions(home ?? runtimeHome(), process.env, isolated)
  } catch (error) {
    console.error(error instanceof BridgeError ? error.message : "kaku: options could not be read")
    return 1
  }
  const report = commandSync({ home, options, log: (line) => console.error(line) }, command)
  if (command === "status") {
    const resolved = home ?? runtimeHome()
    const stateFile = path.join(bridgeDirectory(resolved), "state.json")
    let fields: string[] = []
    let paused = false
    try {
      const state = loadState(readText(stateFile))
      fields = Object.keys(state.fields).sort()
      paused = state.pause !== null
    } catch {
      console.error("kaku: bridge state is invalid")
      return 1
    }
    console.log(
      JSON.stringify({
        connected: report.connected,
        bridge: report.reason,
        paused,
        managed: fields,
      }),
    )
    return 0
  }
  if (report.action === "blocked") return 1
  console.log(JSON.stringify({ action: report.action, conflicts: report.conflicts, wroteConfig: report.wroteConfig }))
  return report.conflicts.length > 0 ? 2 : 0
}

function loadHostOptions(home: string, env: NodeJS.ProcessEnv, isolated: boolean): unknown {
  const inline = env.MAGPIE_KAKU_OPTIONS
  if (inline && inline.trim()) {
    try {
      return JSON.parse(inline) as unknown
    } catch {
      throw new BridgeError("MAGPIE_KAKU_OPTIONS is not JSON")
    }
  }
  const root = !isolated && env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME : path.join(home, ".config")
  const text = readText(path.join(root, "magpie", "plugins.json"))
  if (!text) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return undefined
  for (const entry of plugins) {
    if (!entry || typeof entry !== "object") continue
    const spec = String((entry as { spec?: unknown }).spec ?? "")
    if (spec === "magpie-agent-kaku" || spec.endsWith("/magpie-agent-kaku") || spec.endsWith("\\magpie-agent-kaku")) {
      return (entry as { options?: unknown }).options
    }
  }
  return undefined
}
