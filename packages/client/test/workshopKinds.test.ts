// Workshop chats in the client (spec/WORKSHOP.md W2): what a chat kind's registered look changes
// (the composer's strip, the side panel's tabs, the root's accent) and the capability chip's text.
// Synthetic views only; a plugin's kind uses the same registrations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { Effect } from "effect"
import {
  availableComposerControls,
  invokeComposerControl,
  type ComposerControlContext
} from "../src/features/chat/composerControls.tsx"
import {
  chatKindLooks,
  kindHides,
  kindRootProps,
  kindTitle,
  kindShows,
  mergesInto,
  summarizes
} from "../src/features/chat/kindLooks.ts"
import { panelTabs } from "../src/features/chat/panels.tsx"
import { registerComposerControls } from "../src/features/chat/registerComposerControls.tsx"
import { registerPanels } from "../src/features/chat/registerPanels.tsx"
import type { ChatView } from "../src/features/chat/session.ts"
import {
  chipLabel,
  chipText,
  choicesOf,
  modeText,
  type WorkshopCapability
} from "../src/features/workshop/capabilities.ts"
import { register as registerWorkshop } from "../src/features/workshop/index.tsx"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const chatOf = (kind: string) => ({ kind }) as ChatView["chat"]
const viewOf = (kind: string) => ({ cast: null, chat: chatOf(kind) }) as ChatView
const contextOf = (kind: string, candidates = 1) =>
  ({
    compact: false,
    view: viewOf(kind),
    reply: {
      candidates: Array.from({ length: candidates }, (_, i) => `synthetic-${i}`),
      muted: [],
      next: null,
      picked: null,
      onPick: () => {}
    },
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

  it("enforces hidden controls on invocation and keeps story and workshop Send working", async () => {
    for (const source of ["button", "keyboard"] as const) {
      const replyNow = vi.fn()
      const send = vi.fn()
      for (const kind of ["rp", "workshop"]) {
        const context = {
          ...contextOf(kind, 2),
          hasText: true,
          send,
          replyNow
        }
        await invokeComposerControl("composer.send", context, source)
        await invokeComposerControl("composer.reply-now", context, source)
      }
      expect(send).toHaveBeenCalledTimes(2)
      expect(replyNow).toHaveBeenCalledTimes(1)
    }
  })

  it("leaves the Summaries tab out of a kind whose profile has none, and keeps the rest", () => {
    const tabs = (kind: string) => panelTabs(viewOf(kind), null).map((tab) => tab.value)
    expect(tabs("rp")).toContain("summaries")
    // Workshops summarize too (spec/WORKSHOP-CONTEXT.md §2.4), and add their Changes tab.
    expect(tabs("rp")).not.toContain("workshop.changes")
    expect(tabs("workshop").filter((tab) => tab !== "workshop.changes")).toEqual(tabs("rp"))
    expect(tabs("workshop")).toContain("workshop.changes")
    expect(summarizes(chatOf("workshop"))).toBe(true)
    expect(summarizes(null)).toBe(true)
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          yield* chatKinds.register({ ...chatKinds.get("rp")!, id: "synthetic/plain", allowsSummaries: false })
          expect(tabs("synthetic/plain")).not.toContain("summaries")
          expect(tabs("synthetic/plain")).toEqual(tabs("rp").filter((tab) => tab !== "summaries"))
          expect(summarizes(chatOf("synthetic/plain"))).toBe(false)
        })
      )
    )
    expect(mergesInto(chatOf("workshop"))).toBe(false)
    expect(mergesInto(chatOf("rp"))).toBe(true)
    // Cast stays editable, and card rotation still affects assembly in a workshop.
    expect(kindHides("workshop", "settings.card-layout")).toBe(false)
  })

  it("sets the accent through the kind's token, and nothing for a kind without a look", () => {
    expect(kindRootProps(chatKindLooks.get("workshop"))).toEqual({
      "data-chat-kind": "workshop",
      "data-chat-accent": "",
      style: { "--chat-accent": "var(--accent-workshop)", "--chat-accent-contrast": "var(--accent-workshop-contrast)" }
    })
    expect(kindRootProps(chatKindLooks.get("rp"))).toEqual({})
    expect(kindTitle("Harbor", "rp")).toBe("Harbor")
    expect(kindTitle("Harbor", "workshop")).toBe("Workshop · Harbor")
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
            expect(kindTitle("Harbor", "synthetic/assistant")).toBe("Assistant · Harbor")
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
    defaultMode: mode,
    modes: always ? [mode] : ["allow", "ask", "off"],
    chosen: false,
    ...(always ? { always } : {})
  })

  it("counts what's allowed, what asks first and what's off, leaving out a count of none", () => {
    const read = capability("library.read", "allow", true)
    expect(chipText([read])).toBe("Can: 1")
    expect(chipLabel([read])).toBe("What the assistant may do: 1 allowed")
    const several = [read, capability("a", "allow"), capability("b", "ask"), capability("c", "off")]
    expect(chipText(several)).toBe("Can: 2 · Asks: 1 · Off: 1")
    expect(chipLabel(several)).toBe("What the assistant may do: 2 allowed, 1 asking first, 1 off")
    expect(several.map(modeText)).toEqual(["Always allowed", "Allowed", "Ask first", "Off"])
  })

  it("offers a capability's choices as Off, Ask first, Allowed, whatever order the server lists them in", () => {
    expect(choicesOf({ ...capability("x", "ask"), modes: ["allow", "off", "ask"] })).toEqual(["off", "ask", "allow"])
    expect(choicesOf({ ...capability("x", "ask"), modes: ["ask", "off"] })).toEqual(["off", "ask"])
    expect(choicesOf(capability("library.read", "allow", true))).toEqual(["allow"])
  })
})
