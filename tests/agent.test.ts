import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import plugin from "../src/index.js"
import { agent, connect } from "../agent.js"

describe("agent descriptor", () => {
  test("is a connection switch and returns only gateway fields", () => {
    expect(agent.id).toBe("kaku")
    expect(agent.format).toBe("json")
    expect("model" in agent).toBe(false)
    expect(() => connect({})).toThrow(/not ready/)
    expect(connect({ gateway: { v1: "http://127.0.0.1:3425/v1", key: "magpie-kaku" } })).toEqual({
      baseURL: "http://127.0.0.1:3425/v1",
      apiKey: "magpie-kaku",
    })
    const source = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
    expect(source).not.toMatch(/\bimport\b|\brequire\s*\(|\bfetch\s*\(|\bBun\b|\bnode:|\bfs\b/)
  })
})

describe("package and fake host", () => {
  test("manifest has a built entry and no install scripts", () => {
    const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      main: string
      scripts: Record<string, string>
      magpie: { agent: string }
      private: boolean
    }
    expect(manifest.private).toBe(true)
    expect(manifest.main).toBe("./dist/index.js")
    expect(manifest.magpie.agent).toBe("./agent.js")
    expect(manifest.scripts.install).toBeUndefined()
    expect(manifest.scripts.postinstall).toBeUndefined()
    expect(manifest.scripts.preinstall).toBeUndefined()
    expect(fs.existsSync(new URL("../dist/index.js", import.meta.url))).toBe(true)
    const dist = fs.readFileSync(new URL("../dist/index.js", import.meta.url), "utf8")
    expect(dist).not.toMatch(/export\s+function\s+(?!MagpieKakuAgent)/)
    expect(dist).toContain("export default")
  })

  test("the host entry syncs a bridge and restores it on disconnect", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kaku-host-"))
    const configDir = path.join(home, ".config", "kaku")
    fs.mkdirSync(configDir, { recursive: true })
    const file = path.join(configDir, "assistant.toml")
    fs.writeFileSync(file, 'enabled = true\nmodel = "mine"\nweb_search_api_key = "search-secret"\n')
    const previousHome = process.env.MAGPIE_KAKU_HOME
    const previousXdg = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    process.env.MAGPIE_KAKU_HOME = home
    try {
      await plugin(undefined, { simple: "group/kaku-simple", deep: "provider/model" })
      const bridgeDir = path.join(home, ".config", "magpie-agent-kaku")
      fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 })
      const bridge = path.join(bridgeDir, "bridge.json")
      fs.writeFileSync(bridge, `${JSON.stringify(connect({ gateway: { v1: "http://127.0.0.1:3499/v1", key: "magpie-kaku" } }))}\n`)
      const started = Date.now()
      while (!fs.readFileSync(file, "utf8").includes("group/kaku-simple")) {
        if (Date.now() - started > 2000) throw new Error(fs.readFileSync(file, "utf8"))
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(fs.readFileSync(file, "utf8")).toContain('web_search_api_key = "search-secret"')
      expect(fs.readFileSync(file, "utf8")).toContain('chat_model = "provider/model"')
      fs.writeFileSync(bridge, "{}\n")
      const restoredAt = Date.now()
      while (fs.readFileSync(file, "utf8").includes("group/kaku-simple")) {
        if (Date.now() - restoredAt > 2000) throw new Error(fs.readFileSync(file, "utf8"))
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(fs.readFileSync(file, "utf8")).toContain('model = "mine"')
    } finally {
      const slot = (globalThis as Record<symbol, { stop?: () => void }>)[Symbol.for("magpie.kaku.agent.v1")]
      slot?.stop?.()
      if (previousHome === undefined) delete process.env.MAGPIE_KAKU_HOME
      else process.env.MAGPIE_KAKU_HOME = previousHome
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
    }
  })
})
