import { afterEach, expect, it, vi } from "vitest"

const stored = new Map<string, string>()
const resume = vi.fn(async () => {})
const start = vi.fn()
const stop = vi.fn()
let state = "suspended"
class FakeAudio {
  get state() {
    return state
  }
  currentTime = 10
  destination = {}
  resume = resume
  createOscillator = () => ({
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start,
    stop
  })
  createGain = () => ({
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn()
  })
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
  stored.clear()
  state = "suspended"
})

it("is opt-in, activates only on interaction, skips suspended audio and stops after opt-out", async () => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k),
    setItem: (k: string, v: string) => stored.set(k, v)
  })
  vi.stubGlobal("AudioContext", FakeAudio)
  const sound = await import("../src/features/completionSound.ts")
  expect(sound.soundWanted()).toBe(false)
  sound.activateSound()
  sound.playCompletionSound()
  expect(resume).not.toHaveBeenCalled()
  sound.setSoundWanted(true)
  sound.playCompletionSound()
  expect(start).not.toHaveBeenCalled()
  sound.activateSound()
  expect(resume).toHaveBeenCalledOnce()
  sound.playCompletionSound()
  expect(start).not.toHaveBeenCalled()
  state = "running"
  sound.playCompletionSound()
  expect(start).toHaveBeenCalledWith(10)
  expect(stop).toHaveBeenCalledWith(10.24)
  sound.setSoundWanted(false)
  sound.playCompletionSound()
  expect(start).toHaveBeenCalledOnce()
})

it("deduplicates replayed versions across chats and subscription retries", async () => {
  const { noticeDeduplicator } = await import("../src/features/completionSound.ts")
  const first = noticeDeduplicator()
  expect(first({ versionId: "v1", status: "complete" })).toBe(true)
  expect(first({ versionId: "v1", status: "complete" })).toBe(false)
  expect(first({ versionId: "v2", status: "failed" })).toBe(true)
  expect(first({ versionId: "v2", status: "failed" })).toBe(false)
})
