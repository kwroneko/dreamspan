// Client RPC handlers for connections, models, network settings and usage
// (spec/PROVIDERS.md). Every handler acts as the authenticated user; storage enforces
// ownership, so another user's ids are NotFound.
import {
  type AppApi,
  ConnectionTest,
  ConnectionTestReply,
  CurrentUser,
  ModelRefresh,
  NetworkSettings
} from "@dreamspan/shared/api.ts"
import type { RecomputeTarget } from "@dreamspan/shared/costFormulas.ts"
import { Forbidden, ServerError } from "@dreamspan/shared/errors.ts"
import type { ConnectionId, ModelId } from "@dreamspan/shared/providers.ts"
import { Effect } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Network } from "../net/Network.ts"
import { Providers, type ProvidersShape, type TestResult } from "../providers/Providers.ts"
import { recomputeCosts } from "../providers/recompute.ts"
import { ProviderRegistry } from "../providers/registry.ts"

/** Failures the client can't act on are logged here and reported without internals. */
const toServerError = (operation: string) => (error: unknown) =>
  Effect.logError(`${operation} failed`, error).pipe(
    Effect.andThen(Effect.fail(new ServerError({ message: `${operation} failed` })))
  )

type TestDraftPayload = Omit<Parameters<ProvidersShape["testDraft"]>[0], "userId" | "role">

const toConnectionTest = (result: TestResult) =>
  new ConnectionTest({ ...result, reply: result.reply && new ConnectionTestReply(result.reply) })

const admin = Effect.gen(function* () {
  const user = yield* CurrentUser
  if (user.role !== "admin") return yield* new Forbidden({ message: "only an admin can change instance settings" })
  return user
})

/** The providers a new connection starts from (providerApi.ts), the same for every user. */
export const makeProviderListHandlers = Effect.gen(function* () {
  const providers = yield* Providers
  const reader = yield* Reader
  const writer = yield* Writer
  const registry = yield* ProviderRegistry
  const recompute = (target: RecomputeTarget, apply: boolean, operation: string) =>
    Effect.flatMap(CurrentUser, (user) => recomputeCosts({ reader, writer, registry }, user.id, target, apply)).pipe(
      Effect.catch(toServerError(operation))
    )
  return {
    PreviewCostRecompute: ({ target }: { target: RecomputeTarget }) =>
      recompute(target, false, "PreviewCostRecompute").pipe(Effect.map(({ count, from, to }) => ({ count, from, to }))),
    ApplyCostRecompute: ({ target }: { target: RecomputeTarget }) =>
      recompute(target, true, "ApplyCostRecompute").pipe(Effect.map(({ changed }) => ({ changed }))),
    ListProviders: () => Effect.sync(() => providers.providers()),
    // The typed key goes only to the provider: never stored, logged or returned.
    TestConnectionDraft: ({ provider, kind, settings, apiKey, credentialId, model }: TestDraftPayload) =>
      Effect.flatMap(CurrentUser, (user) =>
        providers.testDraft({
          userId: user.id,
          role: user.role,
          provider,
          kind,
          settings,
          apiKey: apiKey ?? null,
          credentialId: credentialId ?? null,
          model: model ?? null
        })
      ).pipe(Effect.map(toConnectionTest)),
    RefreshModelEndpoints: ({ modelId }: { modelId: ModelId }) =>
      Effect.flatMap(CurrentUser, (user) => providers.refreshEndpoints(user.id, modelId)),
    GetPriceFeedState: ({ connectionId }: { connectionId: ConnectionId }) =>
      Effect.flatMap(CurrentUser, (user) => providers.priceFeedState(user.id, connectionId))
  }
})

