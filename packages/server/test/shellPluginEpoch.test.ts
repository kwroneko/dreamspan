import { assert, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import * as Database from "../src/db/Database.ts"
import { StateModules } from "../src/db/stateModules.ts"
import { cardDoc } from "./support/docs.ts"
import { testWorkers } from "./support/bundles.ts"
import { tempDir } from "./support/tempDir.ts"

for (const persist of [false, true])
  it.live(`shell state follows module activation and disposal without a database write, stored=${persist}`, () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const modules = yield* StateModules
      const userId = (yield* writer.EnsureUser({ handle: "owner", displayName: "Owner" })).id
      const card = yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Synthetic",
        subtitle: "",
        doc: cardDoc("Synthetic"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const chat = yield* writer.CreateChat({
        userId,
        title: "",
        kind: "rp",
        status: "active",
        participants: [card.entityId],
        greeting: null
      })
      const posted = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId: chat.currentForkId!,
        parentSlotId: null,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          content: "Synthetic message",
          writer: "human",
          speakerEntityId: null,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        forkId: chat.currentForkId!,
        slotId: posted.slotId,
        versionId: null,
        scope: null,
        data: { key: "var.set", value: { name: "place", value: "quay" } }
      })
      const read = reader.ShellMaterialize({ userId })
      const base = yield* read
      assert.deepStrictEqual(base.forks[0]!.cast, [card.entityId])
      if (persist) yield* writer.StoreForkSummaries({ userId, chats: base.fresh })
      const scope = yield* Scope.make()
      yield* Scope.provide(
        modules.register({
          id: "review",
          module: new URL("./support/statePlugin.ts", import.meta.url).href,
          exportName: "override"
        }),
        scope
      )
      const active = yield* read
      yield* Scope.close(scope, Exit.void)
      const restored = yield* read
      assert.deepStrictEqual(active.forks[0]!.cast, [], "the active reducer must reach cached shell reads")
      assert.deepStrictEqual(restored.forks[0]!.cast, [card.entityId], "disposal must restore the base fold")
      assert.notStrictEqual(active.forks[0]!.chatName, base.forks[0]!.chatName)
      assert.strictEqual(restored.forks[0]!.chatName, base.forks[0]!.chatName)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Database.layer({ dataDir: tempDir("shell-plugin-epoch"), readers: 1, allowNetworkFs: false, ...testWorkers })
      )
    )
  )
