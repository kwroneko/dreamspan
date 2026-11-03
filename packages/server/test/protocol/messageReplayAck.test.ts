import { assert, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { vi } from "vitest"
import type { Draft } from "@rp/shared/drafts.ts"
import type { MessageDraftSave } from "@rp/shared/chatApi.ts"
import type { ChatSession } from "../../../client/src/features/chat/session.ts"
import type { Copy } from "../../../client/src/features/editor/backup.ts"
import { makeCopy } from "../../../client/src/features/editor/backup.ts"
import { MessageDraft } from "../../../client/src/features/chat/messageDraft.ts"
import { Generator } from "../../src/chat/Generator.ts"
import { client, serverLayer, testConfig, posted } from "../support/config.ts"

const copies = vi.hoisted(() => new Map<string, Copy>())
vi.mock("../../../client/src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../../../client/src/features/editor/backup.ts")>()),
  keepCopy: async (copy: Copy, previous?: Copy | null) => {
    copies.set(copy.key, copy)
    if (previous) copies.delete(previous.key)
  },
  dropCopy: async (copy: Copy) => {
    copies.delete(copy.key)
  }
}))

for (const next of ["save", "reload", "non-exact", "unrelated"] as const)
  it.live(`typing descended from an empty replay keeps its causal base through ${next}`, () =>
    Effect.gen(function* () {
      copies.clear()
      const api = yield* client(),
        owner = (yield* api.Whoami()).id
      const chat = yield* api.CreateChat({ title: "Synthetic empty replay" })
      const sent = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Synthetic anchor" })
      )
      const target = {
        _tag: "Insert",
        chatId: chat.id,
        forkId: sent.chat.currentForkId!,
        anchor: sent.entry.slotId
      } as const
      const initial = yield* api.SaveMessageDraft({
        target,
        draftId: null,
        content: "previous insertion",
        expectedRowVersion: null,
        expectedSession: null
      })
      const empty = makeCopy(
        owner,
        `messages:${chat.id}`,
        `insert:${target.forkId}:${target.anchor}`,
        {
          kind: "message",
          payload: {
            target,
            draftId: initial.id,
            content: "",
            expectedRowVersion: initial.rowVersion,
            expectedSession: initial.session
          }
        },
        1
      )
      copies.set(empty.key, empty)
      let release!: () => void,
        acknowledged: Draft | null = null
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const call: ChatSession["call"] = async (fn) => {
        const outcome = await Effect.runPromiseExit(
          fn(((tag: string, payload: typeof MessageDraftSave.Type) => {
            if (tag === "GetMessageDraft") return api.GetMessageDraft({ target })
            return api.SaveMessageDraft(payload).pipe(
              Effect.flatMap((value) =>
                Effect.promise(async () => {
                  if (payload.content === "") {
                    acknowledged = value
                    await held
                  }
                  return value
                })
              )
            )
          }) as Parameters<typeof fn>[0])
        )
        return Exit.isSuccess(outcome)
          ? { ok: true, value: outcome.value }
          : {
              ok: false,
              error: { tag: "ServerError", message: "Synthetic failure", problems: [], reason: null }
            }
      }
      const session = { id: chat.id, call } as ChatSession
      const first = new MessageDraft(session, owner, target, "", null)
      // A real server handles the empty save before its acknowledgement is delivered.
      if (next === "non-exact") {
        const cleared = yield* api.DiscardMessageDraft({
          target,
          draftId: initial.id,
          expectedRowVersion: initial.rowVersion
        })
        yield* api.SaveMessageDraft({
          target,
          draftId: cleared.id,
          expectedRowVersion: cleared.rowVersion,
          expectedSession: cleared.session,
          content: "Other device's fresh text"
        })
      }
      // Keep the stale opening snapshot in the non-exact control: only the writer sees the deletion.
      const opening =
        next === "non-exact" || next === "unrelated" ? new MessageDraft(session, owner, target, "", initial) : first
      // Cancel its debounce before the server scope closes, even if an assertion fails.
      yield* Effect.addFinalizer(() => Effect.promise(() => opening.save()))
      if (next === "unrelated") {
        // This copy was typed on the old server text, never on the displayed empty copy.
        opening.setText("typing unrelated to the replayed clear")
        opening.setImages([])
      }
      const restoring = opening.restore([empty])
      let fresh: Copy | undefined
      try {
        yield* Effect.promise(() => vi.waitFor(() => assert.isNotNull(acknowledged)))
        if (next !== "unrelated") {
          opening.setText("fresh typing while the recovered empty text was saved")
          // An attachment edit must survive rebasing too.
          opening.setImages([])
        }
        fresh = [...copies.values()].find((copy) => copy.content !== "")
      } finally {
        release()
        yield* Effect.promise(() => restoring)
      }
      const kept = [...copies.values()].find((copy) => copy.content !== "")!
      assert.isDefined(fresh)
      assert.strictEqual(opening.snapshot().text, kept.content)
      assert.strictEqual(kept.save.kind, "message")
      if (kept.save.kind !== "message") return
      if (next === "non-exact" || next === "unrelated") {
        assert.strictEqual(kept.save.payload.expectedRowVersion, initial.rowVersion)
      } else {
        assert.strictEqual(kept.save.payload.expectedRowVersion, acknowledged!.rowVersion)
        assert.deepStrictEqual(kept.save.payload.images, [])
        assert.include(kept.ancestors, empty.key)
        assert.include(kept.ancestors, fresh!.key)
        assert.isFalse(copies.has(fresh!.key))
      }
      if (next === "save") {
        yield* Effect.promise(() => opening.save())
        assert.strictEqual(opening.snapshot().text, kept.content)
        assert.strictEqual((yield* api.GetMessageDraft({ target })).content, kept.content)
      } else if (next === "reload") {
        const reopened = new MessageDraft(session, owner, target, "", null)
        yield* Effect.promise(() => reopened.restore([...copies.values()]))
        assert.strictEqual(reopened.snapshot().text, kept.content)
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
