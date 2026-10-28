import { registerCharacterPanels } from "../src/features/characters/panels.tsx"
import { Effect } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  availableCommands,
  chatCommands,
  runCommandShortcut,
  type ChatCommandContext
} from "../src/features/chat/commands.tsx"
import { registerHistoryCommands } from "../src/features/chat/historyContributions.ts"
import {
  chatPanels,
  isPanelTab,
  panelTabs,
  PanelContent,
  resolvePanel,
  type PanelProps
} from "../src/features/chat/panels.tsx"
import { registerPanels } from "../src/features/chat/registerPanels.tsx"
import type { ChatView } from "../src/features/chat/session.ts"

// No chats or cards are read: each contribution sees only this synthetic view.
const view = { cast: null } as ChatView
const props = { tab: "notes", active: true, view, focus: null, notesFocus: null } as PanelProps
const scoped = (install: () => () => void) =>
  Effect.acquireRelease(Effect.sync(install), (dispose) => Effect.sync(dispose))

describe("chat contributions", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    dispose = [...registerPanels(), registerCharacterPanels(), ...registerHistoryCommands()]
  })
  afterEach(() => {
    for (const close of dispose.reverse()) close()
  })

  it("renders a plugin replacement of a built-in panel within a scope and restores it on close", async () => {
    const original = resolvePanel("notes")!
    const listener = vi.fn()
    const unsubscribe = chatPanels.subscribe(listener)
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* scoped(() =>
              chatPanels.register({
                ...original,
                label: "Synthetic notes",
                component: ({ tab, active }) => createElement("p", null, `${tab}: ${active ? "plugin" : "hidden"}`)
              })
            )
            const tab = panelTabs(view, "notes").find((tab) => tab.value === "notes")!
            expect(tab.label).toBe("Synthetic notes")
            expect(renderToStaticMarkup(createElement(PanelContent, { ...props, descriptor: tab.descriptor }))).toBe(
              "<p>notes: plugin</p>"
            )
          })
        )
      )
      expect(resolvePanel("notes")).toBe(original)
      expect(panelTabs(view, "notes").find((tab) => tab.value === "notes")?.label).toBe("Notes")
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
  })

  it("derives new URLs, ordering, availability and disabling from the same descriptors", async () => {
    expect(isPanelTab("synthetic.panel")).toBe(false)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* scoped(() =>
            chatPanels.register({
              id: "synthetic.panel",
              label: "Synthetic",
              order: 5,
              icon: "note",
              available: (current) => current.cast === null,
              component: () => createElement("p", null, "added by plugin")
            })
          )
          yield* scoped(() => chatPanels.disable("notes"))
          expect(isPanelTab("synthetic.panel")).toBe(true)
          expect(isPanelTab("notes")).toBe(false)
          expect(panelTabs(view, null)[0]?.value).toBe("synthetic.panel")
          expect(panelTabs({ cast: {} } as ChatView, null).some((tab) => tab.value === "synthetic.panel")).toBe(false)
          expect(
            renderToStaticMarkup(
              createElement(PanelContent, { ...props, descriptor: resolvePanel("synthetic.panel")! })
            )
          ).toBe("<p>added by plugin</p>")
        })
      )
    )
    expect(isPanelTab("synthetic.panel")).toBe(false)
    expect(isPanelTab("notes")).toBe(true)
  })

  it("keeps built-in character URLs and restores the character family after disabling it", () => {
    const id = "00000000-0000-4000-8000-000000000001"
    const value = `card:${id}`
    expect(isPanelTab(value)).toBe(true)
    expect(isPanelTab("card:invalid")).toBe(false)
    expect(isPanelTab("character")).toBe(false)
    expect(panelTabs(view, value).find((tab) => tab.value === value)?.label).toBe("Character")
    const restore = chatPanels.disable("character")
    expect(isPanelTab(value)).toBe(false)
    expect(panelTabs(view, value).some((tab) => tab.value === value)).toBe(false)
    restore()
    expect(isPanelTab(value)).toBe(true)
  })

  it("resolves tab families through registered matchers and lets a plugin replace a single family tab", () => {
    const family = {
      id: "synthetic.family",
      label: "Family",
      order: 100,
      icon: "people" as const,
      matches: (value: string) => /^synthetic:[ab]$/.test(value),
      tabs: () => [
        { value: "synthetic:a", label: "A" },
        { value: "synthetic:b", label: "B" }
      ],
      component: () => null
    }
    dispose.push(chatPanels.register(family))
    expect(isPanelTab("synthetic.family")).toBe(false)
    expect(isPanelTab("synthetic:a")).toBe(true)
    expect(isPanelTab("synthetic:invalid")).toBe(false)
    const close = chatPanels.register({
      id: "synthetic:a",
      label: "Alternative A",
      order: 1,
      icon: "note",
      component: () => null
    })
    expect(
      panelTabs(view, null)
        .filter((tab) => tab.value === "synthetic:a")
        .map((tab) => tab.label)
    ).toEqual(["Alternative A"])
    close()
    expect(resolvePanel("synthetic:a")).toBe(family)
    const enable = chatPanels.disable(family.id)
    expect(isPanelTab("synthetic:a")).toBe(false)
    enable()
    expect(isPanelTab("synthetic:a")).toBe(true)
  })

  it("hides history commands and its shortcut while their panel is disabled", () => {
    const onHistory = vi.fn()
    const context = { view, onHistory } as unknown as ChatCommandContext
    const restore = chatPanels.disable("history")
    expect(availableCommands(context)).toEqual([])
    expect(runCommandShortcut({ key: "h", ctrlKey: true, metaKey: false }, context)).toBe(false)
    expect(onHistory).not.toHaveBeenCalled()
    restore()
    expect(runCommandShortcut({ key: "h", ctrlKey: false, metaKey: true }, context)).toBe(true)
    expect(onHistory).toHaveBeenCalledTimes(1)
  })

  it("disables one family tab without falling back to its family, then restores it", () => {
    const value = "card:00000000-0000-4000-8000-000000000001"
    const original = resolvePanel(value)
    const restore = chatPanels.disable(value)
    dispose.push(restore)
    expect(resolvePanel(value)).toBeUndefined()
    expect(isPanelTab(value)).toBe(false)
    expect(panelTabs(view, value).some((tab) => tab.value === value)).toBe(false)
    restore()
    expect(resolvePanel(value)).toBe(original)
  })

  it("validates URLs and command targets against the family's tabs in the viewed chat", () => {
    dispose.push(
      chatPanels.register({
        id: "synthetic.family",
        label: "Family",
        order: 100,
        icon: "note",
        matches: (value) => value.startsWith("synthetic:"),
        tabs: () => [{ value: "synthetic:visible", label: "Visible" }],
        component: () => null
      }),
      chatCommands.register({
        id: "synthetic.command",
        label: "Unavailable target",
        order: 0,
        icon: "note",
        panel: "synthetic:absent",
        shortcut: { key: "x", mod: true },
        run: vi.fn()
      })
    )
    const context = { view } as ChatCommandContext
    expect(isPanelTab("synthetic:visible", view)).toBe(true)
    expect(isPanelTab("synthetic:absent", view)).toBe(false)
    expect(availableCommands(context).some((entry) => entry.id === "synthetic.command")).toBe(false)
    expect(runCommandShortcut({ key: "x", ctrlKey: true, metaKey: false }, context)).toBe(false)
  })

  it("executes a synthetic history command in scope, then restores the built-in command", async () => {
    const original = chatCommands.get("history.search-replace")!
    const onHistory = vi.fn()
    const alternative = vi.fn()
    const context = { view, onHistory } as unknown as ChatCommandContext
    original.run(context)
    expect(onHistory).toHaveBeenCalledTimes(1)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* scoped(() => chatCommands.register({ ...original, label: "Synthetic replacement", run: alternative }))
          yield* scoped(() => chatCommands.disable("history.edits"))
          yield* scoped(() =>
            chatCommands.register({
              id: "synthetic.hidden",
              label: "Hidden",
              order: 0,
              icon: "note",
              available: () => false,
              run: alternative
            })
          )
          const commands = availableCommands(context)
          expect(commands.map((entry) => entry.label)).toEqual(["Synthetic replacement"])
          expect(runCommandShortcut({ key: "h", ctrlKey: true, metaKey: false }, context)).toBe(true)
          expect(alternative).toHaveBeenCalledWith(context)
          expect(onHistory).toHaveBeenCalledTimes(1)
        })
      )
    )
    expect(chatCommands.get(original.id)).toBe(original)
    expect(availableCommands(context).map((entry) => entry.label)).toEqual(["Search and replace", "History edits"])
    chatCommands.get(original.id)!.run(context)
    expect(onHistory).toHaveBeenCalledTimes(2)
  })
})
