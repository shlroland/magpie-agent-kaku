import { BridgeError } from "./errors.js"
import { samePresence, type Presence } from "./toml-edit.js"

export interface FieldRecord {
  original: Presence
  injected: Presence
}

export interface SavedState {
  version: 1
  fields: Record<string, FieldRecord>
  pause: { bridgeHash: string } | null
}

export function emptyState(): SavedState {
  return { version: 1, fields: {}, pause: null }
}

export function loadState(text: string | null): SavedState {
  if (text === null || text.trim() === "") return emptyState()
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new BridgeError("bridge state is invalid")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("bridge state is invalid")
  }
  const record = value as Partial<SavedState>
  if (record.version !== 1 || !record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) {
    throw new BridgeError("bridge state is invalid")
  }
  const fields: Record<string, FieldRecord> = {}
  for (const [key, field] of Object.entries(record.fields)) {
    if (!field || typeof field !== "object") throw new BridgeError("bridge state is invalid")
    const candidate = field as Partial<FieldRecord>
    if (!isPresence(candidate.original) || !isPresence(candidate.injected)) {
      throw new BridgeError("bridge state is invalid")
    }
    fields[key] = { original: candidate.original, injected: candidate.injected }
  }
  let pause: SavedState["pause"] = null
  if (record.pause !== undefined && record.pause !== null) {
    if (typeof record.pause !== "object" || typeof record.pause.bridgeHash !== "string" || !/^[a-f0-9]{64}$/.test(record.pause.bridgeHash)) {
      throw new BridgeError("bridge state is invalid")
    }
    pause = { bridgeHash: record.pause.bridgeHash }
  }
  return { version: 1, fields, pause }
}

export function serializeState(state: SavedState): string {
  const fields = Object.fromEntries(
    Object.keys(state.fields)
      .sort()
      .map((key) => [key, state.fields[key]]),
  )
  return `${JSON.stringify({ version: 1, pause: state.pause, fields }, null, 2)}\n`
}

export function sameState(left: SavedState, right: SavedState): boolean {
  return serializeState(left) === serializeState(right)
}

export function stateSecrets(state: SavedState): string[] {
  const secrets: string[] = []
  for (const field of Object.values(state.fields)) {
    for (const presence of [field.original, field.injected]) {
      if (presence.present && presence.kind === "string" && presence.value.length >= 4) secrets.push(presence.value)
    }
  }
  return secrets
}

export function sameRecord(left: FieldRecord | undefined, right: FieldRecord | undefined): boolean {
  if (!left || !right) return left === right
  return samePresence(left.original, right.original) && samePresence(left.injected, right.injected)
}

function isPresence(value: unknown): value is Presence {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<Presence>
  if (record.present === false) return true
  if (record.present !== true) return false
  if ("anchor" in record && record.anchor != null && typeof record.anchor !== "string") return false
  if (record.kind === "string") {
    return typeof record.value === "string" && typeof record.rawValue === "string" && typeof record.rawStatement === "string"
  }
  if (record.kind === "other") return typeof record.rawValue === "string" && typeof record.rawStatement === "string"
  return false
}
