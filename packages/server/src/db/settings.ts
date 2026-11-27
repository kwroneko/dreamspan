import {
  BACKGROUNDS_KEY,
  BackgroundHolds,
  isLocalBackgroundKey,
  LocalBackgroundHolds,
  readBackgroundHolds
} from "./backgroundMedia.ts"
import { PluginPins } from "@dreamspan/shared/plugins.ts"
import { ExternalMediaPrefs } from "@dreamspan/shared/externalMedia.ts"
import { MediaHosts } from "@dreamspan/shared/savedMedia.ts"
// All settings use this registry and writer; feature handlers keep their ownership checks.
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { makeRegistry } from "@dreamspan/shared/registry.ts"
import { DisplayPrefs } from "@dreamspan/shared/chatApi.ts"
import { BinLimits } from "@dreamspan/shared/bin.ts"
import { SourceAdminSettings, SourcePrefs } from "@dreamspan/shared/cardSources.ts"
import { CostRules } from "@dreamspan/shared/costFormulas.ts"
import { DecisionPointSetting } from "@dreamspan/shared/decisions.ts"
import { LcmDefaults, ModelChoice } from "@dreamspan/shared/lcmSettings.ts"
import { GlobalScripts } from "@dreamspan/shared/regexScripts.ts"
import { SubagentLimits, SubagentModels, SubagentTypes } from "@dreamspan/shared/subagents.ts"
import { StaleWrite } from "@dreamspan/shared/errors.ts"
import { StorageError } from "./ops.ts"

/** Allow always for an assistant card, and in every workshop (spec/WORKSHOP-CARDS.md §2.5). */
export const CARD_GRANTS = "workshop.cardGrants"
export const ALWAYS_GRANTS = "workshop.alwaysGrants"
/** Settings no agent writes, whatever a registration says: the assistant can't give itself anything. */
export const USER_ONLY_SETTINGS: ReadonlySet<string> = new Set([CARD_GRANTS, ALWAYS_GRANTS])

type SettingScope = "app" | "user" | "device"
export interface SettingDefinition {
  readonly id: string
  readonly scope: SettingScope
  readonly agent?: { readonly description: string }
  readonly schema: Schema.Top
}

