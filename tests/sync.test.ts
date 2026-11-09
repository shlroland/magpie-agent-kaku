import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { main } from "../src/cli.js"
import { readBridge } from "../src/io.js"
import { emptyState } from "../src/state.js"
import { project } from "../src/sync.js"
import { commandSync, startBridge } from "../src/runtime.js"
import type { RoleOptions } from "../src/options.js"

const roles: RoleOptions = {
  simple: "group/kaku-simple",
  deep: "group/kaku-deep",
  memory: null,
  configPath: null,
}

const userToml = `# keep
enabled = true
api_key = "user-key" # mine
model = "gpt-mini"
chat_model = "gpt-deep"
fast_model = "legacy-mini"
web_search_api_key = "search-secret"
auth_type = "codex"

[provider]
name = "custom" # table
`

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kaku-bridge-"))
}

function writeUser(home: string, text = userToml): string {
  const file = path.join(home, ".config", "kaku", "assistant.toml")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

function connect(home: string, key = "magpie-kaku"): void {
  const bridge = path.join(home, ".config", "magpie-agent-kaku", "bridge.json")
  fs.mkdirSync(path.dirname(bridge), { recursive: true, mode: 0o700 })
  fs.writeFileSync(bridge, `{\n  // gateway\n  "baseURL": "http://127.0.0.1:3425/v1",\n  "apiKey": "${key}"\n}\n`, { mode: 0o600 })
}

describe("role sync", () => {
  test("binds simple and deep, removes legacy fast_model, and leaves memory and search keys", () => {
    const home = tempHome()
    const file = writeUser(home)
    connect(home)
    const logs: string[] = []
    const report = commandSync({ home, options: roles, log: (line) => logs.push(line) }, "sync")
    const text = fs.readFileSync(file, "utf8")
    expect(report.action).toBe("synced")
    expect(text).toContain('model = "group/kaku-simple"')
    expect(text).toContain('chat_model = "group/kaku-deep"')
    expect(text).toContain('auth_type = "api_key"')
    expect(text).toContain('api_key = "magpie-kaku"')
    expect(text).toContain('base_url = "http://127.0.0.1:3425/v1"')
    expect(text).not.toContain("fast_model")
    expect(text).not.toContain("memory_curator_model")
    expect(text).toContain('web_search_api_key = "search-secret"')
    expect(text).toContain("# keep")
    expect(text).toContain('name = "custom" # table')
    expect(logs.join("\n")).not.toContain("user-key")
    expect(logs.join("\n")).not.toContain("magpie-kaku")
    const stateMode = fs.statSync(path.join(home, ".config", "magpie-agent-kaku", "state.json")).mode & 0o777
    expect(stateMode).toBe(0o600)
    const dirMode = fs.statSync(path.join(home, ".config", "magpie-agent-kaku")).mode & 0o777
    expect(dirMode).toBe(0o700)
  })

  test("a repeated sync does not rewrite the config or state", () => {
    const home = tempHome()
    const file = writeUser(home)
    connect(home)
    commandSync({ home, options: roles, log: () => {} }, "sync")
    const before = fs.statSync(file)
    const state = path.join(home, ".config", "magpie-agent-kaku", "state.json")
    const stateBefore = fs.statSync(state)
    const report = commandSync({ home, options: roles, log: () => {} }, "sync")
    const after = fs.statSync(file)
    const stateAfter = fs.statSync(state)
    expect(report.action).toBe("noop")
    expect(report.wroteConfig).toBe(false)
    expect(report.wroteState).toBe(false)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(stateAfter.mtimeMs).toBe(stateBefore.mtimeMs)
  })

  test("optional memory is written only when opted in, then restored when cleared", () => {
    const home = tempHome()
    const file = writeUser(home, userToml.replace("[provider]", 'memory_curator_model = "curator"\n\n[provider]'))
    connect(home)
    commandSync({ home, options: { ...roles, memory: "group/kaku-memory" }, log: () => {} }, "sync")
    expect(fs.readFileSync(file, "utf8")).toContain('memory_curator_model = "group/kaku-memory"')
    commandSync({ home, options: roles, log: () => {} }, "sync")
    expect(fs.readFileSync(file, "utf8")).toContain('memory_curator_model = "curator"')
  })

  test("manual edits conflict and are not overwritten", () => {
    const home = tempHome()
    const file = writeUser(home)
    connect(home)
    commandSync({ home, options: roles, log: () => {} }, "sync")
    const text = fs.readFileSync(file, "utf8").replace('model = "group/kaku-simple"', 'model = "my-edit"')
    fs.writeFileSync(file, text)
    const report = commandSync({ home, options: roles, log: () => {} }, "sync")
    expect(report.conflicts).toContain("model")
    expect(fs.readFileSync(file, "utf8")).toContain('model = "my-edit"')
    expect(fs.readFileSync(file, "utf8")).toContain('chat_model = "group/kaku-deep"')
  })

  test("restore is conflict-aware and partial", () => {
    const home = tempHome()
    const file = writeUser(home)
    connect(home)
    commandSync({ home, options: roles, log: () => {} }, "sync")
    const text = fs.readFileSync(file, "utf8").replace('chat_model = "group/kaku-deep"', 'chat_model = "kept"')
    fs.writeFileSync(file, text)
    const report = commandSync({ home, options: roles, log: () => {} }, "restore")
    const restored = fs.readFileSync(file, "utf8")
    expect(report.action).toBe("partial")
    expect(report.conflicts).toEqual(["chat_model"])
    expect(restored).toContain('model = "gpt-mini"')
    expect(restored).toContain('api_key = "user-key" # mine')
    expect(restored).toContain('auth_type = "codex"')
    expect(restored).toContain('fast_model = "legacy-mini"')
    expect(restored.indexOf('chat_model = "kept"')).toBeLessThan(restored.indexOf('fast_model = "legacy-mini"'))
    expect(restored.indexOf('fast_model = "legacy-mini"')).toBeLessThan(restored.indexOf('auth_type = "codex"'))
    expect(restored).toContain('chat_model = "kept"')
    const runtime = startBridge({ home, options: roles, debounceMs: 20, log: () => {} })
    try {
      expect(runtime.report().action).toBe("paused")
      expect(fs.readFileSync(file, "utf8")).toContain('model = "gpt-mini"')
    } finally {
      runtime.stop()
    }
  })

  test("invalid bridge and invalid toml fail closed", () => {
    const home = tempHome()
    const file = writeUser(home)
    const bridge = path.join(home, ".config", "magpie-agent-kaku", "bridge.json")
    fs.mkdirSync(path.dirname(bridge), { recursive: true })
    fs.writeFileSync(bridge, '{"baseURL": "http://127.0.0.1:3425/v1"')
    const blocked = commandSync({ home, options: roles, log: () => {} }, "sync")
    expect(blocked.action).toBe("blocked")
    expect(fs.readFileSync(file, "utf8")).toBe(userToml)
    fs.writeFileSync(bridge, '{"baseURL":"http://127.0.0.1:3425/v1","apiKey":"magpie-kaku"}\n')
    fs.writeFileSync(file, 'api_key = "user-key"\nmodel = \n')
    const logs: string[] = []
    const invalid = commandSync({ home, options: roles, log: (line) => logs.push(line) }, "sync")
    expect(invalid.action).toBe("blocked")
    expect(fs.readFileSync(file, "utf8")).toContain('api_key = "user-key"')
    expect(logs.join("\n")).not.toContain("user-key")
  })

  test("rechecks the file before writing", () => {
    const source = 'model = "old"\n'
    expect(() =>
      project(source, () => 'model = "changed"\n', emptyState(), {
        type: "apply",
        roles,
        baseURL: "http://127.0.0.1:3425/v1",
        apiKey: "magpie-kaku",
      }),
    ).toThrow(/changed during sync/)
  })

  test("a missing file is created owner-only", () => {
    const home = tempHome()
    connect(home)
    const report = commandSync({ home, options: roles, log: () => {} }, "sync")
    const file = path.join(home, ".config", "kaku", "assistant.toml")
    expect(report.wroteConfig).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(file, "utf8")).toContain('model = "group/kaku-simple"')
  })

  test("a symlink is updated at its target and keeps its mode", () => {
    const home = tempHome()
    connect(home)
    const file = path.join(home, ".config", "kaku", "assistant.toml")
    const target = path.join(home, "real.toml")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(target, "enabled = true # keep\n", { mode: 0o640 })
    fs.symlinkSync(target, file)
    commandSync({ home, options: roles, log: () => {} }, "sync")
    expect(fs.readlinkSync(file)).toBe(target)
    expect(fs.readFileSync(target, "utf8")).toContain('model = "group/kaku-simple"')
    expect(fs.readFileSync(target, "utf8")).toContain("enabled = true # keep")
    expect(fs.statSync(target).mode & 0o777).toBe(0o640)
  })

  test("recovery refuses a config that matches neither recorded hash", () => {
    const home = tempHome()
    const file = writeUser(home)
    connect(home)
    commandSync({ home, options: roles, log: () => {} }, "sync")
    const pending = path.join(home, ".config", "magpie-agent-kaku", "state.json.pending")
    fs.writeFileSync(
      pending,
      `${JSON.stringify({
        previousHash: "a".repeat(64),
        nextHash: "b".repeat(64),
        previous: emptyState(),
        next: emptyState(),
      })}\n`,
    )
    const before = fs.readFileSync(file, "utf8")
    const report = commandSync({ home, options: roles, log: () => {} }, "sync")
    expect(report.action).toBe("blocked")
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  test("jsonc bridge comments are accepted", () => {
    const text = '{\n  // note\n  "baseURL": "http://127.0.0.1:3425/v1/",\n  "apiKey": "magpie-kaku",\n}\n'
    const view = readBridge(text)
    expect(view.status).toBe("connected")
    if (view.status === "connected") expect(view.link.baseURL).toBe("http://127.0.0.1:3425/v1")
  })
})

describe("watch and cli", () => {
  test("a directory watch applies a bridge written after startup and ignores its own rewrite", async () => {
    const home = tempHome()
    const file = writeUser(home)
    const logs: string[] = []
    const runtime = startBridge({ home, options: roles, debounceMs: 30, log: (line) => logs.push(line) })
    try {
      connect(home)
      const started = Date.now()
      while (!fs.readFileSync(file, "utf8").includes("group/kaku-simple")) {
        if (Date.now() - started > 2000) throw new Error(`watch did not sync: ${logs.join(" | ")}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const stamp = fs.statSync(file).mtimeMs
      fs.writeFileSync(path.join(home, ".config", "magpie-agent-kaku", "bridge.json"), fs.readFileSync(path.join(home, ".config", "magpie-agent-kaku", "bridge.json")))
      await new Promise((resolve) => setTimeout(resolve, 180))
      expect(fs.statSync(file).mtimeMs).toBe(stamp)
      expect(logs.join("\n")).not.toContain("user-key")
    } finally {
      runtime.stop()
    }
  })

  test("cli restore and status stay inside --home", () => {
    const home = tempHome()
    const file = writeUser(home)
    connect(home)
    const options = JSON.stringify(roles)
    const previous = process.env.MAGPIE_KAKU_OPTIONS
    process.env.MAGPIE_KAKU_OPTIONS = options
    try {
      expect(main(["sync", "--home", home])).toBe(0)
      expect(fs.readFileSync(file, "utf8")).toContain("group/kaku-simple")
      expect(main(["restore", "--home", home])).toBe(0)
      expect(fs.readFileSync(file, "utf8")).toContain('model = "gpt-mini"')
      expect(main(["status", "--home", home])).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.MAGPIE_KAKU_OPTIONS
      else process.env.MAGPIE_KAKU_OPTIONS = previous
    }
  })
})
