// The models offered by the pickers: one connection that can't be
// read (an error, a defect, a server too busy to answer) no longer empties the whole list.
import { assert, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { readModelChoices } from "../src/features/chat/modelChoices.ts"
import type { AppClient } from "../src/rpc.ts"
import { vi } from "vitest"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const connection = (id: string, name: string, kind = "openai-chat") => ({ id, name, kind })
const model = (id: string, key: string, hidden = false) => ({ id, key, hidden, upstream: {}, overrides: {} })

/** A client whose ListModels answers by connection id. */
const fakeClient = (
  models: Record<string, Effect.Effect<unknown, unknown>>,
  connections = [connection("a", "Alpha"), connection("b", "Beta"), connection("c", "Gamma")]
) =>
  ((method: string, payload: { connectionId?: string }) =>
    method === "ListProviderKinds"
      ? Effect.succeed([{ id: "openai-chat" }, { id: "system-one", decisions: true }])
      : method === "ListConnections"
        ? Effect.succeed(connections)
        : models[payload.connectionId!]!) as unknown as AppClient["Service"]

it.effect("lists the models of every connection that answers, naming the ones that fail", () =>
  Effect.gen(function* () {
    const read = yield* readModelChoices(
      fakeClient({
        a: Effect.succeed([model("m1", "prose"), model("m2", "old", true)]),
        b: Effect.fail({ _tag: "StorageError", message: "Couldn't read the models." }),
        c: Effect.die(new Error("A model row didn't decode."))
      })
    )
    assert.strictEqual(read.connections, 3)
    assert.deepStrictEqual(
      read.models.map((choice) => choice.label),
      ["Alpha · prose", "Alpha · old"]
    )
    assert.deepStrictEqual(
      read.failed.map((failure) => failure.connection),
      ["Beta", "Gamma"]
    )
    assert.isNull(read.error)
  })
)

it.effect("a connection that doesn't answer in time is named, not waited on for good", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      readModelChoices(
        fakeClient({ a: Effect.succeed([model("m1", "prose")]), b: Effect.never, c: Effect.succeed([]) })
      )
    )
    yield* TestClock.adjust("21 seconds")
    const read = yield* Fiber.join(fiber)
    assert.deepStrictEqual(
      read.models.map((choice) => choice.label),
      ["Alpha · prose"]
    )
    assert.deepStrictEqual(read.failed, [{ connection: "Beta", message: "It didn't answer within 20 seconds." }])
  })
)

it.effect("a decision model's connection isn't offered for replies", () =>
  Effect.gen(function* () {
    const read = yield* readModelChoices(
      fakeClient({ a: Effect.succeed([model("m1", "prose")]), j: Effect.succeed([model("m9", "jev")]) }, [
        connection("a", "Alpha"),
        connection("j", "Jev", "system-one")
      ])
    )
    assert.strictEqual(read.connections, 1)
    assert.deepStrictEqual(
      read.models.map((choice) => choice.label),
      ["Alpha · prose"]
    )
  })
)
