import { builtinSourceDescriptors, type SourceDescriptor } from "./sourceDescriptors.ts"
import {
  defaultLeafPlanner,
  defaultMaintenancePlanner,
  type LeafPlanner,
  type MaintenancePlanner
} from "../lcm/planning.ts"
import {
  defaultSummaryStyle,
  leafInstruction,
  condensationInstruction,
  type SummaryInstruction,
  type SummaryStyleSelector
} from "../lcm/instructionPolicies.ts"
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
import { makeRegistry, type Registry } from "../registry.ts"
import { makeSummaryRequestTransform } from "../lcm/request.ts"
import type { AssemblyTransform, TransformRegistry } from "./pipeline.ts"
import { registerBuiltinProjections, registerBuiltinStages } from "./stages.ts"

export interface Assembler {
  readonly sourceDescriptors: Registry<SourceDescriptor>
  readonly leafPlanners: Registry<LeafPlanner>
  readonly maintenancePlanners: Registry<MaintenancePlanner>
  readonly summaryInstructions: Registry<SummaryInstruction>
  readonly summaryStyles: Registry<SummaryStyleSelector>
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
  const sourceDescriptors = makeRegistry<SourceDescriptor>()
  for (const entry of builtinSourceDescriptors) yield* sourceDescriptors.register(entry)
  const stages = makeStageRegistry()
  const macros = makeMacroRegistry()
  const transforms = makeRegistry<AssemblyTransform>()
  const leafPlanners = makeRegistry<LeafPlanner>()
  const maintenancePlanners = makeRegistry<MaintenancePlanner>()
  const summaryInstructions = makeRegistry<SummaryInstruction>()
  const summaryStyles = makeRegistry<SummaryStyleSelector>()
  yield* leafPlanners.register(defaultLeafPlanner)
  yield* maintenancePlanners.register(defaultMaintenancePlanner)
  yield* summaryInstructions.register(leafInstruction)
  yield* summaryInstructions.register(condensationInstruction)
  yield* summaryStyles.register(defaultSummaryStyle)
  yield* transforms.register(makeSummaryRequestTransform(summaryInstructions))
  const projections = makeProjectionRegistry()
  yield* registerBuiltinStages(stages)
  yield* registerBuiltinProjections(projections)
  yield* registerBuiltinMacros(macros)
  const assembler: Assembler = {
    sourceDescriptors,
    leafPlanners,
    maintenancePlanners,
    summaryInstructions,
    summaryStyles,
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
