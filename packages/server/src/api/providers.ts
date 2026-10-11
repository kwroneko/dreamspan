// Client RPC handlers for connections, models, network settings and usage
// (spec/PROVIDERS.md). Every handler acts as the authenticated user; storage enforces
// ownership, so another user's ids are NotFound.
import { type AppApi, ConnectionTest, CurrentUser, ModelRefresh, NetworkSettings } from "@rp/shared/api.ts"
import { Forbidden, ServerError } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { Network } from "../net/Network.ts"
import { Providers } from "../providers/Providers.ts"

/** Failures the client can't act on are logged here and reported without internals. */
const toServerError = (operation: string) => (error: unknown) =>
  Effect.logError(`${operation} failed`, error).pipe(
    Effect.andThen(Effect.fail(new ServerError({ message: `${operation} failed` })))
  )

const admin = Effect.gen(function* () {
  const user = yield* CurrentUser
  if (user.role !== "admin") return yield* new Forbidden({ message: "only an admin can change instance settings" })
  return user
})

export const makeProviderHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const providers = yield* Providers
  const network = yield* Network

  const userId = Effect.map(CurrentUser, (user) => user.id)

  const handlers = {
    ListProviderKinds: () => Effect.sync(() => providers.kinds()),
    ListConnections: () =>
      Effect.flatMap(userId, (id) => reader.ListConnections({ userId: id })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("ListConnections"))
      ),
    CreateConnection: ({ kind, settings, apiKey, credentialId }) =>
      Effect.flatMap(userId, (id) =>
        providers.createConnection({
          userId: id,
          kind,
          settings,
          apiKey: apiKey ?? null,
          credentialId: credentialId ?? null
        })
      ),
    SetConnectionCredential: ({ connectionId, credentialId }) =>
      Effect.flatMap(userId, (id) => writer.SetConnectionCredential({ userId: id, connectionId, credentialId })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("SetConnectionCredential"))
      ),
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
      Effect.flatMap(userId, (id) => providers.replaceCredentialKey(id, credentialId, apiKey, urls)),
    AllowCredentialHost: ({ credentialId, apiKey, url }) =>
      Effect.flatMap(userId, (id) => providers.allowCredentialOrigin({ userId: id, credentialId, apiKey, url })),
    DeleteCredential: ({ credentialId }) =>
      Effect.flatMap(userId, (id) => writer.DeleteCredential({ userId: id, credentialId })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("DeleteCredential"))
      ),
    UpdateConnection: ({ connectionId, settings, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.UpdateConnection({ userId: id, connectionId, settings, expectedRowVersion })
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], toServerError("UpdateConnection"))),
    SetConnectionKey: ({ connectionId, apiKey, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) => providers.setKey(id, connectionId, apiKey, expectedRowVersion)),
    SetConnectionHeaders: ({ connectionId, headers, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) => providers.setHeaders(id, connectionId, headers, expectedRowVersion)),
    SetConnectionProxy: ({ connectionId, mode, url }) =>
      Effect.flatMap(userId, (id) => providers.setProxy(id, connectionId, mode, url)),
    DeleteConnection: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => writer.DeleteConnection({ userId: id, connectionId })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("DeleteConnection"))
      ),
    TestConnection: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => providers.testConnection(id, connectionId)).pipe(
        Effect.map((result) => new ConnectionTest(result))
      ),
    RefreshModels: ({ connectionId }) =>
      Effect.flatMap(userId, (id) => providers.refreshModels(id, connectionId)).pipe(
        Effect.map((result) => new ModelRefresh(result))
      ),
    ListModels: ({ connectionId, includeHidden }) =>
      Effect.flatMap(userId, (id) => reader.ListModels({ userId: id, connectionId, includeHidden })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("ListModels"))
      ),
    AddUserModel: ({ connectionId, key, overrides }) =>
      Effect.flatMap(userId, (id) => writer.AddUserModel({ userId: id, connectionId, key, overrides })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("AddUserModel"))
      ),
    EditModel: ({ modelId, overrides, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) => writer.EditModel({ userId: id, modelId, overrides, expectedRowVersion })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("EditModel"))
      ),
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
        Effect.map((view) => new NetworkSettings(view))
      ),
    ListLlmRequests: ({ limit, before }) =>
      Effect.flatMap(userId, (id) => reader.ListLlmRequests({ userId: id, limit, before })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], toServerError("ListLlmRequests"))
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
