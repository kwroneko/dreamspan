// Workshop chats in the client (spec/WORKSHOP.md W2): what a chat kind's registered look changes
// (the composer's strip, the side panel's tabs, the root's accent) and the capability chip's text.
// Synthetic views only; a plugin's kind uses the same registrations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { Effect } from "effect"
import { availableComposerControls, type ComposerControlContext } from "../src/features/chat/composerControls.tsx"
import {
  chatKindLooks,
  kindHides,
  kindRootProps,
  kindShows,
  mergesInto,
  summarizes
} from "../src/features/chat/kindLooks.ts"
import { panelTabs } from "../src/features/chat/panels.tsx"
import { registerComposerControls } from "../src/features/chat/registerComposerControls.tsx"
import { registerPanels } from "../src/features/chat/registerPanels.tsx"
import type { ChatView } from "../src/features/chat/session.ts"
import { chipLabel, chipText, modeText, type WorkshopCapability } from "../src/features/workshop/capabilities.ts"
import { register as registerWorkshop } from "../src/features/workshop/index.tsx"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const chatOf = (kind: string) => ({ kind }) as ChatView["chat"]
const viewOf = (kind: string) => ({ cast: null, chat: chatOf(kind) }) as ChatView
const contextOf = (kind: string) =>
  ({
    compact: false,
    view: viewOf(kind),
    reply: { candidates: ["synthetic-a"], muted: [], next: null, picked: null, onPick: () => {} },
    guidance: false,
    leaf: undefined,
    leafGenerating: false
  }) as unknown as ComposerControlContext
const strip = (kind: string) => availableComposerControls("strip", contextOf(kind)).map((entry) => entry.id)

describe("chat kind looks", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    dispose = [...registerComposerControls(), ...registerPanels(), ...registerWorkshop()]
  })
  afterEach(() => {
    for (const close of dispose.reverse()) close()
  })

  it("gives a workshop the capability chip in place of who replies; a story chat's strip is unchanged", () => {
    expect(strip("rp")).toEqual([
      "composer.model",
      "composer.preset",
      "composer.cache",
      "composer.next",
      "composer.reply-now"
    ])
    expect(strip("workshop")).toEqual(["composer.model", "composer.preset", "composer.cache", "workshop.capabilities"])
  })

  it("leaves the Summaries tab out of a kind whose profile has none, and keeps the rest", () => {
    const tabs = (kind: string) => panelTabs(viewOf(kind), null).map((tab) => tab.value)
    expect(tabs("rp")).toContain("summaries")
    expect(tabs("workshop")).not.toContain("summaries")
    expect(tabs("workshop")).toEqual(tabs("rp").filter((tab) => tab !== "summaries"))
    expect(summarizes(chatOf("workshop"))).toBe(false)
    expect(summarizes(null)).toBe(true)
    expect(mergesInto(chatOf("workshop"))).toBe(false)
    expect(mergesInto(chatOf("rp"))).toBe(true)
  })

  it("sets the accent through the kind's token, and nothing for a kind without a look", () => {
    expect(kindRootProps(chatKindLooks.get("workshop"))).toEqual({
      "data-chat-kind": "workshop",
      "data-chat-accent": "",
      style: { "--chat-accent": "var(--accent-workshop)", "--chat-accent-contrast": "var(--accent-workshop-contrast)" }
    })
    expect(kindRootProps(chatKindLooks.get("rp"))).toEqual({})
  })

  it("takes a plugin's kind from its registrations alone: its look, its hidden and added controls", () => {
    const profile = chatKinds.get("workshop")!
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          yield* chatKinds.register({ ...profile, id: "synthetic/assistant", allowsSummaries: true })
          const closeLook = chatKindLooks.register({
            id: "synthetic/assistant",
            badge: { label: "Assistant", hint: "A synthetic kind." },
            accent: "--accent-synthetic",
            hides: ["composer.cache"],
            shows: ["workshop.capabilities"]
          })
          try {
            expect(strip("synthetic/assistant")).toEqual([
              "composer.model",
              "composer.preset",
              "workshop.capabilities",
              "composer.next",
              "composer.reply-now"
            ])
            expect(kindHides("synthetic/assistant", "composer.cache")).toBe(true)
            expect(kindShows("synthetic/assistant", "workshop.capabilities")).toBe(true)
            expect(panelTabs(viewOf("synthetic/assistant"), null).map((tab) => tab.value)).toContain("summaries")
          } finally {
            closeLook()
          }
        })
      )
    )
    expect(chatKinds.get("synthetic/assistant")).toBeUndefined()
    // Disabling the workshop's look gives its chats the story look and strip.
    const off = chatKindLooks.disable("workshop")
    try {
      expect(strip("workshop")).toEqual(strip("rp"))
    } finally {
      off()
    }
  })
})

describe("the capability chip", () => {
  const capability = (id: string, mode: WorkshopCapability["mode"], always = false): WorkshopCapability => ({
    id,
    order: 0,
    label: id,
    explanation: "Synthetic.",
    mode,
    ...(always ? { always } : {})
  })

  it("counts what's allowed and what asks first, leaving out a count of none", () => {
    const read = capability("library.read", "allow", true)
    expect(chipText([read])).toBe("Can: 1")
    expect(chipLabel([read])).toBe("What the assistant may do: 1 allowed")
    const several = [read, capability("a", "allow"), capability("b", "ask"), capability("c", "off")]
    expect(chipText(several)).toBe("Can: 2 · Asks: 1")
    expect(chipLabel(several)).toBe("What the assistant may do: 2 allowed, 1 asking first")
    expect(several.map(modeText)).toEqual(["Always allowed", "Allowed", "Asks first", "Off"])
  })
})
