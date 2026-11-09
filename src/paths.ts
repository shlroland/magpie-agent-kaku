import os from "node:os"
import path from "node:path"

import { BridgeError } from "./errors.js"

export interface BridgePaths {
  home: string
  directory: string
  bridge: string
  state: string
  config: string
}

export function runtimeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MAGPIE_KAKU_HOME
  if (override && override.trim()) return path.resolve(override)
  return os.homedir()
}

export function bridgeDirectory(home: string): string {
  return path.join(home, ".config", "magpie-agent-kaku")
}

export function resolvePaths(
  home: string,
  configPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
  ignoreXdg = false,
): BridgePaths {
  const directory = bridgeDirectory(home)
  const lookup = ignoreXdg ? { ...env, XDG_CONFIG_HOME: "" } : env
  return {
    home,
    directory,
    bridge: path.join(directory, "bridge.json"),
    state: path.join(directory, "state.json"),
    config: resolveConfigPath(home, configPath, lookup),
  }
}

export function resolveConfigPath(
  home: string,
  configPath: string | null,
  env: NodeJS.ProcessEnv,
): string {
  const expanded = expandHome(configPath ?? defaultConfigPath(home, env), home)
  const resolved = path.resolve(expanded)
  if (path.basename(resolved) !== "assistant.toml") {
    throw new BridgeError("configPath must name assistant.toml")
  }
  return resolved
}

function defaultConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME
  if (xdg && xdg.trim()) return path.join(xdg, "kaku", "assistant.toml")
  return path.join(home, ".config", "kaku", "assistant.toml")
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return value
}
