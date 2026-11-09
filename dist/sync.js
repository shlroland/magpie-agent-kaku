import { BridgeError } from "./errors.js";
import { emptyState, sameState, } from "./state.js";
import { editDocument, readPresence, samePresence, stringPresence, } from "./toml-edit.js";
export const MANAGED_KEYS = [
    "auth_type",
    "api_key",
    "base_url",
    "model",
    "chat_model",
    "memory_curator_model",
    "fast_model",
];
export function reconcile(source, state, intent) {
    if (intent.type === "paused") {
        return {
            source,
            state,
            report: { action: "paused", conflicts: [], connected: true },
        };
    }
    const fields = { ...state.fields };
    const plans = [];
    if (intent.type === "restore") {
        for (const key of Object.keys(fields).sort(byManagedOrder)) {
            plans.push({ key, plan: planRestore(source, key, fields[key]) });
        }
    }
    else {
        for (const [key, want, drop] of applyWants(intent, fields)) {
            plans.push({ key, plan: planApply(source, key, fields[key], want, drop) });
        }
    }
    const conflicts = plans.filter((item) => item.plan.conflict).map((item) => item.key);
    const edits = plans.flatMap((item) => (item.plan.edit ? [item.plan.edit] : []));
    let nextSource = source;
    if (edits.length > 0)
        nextSource = editDocument(source, edits);
    const nextFields = { ...fields };
    for (const { key, plan } of plans) {
        if (plan.conflict)
            continue;
        if (plan.drop || !plan.record)
            delete nextFields[key];
        else
            nextFields[key] = plan.record;
    }
    const nextState = { version: 1, fields: nextFields, pause: intent.type === "restore" ? state.pause : state.pause };
    const changed = nextSource !== source || !sameState(state, nextState);
    let action = "noop";
    if (conflicts.length > 0 && edits.length > 0)
        action = "partial";
    else if (conflicts.length > 0)
        action = "partial";
    else if (intent.type === "restore" && changed)
        action = "restored";
    else if (changed)
        action = "synced";
    if (intent.type === "restore" && conflicts.length > 0)
        action = "partial";
    return {
        source: nextSource,
        state: nextState,
        report: {
            action,
            conflicts,
            connected: intent.type === "apply",
        },
    };
}
export function project(current, reread, state, intent) {
    const source = current ?? "";
    const planned = reconcile(source, state, intent);
    if (planned.source !== source) {
        const again = reread() ?? "";
        if (again !== source)
            throw new BridgeError("assistant.toml changed during sync");
    }
    return planned;
}
function applyWants(intent, fields) {
    const wants = [
        ["auth_type", stringPresence("api_key"), false],
        ["api_key", stringPresence(intent.apiKey), false],
        ["base_url", stringPresence(intent.baseURL), false],
        ["model", stringPresence(intent.roles.simple), false],
        ["chat_model", stringPresence(intent.roles.deep), false],
        ["fast_model", { present: false }, false],
    ];
    const memory = fields.memory_curator_model;
    if (intent.roles.memory)
        wants.push(["memory_curator_model", stringPresence(intent.roles.memory), false]);
    else if (memory)
        wants.push(["memory_curator_model", memory.original, true]);
    return wants;
}
function planApply(source, key, record, want, drop) {
    const current = readPresence(source, key);
    if (!record) {
        if (samePresence(current, want))
            return { drop: false, conflict: false };
        return {
            edit: editFor(key, want),
            record: drop ? undefined : { original: current, injected: injectedMark(want) },
            drop,
            conflict: false,
        };
    }
    if (samePresence(current, want)) {
        if (drop)
            return { drop: true, conflict: false };
        return { record: { original: record.original, injected: injectedMark(want) }, drop: false, conflict: false };
    }
    if (samePresence(current, record.injected)) {
        return {
            edit: editFor(key, want),
            record: drop ? undefined : { original: record.original, injected: injectedMark(want) },
            drop,
            conflict: false,
        };
    }
    return { record, drop: false, conflict: true };
}
function planRestore(source, key, record) {
    const current = readPresence(source, key);
    if (samePresence(current, record.original) || (!current.present && !record.original.present)) {
        return { drop: true, conflict: false };
    }
    if (samePresence(current, record.injected)) {
        return { edit: editFor(key, record.original), drop: true, conflict: false };
    }
    return { record, drop: false, conflict: true };
}
function editFor(key, want) {
    if (!want.present)
        return { key, op: "remove" };
    // A value read from the user's file remembers the previous key. Putting it
    // back has to use that anchor. A freshly chosen id has no anchor and is set
    // in place, or inserted before the first table when the key is new.
    if (want.kind !== "string" || want.anchor)
        return { key, op: "restore", original: want };
    return { key, op: "set", value: want.value };
}
function injectedMark(want) {
    if (!want.present)
        return { present: false };
    if (want.kind === "string")
        return stringPresence(want.value);
    return want;
}
function byManagedOrder(left, right) {
    const ai = MANAGED_KEYS.indexOf(left);
    const bi = MANAGED_KEYS.indexOf(right);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
}
export function freshState() {
    return emptyState();
}
