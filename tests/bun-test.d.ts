declare module "bun:test" {
  interface Expectation {
    toBe(value: unknown): void
    toEqual(value: unknown): void
    toContain(value: unknown): void
    toThrow(value?: unknown): void
    toBeLessThan(value: number): void
    toBeUndefined(): void
    toMatch(value: RegExp): void
    not: Expectation
  }
  export function describe(name: string, fn: () => void): void
  export function test(name: string, fn: () => void | Promise<void>): void
  export function expect(value: unknown): Expectation
}
