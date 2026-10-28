import { Effect, Exit, Schema, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { EntityId } from "../src/chat.ts"
import {
  branchOwned,
  type FoldableEvent,
  foldState,
  type PluginStateKey,
  registerStateKey,
  stateKeyDeclaration,
  stateKeys,
  StateEventData,
  WritableStateEvent
} from "../src/state.ts"

const Tally = Schema.Struct({ amount: Schema.Int })
const tally: PluginStateKey = {
  id: "tally/total",
  value: Tally,
  ids: { ids: {} },
  scope: "positional",
  reduce: (current, value) => ((current as number | undefined) ?? 0) + (value as typeof Tally.Type).amount
}
const event = (key: string, value: unknown): FoldableEvent => ({ scope: null, data: { key, value } as never })
const open = (key: PluginStateKey) =>
  Scope.make().pipe(Effect.tap((scope) => Scope.provide(registerStateKey(key), scope)))
const decodes = Schema.is(WritableStateEvent)

describe("plugin state keys", () => {
  it("accepts a registered key's events, reduces them in its namespace, and drops back when the scope closes", async () => {
    expect(decodes({ key: "tally/total", value: { amount: 2 } })).toBe(false)
    const scope = await Effect.runPromise(open(tally))
    expect(decodes({ key: "tally/total", value: { amount: 2 } })).toBe(true)
    expect(decodes({ key: "tally/total", value: { amount: "x" } })).toBe(false)
    expect(decodes({ key: "tally/other", value: { amount: 2 } })).toBe(false)
    expect(decodes({ key: "free", value: {} })).toBe(false)
    const events = [
      event("tally/total", { amount: 2 }),
      event("var.set", { name: "a", value: 1 }),
      event("tally/total", { amount: 3 })
    ]
    const state = foldState(events)
    expect(state.plugin).toEqual({ "tally/total": 5 })
    expect(state.vars).toEqual({ a: 1 })
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(decodes({ key: "tally/total", value: { amount: 2 } })).toBe(false)
    // Stored events still decode on read and are skipped by the fold; core state is intact.
    expect(foldState(events).plugin).toBeUndefined()
    expect(foldState(events).vars).toEqual({ a: 1 })
    expect(stateKeyDeclaration("tally/total")).toBeUndefined()
  })

  it("defaults to the last event's value and lets a plugin choose branch ownership", async () => {
    const scope = await Effect.runPromise(
      open({ id: "mood/now", value: Schema.String, ids: { ids: {} }, scope: "branch" })
    )
    expect(branchOwned.has("mood/now")).toBe(true)
    expect(branchOwned.has("tally/total")).toBe(false)
    expect(branchOwned.has("card.swap")).toBe(true)
    expect(foldState([event("mood/now", "calm"), event("mood/now", "tense")]).plugin).toEqual({ "mood/now": "tense" })
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(branchOwned.has("mood/now")).toBe(false)
  })

  it("registers every built-in and honors scoped overrides and disablement through the same API", async () => {
    expect(
      stateKeys
        .list()
        .map((key) => key.id)
        .sort()
    ).toEqual(StateEventData.members.map((m) => m.fields.key.literal).sort())
    const data = event("var.set", { name: "score", value: 7 })
    const original = stateKeys.get("var.set")!
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerStateKey({
            ...original,
            apply: (state, value, scope) => ({
              ...original.apply!(state, value, scope),
              rolesProjection: "synthetic/roles"
            })
          })
          expect(foldState([data]).rolesProjection).toBe("synthetic/roles")
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* stateKeys.disable("var.set")
              expect(decodes(data.data)).toBe(false)
              expect(stateKeyDeclaration("var.set")).toBeUndefined()
              expect(foldState([data]).vars).toEqual({})
            })
          )
          expect(foldState([data]).vars).toEqual({ score: 7 })
        })
      )
    )
    expect(foldState([data]).rolesProjection).toBeNull()
    expect(foldState([data]).vars).toEqual({ score: 7 })
  })

  it("keeps incompatible stored values inert after a schema override", async () => {
    const events = [event("tally/total", { amount: 2 }), event("var.set", { name: "kept", value: true })]
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerStateKey(tally)
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* registerStateKey({
                ...tally,
                value: Schema.String,
                reduce: () => {
                  throw new Error("invalid old value reached reducer")
                }
              })
              expect(foldState(events).plugin).toBeUndefined()
              expect(foldState(events).vars).toEqual({ kept: true })
            })
          )
          expect(foldState(events).plugin).toEqual({ "tally/total": 2 })
        })
      )
    )
  })

  it("declares ids that the writer checks, and refuses a declaration stateKeyProblems rejects", async () => {
    const scope = await Effect.runPromise(
      open({
        id: "pin/card",
        value: Schema.Struct({ card: EntityId }),
        ids: { ids: { card: { table: "entity", kind: "card" } } },
        scope: "positional"
      })
    )
    expect(stateKeyDeclaration("pin/card")?.ids.card).toEqual({ table: "entity", kind: "card" })
    expect(stateKeyDeclaration("card.swap")?.removes).toBeUndefined()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    const bad = (key: PluginStateKey) => Effect.runPromise(Effect.scoped(registerStateKey(key)).pipe(Effect.flip))
    expect(
      (await bad({ id: "pin/card", value: Schema.Struct({ card: EntityId }), ids: { ids: {} }, scope: "positional" }))
        .problems
    ).toEqual(['entity id in "card" isn\'t declared'])
    expect(
      (await bad({ id: "nospace", value: Schema.String, ids: { ids: {} }, scope: "positional" })).problems
    ).toHaveLength(1)
    expect(stateKeyDeclaration("pin/card")).toBeUndefined()
  })
})
