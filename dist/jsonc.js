import { BridgeError } from "./errors.js";
// Magpie's agent writer preserves JSONC comments (internal/edit/json.go).
// The bridge file is therefore not always strict JSON.
export function parseJsonc(text) {
    const stripped = stripJsonc(text);
    try {
        return JSON.parse(stripped);
    }
    catch {
        throw new BridgeError("bridge JSON is incomplete or invalid");
    }
}
function stripJsonc(text) {
    let out = "";
    let i = 0;
    if (text.charCodeAt(0) === 0xfeff)
        i = 1;
    let quote = "";
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (quote) {
            out += ch;
            if (ch === "\\") {
                if (next !== undefined) {
                    out += next;
                    i += 2;
                    continue;
                }
            }
            else if (ch === quote)
                quote = "";
            i += 1;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            out += ch;
            i += 1;
            continue;
        }
        if (ch === "/" && next === "/") {
            i += 2;
            while (i < text.length && text[i] !== "\n")
                i += 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            const end = text.indexOf("*/", i + 2);
            if (end < 0)
                throw new BridgeError("bridge JSON is incomplete or invalid");
            i = end + 2;
            out += " ";
            continue;
        }
        out += ch;
        i += 1;
    }
    if (quote)
        throw new BridgeError("bridge JSON is incomplete or invalid");
    return out.replace(/,\s*([}\]])/g, "$1");
}
