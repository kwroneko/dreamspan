// Synthetic trusted modules. The passed registry is the worker's, including in bundles.
import { Effect, Schema } from "effect"
import { EntityId } from "@rp/shared/chat.ts"
import type { InstallStateModule } from "../../src/db/stateModules.ts"

export const install: InstallStateModule = (keys) =>
  Effect.gen(function* () {
    yield* keys.register({ id: "review/position", value: Schema.Int, ids: { ids: {} }, scope: "positional" })
    yield* keys.register({
      id: "review/branch",
      value: Schema.Int,
      ids: { ids: {} },
      scope: "branch",
      apply: (state, value) => ({
        ...state,
        plugin: { ...state.plugin, "review/branch": value },
        vars: { ...state.vars, branchSaw: state.plugin?.["review/position"] ?? null }
      })
    })
    yield* keys.register({
      id: "review/card",
      value: Schema.Struct({ card: EntityId }),
      ids: { ids: { card: { table: "entity", kind: "card" } } },
      scope: "positional"
    })
  })

export const disable: InstallStateModule = (keys) =>
  Effect.gen(function* () {
    yield* keys.disable("review/position")
    yield* keys.disable("var.set")
  })

export const override: InstallStateModule = (keys) =>
  Effect.gen(function* () {
    const original = keys.get("var.set")!
    yield* keys.register({
      ...original,
      apply: (state, value, scope) => ({
        ...original.apply!(state, value, scope),
        participants: []
      })
    })
    yield* keys.register({ id: "review/extra", value: Schema.String, ids: { ids: {} }, scope: "positional" })
  })

export const changeSchema: InstallStateModule = (keys) =>
  keys.register({
    id: "review/evolving",
    value: Schema.Struct({ card: EntityId }),
    ids: { ids: { card: { table: "entity", kind: "card" } } },
    scope: "positional"
  })
