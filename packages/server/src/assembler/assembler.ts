import { gapLineDescriptors } from "./gapLines.ts"
import { builtinContextViews, makeContextViewRegistry, type ContextViewRegistry } from "./knowledge.ts"
import {
  builtinMergeLayouts,
  makeMergeLayoutRegistry,
  mergeSectionsTransform,
  type MergeLayoutRegistry
} from "./merges.ts"
import { builtinTextCounters, type TextTokenCounter } from "../providers/textCounters.ts"
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
  workshopInstruction,
  condensationInstruction,
  type SummaryInstruction,
  type SummaryStyleSelector
} from "../lcm/instructionPolicies.ts"
// The assembler with its built-in stages and macros registered (ARCHITECTURE §15).
import { withAssemblyModules } from "./modules.ts"
import { builtinImageTokenRules, type ImageTokenRule } from "@dreamspan/shared/imageTokens.ts"
import { registerBuiltinMacros } from "@dreamspan/shared/macros/builtins.ts"
import { makeMacroRegistry, type MacroRegistry } from "@dreamspan/shared/macros/registry.ts"
import { Context, Effect, type Scope } from "effect"
import type { AssemblySources, SourceError } from "./pipeline.ts"
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
import { assembleThrough } from "./pipeline.ts"
import {
  builtinScriptSources,
  type MessageRewrite,
  regexRewrite,
  type RewriteOptions,
  rewriteSide,
  type ScriptSource,
  unchanged
} from "./scriptSources.ts"
import { makeScriptRunner, PLACEMENT, REGEX_MS, REGEX_OUTPUT } from "./regex.ts"
import type { TextRewrite } from "@dreamspan/shared/regexScripts.ts"

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
  /** How merged chats reach the model (`merge-layout` stage, spec/CHAT-MERGE.md §4). */
  readonly mergeLayouts: MergeLayoutRegistry
  /** How each reply's history is chosen: one shared context or separate ones (`knowledge` stage). */
  readonly contextViews: ContextViewRegistry
  /** Local model tokenizers for display and prepared budget counts (ARCHITECTURE §15). */
  readonly textCounters: Registry<TextTokenCounter>
  /** What an image costs per provider and model (ARCHITECTURE §15, image tokens). */
  readonly imageTokens: Registry<ImageTokenRule>
  /** Where regex scripts come from, in the order they run (global, preset, character). */
  readonly scriptSources: Registry<ScriptSource>
  /** What rewrites text as it's written, in order (ARCHITECTURE §12, "Rewrites"). */
  readonly rewrites: Registry<MessageRewrite>
  readonly projectionOptions: Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly label: string; readonly description?: string }>
  >
  readonly mergeLayoutOptions: Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly label: string; readonly description?: string }>
  >
  /** The context views installed, as the chat's Context setting offers them (CU1). */
  readonly contextViewOptions: Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly label: string; readonly description?: string }>
  >
  readonly assemble: (
    request: Omit<AssemblyRequest, "macros" | "projections" | "imageTokens">
  ) => ReturnType<typeof assemble>
  /**
   * Texts as they're written at the request's position: the stages through `scripts`, which
   * compiles the scripts with neither flag, then each registered rewrite in turn. A message's
   * placement is its side's (ST: user input or AI output), reasoning's ST's reasoning.
   */
  readonly rewrite: (
    request: Omit<AssemblyRequest, "macros" | "projections" | "imageTokens" | "rewrite">,
    options: RewriteOptions,
    items: ReadonlyArray<RewriteItem>
  ) => Effect.Effect<Array<TextRewrite>, SourceError, AssemblySources>
  /**
   * The same, prepared once for texts that keep changing (a reply as it streams): the stages
   * run once, and each `run` takes the registered rewrites with time and output of its own.
   */
  readonly prepareRewrite: (
    request: Omit<AssemblyRequest, "macros" | "projections" | "imageTokens" | "rewrite">,
    options: RewriteOptions
  ) => Effect.Effect<PreparedRewrite, SourceError, AssemblySources>
}

/** A text to rewrite: a message's own, or reasoning (the provider's, or a reply section's). */
interface RewriteItem {
  readonly text: string
  readonly kind: "message" | "reasoning"
}

export interface PreparedRewrite {
  /** Whether a run can change anything: scripts compiled for it, or a rewrite of a plugin's. */
  readonly active: boolean
  readonly run: (items: ReadonlyArray<RewriteItem>) => Array<TextRewrite>
}

