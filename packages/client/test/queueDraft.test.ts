import type { ChatId } from "@rp/shared/chat.ts"
import { Draft, DraftKey } from "@rp/shared/drafts.ts"
import { Effect } from "effect"
import { expect, it, vi } from "vitest"
import { MessageDraft } from "../src/features/chat/messageDraft.ts"
import type { ChatSession } from "../src/features/chat/session.ts"

vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" }))
const target = { _tag: "Queue" as const, chatId: "chat" as ChatId, queuedId: "queue", rowVersion: 1 }
const draft = (content: string, rowVersion = 1) =>
  new Draft({
    id: "draft",
    key: new DraftKey({ targetKind: "queue_edit", targetId: "chat", field: "queue" }),
    content,
    rowVersion,
    session: 1,
    baseRevision: "1",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    recovered: 0,
    displaced: null,
    historyLength: 2
  })
const failed = { ok: false as const, error: { tag: "Offline", message: "Offline", problems: [], reason: null } }

it("a failed queue draft save keeps the edit and refuses Cancel until a retry succeeds", async () => {
  let offline = true
  let saved = ""
  const session = {
    id: target.chatId,
    call: async (run: (client: unknown) => Effect.Effect<unknown>) => {
      if (offline) return failed
      return {
        ok: true,
        value: await Effect.runPromise(
          run((tag: string, payload: { content: string }) => {
            if (tag === "GetMessageDraft") return Effect.succeed(null)
            saved = payload.content
            return Effect.succeed(draft(saved))
          })
        )
      }
    }
  } as unknown as ChatSession
  const editor = new MessageDraft(session, "owner", target, "Original", null)
  editor.setText("An unsent queue edit")
  await editor.save()
  expect(editor.snapshot()).toMatchObject({ text: "An unsent queue edit", unsaved: true, error: failed.error })
  expect(await editor.discard()).toEqual(failed)
  expect(editor.snapshot().text).toBe("An unsent queue edit")
  offline = false
  const ready = await editor.ready()
  expect(saved).toBe("An unsent queue edit")
  expect(ready).toEqual({ text: saved, draft: { draftId: "draft", session: 1 } })
  expect(editor.snapshot().unsaved).toBe(false)
})

it("typing during queue history restore keeps the text and rebases its next save", async () => {
  let release: (() => void) | null = null
  const bases: Array<number> = []
  const session = {
    id: target.chatId,
    call: async (run: (client: unknown) => Effect.Effect<unknown>) => ({
      ok: true,
      value: await Effect.runPromise(
        run((tag: string, payload: { content: string; expectedRowVersion: number }) => {
          if (tag === "RestoreMessageDraft")
            return Effect.promise(
              () =>
                new Promise<Draft>((resolve) => {
                  release = () => resolve(draft("Earlier", 2))
                })
            )
          bases.push(payload.expectedRowVersion)
          return Effect.succeed(draft(payload.content, 3))
        })
      )
    })
  } as unknown as ChatSession
  const editor = new MessageDraft(session, "owner", target, "Original", draft("Original"))
  const restoring = editor.restoreState(0)
  await vi.waitFor(() => expect(release).not.toBeNull())
  editor.setText("Typed during Restore")
  const saving = editor.save()
  release!()
  await restoring
  await saving
  expect(bases).toEqual([2])
  expect(editor.snapshot().text).toBe("Typed during Restore")
  expect(editor.snapshot().unsaved).toBe(false)
})
