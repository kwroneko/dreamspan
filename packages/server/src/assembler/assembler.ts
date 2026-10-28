// The assembler with its built-in stages and macros registered (ARCHITECTURE §15).
import { registerBuiltinMacros } from "@rp/shared/macros/builtins.ts"
import { makeMacroRegistry, type MacroRegistry } from "@rp/shared/macros/registry.ts"
import { Effect, type Scope } from "effect"
import {
  assemble,
  type AssemblyRequest,
  makeProjectionRegistry,
  makeStageRegistry,
  type ProjectionRegistry,
  type StageRegistry
} from "./pipeline.ts"
import { registerBuiltinProjections, registerBuiltinStages } from "./stages.ts"

export interface Assembler {
  readonly stages: StageRegistry
  readonly macros: MacroRegistry
  readonly projections: ProjectionRegistry
  readonly assemble: (request: Omit<AssemblyRequest, "macros" | "projections">) => ReturnType<typeof assemble>
}

/** An assembler whose built-in stages and macros stay registered for the scope. */
export const makeAssembler: Effect.Effect<Assembler, never, Scope.Scope> = Effect.gen(function* () {
  const stages = makeStageRegistry()
  const macros = makeMacroRegistry()
  const projections = makeProjectionRegistry()
  yield* registerBuiltinStages(stages)
  yield* registerBuiltinProjections(projections)
  yield* registerBuiltinMacros(macros)
  return { stages, macros, projections, assemble: (request) => assemble(stages, { ...request, macros, projections }) }
})
