import { parseTOML } from "toml-eslint-parser";
import { BridgeError } from "./errors.js";
export function readPresence(source, key) {
    const { keys, anchors } = inspect(source);
    const found = keys.get(key);
    if (!found)
        return { present: false };
    return presenceOf(source, found, anchors.get(key) ?? null);
}
export function editDocument(source, edits) {
    if (edits.length === 0)
        return source;
    const newline = dominantNewline(source);
    const inspected = inspect(source);
    const { keys, insertAt, structured } = inspected;
    for (const edit of edits) {
        if (structured.has(edit.key)) {
            throw new BridgeError(`top-level ${edit.key} is already a table or dotted key`);
        }
    }
    const splices = [];
    const insertions = [];
    for (const edit of edits) {
        const found = keys.get(edit.key);
        if (edit.op === "set") {
            if (found && found.value.kind === "string" && found.value.value === edit.value)
                continue;
            if (found) {
                splices.push({
                    start: found.value.range[0],
                    end: found.value.range[1],
                    text: tomlBasicString(edit.value),
                });
            }
            else
                insertions.push(`${edit.key} = ${tomlBasicString(edit.value)}`);
            continue;
        }
        if (edit.op === "remove") {
            if (!found)
                continue;
            splices.push(removeStatement(source, found));
            continue;
        }
        splices.push(...restoreStatement(source, found, edit.original, newline, insertions, keys));
    }
    if (insertions.length > 0) {
        splices.push({ start: insertAt, end: insertAt, text: insertionBlock(source, insertions, insertAt, newline) });
    }
    const next = applySplices(source, splices);
    validateToml(next);
    return next;
}
export function samePresence(left, right) {
    if (!left.present || !right.present)
        return left.present === right.present;
    if (left.kind === "string" && right.kind === "string")
        return left.value === right.value;
    return left.kind === right.kind && left.rawValue === right.rawValue;
}
export function stringPresence(value) {
    const rawValue = tomlBasicString(value);
    return {
        present: true,
        kind: "string",
        value,
        rawValue,
        rawStatement: `key = ${rawValue}`,
        anchor: null,
    };
}
function restoreStatement(source, found, original, newline, insertions, keys) {
    if (!original.present) {
        return found ? [removeStatement(source, found)] : [];
    }
    if (found) {
        if (found.value.kind === "string" && original.kind === "string" && found.value.value === original.value) {
            return [];
        }
        if (source.slice(found.value.range[0], found.value.range[1]) === original.rawValue)
            return [];
        return [{ start: found.value.range[0], end: found.value.range[1], text: original.rawValue }];
    }
    const anchorNode = original.anchor ? keys.get(original.anchor) : undefined;
    if (anchorNode) {
        const bounds = lineBounds(source, anchorNode.range[0]);
        const text = bounds.newline ? `${original.rawStatement}${newline}` : `${newline}${original.rawStatement}${newline}`;
        return [{ start: bounds.end, end: bounds.end, text }];
    }
    insertions.push(original.rawStatement);
    return [];
}
function applySplices(source, splices) {
    const ordered = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
    let next = source;
    let cursor = source.length;
    for (const splice of ordered) {
        if (splice.start < 0 || splice.end < splice.start || splice.end > cursor) {
            throw new BridgeError("TOML edit ranges overlap");
        }
        next = next.slice(0, splice.start) + splice.text + next.slice(splice.end);
        cursor = splice.start;
    }
    return next;
}
function insertionBlock(source, lines, at, newline) {
    let block = lines.join(newline) + newline;
    if (at === source.length && source.length > 0 && !source.endsWith("\n"))
        block = newline + block;
    return block;
}
function removeStatement(source, node) {
    const bounds = lineBounds(source, node.range[0]);
    const contentEnd = bounds.end - bounds.newline.length;
    const tail = source.slice(node.value.range[1], contentEnd);
    const hash = tail.indexOf("#");
    if (hash >= 0) {
        return { start: bounds.start, end: bounds.end, text: `${tail.slice(hash).trimStart()}${bounds.newline}` };
    }
    return { start: bounds.start, end: bounds.end, text: "" };
}
function lineBounds(source, index) {
    const start = source.lastIndexOf("\n", index - 1) + 1;
    const nl = source.indexOf("\n", index);
    if (nl < 0)
        return { start, end: source.length, newline: "" };
    if (nl > 0 && source[nl - 1] === "\r")
        return { start, end: nl + 1, newline: "\r\n" };
    return { start, end: nl + 1, newline: "\n" };
}
function inspect(source) {
    const program = parseDocument(source);
    const body = program.body[0]?.body ?? [];
    const keys = new Map();
    const anchors = new Map();
    const structured = new Set();
    let insertAt = source.length;
    let previous = null;
    for (const node of body) {
        if (node.type === "TOMLTable") {
            const root = segmentName(node.key.keys[0]);
            if (root)
                structured.add(root);
            if (node.range[0] < insertAt)
                insertAt = node.range[0];
            continue;
        }
        if (node.type !== "TOMLKeyValue")
            continue;
        const segments = node.key.keys.map(segmentName);
        if (segments.length !== 1) {
            const root = segments[0];
            if (root)
                structured.add(root);
            continue;
        }
        const name = segments[0];
        if (keys.has(name))
            throw new BridgeError("assistant.toml has a duplicate top-level key");
        keys.set(name, node);
        anchors.set(name, previous);
        previous = name;
    }
    return { keys, anchors, insertAt, structured };
}
function presenceOf(source, node, anchor) {
    const rawValue = source.slice(node.value.range[0], node.value.range[1]);
    const bounds = lineBounds(source, node.range[0]);
    const contentEnd = bounds.end - bounds.newline.length;
    const rawStatement = source.slice(bounds.start, contentEnd).trim();
    if (node.value.kind === "string" && typeof node.value.value === "string") {
        return { present: true, kind: "string", value: node.value.value, rawValue, rawStatement, anchor };
    }
    return { present: true, kind: "other", rawValue, rawStatement, anchor };
}
function parseDocument(source) {
    let program;
    try {
        program = parseTOML(source);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/multiple times|duplicate key|redefine/i.test(message)) {
            throw new BridgeError("assistant.toml has a duplicate top-level key");
        }
        throw new BridgeError("assistant.toml is not valid TOML");
    }
    if (hasDuplicateTopLevel(program))
        throw new BridgeError("assistant.toml has a duplicate top-level key");
    validateBun(source);
    return program;
}
function hasDuplicateTopLevel(program) {
    const seen = new Set();
    for (const node of program.body[0]?.body ?? []) {
        if (node.type !== "TOMLKeyValue" || node.key.keys.length !== 1)
            continue;
        const name = segmentName(node.key.keys[0]);
        if (seen.has(name))
            return true;
        seen.add(name);
    }
    return false;
}
function validateToml(source) {
    parseDocument(source);
}
function validateBun(source) {
    const bun = globalThis.Bun;
    if (!bun?.TOML?.parse)
        throw new BridgeError("Bun.TOML.parse is not available");
    try {
        bun.TOML.parse(source);
    }
    catch {
        throw new BridgeError("assistant.toml is not valid TOML");
    }
}
function segmentName(segment) {
    if (!segment)
        return "";
    if (segment.type === "TOMLBare")
        return segment.name ?? "";
    if (segment.type === "TOMLQuoted")
        return segment.value ?? "";
    return "";
}
function dominantNewline(source) {
    const crlf = source.split("\r\n").length - 1;
    const lf = source.split("\n").length - 1 - crlf;
    return crlf > lf ? "\r\n" : "\n";
}
export function tomlBasicString(value) {
    let out = '"';
    for (const ch of value) {
        switch (ch) {
            case "\\":
                out += "\\\\";
                break;
            case '"':
                out += '\\"';
                break;
            case "\b":
                out += "\\b";
                break;
            case "\f":
                out += "\\f";
                break;
            case "\n":
                out += "\\n";
                break;
            case "\r":
                out += "\\r";
                break;
            case "\t":
                out += "\\t";
                break;
            default: {
                const code = ch.codePointAt(0) ?? 0;
                if (code < 0x20 || code === 0x7f)
                    out += `\\u${code.toString(16).padStart(4, "0")}`;
                else
                    out += ch;
            }
        }
    }
    return `${out}"`;
}
