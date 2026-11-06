import { WorkbenchDevice } from "@rp/shared/workbenchApi.ts"
import { Schema } from "effect"
import { afterEach, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const storage = (stored: Map<string, string>, mode: "ok" | "throws" | "drops" = "ok") =>
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (mode === "throws") throw new Error("storage off")
      return stored.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (mode === "throws") throw new Error("storage off")
      if (mode === "ok") stored.set(key, value)
    }
  })

const load = async () => (await import("../src/features/workbench/device.ts")).deviceId

it("makes a device id once, keeps it and reads it back on the next load", async () => {
  const stored = new Map<string, string>()
  storage(stored)
  const first = (await load())()
  expect(Schema.is(WorkbenchDevice)(first)).toBe(true)
  expect(first).not.toBe("shared")
  expect(stored.get("rp.device")).toBe(first)
  vi.resetModules()
  expect((await load())()).toBe(first)
})

it("a browser that can't keep the id, or holds a bad one, falls back or starts over", async () => {
  storage(new Map(), "throws")
  expect((await load())()).toBe("shared")
  vi.resetModules()
  storage(new Map(), "drops")
  expect((await load())()).toBe("shared")
  vi.resetModules()
  const stored = new Map([["rp.device", "not a valid id"]])
  storage(stored)
  const id = (await load())()
  expect(id).not.toBe("not a valid id")
  expect(stored.get("rp.device")).toBe(id)
})
