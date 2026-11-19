// Running commands without a sandbox (spec/FILES-AND-ENVIRONMENT.md §3.7) needs the user's
// agreement, recorded by the server with the grant: a request without it is refused. A server
// started without ALLOW_UNSANDBOXED_COMMANDS forgets every such choice, so allowing it again
// later doesn't bring old ones back. Synthetic data only.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { tempDir } from "./support/tempDir.ts"

it.live(
  "needs a recorded consent, and is forgotten when the server stops allowing it",
  () => {
    const allowed = testConfig({ hostFolders: [tempDir("unsbx-host")], allowUnsandboxedCommands: true })
    const row = (chatId: string) =>
      Effect.gen(function* () {
        const api = yield* client()
        return (yield* api.ListWorkshopCapabilities({ chatId: chatId as never })).find(
          (c) => c.id === "commands.unsandboxed"
        )
      })
    return Effect.gen(function* () {
      const chatId = yield* Effect.gen(function* () {
        const api = yield* client()
        const chat = yield* api.CreateWorkshop({ title: "No sandbox" })
        assert.strictEqual((yield* row(chat.id))?.mode, "off")
        const refused = yield* api
          .SetWorkshopGrant({ chatId: chat.id, capability: "commands.unsandboxed", mode: "allow" })
          .pipe(Effect.flip)
        assert.strictEqual(refused._tag, "GrantRefused")
        assert.strictEqual((yield* row(chat.id))?.mode, "off")
        yield* api.SetWorkshopGrant({
          chatId: chat.id,
          capability: "commands.unsandboxed",
          mode: "allow",
          consented: true
        })
        assert.strictEqual((yield* row(chat.id))?.mode, "allow")
        return chat.id
      }).pipe(Effect.scoped, Effect.provide(serverLayer(allowed)))
      // A start without the setting, then with it again: the choice is gone.
      yield* Effect.void.pipe(
        Effect.scoped,
        Effect.provide(serverLayer({ ...allowed, allowUnsandboxedCommands: false }))
      )
      const after = yield* row(chatId).pipe(Effect.scoped, Effect.provide(serverLayer(allowed)))
      assert.strictEqual(after?.mode, "off")
    })
  },
  120_000
)
