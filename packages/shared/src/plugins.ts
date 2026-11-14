// Plugin management is user initiated. No content/import field enables executable code.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Forbidden, ServerError, StaleWrite } from "./errors.ts"

export const PluginId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/))
export const PluginCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const PluginScope = Schema.Literals(["instance", "user"])
const Entry = Schema.NullOr(
  Schema.String.check(Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|mjs)$/))
)
export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: Schema.String.check(Schema.isMaxLength(120)),
  api: Schema.Literal(1),
  server: Entry,
  worker: Entry,
  client: Entry,
  surfaces: Schema.Array(Schema.String.check(Schema.isMaxLength(100))),
  overrides: Schema.Array(Schema.String),
  network: Schema.Boolean,
  replaces: Schema.Array(Schema.String),
  base: Schema.NullOr(Schema.Struct({ app: Schema.String, path: Schema.String, sha256: Schema.String }))
})
export type PluginManifest = typeof PluginManifest.Type
export const PluginPin = Schema.Struct({
  commit: PluginCommit,
  enabledAt: Schema.Number,
  enabledBy: Schema.String,
  previousCommit: Schema.optionalKey(PluginCommit),
  enabledCommits: Schema.optionalKey(Schema.Array(PluginCommit)),
  suspended: Schema.optionalKey(Schema.Struct({ reason: Schema.String, at: Schema.Number, appStamp: Schema.String })),
  sessionTrust: Schema.optionalKey(Schema.Struct({ workshop: Schema.String, until: Schema.Number }))
})
export type PluginPin = typeof PluginPin.Type
export const PluginPins = Schema.Record(PluginId, PluginPin)
export type PluginPins = typeof PluginPins.Type
export const PluginReport = Schema.Struct({
  commit: PluginCommit,
  appStamp: Schema.String,
  ok: Schema.Boolean,
  step: Schema.Literals(["snapshot", "manifest", "types", "bundle", "probe", "tests", "activate", "ready"]),
  message: Schema.String,
  at: Schema.Number,
  cached: Schema.optionalKey(Schema.Boolean),
  steps: Schema.optionalKey(Schema.Array(Schema.Struct({ step: Schema.String, ok: Schema.Boolean })))
})
export type PluginReport = typeof PluginReport.Type
export class PluginRejected extends Schema.TaggedError<PluginRejected>()("PluginRejected", {
  message: Schema.String
}) {}
export const PluginData = Schema.Struct({
  key: Schema.String,
  value: Schema.Unknown,
  revision: Schema.Int,
  updatedAt: Schema.Number
})
const PluginTarget = { scope: PluginScope, id: PluginId }
const PluginVersion = { ...PluginTarget, commit: PluginCommit }
export const BuiltinPart = Schema.Struct({
  registry: Schema.String,
  id: Schema.String,
  label: Schema.String,
  copyable: Schema.Boolean,
  reason: Schema.String,
  replacedBy: Schema.Array(Schema.Struct(PluginTarget))
})
export const BuiltinComparison = Schema.Struct({
  changed: Schema.Boolean,
  available: Schema.Boolean,
  files: Schema.Array(Schema.Struct({ path: Schema.String, before: Schema.String, current: Schema.String }))
})
export const CopyBuiltinResult = Schema.Struct({ ...PluginVersion, report: PluginReport })
export const PluginView = Schema.Struct({
  ...PluginTarget,
  commit: Schema.NullOr(PluginCommit),
  manifest: Schema.NullOr(PluginManifest),
  pin: Schema.NullOr(PluginPin),
  report: Schema.NullOr(PluginReport)
})
export const PluginDetails = Schema.Struct({
  ...PluginView.fields,
  revision: Schema.Int,
  original: Schema.optionalKey(Schema.NullOr(BuiltinComparison)),
  versions: Schema.Array(
    Schema.Struct({ commit: PluginCommit, message: Schema.String, manifest: Schema.NullOr(PluginManifest) })
  ),
  data: Schema.NullOr(Schema.Array(Schema.Struct({ key: Schema.String, bytes: Schema.Int })))
})
const PluginFiles = Schema.Record(Schema.String, Schema.String)
const Error = Schema.Union([PluginRejected, Forbidden, ServerError, StaleWrite])
export class PluginApi extends RpcGroup.make(
  Rpc.make("ListBuiltinParts", { success: Schema.Array(BuiltinPart), error: Error }),
  Rpc.make("CopyBuiltin", {
    payload: { registry: Schema.String, id: Schema.String, pluginId: PluginId },
    success: CopyBuiltinResult,
    error: Error
  }),
  Rpc.make("ListPlugins", { success: Schema.Array(PluginView), error: Error }),
  Rpc.make("GetPlugin", { payload: PluginTarget, success: PluginDetails, error: Error }),
  // Local source only; registry fetch/merge and archive imports belong to later units.
  Rpc.make("CreatePlugin", { payload: { ...PluginTarget, files: PluginFiles }, success: PluginCommit, error: Error }),
  Rpc.make("CommitPlugin", {
    payload: { ...PluginTarget, files: PluginFiles, message: Schema.String },
    success: PluginCommit,
    error: Error
  }),
  Rpc.make("PluginLog", {
    payload: PluginTarget,
    success: Schema.Array(Schema.Struct({ commit: PluginCommit, message: Schema.String })),
    error: Error
  }),
  Rpc.make("PluginDiff", {
    payload: { ...PluginTarget, before: PluginCommit, after: PluginCommit },
    success: Schema.Array(Schema.String),
    error: Error
  }),
  Rpc.make("CheckPlugin", { payload: PluginVersion, success: PluginReport, error: Error }),
  Rpc.make("EnablePlugin", {
    payload: { ...PluginVersion, consent: Schema.Literal(true), expectedRevision: Schema.optionalKey(Schema.Int) },
    success: PluginReport,
    error: Error
  }),
  Rpc.make("PinPluginCommit", {
    payload: { ...PluginVersion, consent: Schema.Literal(true), expectedRevision: Schema.optionalKey(Schema.Int) },
    success: PluginReport,
    error: Error
  }),
  Rpc.make("GoBackPlugin", {
    payload: { ...PluginTarget, expectedRevision: Schema.Int },
    success: PluginReport,
    error: Error
  }),
  Rpc.make("DisablePlugin", { payload: PluginTarget, success: Schema.Void, error: Error }),
  Rpc.make("DeletePluginData", { payload: PluginTarget, success: Schema.Void, error: Error }),
  Rpc.make("ListClientPlugins", {
    success: Schema.Array(Schema.Struct({ ...PluginVersion, manifest: PluginManifest })),
    error: Error
  })
) {}