export class WorkerAssembler extends Context.Service<WorkerAssembler, Assembler>()("rp/assembler/WorkerAssembler") {}

/** An assembler whose built-in stages and macros stay registered for the scope. */
export const makeAssembler: Effect.Effect<Assembler, never, Scope.Scope> = Effect.gen(function* () {
  const sourceDescriptors = makeRegistry<SourceDescriptor>()
  for (const entry of [...builtinSourceDescriptors, ...gapLineDescriptors]) yield* sourceDescriptors.register(entry)
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
  yield* summaryInstructions.register(workshopInstruction)
  yield* summaryInstructions.register(condensationInstruction)
  yield* summaryStyles.register(defaultSummaryStyle)
  yield* transforms.register(makeSummaryRequestTransform(summaryInstructions))
  // After the instruction is written: summaries over a merge get a section per line.
  yield* transforms.register(mergeSectionsTransform)
  const mergeLayouts = makeMergeLayoutRegistry()
  for (const layout of builtinMergeLayouts) yield* mergeLayouts.register(layout)
  const contextViews = makeContextViewRegistry()
  for (const view of builtinContextViews) yield* contextViews.register(view)
  const projections = makeProjectionRegistry()
  const textCounters = makeRegistry<TextTokenCounter>()
  for (const counter of builtinTextCounters.filter((c) => !c.remote)) yield* textCounters.register(counter)
  const imageTokens = makeRegistry<ImageTokenRule>()
  for (const rule of builtinImageTokenRules) yield* imageTokens.register(rule)
  const scriptSources = makeRegistry<ScriptSource>()
  for (const source of builtinScriptSources) yield* scriptSources.register(source)
  const rewrites = makeRegistry<MessageRewrite>()
  yield* rewrites.register(regexRewrite)
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
    mergeLayouts,
    contextViews,
    imageTokens,
    textCounters,
    scriptSources,
    rewrites,
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
    mergeLayoutOptions: Effect.suspend(() =>
      withAssemblyModules(
        assembler,
        Effect.sync(() => mergeLayouts.list().map(({ id, label, description }) => ({ id, label, description })))
      )
    ),
    contextViewOptions: Effect.suspend(() =>
      withAssemblyModules(
        assembler,
        Effect.sync(() => contextViews.list().map(({ id, label, description }) => ({ id, label, description })))
      )
    ),
    assemble: (request) =>
      withAssemblyModules(
        assembler,
        assemble(
          stages,
          { ...request, macros, projections, mergeLayouts, contextViews, imageTokens, textCounters, scriptSources },
          transforms
        )
      ),
    rewrite: (request, options, items) =>
      Effect.map(assembler.prepareRewrite(request, options), (prepared) => prepared.run(items)),
    prepareRewrite: (request, options) =>
      withAssemblyModules(
        assembler,
        Effect.gen(function* () {
          const assembly = yield* assembleThrough(
            stages,
            {
              ...request,
              macros,
              projections,
              mergeLayouts,
              contextViews,
              imageTokens,
              textCounters,
              scriptSources,
              rewrite: options
            },
            "scripts"
          )
          const side = rewriteSide(assembly, options)
          const compiled = assembly.scripts
          const steps = rewrites.list()
          return {
            active: (compiled?.list.length ?? 0) > 0 || steps.some((step) => step !== regexRewrite),
            run: (items) => {
              // Each run gets the time and output one rewrite has, whatever the runs before spent.
              if (compiled) assembly.scripts = makeScriptRunner(compiled.list, { ms: REGEX_MS, output: REGEX_OUTPUT })
              const placed = items.map((item) => ({
                text: item.text,
                placement:
                  item.kind === "reasoning"
                    ? PLACEMENT.reasoning
                    : side === "user"
                      ? PLACEMENT.userInput
                      : PLACEMENT.aiOutput
              }))
              let results: Array<TextRewrite> = placed.map(unchanged)
              for (const step of steps) {
                const next = step.run(
                  assembly,
                  results.map((result, i) => ({ text: result.text, placement: placed[i]!.placement })),
                  options
                )
                results = results.map((result, i) => ({
                  text: next[i]?.text ?? result.text,
                  applied: [...result.applied, ...(next[i]?.applied ?? [])],
                  failed: [...result.failed, ...(next[i]?.failed ?? [])]
                }))
              }
              return results
            }
          } satisfies PreparedRewrite
        })
      )
  }
  return assembler
})
