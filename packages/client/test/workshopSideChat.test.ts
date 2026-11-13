// The workshop beside a story in the client (spec/WORKSHOP.md §4, W9): which workshop the URL
// shows and how an unknown one falls back, where the Workshop tab and "Talk about this chat" are
// offered, and the URL keys a chat shown inside another's panel uses. Synthetic chats only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Chat } from "@rp/shared/chat.ts"
import { chatPlaceKey } from "../src/features/chat/chatPlace.ts"
import { availableCommands, type ChatCommandContext } from "../src/features/chat/commands.tsx"
import { takesSideChat } from "../src/features/chat/kindLooks.ts"
import { panelHere, panelTabs, type PanelProps } from "../src/features/chat/panels.tsx"
import { registerPanels } from "../src/features/chat/registerPanels.tsx"
import type { ChatView } from "../src/features/chat/session.ts"
import { register as registerWorkshop } from "../src/features/workshop/index.tsx"
import { chooseSideChat, sideChatSearch, SIDE_CHAT_SCOPE, SIDE_CHAT_TAB } from "../src/features/workshop/sideChat.ts"
import { WorkshopSidePanel } from "../src/features/workshop/SidePanel.tsx"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const workshop = (id: string) => ({ id, kind: "workshop", title: `About ${id}` }) as unknown as Chat
const viewOf = (kind: string | null) => ({ cast: null, chat: kind === null ? null : { kind } }) as ChatView
const contextOf = (kind: string | null) =>
  ({
    view: viewOf(kind),
    session: {},
    onHistory: () => {},
    onJump: () => {},
    navigate: () => {}
  }) as unknown as ChatCommandContext

describe("the workshop shown beside a story", () => {
  const newest = workshop("newest")
  const older = workshop("older")

  it("unmounts the session when its panel tab is no longer active", () => {
    expect(renderToStaticMarkup(createElement(WorkshopSidePanel, { active: false } as PanelProps))).toBe("")
  })

  it("shows the one the URL names", () => {
    expect(chooseSideChat([newest, older], "older")).toEqual({ shown: older, missing: false })
  })

  it("shows the newest without one", () => {
    expect(chooseSideChat([newest, older], null)).toEqual({ shown: newest, missing: false })
  })

  it("falls back to the newest, and says so, for one that isn't beside the story", () => {
    expect(chooseSideChat([newest, older], "deleted")).toEqual({ shown: newest, missing: true })
  })

  it("shows none for a story without workshops, saying so only when one was named", () => {
    expect(chooseSideChat([], null)).toEqual({ shown: null, missing: false })
    expect(chooseSideChat([], "deleted")).toEqual({ shown: null, missing: true })
  })
})

describe("where the workshop beside a story is offered", () => {
  let panels: Array<() => void>
  let workshops: Array<() => void>
  beforeEach(() => {
    panels = registerPanels()
    workshops = registerWorkshop()
  })
  afterEach(() => {
    for (const close of [...panels, ...workshops].reverse()) close()
  })

  it("gives a story chat the Workshop tab and menu entry, and a workshop neither", () => {
    expect(takesSideChat({ kind: "rp" })).toBe(true)
    expect(takesSideChat({ kind: "workshop" })).toBe(false)
    expect(takesSideChat(null)).toBe(false)
    const tabs = (kind: string) => panelTabs(viewOf(kind), null).map((tab) => tab.value)
    expect(tabs("rp")).toContain(SIDE_CHAT_TAB)
    expect(tabs("workshop")).not.toContain(SIDE_CHAT_TAB)
    expect(panelHere(viewOf("workshop"), SIDE_CHAT_TAB)).toBeNull()
    const commands = (kind: string | null) => availableCommands(contextOf(kind)).map((command) => command.id)
    expect(commands("rp")).toContain("workshop.talk-about")
    expect(commands("workshop")).not.toContain("workshop.talk-about")
    // Not before the chat is known (a chat page still loading).
    expect(commands(null)).not.toContain("workshop.talk-about")
  })

  it("fills the panel with its chat and explains its menu entry", () => {
    const tab = panelTabs(viewOf("rp"), null).find((entry) => entry.value === SIDE_CHAT_TAB)!
    expect(tab.label).toBe("Workshop")
    expect(tab.descriptor.fill).toBe(true)
    const command = availableCommands(contextOf("rp")).find((entry) => entry.id === "workshop.talk-about")!
    expect(command.label).toBe("Talk about this chat")
    expect(command.description).toBe("Opens a workshop beside this chat to talk about it out of character")
  })

  it("goes when the workshop feature is unregistered, as a plugin's would", () => {
    for (const close of workshops.splice(0).reverse()) close()
    expect(panelTabs(viewOf("rp"), null).map((tab) => tab.value)).not.toContain(SIDE_CHAT_TAB)
    expect(availableCommands(contextOf("rp")).map((command) => command.id)).not.toContain("workshop.talk-about")
  })
})

describe("URL keys of a chat inside another's panel", () => {
  it("drops only the previous workshop's choices when switching workshops", () => {
    const previous = {
      workshop: "one",
      "side.fork": "old-fork",
      "side.messageDialog": "old-message",
      "side.stepEdit": "old-step",
      fork: "story-fork",
      messageDialog: "story-message",
      panel: "workshop"
    }
    expect(sideChatSearch(previous, "two")).toEqual({
      workshop: "two",
      fork: "story-fork",
      messageDialog: "story-message",
      panel: "workshop"
    })
    expect(sideChatSearch(previous, "one")).toEqual(previous)
  })
  it("keeps the page's chat's keys plain and scopes the other's", () => {
    expect(chatPlaceKey("", "messageDialog")).toBe("messageDialog")
    expect(chatPlaceKey(SIDE_CHAT_SCOPE, "messageDialog")).toBe("side.messageDialog")
    expect(chatPlaceKey(SIDE_CHAT_SCOPE, "fork")).toBe("side.fork")
  })
})
