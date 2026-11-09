import fs from "node:fs";
import path from "node:path";
import { BridgeError, publicError, redact } from "./errors.js";
import { ensurePrivateDir, existingMode, readBridge, readText, sha256, tightenPrivate, writeText, } from "./io.js";
import { parseRoleOptions } from "./options.js";
import { resolvePaths, runtimeHome } from "./paths.js";
import { loadState, sameState, serializeState, stateSecrets } from "./state.js";
import { project } from "./sync.js";
const PRIVATE = 0o600;
export function startBridge(settings = {}) {
    let options = settings.options;
    const env = settings.env ?? process.env;
    const home = settings.home ?? runtimeHome(env);
    const ignoreXdg = settings.home !== undefined || Boolean(env.MAGPIE_KAKU_HOME);
    const debounceMs = settings.debounceMs ?? 150;
    let lastLog = "";
    const emit = settings.log ?? ((line) => console.error(line));
    const log = (line) => {
        if (line === lastLog)
            return;
        lastLog = line;
        emit(line);
    };
    let timer;
    let stopped = false;
    let locked = false;
    let rerun = false;
    let lastReport = {
        action: "noop",
        wroteConfig: false,
        wroteState: false,
        conflicts: [],
        connected: false,
    };
    const watchers = [];
    const watched = new Set();
    const run = (mode) => {
        if (locked) {
            rerun = true;
            return lastReport;
        }
        locked = true;
        try {
            let spins = 0;
            do {
                rerun = false;
                lastReport = runOnce(mode, options, home, env, log, ignoreXdg);
                spins += 1;
            } while (rerun && spins < 3);
            return lastReport;
        }
        finally {
            locked = false;
        }
    };
    const schedule = () => {
        if (stopped)
            return;
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            try {
                run("auto");
            }
            catch {
                // runOnce already logs and fails closed.
            }
        }, debounceMs);
        timer.unref?.();
    };
    const arm = (directory) => {
        if (watched.has(directory) || !fs.existsSync(directory))
            return;
        try {
            const watcher = fs.watch(directory, schedule);
            watcher.on("error", () => { });
            watcher.unref?.();
            watchers.push(watcher);
            watched.add(directory);
        }
        catch {
            log("kaku: config directory could not be watched");
        }
    };
    try {
        run("auto");
    }
    catch {
        // The first pass logs its own failure.
    }
    const paths = safePaths(options, home, env, ignoreXdg);
    if (paths) {
        ensurePrivateDir(paths.directory);
        arm(paths.directory);
        arm(path.dirname(paths.config));
        arm(path.dirname(paths.bridge));
    }
    return {
        flush() {
            if (timer)
                clearTimeout(timer);
            timer = undefined;
            run("auto");
        },
        stop() {
            stopped = true;
            if (timer)
                clearTimeout(timer);
            for (const watcher of watchers)
                watcher.close();
        },
        updateOptions(next) {
            options = next;
            this.flush();
        },
        report: () => lastReport,
    };
}
export function commandSync(settings, command) {
    const env = settings.env ?? process.env;
    const home = settings.home ?? runtimeHome(env);
    const ignoreXdg = settings.home !== undefined || Boolean(env.MAGPIE_KAKU_HOME);
    const log = settings.log ?? (() => { });
    if (command === "status")
        return inspect(settings.options, home, env, ignoreXdg);
    return runOnce(command, settings.options, home, env, log, ignoreXdg);
}
function inspect(options, home, env, ignoreXdg = false) {
    const paths = safePaths(options, home, env, ignoreXdg);
    if (!paths) {
        return { action: "blocked", wroteConfig: false, wroteState: false, conflicts: [], connected: false, reason: "config path" };
    }
    const bridge = readBridge(readOptional(paths.bridge));
    return {
        action: "noop",
        wroteConfig: false,
        wroteState: false,
        conflicts: [],
        connected: bridge.status === "connected",
        reason: bridge.status,
    };
}
function runOnce(mode, options, home, env, log, ignoreXdg = false) {
    const paths = safePaths(options, home, env, ignoreXdg);
    if (!paths) {
        log("kaku: configPath must name assistant.toml");
        return blocked("config path");
    }
    const secrets = [];
    try {
        ensurePrivateDir(paths.directory);
        recoverPending(paths);
        if (fs.existsSync(paths.bridge))
            tightenPrivate(paths.bridge);
        const bridgeText = readOptional(paths.bridge);
        const bridge = readBridge(bridgeText);
        const bridgeHash = sha256(bridgeText ?? "");
        if (bridge.status === "connected")
            secrets.push(bridge.link.apiKey, bridge.link.baseURL);
        let state = readState(paths.state);
        secrets.push(...stateSecrets(state));
        if (bridge.status === "invalid") {
            log("kaku: bridge JSON is incomplete; assistant.toml was not changed");
            return blocked("bridge");
        }
        const roles = rolesFor(options, bridge.status === "connected" && mode !== "restore");
        const intent = intentFor(mode, bridge, roles, state, bridgeHash);
        if (intent.type === "apply" && state.pause && state.pause.bridgeHash !== bridgeHash) {
            state = { ...state, pause: null };
        }
        if (intent.type === "paused") {
            return { action: "paused", wroteConfig: false, wroteState: false, conflicts: [], connected: true };
        }
        const current = readOptional(paths.config);
        const planned = project(current, () => readOptional(paths.config), state, intent);
        let nextState = planned.state;
        if (mode === "restore" && bridge.status === "connected") {
            nextState = { ...nextState, pause: { bridgeHash } };
        }
        if (mode === "sync")
            nextState = { ...nextState, pause: null };
        if (bridge.status === "disconnected")
            nextState = { ...nextState, pause: null };
        const wroteConfig = planned.source !== (current ?? "");
        if (wroteConfig) {
            const before = current ?? "";
            if ((readOptional(paths.config) ?? "") !== before)
                throw new BridgeError("assistant.toml changed during sync");
            const pending = {
                previous: state,
                next: nextState,
                previousHash: sha256(before),
                nextHash: sha256(planned.source),
            };
            writeText(pendingPath(paths), `${JSON.stringify(pending)}\n`, PRIVATE);
            const modeBits = existingMode(paths.config) ?? PRIVATE;
            writeText(paths.config, planned.source, modeBits);
        }
        const wroteState = !sameState(state, nextState) || wroteConfig;
        if (wroteState)
            writeText(paths.state, serializeState(nextState), PRIVATE);
        if (wroteConfig)
            fs.rmSync(pendingPath(paths), { force: true });
        const report = { ...planned.report, wroteConfig, wroteState };
        if (report.action !== "noop" && report.action !== "paused") {
            const conflict = report.conflicts.length > 0 ? ` conflicts:${report.conflicts.join(",")}` : "";
            log(`kaku: ${report.action}${conflict}`);
        }
        return report;
    }
    catch (error) {
        const safe = publicError(error, secrets);
        log(`kaku: ${redact(safe.message, secrets)}`);
        return blocked("error");
    }
}
function intentFor(mode, bridge, roles, state, bridgeHash) {
    if (bridge.status === "invalid")
        throw new BridgeError("bridge JSON is incomplete or invalid");
    if (mode === "restore" || bridge.status === "disconnected")
        return { type: "restore" };
    if (!roles)
        throw new BridgeError("plugin options simple and deep are required");
    if (mode === "auto" && state.pause?.bridgeHash === bridgeHash)
        return { type: "paused" };
    return { type: "apply", roles, baseURL: bridge.link.baseURL, apiKey: bridge.link.apiKey };
}
function rolesFor(options, required) {
    if (!required) {
        try {
            return parseRoleOptions(options);
        }
        catch {
            return null;
        }
    }
    return parseRoleOptions(options);
}
function recoverPending(paths) {
    const file = pendingPath(paths);
    const text = readOptional(file);
    if (text === null)
        return;
    let pending;
    try {
        pending = JSON.parse(text);
    }
    catch {
        throw new BridgeError("bridge recovery state is invalid");
    }
    if (!pending?.previousHash || !pending.nextHash || !pending.next) {
        throw new BridgeError("bridge recovery state is invalid");
    }
    const current = readOptional(paths.config) ?? "";
    const hash = sha256(current);
    if (hash === pending.nextHash) {
        writeText(paths.state, serializeState(loadState(JSON.stringify(pending.next))), PRIVATE);
        fs.rmSync(file, { force: true });
        return;
    }
    if (hash === pending.previousHash) {
        fs.rmSync(file, { force: true });
        return;
    }
    throw new BridgeError("assistant.toml changed during recovery; state was kept");
}
function readState(file) {
    return loadState(readOptional(file));
}
function safePaths(options, home, env, ignoreXdg = false) {
    try {
        const configPath = configPathOf(options);
        return resolvePaths(home, configPath, env, ignoreXdg);
    }
    catch {
        return null;
    }
}
function configPathOf(options) {
    if (!options || typeof options !== "object" || Array.isArray(options))
        return null;
    const value = options.configPath;
    if (value === undefined || value === null || value === "")
        return null;
    if (typeof value !== "string")
        throw new BridgeError("plugin option configPath must be a string");
    return value;
}
function pendingPath(paths) {
    return `${paths.state}.pending`;
}
function readOptional(file) {
    return readText(file);
}
function blocked(reason) {
    return { action: "blocked", wroteConfig: false, wroteState: false, conflicts: [], connected: false, reason };
}
