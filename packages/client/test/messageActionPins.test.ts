// Pinning message actions (owner, 2026-11-01): every action is listed in More actions, and
// the pinned ones (Edit, Continue, Branch from here and Delete until the user chooses) show
// as buttons on the message, in the menu's order, when available there. A generic part of
// the registry, so a plugin's action pins the same way and an unknown id is ignored.
import type { PathEntry } from "@dreamspan/shared/chat.ts"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerEditorHistory } from "../src/features/chat/editorHistory.tsx"
import { registerGuidanceEdit } from "../src/features/chat/guidanceEdit.tsx"
import { register as registerInsertMessage } from "../src/features/chat/insertMessage/index.tsx"
import {
  availableMessageActions,
  messageActionPins,
  messageActions,
  MessageActions,
  viewOf,
  type MessageActionContext,
  type MessageActionView
} from "../src/features/chat/messageActions.tsx"
import { registerMessageActions } from "../src/features/chat/registerMessageActions.tsx"
import { registerRewrites } from "../src/features/chat/rewrites.tsx"
import { TooltipProvider } from "../src/ui/Tooltip.tsx"

// These static toolbar tests isolate navigation; real URL transitions are covered in browser tests.
vi.mock("../src/usePlaceParam.ts", async (original) => ({
  ...(await original<typeof import("../src/usePlaceParam.ts")>()),
  usePlaceParam: (_key: string, fallback: string) => [fallback, () => {}]
}))

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1", origin: "http://127.0.0.1" })
})

const markup = (element: ReactNode) => renderToStaticMarkup(createElement(TooltipProvider, null, element))

const entryOf = (writer: "model" | "human", versionCount: number, extra: object = {}) =>
  ({
    slotId: "s1",
    versionCount,
    branchCount: 1,
    firstSpeakerEntityId: null,
    version: {
      id: "v1",
      writer,
      status: "complete",
      content: "Synthetic text.",
      direction: null,
      context: {},
      rewrite: { raw: true },
      ...extra
    }
  }) as unknown as PathEntry

const contextOf = (entry: PathEntry, generated = entry.version.writer === "model"): MessageActionContext => {
  const view = { entries: [entry], newer: null, older: null, loading: false, forkId: null, history: undefined }
  return {
    entry,
    session: { id: "c1", subscribe: () => () => {}, snapshot: () => view, textOf: () => "" },
    branchFork: null,
    generated,
    generating: false,
    hidden: false,
    report: () => {},
    toast: () => {}
  } as unknown as MessageActionContext
}

