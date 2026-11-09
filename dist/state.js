import { BridgeError } from "./errors.js";
import { samePresence } from "./toml-edit.js";
export function emptyState() {
    return { version: 1, fields: {}, pause: null };
}
export function loadState(text) {
    if (text === null || text.trim() === "")
        return emptyState();
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new BridgeError("bridge state is invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new BridgeError("bridge state is invalid");
    }
    const record = value;
    if (record.version !== 1 || !record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) {
        throw new BridgeError("bridge state is invalid");
    }
    const fields = {};
    for (const [key, field] of Object.entries(record.fields)) {
        if (!field || typeof field !== "object")
            throw new BridgeError("bridge state is invalid");
        const candidate = field;
        if (!isPresence(candidate.original) || !isPresence(candidate.injected)) {
            throw new BridgeError("bridge state is invalid");
        }
        fields[key] = { original: candidate.original, injected: candidate.injected };
    }
    let pause = null;
    if (record.pause !== undefined && record.pause !== null) {
        if (typeof record.pause !== "object" || typeof record.pause.bridgeHash !== "string" || !/^[a-f0-9]{64}$/.test(record.pause.bridgeHash)) {
            throw new BridgeError("bridge state is invalid");
        }
        pause = { bridgeHash: record.pause.bridgeHash };
    }
    return { version: 1, fields, pause };
}
export function serializeState(state) {
    const fields = Object.fromEntries(Object.keys(state.fields)
        .sort()
        .map((key) => [key, state.fields[key]]));
    return `${JSON.stringify({ version: 1, pause: state.pause, fields }, null, 2)}\n`;
}
export function sameState(left, right) {
    return serializeState(left) === serializeState(right);
}
export function stateSecrets(state) {
    const secrets = [];
    for (const field of Object.values(state.fields)) {
        for (const presence of [field.original, field.injected]) {
            if (presence.present && presence.kind === "string" && presence.value.length >= 4)
                secrets.push(presence.value);
        }
    }
    return secrets;
}
export function sameRecord(left, right) {
    if (!left || !right)
        return left === right;
    return samePresence(left.original, right.original) && samePresence(left.injected, right.injected);
}
function isPresence(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    if (record.present === false)
        return true;
    if (record.present !== true)
        return false;
    if ("anchor" in record && record.anchor != null && typeof record.anchor !== "string")
        return false;
    if (record.kind === "string") {
        return typeof record.value === "string" && typeof record.rawValue === "string" && typeof record.rawStatement === "string";
    }
    if (record.kind === "other")
        return typeof record.rawValue === "string" && typeof record.rawStatement === "string";
    return false;
}
