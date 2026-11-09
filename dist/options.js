import { BridgeError } from "./errors.js";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,200}$/;
export function parseRoleOptions(raw) {
    if (raw === undefined || raw === null) {
        throw new BridgeError("plugin options simple and deep are required");
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new BridgeError("plugin options must be a JSON object");
    }
    const record = raw;
    const simple = requiredId(record.simple, "simple");
    const deep = requiredId(record.deep, "deep");
    const memory = optionalId(record.memory, "memory");
    const configPath = optionalPath(record.configPath);
    return { simple, deep, memory, configPath };
}
export function modelId(value, label) {
    if (!MODEL_ID.test(value) ||
        value.includes("//") ||
        value.includes("..") ||
        value.startsWith("/") ||
        value.endsWith("/")) {
        throw new BridgeError(`plugin option ${label} must be an existing Magpie model or group id`);
    }
    return value;
}
function requiredId(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new BridgeError(`plugin option ${label} is required`);
    }
    return modelId(value.trim(), label);
}
function optionalId(value, label) {
    if (value === undefined || value === null || value === "")
        return null;
    if (typeof value !== "string")
        throw new BridgeError(`plugin option ${label} must be a string`);
    return modelId(value.trim(), label);
}
function optionalPath(value) {
    if (value === undefined || value === null || value === "")
        return null;
    if (typeof value !== "string")
        throw new BridgeError("plugin option configPath must be a string");
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
        throw new BridgeError("plugin option configPath is not a usable path");
    }
    return trimmed;
}
