import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";
export function runtimeHome(env = process.env) {
    const override = env.MAGPIE_KAKU_HOME;
    if (override && override.trim())
        return path.resolve(override);
    return os.homedir();
}
export function bridgeDirectory(home) {
    return path.join(home, ".config", "magpie-agent-kaku");
}
export function resolvePaths(home, configPath, env = process.env, ignoreXdg = false) {
    const directory = bridgeDirectory(home);
    const lookup = ignoreXdg ? { ...env, XDG_CONFIG_HOME: "" } : env;
    return {
        home,
        directory,
        bridge: path.join(directory, "bridge.json"),
        state: path.join(directory, "state.json"),
        config: resolveConfigPath(home, configPath, lookup),
    };
}
export function resolveConfigPath(home, configPath, env) {
    const expanded = expandHome(configPath ?? defaultConfigPath(home, env), home);
    const resolved = path.resolve(expanded);
    if (path.basename(resolved) !== "assistant.toml") {
        throw new BridgeError("configPath must name assistant.toml");
    }
    return resolved;
}
function defaultConfigPath(home, env) {
    const xdg = env.XDG_CONFIG_HOME;
    if (xdg && xdg.trim())
        return path.join(xdg, "kaku", "assistant.toml");
    return path.join(home, ".config", "kaku", "assistant.toml");
}
function expandHome(value, home) {
    if (value === "~")
        return home;
    if (value.startsWith("~/"))
        return path.join(home, value.slice(2));
    return value;
}
