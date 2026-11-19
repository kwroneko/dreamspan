// A chat that uses an earlier version of a card shows that version on the card's tab, read-only:
// the tab's text boxes edit the library's latest (synthetic card text).
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { CardDefinition, ChatCard } from "@dreamspan/shared/chatSetupApi.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { ChatDefinition } from "../src/features/chat/ChatDefinition.tsx"

it("shows the version the chat reads, its empty fields named in one line", () => {
  const info = new ChatCard({
    entityId: "mira" as EntityId,
    refId: "ref" as RefId,
    usedByChats: 2,
    binding: "revision",
    definition: new CardDefinition({
      description: "An older harbor pilot who reads the tides.",
      personality: "",
      scenario: "",
      firstMessage: "Mind the shoal.",
      exampleDialogue: "",
      creatorNotes: "",
      alternateGreetings: 2
    })
  })
  const html = renderToStaticMarkup(createElement(ChatDefinition, { name: "Mira", info }))
  expect(html).toContain("The version this chat uses")
  expect(html).toContain('aria-label="Mira as this chat uses them"')
  expect(html).toContain("An older harbor pilot who reads the tides.")
  expect(html).toContain("Mind the shoal.")
  expect(html).toContain("2 alternate greetings. Empty: personality, scenario, example messages, creator&#x27;s notes.")
})
