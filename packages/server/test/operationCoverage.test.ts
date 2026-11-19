import { assert, it } from "@effect/vitest"
import { AppApi } from "@dreamspan/shared/api.ts"
import { Effect } from "effect"
import { builtinOperationExposures, exposedCastChanges } from "../src/agent/exposures/builtins.ts"
import { operationExclusions, unclassifiedOperations } from "../src/agent/exposures/exclusions.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { Commands } from "../src/commands.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import { boundedArguments } from "../src/agent/operations.ts"

it.live("classifies every RPC and registered command; a new unclassified operation fails", () =>
  Effect.gen(function* () {
    yield* client()
    const commands = yield* Commands
    const registry = yield* ExecutionRegistry
    const exposures = registry.operationTools.list()
    assert.deepStrictEqual(
      unclassifiedOperations(
        AppApi.requests.keys(),
        commands.list().map((c) => c.id),
        exposures
      ),
      []
    )
    assert.deepStrictEqual(unclassifiedOperations(["NewUnclassifiedRpc"], ["plugin.new"], exposures), [
      "NewUnclassifiedRpc",
      "plugin.new"
    ])
    const protectedTags = [
      "SetWorkshopGrant",
      "AnswerToolApproval",
      "SetRegexApproval",
      "SetHtmlApproval",
      "SetTokenCounting",
      "SetExternalMedia",
      "ChangeMediaHosts",
      "DecideMediaApproval",
      "GetMediaHosts",
      "GetSavedMediaStatus",
      "ListMediaApproval",
      "LookupSavedMedia",
      "RetrySavedMedia",
      "PurgeBinItem",
      "StartStImportPlan",
      "GetStImportPlan",
      "GetStImportPlanMessages",
      "CancelStImportPlan",
      "ChangeSubagentSettings",
      "ChangeSubagentType",
      "ApplyCostRecompute"
    ]
    for (const tag of protectedTags) {
      if (!AppApi.requests.has(tag as never)) continue
      assert.isString(operationExclusions[tag])
      assert.isFalse(exposures.some((e) => "rpc" in e.operation && e.operation.rpc === tag))
    }
    assert.notInclude(exposedCastChanges, "AgentPermission")
    assert.notInclude(exposedCastChanges, "SendPresence")
    assert.strictEqual(builtinOperationExposures.length, 33)
  }).pipe(Effect.provide(serverLayer(testConfig())))
)

it.effect("requires one registered capability and restores plugin exposures when their scope closes", () =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    const original = registry.operationTools.get("rename_chat")!
    const invalid = yield* registry.operationTools
      .register({ ...original, id: "invalid", capability: "" })
      .pipe(Effect.exit)
    assert.strictEqual(invalid._tag, "Failure")
    const unknown = yield* registry.operationTools
      .register({ ...original, id: "unknown", capability: "missing" })
      .pipe(Effect.exit)
    assert.strictEqual(unknown._tag, "Failure")
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* registry.operationTools.disable("rename_chat")
        yield* registry.operationTools.register({ ...original, id: "plugin_rename" })
        assert.strictEqual(toolForKind(registry, "workshop", "plugin_rename")!.capability, "chats.setup")
        assert.isUndefined(toolForKind(registry, "workshop", "rename_chat"))
      })
    )
    assert.isUndefined(toolForKind(registry, "workshop", "plugin_rename"))
    assert.strictEqual(registry.operationTools.get("rename_chat"), original)
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)

it("bounds nested and crafted argument trees", () => {
  assert.isFalse(boundedArguments({ text: "a".repeat(64_001) }))
  assert.isFalse(boundedArguments(JSON.parse('{"__proto__":{"danger":true}}')))
  assert.isFalse(boundedArguments({ list: Array.from({ length: 201 }, () => 1) }))
  assert.isFalse(boundedArguments({ value: Number.NaN }))
  assert.isTrue(boundedArguments({ key: "display", value: { reasoning: "collapsed" } }))
})

it.effect("keeps workshop operations out of story and unknown kind tool catalogs", () =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    for (const name of ["history_search", "list_chats", "get_cast", "generate_reply", "rename_chat"])
      for (const kind of ["rp", "unknown"]) assert.isUndefined(toolForKind(registry, kind, name), `${kind}: ${name}`)
    assert.isDefined(toolForKind(registry, "rp", "read_messages"))
    for (const name of ["list_library", "read_card", "read_preset", "read_lorebook"])
      for (const kind of ["rp", "unknown"]) assert.isUndefined(toolForKind(registry, kind, name))
    assert.isDefined(toolForKind(registry, "workshop", "list_library"))
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)

it.effect("refuses operation aliases and excluded RPC or command exposures", () =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    const original = registry.operationTools.get("rename_chat")!
    for (const entry of [
      { ...original, id: "rename_alias" },
      { ...original, id: "excluded", operation: { rpc: "GetRevision" } },
      { ...original, id: "excluded_command", operation: { command: "chat.merge" } }
    ]) {
      assert.strictEqual((yield* Effect.exit(registry.operationTools.register(entry)))._tag, "Failure", entry.id)
      assert.isUndefined(registry.operationTools.get(entry.id))
    }
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)
