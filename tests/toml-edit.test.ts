import { describe, expect, test } from "bun:test"

import { editDocument, readPresence } from "../src/toml-edit.js"

const secret = "super-secret-value"

describe("TOML field edits", () => {
  test("preserves comments, top-level keys, and table bodies", () => {
    const source = [
      "# Kaku Assistant configuration",
      "enabled = true # stay",
      'api_key = "user-key" # mine',
      "",
      "[provider]",
      "# inner",
      'name = "custom" # keep',
      'web_search_api_key = "search-secret"',
      "",
    ].join("\n")
    const next = editDocument(source, [
      { key: "model", op: "set", value: "group/kaku-simple" },
      { key: "chat_model", op: "set", value: "group/kaku-deep" },
      { key: "base_url", op: "set", value: "http://127.0.0.1:3425/v1" },
    ])
    expect(next).toContain("# Kaku Assistant configuration")
    expect(next).toContain("enabled = true # stay")
    expect(next).toContain('api_key = "user-key" # mine')
    expect(next).toContain("# inner")
    expect(next).toContain('name = "custom" # keep')
    expect(next).toContain('web_search_api_key = "search-secret"')
    expect(next.indexOf('model = "group/kaku-simple"')).toBeLessThan(next.indexOf("[provider]"))
    expect(next.indexOf('chat_model = "group/kaku-deep"')).toBeLessThan(next.indexOf("[provider]"))
    expect(next.indexOf("[provider]")).toBeLessThan(next.indexOf('name = "custom" # keep'))
  })

  test("updates quoted keys and leaves dotted keys alone", () => {
    const source = '"chat_model" = \'deep\' # quoted\na.b = "dotted"\nmodel.extra = "nope"\n'
    expect(() => editDocument(source, [{ key: "model", op: "set", value: "group/x" }])).toThrow(
      /already a table or dotted key/,
    )
    const next = editDocument(source, [{ key: "chat_model", op: "set", value: "group/kaku-deep" }])
    expect(next).toContain('"chat_model" = "group/kaku-deep" # quoted')
    expect(next).toContain('a.b = "dotted"')
    expect(next).toContain('model.extra = "nope"')
  })

  test("keeps CRLF outside the edited value", () => {
    const source = "# head\r\nenabled = true\r\nmodel = 'old'\r\n\r\n[provider]\r\nname = \"x\"\r\n"
    const next = editDocument(source, [{ key: "model", op: "set", value: "group/kaku-simple" }])
    expect(next).toContain("\r\n")
    expect(next).toContain("# head\r\n")
    expect(next).toContain('[provider]\r\nname = "x"\r\n')
    const model = readPresence(next, "model")
    expect(model.present).toBe(true)
    if (model.present && model.kind === "string") expect(model.value).toBe("group/kaku-simple")
  })

  test("removes a legacy key without taking the comment above it", () => {
    const source = "# legacy simple\nfast_model = \"mini\" # old\nmodel = \"deep\"\n"
    const next = editDocument(source, [{ key: "fast_model", op: "remove" }])
    expect(next).toContain("# legacy simple\n")
    expect(next).toContain("# old\n")
    expect(next).not.toContain("fast_model")
    expect(next).toContain('model = "deep"')
  })

  test("puts a removed key back after the key that preceded it", () => {
    const source = 'model = "gpt-mini"\nchat_model = "gpt-deep"\nfast_model = "legacy-mini"\nauth_type = "codex"\n\n[provider]\nname = "custom" # table\n'
    const original = readPresence(source, "fast_model")
    const removed = editDocument(source, [{ key: "fast_model", op: "remove" }])
    expect(removed).not.toContain("fast_model")
    const restored = editDocument(removed, [{ key: "fast_model", op: "restore", original }])
    expect(restored).toBe(source)
  })

  test("restores a primitive value token", () => {
    const source = "model = 1\n"
    const original = readPresence(source, "model")
    const edited = editDocument(source, [{ key: "model", op: "set", value: "group/kaku-simple" }])
    const restored = editDocument(edited, [{ key: "model", op: "restore", original }])
    expect(restored).toBe("model = 1\n")
  })

  test("rejects duplicate and invalid documents without echoing secrets", () => {
    expect(() =>
      editDocument(`api_key = "${secret}"\nmodel = "a"\nmodel = "b"\n`, [{ key: "chat_model", op: "set", value: "x" }]),
    ).toThrow(/duplicate/)
    try {
      editDocument(`api_key = "${secret}"\nmodel = \n`, [{ key: "chat_model", op: "set", value: "x" }])
      throw new Error("invalid toml was accepted")
    } catch (error) {
      expect(String(error)).not.toContain(secret)
      expect(String(error)).toContain("not valid TOML")
    }
  })

  test("inserts into an empty file and does not rewrite an equal string", () => {
    const created = editDocument("", [{ key: "model", op: "set", value: "group/kaku-simple" }])
    expect(created).toBe('model = "group/kaku-simple"\n')
    const same = editDocument("model = 'group/kaku-simple'\n", [{ key: "model", op: "set", value: "group/kaku-simple" }])
    expect(same).toBe("model = 'group/kaku-simple'\n")
  })
})