/** The buttons on the message, by accessible name, in order. */
const buttons = (context: MessageActionContext) =>
  [...markup(createElement(MessageActions, { context })).matchAll(/aria-label="([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter((name) => name !== "Message actions" && name !== "More actions")

/** Each available action's view on this message, by id. */
const views = (context: MessageActionContext) => {
  const found = new Map<string, MessageActionView>()
  const props = { ...context, openDialog: () => {}, closeDialog: () => {} }
  for (const action of availableMessageActions(context))
    markup(
      createElement(action.describe, {
        ...props,
        show: (view: MessageActionView) => {
          found.set(action.id, view)
          return null
        }
      })
    )
  return found
}

describe("pinned message actions", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    dispose = [
      ...registerMessageActions(),
      ...registerGuidanceEdit(),
      ...registerInsertMessage(),
      ...registerEditorHistory(),
      ...registerRewrites()
    ]
    messageActionPins.connect({}, null, null)
  })
  afterEach(() => {
    for (const close of dispose.reverse()) close()
    messageActionPins.connect({}, null, null)
  })

  it("shows Edit, Continue, Branch from here and Delete by default, in the menu's order", () => {
    expect(buttons(contextOf(entryOf("model", 3)))).toEqual(["Edit", "Continue", "Branch from here", "Delete swipe"])
    expect(buttons(contextOf(entryOf("human", 1)))).toEqual(["Edit", "Continue", "Branch from here", "Delete message"])
  })

  it("ignores a stored pin for the removed model action on normal, refused and human turns", () => {
    messageActionPins.connect({ "message.regenerate-with": true, "message.copy-text": true }, null, null)
    for (const entry of [entryOf("model", 1), entryOf("model", 1, { mark: "refused" }), entryOf("human", 1)]) {
      const context = contextOf(entry)
      expect(views(context).has("message.regenerate-with")).toBe(false)
      expect(buttons(context)).toEqual(["Edit", "Continue", "Branch from here", "Copy text", "Delete message"])
    }
  })

  it("pins and unpins by action id, ignores an unknown id, and hides an unavailable pinned action", () => {
    const reply = contextOf(entryOf("model", 3))
    messageActionPins.choose("message.copy-text", true)
    messageActionPins.choose("message.edit", false)
    messageActionPins.choose("plugin.not-installed", true)
    expect(buttons(reply)).toEqual(["Continue", "Branch from here", "Copy text", "Delete swipe"])
    // Delete all versions retains its pin and becomes disabled with only one version.
    messageActionPins.choose("message.delete-all", true)
    expect(buttons(reply)).toEqual(["Continue", "Branch from here", "Copy text", "Delete swipe", "Delete all swipes"])
    expect(buttons(contextOf(entryOf("model", 1)))).toEqual([
      "Continue",
      "Branch from here",
      "Copy text",
      "Delete message",
      "Delete all swipes"
    ])
    messageActionPins.choose("message.edit", true)
    expect(buttons(reply)[0]).toBe("Edit")
  })

  it("pins a plugin's action like a built-in one, and drops it with its registration", () => {
    const close = messageActions.register({
      id: "synthetic.pinnable",
      order: 105,
      describe: viewOf(() => ({ label: "Synthetic action", icon: "note", hint: "A synthetic plugin action." }))
    })
    const reply = contextOf(entryOf("model", 2))
    expect(buttons(reply)).not.toContain("Synthetic action")
    messageActionPins.choose("synthetic.pinnable", true)
    expect(buttons(reply)).toEqual(["Edit", "Continue", "Branch from here", "Synthetic action", "Delete swipe"])
    close()
    expect(buttons(reply)).toEqual(["Edit", "Continue", "Branch from here", "Delete swipe"])
  })

  it("gives every action its own icon, a short label and an explanation", () => {
    const icons = new Map<string, string>()
    for (const context of [
      contextOf(entryOf("model", 12)),
      contextOf(entryOf("human", 1)),
      { ...contextOf(entryOf("model", 1)), hidden: true }
    ]) {
      const shown = views(context)
      const used = [...shown.values()].map((view) => view.icon)
      expect(new Set(used).size).toBe(used.length)
      for (const [id, view] of shown) {
        // One icon per action across messages (visibility's eye/ghost aside, which says its state).
        if (id !== "message.visibility" && id !== "message.delete") {
          const before = icons.get(view.icon)
          expect(before === undefined || before === id, `${view.icon}: ${before} and ${id}`).toBe(true)
          icons.set(view.icon, id)
        }
        expect(view.label.length).toBeLessThanOrEqual(30)
        expect(view.hint.length).toBeGreaterThan(view.label.length)
      }
    }
    const reply = views(contextOf(entryOf("model", 12)))
    expect(reply.get("message.add-guidance")).toMatchObject({ label: "New swipe with guidance…", icon: "guidance" })
    expect(reply.get("message.delete-all")).toMatchObject({ label: "Delete all swipes", icon: "trash-all" })
    expect(reply.get("message.delete-all")!.hint).toBe(
      "Moves this message and all its swipes to the bin, from which it can be restored later."
    )
    expect(reply.get("message.delete")).toMatchObject({ label: "Delete swipe", icon: "trash" })
    // Every action the old menu and toolbar had is listed, the toolbar's included.
    expect([...reply.keys()]).toEqual([
      "message.edit",
      "message.continue",
      "message.write-version",
      "message.add-guidance",
      "message.branch",
      "message.insert-above",
      "message.insert-below",
      "message.duplicate",
      "message.merge",
      "message.visibility",
      "message.context",
      "message.original-text",
      "message.copy-text",
      "message.copy-link",
      "message.delete",
      "message.delete-all"
    ])
  })
})
