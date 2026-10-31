// `it` for tests that npm test leaves out and npm run test:slow runs (vitest.config.ts):
// each test registered through it is tagged slow. `slowIt.live(...)`, `slowIt.effect(...)`, or
// `slowIt(...)` for a plain Vitest test, with the same arguments as `it`.
import { makeMethods } from "@effect/vitest"
import { it } from "vitest"

const tagged = new Proxy(it, {
  apply: (target, self, args: Array<unknown>) => {
    const [name, second, third] = args
    const options = typeof second === "function" ? {} : typeof second === "number" ? { timeout: second } : second
    const fn = typeof second === "function" ? second : third
    const timeout = typeof second === "function" && typeof third === "number" ? { timeout: third } : {}
    return Reflect.apply(target, self, [name, { ...timeout, ...(options as object), tags: ["slow"] }, fn])
  }
})

export const slowIt = makeMethods(tagged)
