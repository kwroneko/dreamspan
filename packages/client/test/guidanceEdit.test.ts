// Guidance on swipes (DESIGN §2.2, owner 2026-10-29): what a new version and Continue are
// asked with, the guidance editor, its edit button and "New version with guidance…" entry points, and the bar.
import type { ChatId, EntityId, ForkId, PathEntry, SlotId, Version, VersionId } from "@dreamspan/shared/chat.ts"
import { AtomRegistry } from "effect/reactivity"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// rpc.ts reads the page's location when imported.
vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
const { ChatSession } = await import("../src/features/chat/session.ts")
const { CastContext, castView } = await import("../src/features/chat/cast.ts")
const { availableComposerControls, ComposerControls, composerControls } =
  await import("../src/features/chat/composerControls.tsx")
const { availableMessageActions } = await import("../src/features/chat/messageActions.tsx")
const { registerComposerControls } = await import("../src/features/chat/registerComposerControls.tsx")
const { TooltipProvider } = await import("../src/ui/Tooltip.tsx")
const { composerGuidance, editStillShown, GuidanceEditor, guidanceEditor, MessageDirection, registerGuidanceEdit } =
  await import("../src/features/chat/guidanceEdit.tsx")

const aria = "aria" as EntityId
const version = (slot: string, direction: string | null, writer: "model" | "human" = "model") =>
  ({
    id: `v-${slot}` as VersionId,
    slotId: slot as SlotId,
    status: "complete",
    speakerEntityId: aria,
    writer,
    content: "The tide comes in.",
    direction
  }) as unknown as Version
const entry = (slot: string, direction: string | null, writer: "model" | "human" = "model") =>
  ({
    slotId: slot as SlotId,
    rowVersion: 4,
    version: version(slot, direction, writer),
    versionCount: 1,
    firstSpeakerEntityId: aria
  }) as unknown as PathEntry

const markup = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, element))

/** A session whose writes are recorded instead of sent. */
const session = () => {
  const s = new ChatSession("chat-1" as ChatId, null, AtomRegistry.make(), "user")
  const requests: Array<{ method: string; payload: Record<string, unknown> }> = []
  type StubClient = (method: string, payload: Record<string, unknown>) => Promise<unknown>
  ;(s as unknown as { slotWrite: (slot: SlotId, run: (client: StubClient) => Promise<unknown>) => unknown }).slotWrite =
    async (_slot, run) => ({
      ok: true,
      value: await run(async (method, payload) => {
        requests.push({ method, payload })
        return null
      })
    })
  return { s, requests }
}

describe("what a new version is asked with", () => {
  it("reuses the re-rolled version's guidance, the composer's text unused, with the toggle on or off (rule 2)", async () => {
    for (const toggle of [true, false]) {
      const { s, requests } = session()
      const editor = new GuidanceEditor()
      s.provideGuidance(
        composerGuidance(
          editor,
          () => toggle,
          () => "My own next message."
        )
      )
      await s.regenerate(entry("s2", "Make it rain."))
      expect(requests[0]!.method).toBe("Regenerate")
      // No direction given: the server reuses the version's own.
      expect(requests[0]!.payload).not.toHaveProperty("direction")
      s.dispose()
    }
  })

  it("Continue still takes the box's text with the toggle on, and none with it off", async () => {
    for (const [toggle, expected] of [
      [true, "Then the tide turns."],
      [false, undefined]
    ] as const) {
      const { s, requests } = session()
      s.provideGuidance(
        composerGuidance(
          new GuidanceEditor(),
          () => toggle,
          () => "Then the tide turns."
        )
      )
      await s.continueVersion(entry("s2", null))
      expect(requests[0]!.payload.direction).toBe(expected)
      s.dispose()
    }
  })

  it("for the reply being edited, uses the box as it is now, unsaved edits and an empty box included (rule 4)", async () => {
    const { s, requests } = session()
    const editor = new GuidanceEditor()
    let box = "Make it rain."
    s.provideGuidance(
      composerGuidance(
        editor,
        () => false,
        () => box
      )
    )
    editor.open(entry("s2", "Make it rain."), null)
    await s.regenerate(entry("s2", "Make it rain."))
    box = "Make it snow."
    await s.regenerate(entry("s2", "Make it rain."))
    box = ""
    await s.regenerate(entry("s2", "Make it rain."))
    // Any other reply keeps its own guidance; Continue of another reply takes none.
    await s.regenerate(entry("s1", "Wake up."))
    await s.continueVersion(entry("s1", null))
    expect(requests.map((r) => [r.method, r.payload.slotId ?? null, r.payload.direction])).toEqual([
      ["Regenerate", "s2", "Make it rain."],
      ["Regenerate", "s2", "Make it snow."],
      ["Regenerate", "s2", ""],
      ["Regenerate", "s1", undefined],
      ["ContinueVersion", null, undefined]
    ])
    s.dispose()
  })
})

