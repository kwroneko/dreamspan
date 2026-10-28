// The assembler with its built-in stages and macros registered (ARCHITECTURE §15).
import { withAssemblyModules } from "./modules.ts"
import { registerBuiltinMacros } from "@rp/shared/macros/builtins.ts"
import { makeMacroRegistry, type MacroRegistry } from "@rp/shared/macros/registry.ts"
import { Context, Effect, type Scope } from "effect"
import {
  assemble,
  type AssemblyRequest,
  makeProjectionRegistry,
  makeStageRegistry,
  type ProjectionRegistry,
  type StageRegistry
} from "./pipeline.ts"
import { makeRegistry } from "../registry.ts"
import { summaryRequestTransform } from "../lcm/request.ts"
import type { AssemblyTransform, TransformRegistry } from "./pipeline.ts"
import { registerBuiltinProjections, registerBuiltinStages } from "./stages.ts"

export interface Assembler {
  readonly stages: StageRegistry
  readonly transforms: TransformRegistry
  readonly macros: MacroRegistry
  readonly projections: ProjectionRegistry
  readonly projectionOptions: Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly label: string; readonly description?: string }>
  >
  readonly assemble: (request: Omit<AssemblyRequest, "macros" | "projections">) => ReturnType<typeof assemble>
}

export class WorkerAssembler extends Context.Service<WorkerAssembler, Assembler>()("rp/assembler/WorkerAssembler") {}

/** An assembler whose built-in stages and macros stay registered for the scope. */
export const makeAssembler: Effect.Effect<Assembler, never, Scope.Scope> = Effect.gen(function* () {
  const stages = makeStageRegistry()
  const macros = makeMacroRegistry()
  const transforms = makeRegistry<AssemblyTransform>()
  yield* transforms.register(summaryRequestTransform)
  const projections = makeProjectionRegistry()
  yield* registerBuiltinStages(stages)
  yield* registerBuiltinProjections(projections)
  yield* registerBuiltinMacros(macros)
  const assembler: Assembler = {
    stages,
    transforms,
    macros,
    projections,
    projectionOptions: Effect.suspend(() =>
      withAssemblyModules(
        assembler,
        Effect.sync(() =>
          projections
            .list()
            .map(({ id, label, description }) => ({ id, label, ...(description === undefined ? {} : { description }) }))
        )
      )
    ),
    assemble: (request) =>
      withAssemblyModules(assembler, assemble(stages, { ...request, macros, projections }, transforms))
  }
  return assembler
})
