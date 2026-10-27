import { afterEach, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const browser = (values: Record<string, string> = {}, unavailable = false) => {
  const stored = new Map(Object.entries(values))
  const dataset: Record<string, string> = {}
  const events = new Map<string, (event: Record<string, unknown>) => void>()
  vi.stubGlobal("document", { documentElement: { dataset } })
  vi.stubGlobal("window", {
    addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => events.set(name, listener)
  })
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (unavailable) throw new Error("storage off")
      return stored.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (unavailable) throw new Error("storage off")
      stored.set(key, value)
    }
  })
  return { stored, dataset, events }
}

it("applies saved concealment before rendering, remembers the last concealment and follows other tabs", async () => {
  const { stored, dataset, events } = browser({ "rp.images": "hide", "rp.avatarStyle": "square" })
  const prefs = await import("../src/ui/imagePrefs.ts")
  prefs.applyImagePrefs()
  expect(dataset).toEqual({ images: "hide" })
  prefs.setImageMode("blur")
  prefs.toggleImages()
  expect(dataset.images).toBe("show")
  prefs.toggleImages()
  expect(dataset.images).toBe("blur")
  prefs.setImageMode("hide")
  prefs.toggleImages()
  prefs.toggleImages()
  expect(dataset.images).toBe("hide")
  expect(stored.get("rp.images.conceal")).toBe("hide")
  stored.set("rp.images", "show")
  stored.set("rp.avatarStyle", "round")
  events.get("storage")!({ key: "rp.images" })
  expect(dataset).toEqual({ images: "show" })
  stored.clear()
  events.get("storage")!({ key: null })
  expect(dataset).toEqual({ images: "show" })
})

it("validates corrupted values and works without localStorage, including the shortcut in a field", async () => {
  const { dataset, events } = browser({ "rp.images": "bad", "rp.avatarStyle": "bad" })
  const prefs = await import("../src/ui/imagePrefs.ts")
  prefs.applyImagePrefs()
  expect(dataset).toEqual({ images: "show" })
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("storage off")
    },
    setItem: () => {
      throw new Error("storage off")
    }
  })
  const preventDefault = vi.fn()
  const key = {
    code: "KeyB",
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    preventDefault,
    target: { tagName: "TEXTAREA" }
  }
  events.get("keydown")!({ ...key, repeat: true })
  expect(dataset.images).toBe("show")
  events.get("keydown")!(key)
  expect(dataset.images).toBe("blur")
  expect(preventDefault).toHaveBeenCalledOnce()
  prefs.setImageMode("hide")
  prefs.toggleImages()
  prefs.toggleImages()
  expect(dataset).toEqual({ images: "hide" })
})
