import { inject } from "vitest"
import { assert, describe, it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import { foldState, stateKeys, WritableStateEvent } from "@dreamspan/shared/state.ts"
import { Effect, Exit, Schema, Scope } from "effect"
import { RpcClient } from "effect/rpc"
import * as Database from "../src/db/Database.ts"
import { StateModules } from "../src/db/stateModules.ts"
import { cardDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import type * as Plugin from "./support/statePlugin.ts"

for (const workers of ["source", "bundle"] as const) {
  describe(`registered state in ${workers} workers`, () => {
    it.live(
      "saves, forks and reloads plugin state; scoped overrides and disablement reach both workers",
      () =>
        Effect.gen(function* () {
          const writer = yield* Database.Writer
          const reader = yield* Database.Reader
          const modules = yield* StateModules
          const source = (exportName: keyof typeof Plugin) => ({
            id: "review",
            module: new URL("./support/statePlugin.ts", import.meta.url).href,
            exportName
          })
          const open = (exportName: keyof typeof Plugin) =>
            Effect.gen(function* () {
              const scope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit))
              yield* Scope.provide(modules.register(source(exportName)), scope)
              return scope
            })
          const userId = (yield* writer.EnsureUser({ handle: "state-owner", displayName: "Owner" })).id
          const otherId = (yield* writer.EnsureUser({ handle: "state-other", displayName: "Other" })).id
          const card = (owner: typeof userId) =>
            writer.CreateEntity({
              userId: owner,
              kind: "card",
              label: "Synthetic",
              subtitle: "",
              doc: cardDoc("Synthetic"),
              schemaVersion: 1,
              origin: "user",
              sourcePath: null
            })
          const own = yield* card(userId)
          const foreign = yield* card(otherId)
          const chat = yield* writer.CreateChat({
            userId,
            kind: "rp",
            status: "active",
            title: "Plugin state",
            participants: [own.entityId],
            greeting: null
          })
          const main = chat.currentForkId!
          const append = (parentSlotId: SlotId | null) =>
            writer.AppendMessage({
              userId,
              chatId: chat.id,
              forkId: main,
              parentSlotId,
              branch: false,
              commitDraft: null,
              version: new NewVersion({
                speakerEntityId: null,
                writer: "human",
                content: "Synthetic",
                status: "complete",
                macroMode: "verbatim",
                origin: "user_written"
              })
            })
          const a = yield* append(null)
          const b = yield* append(a.slotId)
          const add = (key: string, value: unknown, forkId = main, slotId: SlotId | null = b.slotId) =>
            writer.AddStateEvent({
              userId,
              chatId: chat.id,
              forkId,
              slotId,
              versionId: null,
              scope: null,
              data: { key, value } as WritableStateEvent
            })
          const read = (forkId = main, slotId: SlotId | null = b.slotId) =>
            reader.StateEventsAt({ userId, chatId: chat.id, forkId, slotId })
          const state = (forkId = main, slotId: SlotId | null = b.slotId) =>
            read(forkId, slotId).pipe(Effect.map(foldState))
          const fork = (atSlotId: SlotId | null) =>
            writer
              .CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId })
              .pipe(Effect.map((r) => r.fork.id))
          const refused = (effect: ReturnType<typeof add>, entity: string) =>
            Effect.gen(function* () {
              const error = yield* Effect.flip(effect)
              assert.strictEqual(error._tag, "NotFound")
              if (error._tag === "NotFound") assert.strictEqual(error.entity, entity)
            })
          // Trusted snapshots override caller-provided headers, for the writer too.
          yield* refused(
            add("review/position", 1).pipe(
              RpcClient.withHeaders({
                "rp-state-modules": JSON.stringify([source("install")])
              })
            ),
            "unavailable state key"
          )
          const scope = yield* open("install")
          assert.isTrue(Schema.is(WritableStateEvent)({ key: "review/position", value: 1 }))
          const old = yield* fork(b.slotId)
          yield* add("review/position", 10)
          yield* add("review/branch", 20)
          yield* add("review/card", { card: own.entityId })
          yield* refused(add("review/card", { card: foreign.entityId }), "entity")
          yield* refused(add("review/missing", 1), "unavailable state key")
          const branchScope = yield* Effect.flip(
            writer.AddStateEvent({
              userId,
              chatId: chat.id,
              forkId: main,
              slotId: b.slotId,
              versionId: null,
              scope: "narrator",
              data: { key: "review/branch", value: 99 }
            })
          )
          assert.strictEqual(branchScope._tag, "NotFound")
          const branchVersion = yield* Effect.flip(
            writer.AddStateEvent({
              userId,
              chatId: chat.id,
              forkId: main,
              slotId: b.slotId,
              versionId: b.version.id,
              scope: null,
              data: { key: "review/branch", value: 99 }
            })
          )
          assert.strictEqual(branchVersion._tag, "NotFound")
          const bad = yield* Effect.flip(add("review/position", "invalid"))
          assert.strictEqual(bad._tag, "StorageError")
          assert.deepStrictEqual((yield* state()).plugin, {
            "review/position": 10,
            "review/branch": 20,
            "review/card": { card: own.entityId }
          })
          assert.isUndefined((yield* state(old)).plugin)
          assert.strictEqual((yield* state()).vars.branchSaw, 10)
          assert.deepStrictEqual((yield* state(main, a.slotId)).plugin, { "review/branch": 20 })
          const early = yield* fork(a.slotId)
          const later = yield* fork(b.slotId)
          yield* add("review/branch", 30)
          yield* add("review/position", 11)
          assert.deepStrictEqual((yield* state(early, a.slotId)).plugin, { "review/branch": 20 })
          assert.strictEqual((yield* state(later)).plugin?.["review/position"], 10)
          assert.strictEqual((yield* state(later)).plugin?.["review/branch"], 20)
          assert.strictEqual((yield* state(main, null)).plugin?.["review/branch"], 30)
          // The reader executes this registered built-in reducer; no main-thread fold here.
          yield* append(b.slotId)
          const override = yield* open("override")
          yield* add("var.set", { name: "kept", value: 1 })
          const cast = yield* reader.ChatSummaries({ userId, chatIds: [chat.id] })
          assert.deepStrictEqual(cast[0]!.cast, [])
          assert.strictEqual(stateKeys.get("review/extra")?.id, "review/extra")
          const disabled = yield* open("disable")
          yield* refused(add("review/position", 2), "unavailable state key")
          yield* refused(add("var.set", { name: "bad", value: 2 }), "unavailable state key")
          assert.isFalse(Schema.is(WritableStateEvent)({ key: "var.set", value: { name: "bad", value: 2 } }))
          assert.isUndefined((yield* state()).plugin?.["review/position"])
          yield* Scope.close(disabled, Exit.void)
          assert.strictEqual((yield* state()).plugin?.["review/position"], 11)
          yield* Scope.close(override, Exit.void)
          assert.deepStrictEqual(
            (yield* reader.ChatSummaries({ userId, chatIds: [chat.id] }))[0]!.cast.map((c) => c.entityId),
            [own.entityId]
          )
          assert.isUndefined(stateKeys.get("review/extra"))
          yield* Scope.close(scope, Exit.void)
          yield* refused(add("review/position", 3), "unavailable state key")
          assert.isUndefined((yield* state()).plugin)
          assert.strictEqual((yield* state()).vars.kept, 1)
          assert.isTrue((yield* read()).some((e) => e.data.key === "review/position"))
          const reload = yield* open("install")
          assert.strictEqual((yield* state()).plugin?.["review/position"], 11)
          yield* Scope.close(reload, Exit.void)
        }).pipe(
          Effect.provide(
            Database.layer({
              dataDir: tempDir("plugin-state"),
              readers: 2,
              allowNetworkFs: false,
              workers,
              bundleDir: inject("bundleDir")
            })
          ),
          Effect.scoped
        ),
      120_000
    )
  })
}
