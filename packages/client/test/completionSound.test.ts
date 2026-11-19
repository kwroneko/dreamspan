import { afterEach, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Notice } from "@dreamspan/shared/noticeApi.ts"
// Load the UI graph before test deadlines; no assertion depends on import/transform speed.
import * as sound from "../src/features/completionSound.ts"
import { register } from "../src/features/completionSoundFeature.tsx"
import {
  noticeChannels,
  NoticeChannelSettings,
  activateNoticeChannels,
  receiveNoticeChannels,
  noticeDeduplicator
} from "../src/features/noticeContributions.tsx"

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
  vi.clearAllMocks()
  stored.clear()
  state = "suspended"
})

it("is opt-in, activates only on interaction, skips suspended audio and stops after opt-out", () => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k),
    setItem: (k: string, v: string) => stored.set(k, v)
  })
  vi.stubGlobal("AudioContext", FakeAudio)
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

it("deduplicates replayed versions across chats and subscription retries", () => {
  const first = noticeDeduplicator()
  expect(first({ versionId: "v1", status: "complete" })).toBe(true)
  expect(first({ versionId: "v1", status: "complete" })).toBe(false)
  expect(first({ versionId: "v2", status: "failed" })).toBe(true)
  expect(first({ versionId: "v2", status: "failed" })).toBe(false)
})

it("replaces or disables sound settings, activation and playback together, then restores them", () => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k),
    setItem: (k: string, v: string) => stored.set(k, v)
  })
  vi.stubGlobal("AudioContext", FakeAudio)
  const dispose = register()
  sound.setSoundWanted(true)
  state = "running"
  const notice = { status: "complete" } as Extract<Notice, { _tag: "ReplyFinished" }>
  const render = () => renderToStaticMarkup(createElement(NoticeChannelSettings))
  expect(render()).toContain("Completion sound")
  activateNoticeChannels()
  receiveNoticeChannels(notice)
  expect(resume).toHaveBeenCalledOnce()
  expect(start).toHaveBeenCalledOnce()
  const disabled = noticeChannels.disable("notifications.completion-sound")
  expect(render()).toBe("")
  activateNoticeChannels()
  receiveNoticeChannels(notice)
  expect(resume).toHaveBeenCalledOnce()
  expect(start).toHaveBeenCalledOnce()
  disabled()
  const activate = vi.fn()
  const receive = vi.fn()
  const replacement = noticeChannels.register({
    id: "notifications.completion-sound",
    component: () => createElement("span", null, "Alternative sound"),
    activate,
    receive
  })
  expect(render()).toBe("<span>Alternative sound</span>")
  activateNoticeChannels()
  receiveNoticeChannels(notice)
  expect(activate).toHaveBeenCalledOnce()
  expect(receive).toHaveBeenCalledWith(notice)
  expect(start).toHaveBeenCalledOnce()
  replacement()
  expect(render()).toContain("Completion sound")
  receiveNoticeChannels({ ...notice, status: "failed" })
  expect(start).toHaveBeenCalledTimes(2)
  dispose()
  expect(render()).toBe("")
})