describe("the guidance editor", () => {
  it("opens on a reply, handing the composer its guidance once (none for a reply without), and closes (rules 3 and 5)", () => {
    const editor = new GuidanceEditor()
    const seen: Array<unknown> = []
    editor.subscribe(() => seen.push(editor.snapshot()?.slotId ?? null))
    editor.open(entry("s2", "Make it rain."), "f1" as ForkId)
    expect(editor.snapshot()).toEqual({ slotId: "s2", forkId: "f1", speakerEntityId: aria })
    expect(editor.takePending()).toBe("Make it rain.")
    expect(editor.takePending()).toBeNull()
    editor.open(entry("s3", null), null)
    expect(editor.takePending()).toBeNull()
    editor.close()
    expect(editor.snapshot()).toBeNull()
    expect(seen).toEqual(["s2", "s3", null])
  })

  it("stays only while its reply is on the path shown, in the fork it was opened in (rule 5)", () => {
    const edit = { slotId: "s2" as SlotId, forkId: "f1" as ForkId, speakerEntityId: aria }
    const entries = [entry("s1", null), entry("s2", "Rain.")]
    expect(editStillShown(edit, { forkId: "f1" as ForkId, entries })).toBe(true)
    expect(editStillShown(edit, { forkId: "f1" as ForkId, entries: entries.slice(0, 1) })).toBe(false)
    expect(editStillShown(edit, { forkId: "f2" as ForkId, entries })).toBe(false)
  })

  it("is the chat session's own, so another chat starts without one", () => {
    const a = new ChatSession("chat-a" as ChatId, null, AtomRegistry.make(), "user")
    const b = new ChatSession("chat-b" as ChatId, null, AtomRegistry.make(), "user")
    guidanceEditor(a).open(entry("s2", "Rain."), null)
    expect(guidanceEditor(a).snapshot()).not.toBeNull()
    expect(guidanceEditor(b).snapshot()).toBeNull()
  })
})

describe("guidance on swipes, as registered parts", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    dispose = [...registerComposerControls(), ...registerGuidanceEdit()]
  })
  afterEach(() => {
    for (const close of dispose.reverse()) close()
  })

  it("shows a reply's guidance with a visible Edit button, and nothing for a reply without (rule 3)", () => {
    const { s } = session()
    const shown = markup(createElement(MessageDirection, { entry: entry("s2", "Make it rain."), session: s }))
    expect(shown).toContain("Make it rain.")
    expect(shown).toContain('aria-label="Edit this guidance"')
    expect(markup(createElement(MessageDirection, { entry: entry("s2", null), session: s }))).toBe("")
    expect(markup(createElement(MessageDirection, { entry: entry("s2", "Rain.", "human"), session: s }))).toBe("")
  })

  it("offers New version with guidance… in the menu only for a reply without guidance (rule 3)", () => {
    const { s } = session()
    const offered = (e: PathEntry, generating = false) =>
      availableMessageActions({ entry: e, session: s, generating } as never).some(
        (action) => action.id === "message.add-guidance"
      )
    expect(offered(entry("s2", null))).toBe(true)
    expect(offered(entry("s2", "Rain."))).toBe(false)
    expect(offered(entry("s2", null, "human"))).toBe(false)
    expect(offered(entry("s2", null), true)).toBe(true)
  })

  it("shows the bar naming the reply, with a visible ✕, only while editing (rules 3, 5 and 6)", () => {
    const { s } = session()
    const context = { session: s } as never
    const cast = {
      ...castView(null),
      cards: new Map([[aria, { name: "Aria" }]])
    } as never
    const bar = () =>
      markup(
        createElement(
          CastContext.Provider,
          { value: cast },
          createElement(ComposerControls, { placement: "banner", context })
        )
      )
    expect(availableComposerControls("banner", context).map((c) => c.id)).toEqual(["composer.guidance-edit"])
    expect(bar()).toBe("")
    guidanceEditor(s).open(entry("s2", "Rain."), null)
    expect(bar()).toContain("Guidance for a new swipe of Aria&#x27;s reply")
    expect(bar()).toContain('aria-label="Close: back to new messages"')
    guidanceEditor(s).close()
    expect(bar()).toBe("")
  })

  it("submits through the visible primary button as well as Enter (rule 6)", () => {
    const generate = vi.fn(async () => {})
    const context = {
      guidance: true,
      busy: false,
      ready: true,
      generate,
      generateText: "New version",
      generateHint: "A new version of Aria's reply"
    } as never
    expect(markup(createElement(ComposerControls, { placement: "actions", context }))).toContain(
      'aria-label="New version"'
    )
    // Send keeps its place, disabled: no submit can post guidance as a message.
    expect(availableComposerControls("actions", context).map((c) => c.id)).toContain("composer.send")
    void composerControls.get("composer.generate")!.run!(context, "keyboard")
    void composerControls.get("composer.generate")!.run!(context, "button")
    expect(generate).toHaveBeenCalledTimes(2)
  })
})
