import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.js";
import { parseJsonc } from "./jsonc.js";
export function readText(file) {
    let info;
    try {
        info = fs.lstatSync(file);
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return null;
        throw new BridgeError("could not read a bridge file");
    }
    if (info.isSymbolicLink()) {
        let target;
        try {
            target = fs.realpathSync(file);
        }
        catch {
            throw new BridgeError("config symlink could not be resolved");
        }
        return fs.readFileSync(target, "utf8");
    }
    if (!info.isFile())
        throw new BridgeError("config path is not a regular file");
    return fs.readFileSync(file, "utf8");
}
export function writeText(file, text, mode) {
    const dest = writeDestination(file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = path.join(path.dirname(dest), `.magpie-kaku-${crypto.randomBytes(8).toString("hex")}.tmp`);
    const fd = fs.openSync(tmp, "wx", mode);
    try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, dest);
    }
    catch (error) {
        fs.rmSync(tmp, { force: true });
        throw error;
    }
    fs.chmodSync(dest, mode);
}
export function existingMode(file) {
    try {
        const dest = writeDestination(file);
        const info = fs.statSync(dest);
        if (!info.isFile())
            return null;
        return info.mode & 0o777;
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return null;
        throw new BridgeError("could not read config file mode");
    }
}
export function ensurePrivateDir(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const mode = fs.statSync(directory).mode & 0o777;
    if (mode !== 0o700)
        fs.chmodSync(directory, 0o700);
}
export function tightenPrivate(file) {
    if (!fs.existsSync(file))
        return;
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile())
        throw new BridgeError("bridge file must be a regular file");
    if ((info.mode & 0o777) !== 0o600)
        fs.chmodSync(file, 0o600);
}
export function sha256(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}
export function readBridge(text) {
    if (text === null || text.trim() === "")
        return { status: "disconnected" };
    let value;
    try {
        value = parseJsonc(text);
    }
    catch {
        return { status: "invalid" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        return { status: "invalid" };
    const record = value;
    const hasUrl = Object.prototype.hasOwnProperty.call(record, "baseURL");
    const hasKey = Object.prototype.hasOwnProperty.call(record, "apiKey");
    if (!hasUrl && !hasKey)
        return { status: "disconnected" };
    if (!hasUrl || !hasKey)
        return { status: "invalid" };
    if (typeof record.baseURL !== "string" || typeof record.apiKey !== "string")
        return { status: "invalid" };
    const baseURL = normalizeGateway(record.baseURL);
    if (!baseURL || !validKey(record.apiKey))
        return { status: "invalid" };
    return { status: "connected", link: { baseURL, apiKey: record.apiKey } };
}
function normalizeGateway(value) {
    if (/[\s\\]/.test(value) || value.includes("\0"))
        return null;
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return null;
    if (parsed.username || parsed.password)
        return null;
    const stripped = value.replace(/\/+$/, "");
    if (!stripped.endsWith("/v1"))
        return null;
    return stripped;
}
function validKey(value) {
    if (value.length < 1 || value.length > 500)
        return false;
    return !/[\s\u0000-\u001f\u007f]/.test(value);
}
function writeDestination(file) {
    try {
        const info = fs.lstatSync(file);
        if (info.isSymbolicLink())
            return fs.realpathSync(file);
        if (!info.isFile())
            throw new BridgeError("config path is not a regular file");
        return file;
    }
    catch (error) {
        if (error instanceof BridgeError)
            throw error;
        if (errorCode(error) === "ENOENT")
            return file;
        throw new BridgeError("config path could not be resolved");
    }
}
function errorCode(error) {
    return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}
