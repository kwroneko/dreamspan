import { toolData } from "../toolData.ts"
import { builtinCopyStem } from "@dreamspan/shared/builtinParts.ts"
// Workshop plugin tools: registered by the host, never generic RPC exposures. Loading grants no authority.
import { createHash, randomUUID } from "node:crypto"
import { Type, type TSchema } from "@earendil-works/pi-ai"
import { Effect, Semaphore } from "effect"
import type { User } from "@dreamspan/shared/domain.ts"
import type { PluginDetails, PluginReport } from "@dreamspan/shared/plugins.ts"
import { PluginRejected } from "@dreamspan/shared/plugins.ts"
import { pluginConsent, pluginAccessGrows } from "@dreamspan/shared/pluginConsent.ts"
import type { RolloutEffect, RolloutEffectRecord } from "@dreamspan/shared/workshopApi.ts"
import type { Reader, Writer } from "../../db/Database.ts"
import type { PluginHost } from "../../plugins/Host.ts"
import { repoTask } from "../../plugins/repoTask.ts"
import type { AuthorRequest, AuthorResult } from "../../plugins/authorRepo.ts"
import { checkPlugin } from "../../plugins/check.ts"
import { appSource, pluginApiDocs } from "../../plugins/reference.ts"
import { argsDigest, argumentRows } from "../approvals.ts"
import { ToolInputRefused, type RolloutTool, type ToolContext, type ToolOutput } from "../tools.ts"
import { builtinCopy, builtinCopyPage } from "../../plugins/builtins.ts"
import type { PluginWorkingCopy } from "../pluginWorkingCopies.ts"

export const PLUGIN_TOOLS = [
  "plugin_list",
  "plugin_api",
  "plugin_create",
  "plugin_copy_builtin",
  "plugin_read",
  "plugin_search",
  "plugin_write",
  "plugin_edit",
  "plugin_diff",
  "plugin_log",
  "plugin_check",
  "plugin_commit",
  "plugin_enable",
  "plugin_rollback",
  "plugin_disable",
  "app_source"
] as const
const labels: Readonly<Record<string, string>> = {
  plugin_list: "Listed your plugins",
  plugin_api: "Read the plugin docs",
  plugin_create: "Created a plugin",
  plugin_copy_builtin: "Copied a built-in part",
  plugin_read: "Read a plugin file",
  plugin_search: "Searched a plugin",
  plugin_write: "Wrote a plugin file",
  plugin_edit: "Edited a plugin file",
  plugin_diff: "Read the plugin changes",
  plugin_log: "Read the saved versions",
  plugin_check: "Checked the plugin",
  plugin_commit: "Saved a plugin version",
  plugin_enable: "Turned on the plugin",
  plugin_rollback: "Restored the previous version",
  plugin_disable: "Turned off the plugin",
  app_source: "Read the app source"
}
const str = (description?: string) => Type.String({ ...(description ? { description } : {}), maxLength: 64000 })
const plugin = { plugin: str("The repository id returned by plugin_create/list; instance plugins use instance:id.") }
const path = { ...plugin, path: str("A relative UTF-8 text file in this plugin. No links, dot paths or Git metadata.") }
const page = {
  from: Type.Optional(Type.Integer({ minimum: 1 })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }))
}
const commitField = Type.String({ pattern: "^[a-f0-9]{40}$" })
const edit = Type.Object({ old_str: str(), new_str: str() })
type Args = Record<string, unknown>
type Target = { scope: "user" | "instance"; id: string }
type Prepared = {
  target: Target
  commit: string
  digest: string
  revision: number
  head: string
  before: string | null
  name: string
}
const targetOf = (value: unknown): Target => {
  if (typeof value !== "string") throw new ToolInputRefused("Name a plugin repository.")
  const scope = value.startsWith("instance:") ? "instance" : "user"
  const id = scope === "instance" ? value.slice(9) : value
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new ToolInputRefused("Use the plugin id returned by plugin_list.")
  return { scope, id }
}
const data = toolData
const refused = (message: string) => new PluginRejected({ message })
/**
 * A commit of an instance plugin's working copy (spec/FILES-AND-ENVIRONMENT.md §5.3): the copy
 * sits in the admin's Files, which commands change, so it becomes server code only with the
 * admin's own approval of this exact call, after seeing its diff; never allowed in advance.
 */
