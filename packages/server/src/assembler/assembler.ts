// The assembler with its built-in stages and macros registered (ARCHITECTURE §15).
import { registerBuiltinMacros } from "@rp/shared/macros/builtins.ts"
import { makeMacroRegistry, type MacroRegistry } from "@rp/shared/macros/registry.ts"
import { Context, Effect, type Scope } from "effect"
import { assemble, type AssemblyRequest, makeStageRegistry, type StageRegistry } from "./pipeline.ts"
import { makeRegistry } from "../registry.ts"
import { summaryRequestTransform } from "../lcm/request.ts"
import type { AssemblyTransform, TransformRegistry } from "./pipeline.ts"
import { registerBuiltinStages } from "./stages.ts"

export interface Assembler {
  readonly stages: StageRegistry
  readonly transforms: TransformRegistry
  readonly macros: MacroRegistry
  readonly assemble: (request: Omit<AssemblyRequest, "macros">) => ReturnType<typeof assemble>
}

export class WorkerAssembler extends Context.Service<WorkerAssembler, Assembler>()("rp/assembler/WorkerAssembler") {}

/** An assembler whose built-in stages and macros stay registered for the scope. */
export const makeAssembler: Effect.Effect<Assembler, never, Scope.Scope> = Effect.gen(function* () {
  const stages = makeStageRegistry()
  const macros = makeMacroRegistry()
  const transforms = makeRegistry<AssemblyTransform>()
  yield* transforms.register(summaryRequestTransform)
  yield* registerBuiltinStages(stages)
  yield* registerBuiltinMacros(macros)
  return { stages, macros, transforms, assemble: (request) => assemble(stages, { ...request, macros }, transforms) }
})
