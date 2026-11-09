export const agent: {
  id: string
  name: string
  format: string
  config: string
  bin: string
  dir: string
  notice: string
  model?: string
}

export function connect(input: unknown): { baseURL: string; apiKey: string }