export const makeProviderHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const providers = yield* Providers
  const network = yield* Network
  const warmth = yield* CacheWarmth

  const userId = Effect.map(CurrentUser, (user) => user.id)

  const handlers = {
    GetCostSettings: () =>
      Effect.flatMap(userId, (id) => reader.GetCostSettings({ userId: id })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("GetCostSettings"))
      ),
    SetCostSettings: (input) =>
      Effect.flatMap(userId, (id) => writer.SetCostSettings({ userId: id, ...input })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("SetCostSettings"))
      ),
    ListProviderKinds: () => Effect.sync(() => providers.kinds()),
    ListConnections: () =>
      Effect.flatMap(userId, (id) => reader.ListConnections({ userId: id })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("ListConnections"))
      ),
    CreateConnection: ({ provider, kind, settings, apiKey, credentialId }) =>
      Effect.flatMap(userId, (id) =>
        providers.createConnection({
          userId: id,
          provider,
          kind,
          settings,
          apiKey: apiKey ?? null,
          credentialId: credentialId ?? null
        })
      ),
    SetConnectionCredential: ({ connectionId, credentialId }) =>
      Effect.flatMap(userId, (id) =>
        writer
          .SetConnectionCredential({ userId: id, connectionId, credentialId })
          .pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], toServerError("SetConnectionCredential"))),
    ListCredentials: () =>
      Effect.flatMap(userId, (id) => reader.ListCredentials({ userId: id })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("ListCredentials"))
      ),
    CreateCredential: ({ name, apiKey, urls }) =>
      Effect.flatMap(userId, (id) => providers.createCredential({ userId: id, name, apiKey, urls })),
    RenameCredential: ({ credentialId, name }) =>
      Effect.flatMap(userId, (id) => writer.RenameCredential({ userId: id, credentialId, name })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("RenameCredential"))
      ),
    ReplaceCredentialKey: ({ credentialId, apiKey, urls }) =>
      Effect.flatMap(userId, (id) =>
        providers
          .replaceCredentialKey(id, credentialId, apiKey, urls)
          .pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ),
    AllowCredentialHost: ({ credentialId, apiKey, url }) =>
      Effect.flatMap(userId, (id) => providers.allowCredentialOrigin({ userId: id, credentialId, apiKey, url })),
    DeleteCredential: ({ credentialId }) =>
      Effect.flatMap(userId, (id) =>
        writer.DeleteCredential({ userId: id, credentialId }).pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], toServerError("DeleteCredential"))),
    UpdateConnection: ({ connectionId, settings, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer
          .UpdateConnection({ userId: id, connectionId, settings, expectedRowVersion })
          .pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], toServerError("UpdateConnection"))),
    SetConnectionKey: ({ connectionId, apiKey, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        providers
          .setKey(id, connectionId, apiKey, expectedRowVersion)
          .pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ),
    SetConnectionHeaders: ({ connectionId, headers, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        providers
          .setHeaders(id, connectionId, headers, expectedRowVersion)
          .pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ),
    SetConnectionProxy: ({ connectionId, mode, url }) =>
      Effect.flatMap(userId, (id) =>
        providers.setProxy(id, connectionId, mode, url).pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ),
    DeleteConnection: ({ connectionId }) =>
      Effect.flatMap(userId, (id) =>
        writer.DeleteConnection({ userId: id, connectionId }).pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], toServerError("DeleteConnection"))),
    TestConnection: ({ connectionId, modelId }) =>
      Effect.flatMap(userId, (id) => providers.testConnection(id, connectionId, modelId ?? null)).pipe(
        Effect.map(toConnectionTest)
      ),
    RefreshModels: ({ connectionId }) =>
      Effect.flatMap(userId, (id) =>
        providers.refreshModels(id, connectionId).pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ).pipe(Effect.map((result) => new ModelRefresh(result))),
    ListModels: ({ connectionId, includeHidden }) =>
      Effect.flatMap(userId, (id) => reader.ListModels({ userId: id, connectionId, includeHidden })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("ListModels"))
      ),
    ListModelUse: () =>
      Effect.flatMap(userId, (id) => reader.ListModelUse({ userId: id })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("ListModelUse"))
      ),
    AddUserModel: ({ connectionId, key, overrides }) =>
      Effect.flatMap(userId, (id) =>
        providers.catalogUpstream(id, connectionId, key).pipe(
          Effect.flatMap((upstream) => writer.AddUserModel({ userId: id, connectionId, key, overrides, upstream })),
          Effect.tap(() => warmth.refreshUser(id, true))
        )
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], toServerError("AddUserModel"))),
    SaveLearnedContext: ({ modelId, context }) =>
      Effect.flatMap(userId, (id) =>
        writer
          .SetLearnedContext({ userId: id, modelId, context, at: Date.now() })
          .pipe(Effect.tap(() => warmth.refreshUser(id, true)))
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], toServerError("SaveLearnedContext"))),
    EditModel: ({ modelId, overrides, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.EditModel({ userId: id, modelId, overrides, expectedRowVersion }).pipe(
          Effect.tap(() => warmth.refreshUser(id, true)),
          // A pin saved: its provider's prices are fetched now, off the save's path.
          Effect.tap((model) => Effect.forkDetach(providers.ensureEndpoints(id, model)))
        )
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], toServerError("EditModel"))),
    SetModelHidden: ({ modelId, hidden }) =>
      Effect.flatMap(userId, (id) => writer.SetModelHidden({ userId: id, modelId, hidden })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("SetModelHidden"))
      ),
    GetNetworkSettings: () =>
      admin.pipe(
        Effect.andThen(network.view),
        Effect.map((view) => new NetworkSettings(view))
      ),
    SetNetworkSettings: ({ proxyUrl, bypass, forceProxy }) =>
      admin.pipe(
        Effect.andThen(network.setInstance({ proxyUrl, bypass, forceProxy })),
        Effect.tap(() => warmth.refreshAll),
        Effect.map((view) => new NetworkSettings(view))
      ),
    ListLlmRequests: ({ limit, before }) =>
      Effect.flatMap(userId, (id) => reader.ListLlmRequests({ userId: id, limit, before })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("ListLlmRequests"))
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
