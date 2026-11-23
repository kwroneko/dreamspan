// Text typed in a chat: the composer, message editors, guidance, the queue, insertions,
// summaries, notes and the chat's own dialogs and settings.
import type { Page } from "@playwright/test"
import type { ChatId, EntityId, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { openRename, place, renameField, type PlaceContext } from "../durability.ts"
import { messageMenu, showActions } from "../message.ts"
import { noteText } from "../notes.ts"
import { openPanel, openSummarySettings } from "../panel.ts"
import { level1 } from "../summaries.ts"

const composer = (page: Page) => page.getByTestId("composer")
const rows = (page: Page) => page.locator("article[data-slot]")
const goChat = async (page: Page, { server }: PlaceContext, chatId: ChatId) => {
  await page.goto(`${server.url}/chats/${chatId}`)
  await rows(page).first().or(composer(page)).first().waitFor()
}

/** A chat with one message of the user's. */
const oneMessage = ({ rpc, tag }: PlaceContext) =>
  rpc((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: `Durable ${tag}` })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The lamp is lit." })
      return { chatId: chat.id }
    })
  )

/** A chat with Sam (played) and Aria: Sam's line, then Aria's reply, generated with guidance and stopped. */
const guidedReply = ({ rpc, tag }: PlaceContext) =>
  rpc((api) =>
    Effect.gen(function* () {
      const aria = (yield* api.CreateCard({ label: `Aria ${tag}`, name: "Aria" })).entityId
      const sam = (yield* api.CreateCard({ label: `Sam ${tag}`, name: "Sam" })).entityId
      const chat = yield* api.CreateChat({ title: `Durable ${tag}` })
      for (const id of [aria, sam])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: id } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [sam] } })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Sam ties the boat to the dock.",
        speakerEntityId: sam
      })
      if (sent._tag !== "Posted") throw new Error("Expected a posted message")
      const reply = yield* api.Generate({
        chatId: chat.id,
        parentSlotId: sent.entry.slotId,
        branch: false,
        speakerEntityId: aria as EntityId,
        direction: "Aria looks out to sea."
      })
      if (reply._tag !== "Posted") throw new Error("Expected a posted reply")
      yield* api.StopGeneration({ versionId: reply.entry.version.id as VersionId })
      return { chatId: chat.id, slotId: reply.entry.slotId as SlotId }
    })
  )

/** Two chats of the same name and characters: a group. */
const group = ({ rpc, tag }: PlaceContext) =>
  rpc((api) =>
    Effect.gen(function* () {
      const a = yield* api.CreateCard({ label: `Ana ${tag}`, name: "Ana" })
      const b = yield* api.CreateCard({ label: `Bo ${tag}`, name: "Bo" })
      const ids: Array<ChatId> = []
      for (let i = 0; i < 2; i++) {
        const chat = yield* api.CreateChat({ title: `Harbor ${tag}` })
        for (const card of [a, b])
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
        yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The lamp is lit." })
        ids.push(chat.id)
      }
      return { chatId: ids[0]! }
    })
  )

/** A chat with Mira and Wren, and a line of Mira's: someone to move to a new thread. */
const twoInCast = ({ rpc, tag }: PlaceContext) =>
  rpc((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: `Durable ${tag}` })
      const mira = yield* api.CreateCard({ label: `Mira ${tag}`, name: "Mira" })
      const wren = yield* api.CreateCard({ label: `Wren ${tag}`, name: "Wren" })
      for (const card of [mira, wren])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Mira counts the crates.",
        speakerEntityId: mira.entityId as EntityId
      })
      return { chatId: chat.id }
    })
  )

const threadsDialog = (page: Page) => page.getByRole("dialog", { name: "Threads from #1", exact: true })
const threadName = (page: Page) =>
  threadsDialog(page).locator('[data-thread-row="1"]').getByRole("textbox", { name: "Name" })
const macroName = (page: Page) =>
  page.getByRole("form", { name: "Your name in prompts", exact: true }).getByRole("textbox")

