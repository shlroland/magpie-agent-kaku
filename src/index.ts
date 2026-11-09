import { startBridge, type Runtime } from "./runtime.js"

const SLOT = Symbol.for("magpie.kaku.agent.v1")

type GlobalSlot = typeof globalThis & { [SLOT]?: Runtime }

// Magpie calls every function exported from this module. Keep the default
// export as the only export.
export default async function MagpieKakuAgent(_input: unknown, options: unknown): Promise<Record<string, never>> {
  const holder = globalThis as GlobalSlot
  const existing = holder[SLOT]
  if (existing) {
    existing.updateOptions(options)
    return {}
  }
  const started = startBridge({ options })
  holder[SLOT] = started
  process.once("exit", () => {
    try {
      started.flush()
    } catch {
      console.error("kaku: bridge flush failed; assistant.toml and recovery state were left in place")
    }
  })
  return {}
}
