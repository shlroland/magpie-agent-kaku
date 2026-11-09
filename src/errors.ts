export class BridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BridgeError"
  }
}

export function publicError(error: unknown, secrets: readonly string[]): BridgeError {
  if (error instanceof BridgeError) return new BridgeError(redact(error.message, secrets))
  return new BridgeError("Kaku bridge failed closed")
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  const unique = [...new Set(secrets.filter((item) => item.length >= 4))]
  unique.sort((a, b) => b.length - a.length)
  for (const secret of unique) out = out.split(secret).join("[redacted]")
  return out
}
