// Deterministic OpenAI-compatible stand-in. No network except 127.0.0.1.
import http from "node:http"

const port = Number(process.env.MOCK_PORT || 18765)
const calls = []

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(typeof body === "string" ? body : JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (chunk) => chunks.push(chunk))
  req.on("end", () => {
    const url = new URL(req.url || "/", "http://127.0.0.1")
    const body = Buffer.concat(chunks).toString("utf8")
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const ids = ["simple-a", "simple-b", "deep-a", "deep-b", "memory-a"]
      send(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "mock" })) })
      return
    }
    if (req.method === "GET" && url.pathname === "/__calls") {
      send(res, 200, calls)
      return
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let payload = {}
      try {
        payload = JSON.parse(body || "{}")
      } catch {
        send(res, 400, { error: { message: "bad json" } })
        return
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const last = messages[messages.length - 1] || {}
      const hasToolResult = messages.some((message) => message.role === "tool" || message.tool_call_id)
      const user = typeof last.content === "string" ? last.content : ""
      calls.push({
        model: payload.model,
        stream: Boolean(payload.stream),
        tools: Array.isArray(payload.tools) ? payload.tools.length : 0,
        hasToolResult,
        user,
      })
      const wantTool = !hasToolResult && Array.isArray(payload.tools) && payload.tools.length > 0 && user.includes("tool")
      const text = hasToolResult ? `tool-done:${payload.model}` : `pong:${payload.model}`
      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        const id = "chatcmpl-mock"
        const chunk = (delta, finish) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        if (wantTool) {
          res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: "" } }] }, null))
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"text\":\"ok\"}" } }] }, null))
          res.write(chunk({}, "tool_calls"))
        } else {
          res.write(chunk({ role: "assistant", content: text }, null))
          res.write(chunk({}, "stop"))
        }
        res.end("data: [DONE]\n\n")
        return
      }
      if (wantTool) {
        send(res, 200, {
          id: "chatcmpl-mock",
          object: "chat.completion",
          model: payload.model,
          choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"ok\"}" } }] }, finish_reason: "tool_calls" }],
        })
        return
      }
      send(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      })
      return
    }
    send(res, 404, { error: { message: "not found" } })
  })
})

server.listen(port, "127.0.0.1", () => {
  console.log(`mock listening on 127.0.0.1:${port}`)
})
