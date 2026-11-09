#!/usr/bin/env node
// Real Magpie CLI integration against a local mock. No vendor keys and no paid calls.
//
//   MAGPIE_BIN=/path/to/magpie node scripts/integration-smoke.mjs
//
// Install the terminal build first, in any home:
//   curl -fsSL https://usemagpie.ai/install.sh | sh -s -- --tui
// Verified with magpie 0.1.3304 (magpie-cli-linux-amd64).

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const magpie = process.env.MAGPIE_BIN || "magpie"
const mockPort = Number(process.env.MOCK_PORT || 18771)
const gatewayPort = Number(process.env.MAGPIE_PORT || 34991)
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kaku-magpie-it-"))
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`,
  PATH: `${path.join(home, ".local", "bin")}${path.delimiter}${process.env.PATH || ""}`,
}
const tomlPath = path.join(home, ".config", "kaku", "assistant.toml")
const children = []

function fail(message) {
  console.error(`integration: ${message}`)
  shutdown()
  process.exit(1)
}

function run(args, { allowFail = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(magpie, args, { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => { out += chunk })
    child.stderr.on("data", (chunk) => { err += chunk })
    child.on("close", (code) => {
      const text = `${out}\n${err}`
      if (code !== 0 && !allowFail) fail(`magpie ${args.join(" ")} exited ${code}\n${text}`)
      resolve({ code, text })
    })
  })
}

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, { env: { ...env, ...extraEnv }, cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  children.push(child)
  child.stdout.on("data", (chunk) => process.stdout.write(chunk))
  child.stderr.on("data", (chunk) => process.stderr.write(chunk))
  return child
}

async function waitFor(label, probe, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (await probe()) return
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  fail(`timed out waiting for ${label}`)
}

function assertIncludes(text, needle) {
  if (!text.includes(needle)) fail(`missing ${JSON.stringify(needle)} in:\n${text}`)
}

async function main() {
  fs.mkdirSync(path.dirname(tomlPath), { recursive: true })
  fs.copyFileSync(path.join(root, "scripts", "fixtures", "assistant.toml"), tomlPath)
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, ".local", "bin", "kaku"), "#!/bin/sh\necho kaku-fake\n", { mode: 0o755 })

  const version = await run(["version"])
  console.log(`magpie: ${version.text.trim()}`)

  start(process.execPath, [path.join(root, "scripts", "mock-openai.mjs")], { MOCK_PORT: String(mockPort) })
  await waitFor("mock", async () => {
    const response = await fetch(`http://127.0.0.1:${mockPort}/v1/models`)
    return response.ok
  })

  await run(["provider", "add", "Local Mock", `url=http://127.0.0.1:${mockPort}/v1`, "key=mock-local", "models=simple-a,simple-b,deep-a,deep-b,memory-a"])
  await run(["group", "add", "Kaku simple", "models=local-mock/simple-a,local-mock/simple-b", "routing=order", "stays=turn"])
  await run(["group", "add", "Kaku deep", "models=local-mock/deep-a,local-mock/deep-b", "routing=order", "stays=turn"])
  await run(["group", "add", "Kaku memory", "models=local-mock/memory-a", "routing=order", "stays=turn"])
  await run(["plugin", "add", root])
  await run(["plugin", "options", root, JSON.stringify({ simple: "group/kaku-simple", deep: "group/kaku-deep", memory: "group/kaku-memory" })])

  const serve = start(magpie, ["serve"])
  await waitFor("gateway", async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/hello`)
    return response.ok
  })

  const shown = await run(["kaku", "--help"])
  assertIncludes(shown.text, "fields: provider")
  await run(["kaku", "magpie"])
  await waitFor("toml injection", async () => fs.readFileSync(tomlPath, "utf8").includes("group/kaku-simple"))
  const injected = fs.readFileSync(tomlPath, "utf8")
  for (const needle of [
    "# Kaku Assistant configuration",
    'api_key = "magpie-kaku" # mine',
    'model = "group/kaku-simple"',
    'chat_model = "group/kaku-deep"',
    'memory_curator_model = "group/kaku-memory"',
    'base_url = "http://127.0.0.1:' + gatewayPort + '/v1"',
    'auth_type = "api_key"',
    'web_search_api_key = "search-secret"',
    'name = "custom" # table',
  ]) assertIncludes(injected, needle)
  if (injected.includes("fast_model")) fail("fast_model was left in place while connected")

  const models = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, { headers: { authorization: "Bearer magpie-kaku" } })).json()
  const ids = new Set((models.data || []).map((item) => item.id))
  for (const id of ["group/kaku-simple", "group/kaku-deep", "group/kaku-memory"]) {
    if (!ids.has(id)) fail(`gateway catalog missing ${id}`)
  }

  const simple = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer magpie-kaku", "content-type": "application/json" },
    body: JSON.stringify({ model: "group/kaku-simple", stream: true, messages: [{ role: "user", content: "ping simple" }] }),
  })
  const simpleBody = await simple.text()
  assertIncludes(simpleBody, "pong:simple-a")

  const tool = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer magpie-kaku", "content-type": "application/json" },
    body: JSON.stringify({
      model: "group/kaku-deep",
      stream: true,
      messages: [{ role: "user", content: "please use the tool" }],
      tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
    }),
  })
  assertIncludes(await tool.text(), "tool_calls")
  const follow = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer magpie-kaku", "content-type": "application/json" },
    body: JSON.stringify({
      model: "group/kaku-deep",
      stream: true,
      messages: [
        { role: "user", content: "please use the tool" },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"ok\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
      tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
    }),
  })
  assertIncludes(await follow.text(), "tool-done:deep-a")

  const calls = await (await fetch(`http://127.0.0.1:${mockPort}/__calls`)).json()
  const deep = calls.filter((call) => String(call.model).startsWith("deep"))
  if (deep.length < 2 || deep.some((call) => call.model !== "deep-a")) fail(`tool roundtrip did not stay on deep-a: ${JSON.stringify(calls)}`)

  await run(["kaku", "default"])
  await waitFor("disconnect restore", async () => {
    const text = fs.readFileSync(tomlPath, "utf8")
    return text.includes('model = "gpt-mini"') && text.includes('fast_model = "legacy-mini"') && !text.includes("group/kaku-simple")
  })
  const restored = fs.readFileSync(tomlPath, "utf8")
  const fixture = fs.readFileSync(path.join(root, "scripts", "fixtures", "assistant.toml"), "utf8")
  if (restored !== fixture) fail(`disconnect did not restore the original file\n--- got ---\n${restored}\n--- want ---\n${fixture}`)

  await run(["kaku", "magpie"])
  await waitFor("reinject", async () => fs.readFileSync(tomlPath, "utf8").includes("group/kaku-simple"))
  await run(["plugin", "off", root])
  await waitFor("disable restore", async () => !fs.readFileSync(tomlPath, "utf8").includes("group/kaku-simple"))
  if (fs.readFileSync(tomlPath, "utf8") !== fixture) fail("plugin off did not restore assistant.toml")

  console.log("integration: passed")
  console.log(`home: ${home}`)
  shutdown()
  process.exit(0)
}

const shutdown = () => {
  for (const child of children) child.kill("SIGTERM")
}
process.on("exit", shutdown)
process.on("SIGINT", () => { shutdown(); process.exit(1) })

main().catch((error) => {
  if (!process.exitCode) process.exitCode = 1
  console.error(error.message || error)
  shutdown()
})