export const chatPlaces = [
  place({
    name: "Composer",
    source: "features/chat/Composer.tsx:749",
    setup: oneMessage,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      return composer(page)
    },
    shown: composer
  }),
  place({
    name: "Message edit",
    source: "features/chat/InPlaceEdit.tsx:185",
    setup: oneMessage,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      const row = rows(page).first()
      await showActions(row)
      await row.getByRole("button", { name: "Edit", exact: true }).click()
      return row.getByLabel("Message text", { exact: true })
    },
    shown: (page) => rows(page).first().getByLabel("Message text", { exact: true })
  }),
  place({
    name: "Your own version",
    source: "features/chat/Message.tsx:372",
    setup: oneMessage,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      const row = rows(page).first()
      await messageMenu(row, "Write your own version")
      return row.getByLabel("Your version", { exact: true })
    },
    shown: (page) => rows(page).first().getByLabel("Your version", { exact: true })
  }),
  place({
    name: "Guidance for a new version",
    source: "features/chat/guidanceEdit.tsx:29",
    setup: guidedReply,
    open: async (page, { chatId, slotId }, ctx) => {
      await goChat(page, ctx, chatId)
      const reply = page.locator(`article[data-slot="${slotId}"]`)
      await reply.getByRole("button", { name: "New version with this guidance" }).click()
      await page.getByTestId("guidance-edit-bar").waitFor()
      return composer(page)
    },
    shown: composer,
    mode: (page) => page.getByTestId("guidance-edit-bar")
  }),
  place({
    name: "Queued message edit",
    source: "features/chat/QueuedMessages.tsx:51",
    setup: async (ctx) => {
      const { chatId } = await oneMessage(ctx)
      await ctx.rpc((api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 5 })
          const last = path.entries.at(-1)!
          yield* api.Generate({ chatId, parentSlotId: last.slotId, branch: false })
        })
      )
      return { chatId }
    },
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      const queue = page.getByRole("list", { name: "Queued messages" })
      if ((await queue.count()) === 0) {
        await composer(page).fill("A queued line.")
        await page.getByRole("button", { name: "Send", exact: true }).click()
        await queue.waitFor()
      }
      const box = queue.getByLabel("Queued message")
      if ((await box.count()) === 0) await queue.getByRole("button", { name: "Edit" }).first().click()
      return box
    },
    shown: (page) => page.getByRole("list", { name: "Queued messages" }).getByLabel("Queued message")
  }),
  place({
    name: "Inserted message",
    source: "features/chat/insertMessage/InsertEditor.tsx:194",
    setup: oneMessage,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      await messageMenu(rows(page).first(), "Insert message below")
      return page.getByTestId("insert-editor").getByRole("textbox").first()
    },
    shown: (page) => page.getByTestId("insert-editor").getByRole("textbox").first()
  }),
  place({
    name: "Summary edit",
    source: "features/chat/SummaryPanel.tsx:116",
    setup: async (ctx) => {
      const fixture = await ctx.rpc((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Durable ${ctx.tag}` })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "A harbor."
          })
          if (sent._tag !== "Posted") throw new Error("Expected a posted message")
          return { chatId: chat.id, entry: sent.entry }
        })
      )
      await level1(ctx.server.dataDir, fixture.chatId, [fixture.entry], "Original summary.")
      return { chatId: fixture.chatId }
    },
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      const panel = await openPanel(page, "Summaries")
      const box = panel.getByRole("textbox", { name: /Text of the summary/ })
      if ((await box.count()) === 0) await panel.getByRole("button", { name: /Edit the summary/ }).click()
      return box
    },
    shown: (page) => page.getByRole("textbox", { name: /Text of the summary/ })
  }),
  place({
    name: "Edit thinking",
    source: "features/chat/editThinking.tsx:121",
    setup: oneMessage,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      const row = rows(page).first()
      if ((await row.getByLabel("Message text", { exact: true }).count()) === 0) {
        await showActions(row)
        await row.getByRole("button", { name: "Edit", exact: true }).click()
      }
      const box = row.getByRole("textbox", { name: "Thinking", exact: true })
      await row.getByLabel("Message text", { exact: true }).waitFor()
      if ((await box.count()) === 0) await row.getByRole("button", { name: "Add thinking", exact: true }).click()
      return box
    },
    shown: (page) => rows(page).first().getByRole("textbox", { name: "Thinking", exact: true })
  }),
  place({
    name: "Chat note",
    source: "features/editor/NoteList.tsx:470",
    setup: oneMessage,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      const panel = await openPanel(page, "Notes")
      const own = panel.getByRole("region", { name: "This chat's notes" })
      if ((await panel.getByRole("region", { name: "Note Note" }).count()) === 0)
        await own.getByRole("button", { name: "Add note", exact: true }).click()
      return noteText(panel, "Note")
    },
    shown: (page) => page.getByRole("region", { name: "Note Note" }).getByRole("textbox", { name: "Text of Note" })
  }),
  place({
    name: "Chat note title (rename in place)",
    source: "features/editor/NoteList.tsx:344",
    setup: oneMessage,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      const panel = await openPanel(page, "Notes")
      const own = panel.getByRole("region", { name: "This chat's notes" })
      const note = panel.getByRole("region", { name: "Note Note" })
      await own.getByRole("button", { name: "Add note", exact: true }).or(note).first().waitFor()
      if ((await note.count()) === 0) await own.getByRole("button", { name: "Add note", exact: true }).click()
      return openRename(note, "Rename Note", "New name for Note")
    },
    shown: (page) => renameField(page.getByRole("region", { name: "Note Note" }), "New name for Note")
  }),
  place({
    name: "Start parallel threads: a thread's name",
    source: "features/threads/StartThreadsDialog.tsx:186",
    setup: twoInCast,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      await messageMenu(rows(page).first(), "Start parallel threads here…")
      await threadName(page).waitFor()
      return threadName(page)
    },
    shown: threadName
  }),
  place({
    name: "This chat: your name in prompts",
    source: "features/chat/MacroBindings.tsx:28",
    setup: twoInCast,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      const panel = await openPanel(page, "This chat")
      const toggle = panel.getByText("Advanced: names in prompts", { exact: true })
      await toggle.waitFor()
      if (!(await macroName(page).isVisible())) await toggle.click()
      return macroName(page)
    },
    shown: macroName
  }),
  place({
    name: "Branch name in the sidebar (rename in place)",
    source: "features/characters/ShellBrowser.tsx:367",
    setup: ({ rpc, tag }) =>
      rpc((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Branches ${tag}` })
          yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The lamp is lit." })
          const fork = (yield* api.ListForks({ chatId: chat.id }))[0]!
          yield* api.NameFork({ forkId: fork.id, name: "Lamplight" })
          return { chatId: chat.id, forkId: fork.id }
        })
      ),
    open: async (page, { chatId, forkId }, { server }) => {
      await page.goto(`${server.url}/chats/${chatId}?fork=${forkId}&side=chats&forks=${chatId}`)
      const sidebar = page.getByRole("complementary", { name: "Sidebar", exact: true })
      return openRename(sidebar, "Rename branch Lamplight", "New name for branch Lamplight")
    },
    shown: (page) =>
      renameField(page.getByRole("complementary", { name: "Sidebar", exact: true }), "New name for branch Lamplight")
  }),
  place({
    name: "Card text in the chat panel",
    source: "features/chat/CharacterTab.tsx:145",
    setup: ({ rpc, tag }) =>
      rpc((api) =>
        Effect.gen(function* () {
          const name = `Mira${tag}`
          const card = yield* api.CreateCard({ label: name, name })
          const chat = yield* api.CreateChat({ title: `Durable ${tag}` })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The lamp is lit." })
          return { chatId: chat.id, name }
        })
      ),
    open: async (page, { chatId, name }, ctx) => {
      await goChat(page, ctx, chatId)
      const panel = await openPanel(page, name)
      return panel.getByRole("textbox", { name: /^Description/ }).first()
    },
    shown: (page, { name }) =>
      page
        .getByRole("tabpanel", { name })
        .getByRole("textbox", { name: /^Description/ })
        .first()
  }),
  place({
    name: "This chat's summarization instruction",
    source: "features/chat/ThisChatTab.tsx:75",
    setup: oneMessage,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      await openSummarySettings(page)
      return page.getByRole("textbox", { name: "This chat's summarization instruction", exact: true })
    },
    shown: (page) => page.getByRole("textbox", { name: "This chat's summarization instruction", exact: true })
  }),
  place({
    name: "First message of a card's new chat",
    source: "features/chat/StartChatPage.tsx:581",
    setup: ({ rpc, tag }) => rpc((api) => api.CreateCard({ label: `Tobias ${tag}`, name: "Tobias" })),
    open: async (page, card, { server }) => {
      await page.goto(`${server.url}/cards/${card.entityId}/chat`)
      return composer(page)
    },
    shown: composer
  }),
  place({
    name: "Title on the new chat page",
    source: "features/chat/StartChatPage.tsx:827",
    setup: async () => null,
    open: async (page, _state, { server }) => {
      await page.goto(`${server.url}/new/chat`)
      return page.getByRole("textbox", { name: "Title of the new chat", exact: true })
    },
    shown: (page) => page.getByRole("textbox", { name: "Title of the new chat", exact: true })
  }),
  place({
    name: "Title on the Chats page",
    source: "features/chat/ChatsPage.tsx:65",
    setup: async () => null,
    open: async (page, _state, { server }) => {
      await page.goto(`${server.url}/chats`)
      return page.getByRole("textbox", { name: "Title of the new chat", exact: true })
    },
    shown: (page) => page.getByRole("textbox", { name: "Title of the new chat", exact: true })
  }),
  place({
    name: "Framing line of a chat merge",
    source: "features/chat/MergeChatDialog.tsx:780",
    setup: ({ rpc, tag }) =>
      rpc((api) =>
        Effect.gen(function* () {
          const home = yield* api.CreateChat({ title: `Harbor ${tag}` })
          yield* api.SendMessage({ chatId: home.id, parentSlotId: null, branch: false, content: "The lantern swings." })
          const away = yield* api.CreateChat({ title: `Docks ${tag}` })
          yield* api.SendMessage({
            chatId: away.id,
            parentSlotId: null,
            branch: false,
            content: "Kai climbs the crane."
          })
          return { chatId: home.id, away: `Docks ${tag}` }
        })
      ),
    open: async (page, { chatId, away }, ctx) => {
      await goChat(page, ctx, chatId)
      await page.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "Merge another chat…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Merge a chat into this one", exact: true })
      await dialog.getByRole("searchbox", { name: "Chat to merge" }).fill(away)
      await dialog.getByRole("list", { name: "Chats" }).getByRole("button", { name: away, exact: true }).click()
      return dialog.getByRole("textbox", { name: "Framing line", exact: true })
    },
    shown: (page) =>
      page
        .getByRole("dialog", { name: "Merge a chat into this one", exact: true })
        .getByRole("textbox", { name: "Framing line", exact: true })
  }),
  place({
    name: "Text field in a message's HTML",
    source: "features/chat/htmlTextField.tsx:7",
    setup: ({ rpc, tag }) =>
      rpc((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Durable ${tag}` })
          yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: 'Fill in the form:\n\n<textarea aria-label="Story form field">Start</textarea>'
          })
          return { chatId: chat.id }
        })
      ),
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      return page.getByRole("textbox", { name: "Story form field", exact: true })
    },
    shown: (page) => page.getByRole("textbox", { name: "Story form field", exact: true })
  }),
  place({
    name: "Inline chat rename",
    source: "features/chat/ChatHeader.tsx:140",
    setup: oneMessage,
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      await page.getByRole("heading", { level: 1 }).getByRole("button").first().click()
      return page.getByRole("textbox", { name: "Chat name", exact: true })
    },
    shown: (page) => page.getByRole("textbox", { name: "Chat name", exact: true })
  }),
  place({
    name: "Group rename dialog",
    source: "features/chat/NameDialog.tsx:99",
    // Two chats of the same name and characters are a group: renaming one asks which.
    setup: ({ rpc, tag }) =>
      rpc((api) =>
        Effect.gen(function* () {
          const a = yield* api.CreateCard({ label: `Ana ${tag}`, name: "Ana" })
          const b = yield* api.CreateCard({ label: `Bo ${tag}`, name: "Bo" })
          const ids: Array<ChatId> = []
          for (let i = 0; i < 2; i++) {
            const chat = yield* api.CreateChat({ title: `Harbor ${tag}` })
            for (const card of [a, b])
              yield* api.ChangeCast({
                chatId: chat.id,
                slotId: null,
                change: { _tag: "Join", entityId: card.entityId }
              })
            yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The lamp is lit." })
            ids.push(chat.id)
          }
          return { chatId: ids[0]! }
        })
      ),
    open: async (page, { chatId }, ctx) => {
      await goChat(page, ctx, chatId)
      await page.getByRole("heading", { level: 1 }).getByRole("button").first().click()
      return page.getByRole("dialog", { name: "Rename chat" }).getByRole("textbox", { name: "Name" })
    },
    shown: (page) => page.getByRole("dialog", { name: "Rename chat" }).getByRole("textbox", { name: "Name" })
  }),
  place({
    name: "Group page rename",
    source: "features/characters/GroupPage.tsx:121",
    setup: group,
    open: async (page, { chatId }, { server }) => {
      await page.goto(`${server.url}/groups/${chatId}`)
      await page.getByRole("button", { name: "Rename group" }).click()
      return page.getByRole("dialog", { name: "Rename group" }).getByRole("textbox", { name: "Name" })
    },
    shown: (page) => page.getByRole("dialog", { name: "Rename group" }).getByRole("textbox", { name: "Name" })
  }),
  place({
    name: "Make this branch its own chat",
    source: "features/chat/SplitChatDialog.tsx:78",
    setup: ({ rpc, tag }) =>
      rpc((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Durable ${tag}` })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "The lamp is lit."
          })
          if (sent._tag !== "Posted") throw new Error("Expected a posted message")
          const fork = yield* api.CreateFork({
            chatId: chat.id,
            fromForkId: chat.currentForkId,
            atSlotId: sent.entry.slotId
          })
          return { chatId: chat.id, forkId: fork.fork.id as string }
        })
      ),
    open: async (page, { chatId, forkId }, { server }) => {
      await page.goto(`${server.url}/chats/${chatId}?fork=${forkId}`)
      await page.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "Make this branch its own chat", exact: true }).click()
      return page
        .getByRole("dialog", { name: "Make this branch its own chat?" })
        .getByLabel("Chat title", { exact: true })
    },
    shown: (page) =>
      page.getByRole("dialog", { name: "Make this branch its own chat?" }).getByLabel("Chat title", { exact: true })
  }),
  place({
    name: "Fork for this chat dialog",
    source: "features/chat/CardForkDialogs.tsx:122",
    setup: ({ rpc, tag }) =>
      rpc((api) =>
        Effect.gen(function* () {
          const name = `Mira${tag}`
          const card = yield* api.CreateCard({ label: name, name })
          const chat = yield* api.CreateChat({ title: `Durable ${tag}` })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The lamp is lit." })
          return { chatId: chat.id, name }
        })
      ),
    open: async (page, { chatId, name }, ctx) => {
      await goChat(page, ctx, chatId)
      await openPanel(page, name)
      await page.getByRole("button", { name: `Fork for this chat: ${name}`, exact: true }).click()
      return page
        .getByRole("dialog", { name: "Fork for this chat" })
        .getByRole("textbox", { name: "In-character name" })
    },
    shown: (page) =>
      page.getByRole("dialog", { name: "Fork for this chat" }).getByRole("textbox", { name: "In-character name" })
  })
]