const commitsServerCopy = (args: Record<string, unknown>) => {
  if (args.from !== "files") return false
  try {
    return targetOf(args.plugin).scope === "instance"
  } catch {
    return false
  }
}
const treeDigest = (files: Record<string, string>) =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest("hex")
/** The diff shown for a commit from a working copy: at most this many files, each in full. */
const COMMIT_DIFF_FILES = 64
export interface PluginAuthorDeps {
  readonly host: Omit<PluginHost["Service"], "undoEffect">
  readonly lock: Semaphore.Semaphore
  readonly dataDir: string
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  /** Raw lifecycle functions: caller already owns the shared lifecycle lock. */
  readonly rollback: (
    actor: User,
    target: Target & { commit: string; expectedRevision?: number }
  ) => Effect.Effect<PluginReport, unknown>
  readonly dirty: (actor: User, target: Target) => Effect.Effect<void, unknown>
  /** Working copies in the account's Files (agent/pluginWorkingCopies.ts); the first is used. */
  readonly copies?: { readonly list: () => ReadonlyArray<PluginWorkingCopy> }
}
export const makePluginAuthoring = (deps: PluginAuthorDeps) => {
  const { reader, writer, dataDir, host } = deps
  // Only successful checks in this process count. A restart must check again; editable reports never grant authority.
  const checked = new Map<string, { tree: string; commit: string }>()
  const checkKey = (owner: string, id: string) => `${owner}/${id}`
  const journalSnapshot = {
    key: "plugin-authoring",
    prepare: (ctx: ToolContext, frozen: unknown) =>
      Effect.sync(() => {
        const identity = typeof frozen === "string" && /^[a-f0-9-]{36}$/.test(frozen) ? frozen : randomUUID()
        ctx.cache.set("plugin:journalIdentity", identity)
        return identity
      })
  }
  const operationKey = (ctx: ToolContext, args: Args) =>
    `${String(ctx.cache.get("plugin:journalIdentity") ?? ctx.rolloutId)}:${ctx.toolCallId}:${argsDigest(args)}`
  const preparedKey = (ctx: ToolContext) => `plugin:consent:${ctx.toolCallId}`
  /** The working copy's files as shown in a commit's question, by digest. */
  const commitFilesKey = (ctx: ToolContext) => `plugin:commitFiles:${ctx.toolCallId}`
  const attempt = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({
      try: f,
      catch: () => refused("Plugin files are unavailable or invalid. Read the file and plugin_api before trying again.")
    })
  const ownerOf = (actor: User, target: Target) => {
    if (target.scope === "instance" && actor.role !== "admin") throw new ToolInputRefused("Server code needs an admin.")
    return target.scope === "instance" ? "" : actor.id
  }
  const proof = (ctx: ToolContext, capability: string, requireApproval = false, rollback = false) =>
    reader.AuthorizePluginTool({
      userId: ctx.userId,
      rolloutId: ctx.rolloutId,
      toolCallId: ctx.toolCallId,
      capability,
      requireApproval,
      rollback,
      ...(ctx.approvalDigest ? { digest: ctx.approvalDigest } : {})
    })
  const repo = (owner: string, id: string, request: AuthorRequest) =>
    attempt(() => repoTask<AuthorResult>(dataDir, { op: "author", owner, id, request }))
  /** The repository's tree on disk (the saved version, or what plugin_write left). */
  const treeOf = (owner: string, id: string) =>
    repo(owner, id, { action: "files" }).pipe(Effect.map((result) => result.files ?? {}))
  const copyOf = () => deps.copies?.list()[0]
  /** The tree before a change, when a working copy follows the repository. */
  const treeBefore = (owner: string, id: string) =>
    copyOf() ? treeOf(owner, id).pipe(Effect.orElseSucceed(() => null)) : Effect.succeed(null)
  /**
   * Brings the Files working copy up to date after the repository changed (§5.3), and says what
   * the agent should know. Never fails the tool: a copy that can't be updated is reported.
   */
  const follow = (ctx: ToolContext | null, actor: User, target: Target, before: Record<string, string> | null) =>
    Effect.gen(function* () {
      const copy = copyOf()
      if (!copy) return {}
      const after = yield* treeOf(ownerOf(actor, target), target.id)
      const synced = yield* copy
        .sync({
          actor,
          target,
          before,
          after,
          ...(ctx ? { call: { rolloutId: ctx.rolloutId, toolCallId: ctx.toolCallId } } : {})
        })
        .pipe(
          Effect.catchCause((cause) => {
            const reason = cause.reasons.find((r) => r._tag === "Fail" || r._tag === "Die")
            const value = reason?._tag === "Fail" ? reason.error : reason?._tag === "Die" ? reason.defect : undefined
            return Effect.succeed({
              path: copy.where(target),
              overwritten: [],
              failed: value instanceof Error ? value.message : "It couldn't be written."
            })
          })
        )
      return {
        workingCopy: synced.path,
        ...("failed" in synced ? { workingCopyNotUpdated: synced.failed } : {}),
        ...(synced.overwritten.length
          ? {
              workingCopyOverwritten: synced.overwritten,
              workingCopyNote:
                "These files in the working copy had changes that weren't committed. They now match the repository; their earlier content is kept as versions in Files."
            }
          : {})
      }
    }).pipe(Effect.orElseSucceed(() => ({})))
  const effects = (
    kind: string,
    target: Target,
    title: string,
    undo: Record<string, unknown> | null
  ): RolloutEffectRecord => ({
    kind,
    targetKind: "plugin",
    targetId: target.id,
    title,
    undo: undo ? { ...target, ...undo } : null
  })
  const record = (
    ctx: ToolContext,
    text: string,
    changes: ReadonlyArray<RolloutEffectRecord>
  ): Effect.Effect<ToolOutput, unknown> =>
    Effect.gen(function* () {
      // Files/Git or lifecycle pins first, then one synchronous receipt/effects transaction.
      // Repository journals recover the gap. A lifecycle gap asks again, never inventing consent.
      const saved = yield* writer.RecordRolloutEffects({
        userId: ctx.userId,
        rolloutId: ctx.rolloutId,
        toolCallId: ctx.toolCallId,
        result: data(text),
        effects: changes
      })
      return { text: saved, dataOnly: true as const }
    })
  /** The question for a commit of a server plugin's working copy: every file it changes, before and after. */
  const describeCommitFromFiles = (ctx: ToolContext, args: Args) =>
    Semaphore.withPermit(deps.lock)(
      Effect.gen(function* () {
        const actor = yield* proof(ctx, "plugins.write", false, true)
        const target = targetOf(args.plugin)
        const owner = ownerOf(actor, target)
        const copy = copyOf()
        if (!copy) return yield* refused("There's no working copy in your files here.")
        const files = yield* copy.read(actor, target).pipe(Effect.mapError((error) => refused(error.message)))
        const saved = yield* treeOf(owner, target.id)
        const paths = [...new Set([...Object.keys(saved), ...Object.keys(files)])]
          .filter((path) => saved[path] !== files[path])
          .sort()
        ctx.cache.set(commitFilesKey(ctx), treeDigest(files))
        const shown = paths.slice(0, COMMIT_DIFF_FILES)
        return {
          title: `Save the working copy of ${target.id} as server code?`,
          rows: [
            { label: "Plugin", value: target.id },
            { label: "From", value: copy.where(target) },
            { label: "Message", value: String(args.message ?? "") },
            {
              label: "Files changed",
              value:
                paths.length === 0
                  ? "None"
                  : `${paths.length}${paths.length > shown.length ? ` (the first ${shown.length} are shown)` : ""}`
            },
            { label: "Then", value: "Nothing runs until the plugin is turned on, which asks again." }
          ],
          changes: shown.map((path) => ({ field: path, before: saved[path] ?? "", after: files[path] ?? "" })),
          once: true as const
        }
      })
    ).pipe(
      Effect.mapError((error) =>
        error instanceof PluginRejected || error instanceof ToolInputRefused
          ? new ToolInputRefused(error.message)
          : new ToolInputRefused("This commit couldn't be shown safely.")
      )
    )
  const describeEnable = (ctx: ToolContext, args: Args) =>
    Semaphore.withPermit(deps.lock)(
      Effect.gen(function* () {
        const actor = yield* proof(ctx, "plugins.apply", false, true)
        if (actor.role !== "admin")
          return yield* refused("An admin turns plugins on and applies new versions. Server code needs an admin.")
        const target = targetOf(args.plugin)
        const details = yield* host.get(actor, target)
        const selected = details.versions.find((v) => v.commit === args.commit)
        if (!selected?.manifest)
          return yield* refused("Use an exact committed version returned by plugin_commit or plugin_log.")
        const owner = ownerOf(actor, target),
          last = checked.get(checkKey(owner, target.id))
        const snapshot = yield* repo(owner, target.id, { action: "checkpoint" })
        yield* attempt(() => repoTask(dataDir, { op: "verify", owner, id: target.id, commit: snapshot.head! }))
        const selectedTree = yield* repo(owner, target.id, { action: "checkpoint", commit: selected.commit })
        if (!last || last.tree !== selectedTree.tree)
          return yield* refused("Run plugin_check successfully on these files before turning this version on.")
        const prepared: Prepared = {
          target,
          commit: selected.commit,
          digest: argsDigest({ tool: "plugin_enable", capability: "plugins.apply", args }),
          revision: details.revision,
          head: snapshot.head!,
          before: details.pin?.commit ?? null,
          name: selected.manifest.name
        }
        ctx.cache.set(preparedKey(ctx), prepared)
        return {
          plugin: { id: target.id, commit: selected.commit },
          presentation: { title: selected.manifest.name, subtitle: `Version ${selected.commit.slice(0, 8)}` },
          title: `Turn on ${selected.manifest.name}?`,
          rows: [
            { label: "Version", value: selected.commit.slice(0, 8) },
            { label: "Saved change", value: selected.message },
            ...pluginConsent(selected.manifest, target.scope).map((value, i) => ({
              label: i === 0 ? "Runs" : "Access " + i,
              value
            }))
          ]
        }
      })
    )
  const built: Array<RolloutTool<Args>> = []
  const add = (
    id: string,
    effect: "read" | "library" | "setup" | "outside",
    parameters: Record<string, TSchema>,
    description: string,
    run: (ctx: ToolContext, args: Args, actor: User) => Effect.Effect<ToolOutput, unknown>,
    options: Partial<RolloutTool<Args>> = {}
  ) => {
    const capability = ["plugin_enable", "plugin_rollback", "plugin_disable"].includes(id)
      ? "plugins.apply"
      : "plugins.write"
    built.push({
      source: import.meta.url,
      id,
      effect,
      capability,
      replyTool: false,
      snapshot: journalSnapshot,
      storyRead: "account",
      label: labels[id] ?? "Used a plugin tool",
      description,
      parameters: Type.Object(parameters, { additionalProperties: false }),
      ...options,
      execute: (ctx, args) =>
        Semaphore.withPermit(deps.lock)(
          Effect.gen(function* () {
            const actor = yield* proof(
              ctx,
              capability,
              id === "plugin_enable" || (id === "plugin_commit" && commitsServerCopy(args)),
              id === "plugin_rollback"
            )
            return yield* run(ctx, args, actor)
          })
        ).pipe(
          Effect.catchCause((cause) => {
            const error = cause.reasons.find((r) => r._tag === "Fail" || r._tag === "Die")
            const value = error?._tag === "Fail" ? error.error : error?._tag === "Die" ? error.defect : undefined
            const text =
              value instanceof ToolInputRefused ||
              value instanceof PluginRejected ||
              (value && typeof value === "object" && "_tag" in value && value._tag === "ApprovalRefused")
                ? String((value as Error).message)
                : "Plugin operation could not be completed. Read its files and check again."
            return Effect.succeed({ isError: true, text })
          })
        )
    })
  }
  add(
    "plugin_api",
    "read",
    { topic: Type.Optional(str()) },
    "Read the plugin API. Returns installed types and one example for supported typed adapters; no unsupported internal contracts.",
    (_ctx, args) =>
      Effect.map(
        attempt(() => pluginApiDocs(args.topic as string | undefined)),
        (t) => ({ dataOnly: true as const, text: data(t) })
      )
  )
  add(
    "app_source",
    "read",
    { path: Type.Optional(str()), query: Type.Optional(str()), ...page },
    "Read shipped app reference source. Admin only; source paths/index and limits are explicit in every result. No files can be changed.",
    (_ctx, args, actor) =>
      actor.role !== "admin"
        ? Effect.fail(refused("Only an admin can read app source."))
        : Effect.map(
            attempt(() => appSource(args, dataDir)),
            (t) => ({ dataOnly: true as const, text: data(t) })
          ),
    { adminOnly: true }
  )
  add(
    "plugin_list",
    "read",
    {},
    "List your plugin repositories. Admins also see instance repositories, with saved and enabled versions and status.",
    (_ctx, _args, actor) =>
      host.list(actor).pipe(
        Effect.map((list) => ({
          dataOnly: true as const,
          text: data(
            JSON.stringify(
              list
                .filter((p) => actor.role === "admin" || p.scope === "user")
                .map((p) => ({
                  plugin: (p.scope === "instance" ? "instance:" : "") + p.id,
                  name: p.manifest?.name,
                  latest: p.commit,
                  enabled: p.pin && !p.pin.suspended ? p.pin.commit : null,
                  status: p.pin?.suspended ? "off (needs attention)" : p.pin ? "on" : "off"
                }))
            )
          )
        }))
      )
  )
  add(
    "plugin_copy_builtin",
    "library",
    {
      registry: Type.Optional(str()),
      id: Type.Optional(str()),
      pluginId: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }))
    },
    "Without arguments, list built-in parts and copy support. Pass nextRegistry as registry to continue the list. With registry and id, create, commit and check an editable copy. The copy starts off; plugin_enable still asks.",
    (ctx, args, actor) =>
      Effect.gen(function* () {
        if (args.id === undefined) {
          const registry = args.registry === undefined ? undefined : String(args.registry)
          const text = builtinCopyPage(yield* host.builtinParts(actor, ctx), registry)
          if (text === undefined)
            return yield* refused("This registry is unavailable. List built-in parts to start again.")
          return { dataOnly: true as const, text }
        }
        const part = builtinCopy(String(args.registry), String(args.id))
        if (!part)
          return yield* refused("This part does not have a copy adapter yet. Read plugin_api for supported parts.")
        const target: Target = {
          scope: part.side !== "client" ? "instance" : "user",
          id: typeof args.pluginId === "string" ? args.pluginId : builtinCopyStem(part.id) + "-copy"
        }
        const owner = ownerOf(actor, target)
        const result = yield* attempt(() =>
          repoTask<AuthorResult & { unsupported?: ReadonlyArray<string> }>(dataDir, {
            op: "copyBuiltin",
            owner,
            id: target.id,
            registry: part.registry,
            partId: part.id,
            key: operationKey(ctx, args)
          })
        )
        if ("unsupported" in result)
          return {
            isError: true,
            dataOnly: true as const,
            text: data("This built-in needs an adapter for: " + result.unsupported!.join(", ") + ".")
          }
        const snapshot = yield* repo(owner, target.id, { action: "checkpoint", commit: result.commit! })
        const report = yield* attempt(() =>
          checkPlugin(dataDir, owner, target.id, result.commit!, { working: false, admin: actor.role === "admin" })
        )
        if (report.ok && actor.role === "admin")
          checked.set(checkKey(owner, target.id), { tree: snapshot.tree!, commit: result.commit! })
        const copy = yield* follow(ctx, actor, target, null)
        const saved = yield* record(
          ctx,
          JSON.stringify({ plugin: (owner ? "" : "instance:") + target.id, ...result, report, ...copy }),
          [
            effects("plugin.create", target, `Made an editable copy of ${part.label}`, {
              creation: true,
              commit: result.commit
            })
          ]
        )
        const selected = yield* attempt(() =>
          repoTask<Pick<typeof PluginDetails.Type, "manifest">>(dataDir, {
            op: "info",
            owner,
            id: target.id,
            selected: result.commit!
          })
        )
        return {
          ...saved,
          ...(selected.manifest
            ? {
                presentation: { title: selected.manifest.name, subtitle: `Version ${result.commit!.slice(0, 8)}` }
              }
            : {})
        }
      }),
    {
      describe: (ctx, args) =>
        Effect.gen(function* () {
          const actor = yield* proof(ctx, "plugins.write", false, true)
          if (args.id === undefined) return { title: "List built-in parts?", rows: [] }
          const part = builtinCopy(String(args.registry), String(args.id))
          if (!part)
            return yield* refused("This part does not have a copy adapter yet. Read plugin_api for supported parts.")
          ownerOf(actor, { scope: part.side === "client" ? "user" : "instance", id: part.id })
          const name = `${part.label} (editable)`
          return {
            title: `Make an editable copy of ${part.label}?`,
            presentation: { title: name },
            rows: [
              { label: "Plugin", value: name },
              { label: "Starts", value: "Off. Turning it on requires a separate review." }
            ]
          }
        })
    }
  )
  add(
    "plugin_create",
    "library",
    {
      id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
      name: Type.String({ maxLength: 120 }),
      runs: Type.Union([Type.Literal("browser"), Type.Literal("server")])
    },
    'Create a plugin repository from a template. Nothing loads or is enabled; server repositories need an admin. It also makes a working copy in your files (/files/Plugins/<id>, a server plugin\'s at /files/Plugins/Server/<id>) with a .git of its own, which commands and the file tools can change; commit it with plugin_commit from: "files".',
    (ctx, args, actor) =>
      Effect.gen(function* () {
        const server = args.runs === "server",
          target: Target = { scope: server ? "instance" : "user", id: String(args.id) },
          owner = ownerOf(actor, target)
        const files = {
          "dreamspan-plugin.json": JSON.stringify(
            {
              id: target.id,
              name: args.name,
              api: 1,
              client: server ? null : "src/client.tsx",
              server: server ? "src/server.ts" : null,
              worker: null,
              surfaces: server ? [] : ["client:composerControls"],
              overrides: [],
              network: false,
              replaces: [],
              base: null
            },
            null,
            2
          ),
          [server ? "src/server.ts" : "src/client.tsx"]: server
            ? 'import { Effect, type Activate } from "@dreamspan/plugin-api/server"\nexport const activate: Activate = () => Effect.void\n'
            : 'import { type Activate } from "@dreamspan/plugin-api/client"\nexport const activate: Activate = () => {}\n',
          "test/plugin.test.ts":
            'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("plugin fixture", () => assert.equal(1 + 1, 2))\n'
        }
        const result = yield* attempt(() =>
          repoTask<AuthorResult>(dataDir, {
            op: "authorCreate",
            owner,
            id: target.id,
            files,
            key: operationKey(ctx, args)
          })
        )
        const copy = yield* follow(ctx, actor, target, null)
        return yield* record(
          ctx,
          JSON.stringify({ plugin: (server ? "instance:" : "") + target.id, ...result, ...copy }),
          [
            effects("plugin.create", target, `Created the plugin ${String(args.name)}`, {
              creation: true,
              commit: result.commit
            })
          ]
        )
      })
  )
  const fileRead = (action: "read" | "search" | "diff") => (ctx: ToolContext, args: Args, actor: User) =>
    Effect.gen(function* () {
      const target = targetOf(args.plugin),
        owner = ownerOf(actor, target)
      const result = yield* repo(owner, target.id, { ...args, action } as AuthorRequest)
      return { dataOnly: true as const, text: data(result.text) }
    })
  add(
    "plugin_read",
    "read",
    { ...path, ...page },
    "Read a plugin text file with line numbers. At most 200 lines and 15000 characters.",
    fileRead("read")
  )
  add(
    "plugin_search",
    "read",
    { ...plugin, path: Type.Optional(str()), query: Type.String({ minLength: 1, maxLength: 200 }) },
    "Search plugin text for a literal string. At most 30 matches, confined to this repository.",
    fileRead("search")
  )
  add(
    "plugin_diff",
    "read",
    plugin,
    "Read uncommitted changes against the saved version. Output is bounded; read individual files for more.",
    fileRead("diff")
  )
  add(
    "plugin_log",
    "read",
    plugin,
    "Read the plugin's saved versions. Returns full commit ids and messages.",
    (_ctx, args, actor) => {
      const target = targetOf(args.plugin)
      ownerOf(actor, target)
      return host
        .log(actor, target)
        .pipe(Effect.map((v) => ({ dataOnly: true as const, text: data(JSON.stringify(v)) })))
    }
  )
  const mutate = (action: "write" | "edit" | "commit") => (ctx: ToolContext, args: Args, actor: User) =>
    Effect.gen(function* () {
      const target = targetOf(args.plugin),
        owner = ownerOf(actor, target)
      if (
        action === "edit" &&
        ((args.edits !== undefined && (args.old_str !== undefined || args.new_str !== undefined)) ||
          (args.edits === undefined && (typeof args.old_str !== "string" || typeof args.new_str !== "string")))
      )
        return yield* refused("Provide edits, or both old_str and new_str.")
      // The working copy's files, read back through the app's own checks (§5.3).
      const fromFiles = action === "commit" && args.from === "files"
      const copy = copyOf()
      if (fromFiles && !copy) return yield* refused("There's no working copy in your files here.")
      if (fromFiles) {
        const unsaved = JSON.parse((yield* repo(owner, target.id, { action: "diff" })).text) as {
          files: Array<unknown>
        }
        if (unsaved.files.length)
          return yield* refused(
            "This plugin has changes made with plugin_write or plugin_edit that aren't committed. Commit them first (plugin_commit without from), then commit the working copy."
          )
      }
      // A server plugin's copy: only this exact call, approved by the admin, with the files shown.
      const serverCopy = fromFiles && target.scope === "instance"
      if (serverCopy && ctx.approvalDigest !== argsDigest({ tool: "plugin_commit", capability: "plugins.write", args }))
        return yield* refused("Committing a server plugin's working copy needs your approval of this exact call.")
      const files = fromFiles
        ? yield* copy!.read(actor, target).pipe(Effect.mapError((error) => refused(error.message)))
        : undefined
      if (serverCopy && (!files || ctx.cache.get(commitFilesKey(ctx)) !== treeDigest(files)))
        return yield* refused("The working copy changed after you were asked. Commit it again to see the new changes.")
      const request: AuthorRequest = {
        ...args,
        action,
        key: operationKey(ctx, args),
        ...(files ? { files } : {}),
        ...(action === "edit" ? { edits: args.edits ?? [{ old_str: args.old_str, new_str: args.new_str }] } : {})
      } as AuthorRequest
      yield* repo(owner, target.id, { ...request, preview: true })
      const prior = checked.get(checkKey(owner, target.id))
      const before = yield* treeBefore(owner, target.id)
      const result = yield* repo(owner, target.id, request)
      if (action !== "commit" || prior?.tree !== result.tree) checked.delete(checkKey(owner, target.id))
      const followed = yield* follow(ctx, actor, target, before)
      return yield* record(ctx, JSON.stringify({ ...result, ...followed }), [
        effects(
          action === "commit" ? "plugin.commit" : "plugin.write",
          target,
          action === "commit" ? `Saved a version of ${target.id}` : `Edited ${target.id}: ${String(args.path)}`,
          { journal: result.journal, commit: result.commit ?? null }
        )
      ])
    })
  add(
    "plugin_write",
    "library",
    { ...path, content: str() },
    "Write a plugin text file without applying it. Limits: 512 KiB/file, 8 MiB, 256 files, depth 24; no binaries, links, Git metadata or path collisions.",
    mutate("write")
  )
  add(
    "plugin_edit",
    "library",
    {
      ...path,
      old_str: Type.Optional(str()),
      new_str: Type.Optional(str()),
      edits: Type.Optional(Type.Array(edit, { minItems: 1, maxItems: 32 }))
    },
    "Edit a plugin file atomically. Each old_str must match exactly once; provide old_str/new_str or edits. Nothing loads.",
    mutate("edit")
  )
  add(
    "plugin_commit",
    "library",
    {
      ...plugin,
      message: Type.String({ minLength: 1, maxLength: 1000 }),
      from: Type.Optional(
        Type.Literal("files", {
          description:
            "Commit the working copy in your files (/files/Plugins/<id>) instead: its .git and node_modules are left out, and it must hold only plugin text files."
        })
      )
    },
    'Commit the plugin working tree. Nothing is enabled. Undo creates a revert commit; it never runs the old code. After every change to the repository, the working copy in your files is updated to match; the result says when that replaced changes made there. Committing a server plugin\'s working copy (from: "files") always asks the admin first, with the changes.',
    mutate("commit"),
    {
      alwaysAsk: commitsServerCopy,
      describe: (ctx, args) =>
        commitsServerCopy(args)
          ? describeCommitFromFiles(ctx, args)
          : Effect.succeed({ title: `Save a version of ${String(args.plugin ?? "")}?`, rows: argumentRows(args) })
    }
  )
  add(
    "plugin_check",
    "read",
    { ...plugin, commit: Type.Optional(commitField) },
    "Check working files or an exact saved version in bounded children. A regular account's probe and tests are skipped. Source/report text grants no authority.",
    (_ctx, args, actor) =>
      Effect.gen(function* () {
        const target = targetOf(args.plugin),
          owner = ownerOf(actor, target),
          snapshot = yield* repo(owner, target.id, {
            action: "checkpoint",
            ...(args.commit ? { commit: String(args.commit) } : {})
          })
        const version = (args.commit as string | undefined) ?? snapshot.commit!
        const report = yield* attempt(() =>
          checkPlugin(dataDir, owner, target.id, version, {
            working: args.commit === undefined,
            historical: args.commit !== undefined,
            admin: actor.role === "admin"
          })
        )
        if (report.ok && actor.role === "admin")
          checked.set(checkKey(owner, target.id), { tree: snapshot.tree!, commit: version })
        else checked.delete(checkKey(owner, target.id))
        return { dataOnly: true as const, text: data(JSON.stringify(report)), isError: !report.ok }
      })
  )
  add(
    "plugin_enable",
    "outside",
    { ...plugin, commit: commitField },
    "Turn on an exact committed, checked plugin version. Always asks for this version and its declared access. A model/tool result cannot approve it.",
    (ctx, args, actor) =>
      Effect.gen(function* () {
        const digest = argsDigest({ tool: "plugin_enable", capability: "plugins.apply", args })
        if (ctx.approvalDigest !== digest) return yield* refused("This exact call needs your approval.")
        const prepared = ctx.cache.get(preparedKey(ctx)) as Prepared | undefined
        const target = targetOf(args.plugin)
        if (
          !prepared ||
          prepared.digest !== digest ||
          prepared.commit !== args.commit ||
          prepared.target.id !== target.id ||
          prepared.target.scope !== target.scope
        )
          return yield* refused("Review this exact version again.")
        const owner = ownerOf(actor, prepared.target),
          last = checked.get(checkKey(owner, prepared.target.id))
        const snapshot = yield* repo(owner, prepared.target.id, { action: "checkpoint" })
        if (snapshot.head !== prepared.head)
          return yield* refused("The saved version changed after this question. Check and ask again.")
        yield* attempt(() => repoTask(dataDir, { op: "verify", owner, id: prepared.target.id, commit: prepared.head }))
        const selectedTree = yield* repo(owner, prepared.target.id, { action: "checkpoint", commit: prepared.commit })
        if (!last || last.tree !== selectedTree.tree)
          return yield* refused("Plugin files changed after the check. Check and ask again.")
        const before = yield* treeBefore(owner, prepared.target.id)
        const report = yield* deps.rollback(actor, {
          ...prepared.target,
          commit: prepared.commit,
          expectedRevision: prepared.revision
        })
        if (!report.ok) return { dataOnly: true as const, text: data(JSON.stringify(report)), isError: true }
        const followed = yield* follow(ctx, actor, prepared.target, before)
        const saved = yield* record(
          ctx,
          JSON.stringify({ enabled: prepared.commit, plugin: args.plugin, ...followed }),
          [
            effects("plugin.enable", prepared.target, `Turned on ${prepared.name}`, {
              enabled: prepared.commit,
              previous: prepared.before
            })
          ]
        )
        return { ...saved, presentation: { title: prepared.name, subtitle: `Version ${prepared.commit.slice(0, 8)}` } }
      }),
    {
      titleField: "plugin",
      approval: "always",
      adminOnly: true,
      describe: (ctx, args) =>
        describeEnable(ctx, args).pipe(
          Effect.mapError(
            (e) =>
              new ToolInputRefused(
                e instanceof PluginRejected ? e.message : "This version could not be checked safely."
              )
          )
        )
    }
  )
  add(
    "plugin_rollback",
    "outside",
    { ...plugin, to: commitField },
    "Go back to the immediately previous approved version without asking, only if declared access does not grow. Arbitrary old versions must use plugin_enable and consent.",
    (ctx, args, actor) =>
      Effect.gen(function* () {
        const target = targetOf(args.plugin),
          details = yield* hostDetails(actor, target),
          previous = details.pin?.previousCommit
        if (!previous || previous !== args.to)
          return yield* refused("Only the previous approved version can go back without asking.")
        const before = details.versions.find((v) => v.commit === details.pin!.commit)?.manifest,
          after = details.versions.find((v) => v.commit === previous)?.manifest
        if (!after || pluginAccessGrows(before, after))
          return yield* refused("This version adds access. Check it and use plugin_enable to ask first.")
        const tree = yield* treeBefore(ownerOf(actor, target), target.id)
        const report = yield* deps.rollback(actor, { ...target, commit: previous, expectedRevision: details.revision })
        if (!report.ok) return { dataOnly: true as const, text: data(JSON.stringify(report)), isError: true }
        const followed = yield* follow(ctx, actor, target, tree)
        return yield* record(ctx, JSON.stringify({ wentBackTo: previous, ...followed }), [
          effects("plugin.enable", target, `Went back to the previous version of ${target.id}`, {
            enabled: previous,
            previous: details.pin!.commit
          })
        ])
      }),
    { approval: "rollback", adminOnly: true }
  )
  // Locked details without reentering host.get (the caller already owns the lifecycle lock).
  function hostDetails(actor: User, target: Target): Effect.Effect<typeof PluginDetails.Type, unknown> {
    return deps.host.get(actor, target)
  }
  add(
    "plugin_disable",
    "setup",
    plugin,
    "Turn a plugin off and keep its files, versions and data.",
    (ctx, args, actor) =>
      Effect.gen(function* () {
        const target = targetOf(args.plugin)
        yield* deps.dirty(actor, target)
        return yield* record(ctx, `Turned off ${target.id}. Files and data are kept.`, [
          effects("plugin.disable", target, `Turned off ${target.id}`, null)
        ])
      })
  )
  return {
    tools: built as ReadonlyArray<RolloutTool<never>>,
    undoEffect: (actor: User, effect: RolloutEffect) =>
      Semaphore.withPermit(deps.lock)(
        Effect.gen(function* () {
          if (effect.undoneAt !== null) return effect
          const recipe = effect.undo
          if (!recipe) return yield* refused("This change cannot be undone.")
          const target: Target = { scope: recipe.scope === "instance" ? "instance" : "user", id: effect.targetId },
            owner = ownerOf(actor, target)
          const key = `undo:${effect.rolloutId}:${effect.toolCallId}:${effect.seq}`
          if (typeof recipe.journal === "string") {
            const request: AuthorRequest = { action: "undo", undo: recipe.journal, key }
            yield* repo(owner, target.id, { ...request, preview: true })
            const before = yield* treeBefore(owner, target.id)
            yield* repo(owner, target.id, request)
            yield* follow(null, actor, target, before)
          } else if (effect.kind === "plugin.enable" || effect.kind === "plugin.create") {
            const details = yield* hostDetails(actor, target)
            if (effect.kind === "plugin.enable" && details.pin?.commit !== recipe.enabled)
              return yield* refused("Plugin changed since; open its versions first.")
            // Undo never increases authority: turn off. Files/commits remain for recovery.
            yield* deps.dirty(actor, target)
          } else return yield* refused("This change cannot be undone.")
          checked.delete(checkKey(owner, target.id))
          return yield* writer.CompletePluginUndo({
            userId: actor.id,
            rolloutId: effect.rolloutId,
            toolCallId: effect.toolCallId,
            seq: effect.seq,
            result: { turnedOff: true }
          })
        })
      )
  }
}