const definitions: ReadonlyArray<SettingDefinition> = [
  { id: "plugins.instance", scope: "app", schema: PluginPins },
  { id: "plugins.user", scope: "user", schema: PluginPins },
  {
    id: "network",
    scope: "app",
    schema: Schema.Struct({
      proxyUrlEnc: Schema.NullOr(Schema.String),
      bypass: Schema.Array(Schema.String),
      forceProxy: Schema.optionalKey(Schema.Boolean)
    })
  },
  { id: "media.external", scope: "user", schema: ExternalMediaPrefs },
  { id: "media.saved.hosts", scope: "user", schema: MediaHosts },
  { id: BACKGROUNDS_KEY, scope: "user", schema: BackgroundHolds },
  { id: "display", scope: "user", schema: DisplayPrefs, agent: { description: "How chats are displayed." } },
  // One-time notices shown, by notice. Nothing writes it since the impersonation notice was
  // removed (2026-11-21); kept registered so rows already stored still read.
  { id: "notices", scope: "user", schema: Schema.Record(Schema.String, Schema.Array(Schema.String)) },
  {
    id: "shell.pinsCollapsed",
    scope: "user",
    schema: Schema.Boolean,
    agent: { description: "Collapse pinned chats." }
  },
  { id: "cost", scope: "user", schema: CostRules },
  {
    id: "workshop.defaults",
    scope: "user",
    // The workshop persona is its own default, never the story one (owner, 2026-11-12).
    schema: Schema.Struct({
      card: Schema.String,
      preset: Schema.String,
      persona: Schema.optionalKey(Schema.NullOr(Schema.String))
    })
  },
  { id: "chat.persona", scope: "user", schema: Schema.NullOr(Schema.String) },
  // The working folder a workshop starts in, per assistant card, and the folders picked last
  // (spec/FILES-AND-ENVIRONMENT.md §2.3): the user's, never part of a card.
  {
    id: "workshop.cardFolders",
    scope: "user",
    schema: Schema.Record(
      Schema.String,
      Schema.Struct({ path: Schema.String, inode: Schema.NullOr(Schema.Number), at: Schema.Number })
    )
  },
  {
    id: "workshop.recentFolders",
    scope: "user",
    schema: Schema.Array(Schema.Struct({ path: Schema.String, inode: Schema.NullOr(Schema.Number) }))
  },
  // Folders moved or renamed in the app, oldest first (at most 200): a branch's stored working
  // folder (an immutable state event) is found again through them (files/workingFolder.ts).
  {
    id: "workshop.folderMoves",
    scope: "user",
    schema: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))
  },
  // What the assistant may look at without asking beyond one workshop (spec/WORKSHOP-CARDS.md
  // §2.5): per assistant card (by entity, so its revisions and renames keep it) and in every
  // workshop. Consent, so never an agent's write: no `agent` entry, and `USER_ONLY_SETTINGS`.
  {
    id: CARD_GRANTS,
    scope: "user",
    schema: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Literal("allow")))
  },
  { id: ALWAYS_GRANTS, scope: "user", schema: Schema.Record(Schema.String, Schema.Literal("allow")) },
  { id: "generation.model", scope: "user", schema: Schema.NullOr(ModelChoice) },
  { id: "generation.preset", scope: "user", schema: Schema.NullOr(Schema.String) },
  { id: "generation.judge", scope: "user", schema: Schema.NullOr(ModelChoice) },
  // Whether the judge also reads a reply that was never sent (spec/REPLY-CONTRACT.md §3.6).
  { id: "generation.judge_endings", scope: "user", schema: Schema.Boolean },
  { id: "generation.lcm", scope: "user", schema: Schema.NullOr(LcmDefaults) },
  { id: "regex.global", scope: "user", schema: GlobalScripts },
  // Subagents' models and limits (spec/SUBAGENTS.md §5, §6.2): consent and spend, so never an
  // agent's write (no `agent` entry).
  { id: "subagents.models", scope: "user", schema: SubagentModels },
  { id: "subagents.limits", scope: "user", schema: SubagentLimits },
  // The user's subagent types (§10): the workshop agent may write them (`change_setting`), as a
  // setup change with Undo. They hold no limits, so consent and spend stay the user's.
  {
    id: "subagents.types",
    scope: "user",
    schema: SubagentTypes,
    agent: {
      description:
        "Your subagent types: a list of {id, label, description, instructions, tools (tool ids), defaultAlias, context: task|fork, off}. An entry with a built-in type's id changes that type."
    }
  },
  { id: "bin.limits", scope: "user", schema: BinLimits },
  { id: "sources", scope: "user", schema: SourcePrefs },
  { id: "sources.admin", scope: "app", schema: SourceAdminSettings },
  // Admins' Files quotas per account, in bytes (files/quota.ts); absent: FILES_QUOTA.
  {
    id: "files.quotas",
    scope: "app",
    schema: Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
  },
  {
    id: "cards.favourites",
    scope: "user",
    schema: Schema.Struct({ on: Schema.Array(Schema.String), here: Schema.Array(Schema.String) })
  },
  {
    id: "token_counting",
    scope: "user",
    schema: Schema.Struct({ connections: Schema.Record(Schema.String, Schema.String) })
  },
  {
    id: "decisions",
    scope: "user",
    schema: Schema.Struct({
      connections: Schema.Record(
        Schema.String,
        Schema.Struct({
          model: Schema.NullOr(Schema.String),
          points: Schema.Record(Schema.String, DecisionPointSetting)
        })
      )
    })
  },
  {
    id: "import.st.memory",
    scope: "user",
    schema: Schema.Struct({
      prompt: Schema.NullOr(Schema.String),
      promptWords: Schema.Number,
      position: Schema.Number,
      depth: Schema.Number,
      role: Schema.Number,
      template: Schema.String,
      enabled: Schema.Boolean
    })
  }
]

const accepts = (definition: SettingDefinition) => Schema.is(definition.schema as Schema.Schema<unknown>)
const entries = makeRegistry(definitions.map((definition) => ({ ...definition, accepts: accepts(definition) })))

/** Plugins add, replace or disable keys with scoped registrations, also inside workers. */
export const settingsRegistry = {
  ...entries,
  register: (definition: SettingDefinition, validate = accepts(definition)) =>
    entries.register({ ...definition, accepts: validate })
}

// Device ids are browser-generated. Pair with the account to isolate shared browsers/accounts.
export const deviceScopeId = (userId: string, device: string) => JSON.stringify([userId, device])

export const readSetting = (sql: SqlClient.SqlClient, scope: SettingScope, scopeId: string, key: string) =>
  sql<{ value_json: string; revision: number }>`SELECT value_json, revision FROM settings
    WHERE scope = ${scope} AND scope_id = ${scopeId} AND key = ${key}`.pipe(
    Effect.map(([row]) => ({
      value: row ? (JSON.parse(row.value_json) as unknown) : null,
      revision: row?.revision ?? 0
    }))
  )

/** Must run in the caller's writer transaction; patches read/merge there, replacements pass a revision. */
export const writeSetting = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  scope: SettingScope,
  scopeId: string,
  key: string,
  value: unknown,
  expectedRevision?: number
) {
  const definition = isLocalBackgroundKey(key)
    ? { scope: "user", accepts: Schema.is(LocalBackgroundHolds) }
    : settingsRegistry.get(key)
  if (!definition || definition.scope !== scope || !definition.accepts(value))
    return yield* new StorageError({
      operation: "writeSetting",
      reason: "constraint",
      message: `Invalid ${scope} setting: ${key}`
    })
  const stored = yield* readSetting(sql, scope, scopeId, key)
  if (expectedRevision !== undefined && stored.revision !== expectedRevision)
    return yield* new StaleWrite({
      entity: "setting",
      id: `${scope}/${scopeId}/${key}`,
      expected: expectedRevision,
      actual: stored.revision
    })
  // Other account setting writers (including settings undo) use the same ownership boundary.
  if (key === "display" && Schema.is(DisplayPrefs)(value)) {
    const { chatBackground, chatBackgrounds, workshopBackground } = value
    const globals = [chatBackground.mediaId, workshopBackground === "inherit" ? null : workshopBackground]
    const overrides = Object.entries(chatBackgrounds).filter(([, id]) => typeof id === "string")
    if (globals.some((id) => id !== null) || overrides.length > 0) {
      const gallery = new Set((yield* readBackgroundHolds(sql, scopeId)).map(({ mediaId }) => mediaId))
      const missingGlobal = globals.some((id) => id !== null && !gallery.has(id))
      let missingLocal = false
      for (const [chatId, id] of overrides) {
        if (id === null || gallery.has(id)) continue
        if (!(yield* readBackgroundHolds(sql, scopeId, chatId)).some((entry) => entry.mediaId === id)) {
          missingLocal = true
          break
        }
      }
      if (missingGlobal || missingLocal)
        return yield* new StorageError({
          operation: "writeSetting",
          reason: "constraint",
          message: "Chat backgrounds must belong to an available gallery."
        })
    }
  }
  const revision = stored.revision + 1
  yield* sql`INSERT INTO settings (scope, scope_id, key, value_json, revision, updated_at)
    VALUES (${scope}, ${scopeId}, ${key}, ${JSON.stringify(value)}, ${revision}, ${Date.now()})
    ON CONFLICT (scope, scope_id, key) DO UPDATE SET value_json = excluded.value_json,
      revision = excluded.revision, updated_at = excluded.updated_at`
  return revision
})

/** Atomic patches have no stale caller snapshot; their read and write share the transaction. */
export const putUserSetting = (sql: SqlClient.SqlClient, userId: string, key: string, value: unknown) =>
  writeSetting(sql, "user", userId, key, value).pipe(Effect.catchTag("StaleWrite", Effect.die))
