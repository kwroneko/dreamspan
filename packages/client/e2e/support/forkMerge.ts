// Synthetic library forks with parent changes since the fork, for the merge review specs.
import type { APIRequestContext } from "@playwright/test"
import { textField, valueField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { asUser, type Client } from "./rpc.ts"
import { ADMIN, type TestServer } from "./server.ts"

type Path = ReadonlyArray<string | number>

/** Saves one field as a revision, as the editor would: a draft, then a commit. */
export const saveField = (api: Client, refId: RefId, path: Path, content: unknown) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId })
    const text = typeof content === "string"
    const draft = yield* api.SaveEditorDraft({
      refId,
      field: text ? textField(path) : valueField(path),
      content: text ? content : JSON.stringify(content),
      draftId: null,
      expectedSession: null,
      expectedRowVersion: null,
      baseRevisionId: opened.ref.headRevisionId
    })
    return yield* api.CommitEditorDrafts({
      refId,
      expectedRowVersion: opened.ref.rowVersion,
      fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
      message: null
    })
  })

/** Leaves an unsaved field on the ref (a draft), the state a merge refuses. */
export const draftField = (api: Client, refId: RefId, path: Path, content: string) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId })
    return yield* api.SaveEditorDraft({
      refId,
      field: textField(path),
      content,
      draftId: null,
      expectedSession: null,
      expectedRowVersion: null,
      baseRevisionId: opened.ref.headRevisionId
    })
  })

export const importFile = async (request: APIRequestContext, server: TestServer, name: string, doc: unknown) => {
  const response = await request.post(`${server.url}/library/import?name=${encodeURIComponent(name)}`, {
    headers: { "content-type": "application/octet-stream", origin: server.url },
    data: Buffer.from(JSON.stringify(doc))
  })
  if (response.status() !== 200) throw new Error(`import ${name}: ${response.status()} ${await response.text()}`)
  return (await response.json()).library.ref as { id: RefId; label: string; entityId: string }
}

export const book = (name: string, entries: ReadonlyArray<{ uid: number; comment: string; content: string }>) => ({
  name,
  entries: Object.fromEntries(entries.map((e) => [e.uid, { ...e, key: [e.comment.toLowerCase()] }]))
})

/**
 * A preset "Harbour style" and its fork "Harbour style (night)": since the fork the parent
 * rewrote Main (a conflict with the fork's own edit), changed the jailbreak (clean), added a
 * prompt and moved one; the fork added its own prompt. Two parent revisions after the fork.
 */
export const seedPresetFork = (server: TestServer, suffix = "") =>
  asUser(server, ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const parent = yield* api.CreatePreset({ label: `Harbour style${suffix}` })
      yield* saveField(api, parent.id, ["prompts", "identifier=main", "content"], "Write {{char}}'s next reply.")
      const fork = yield* api.ForkVariant({
        refId: parent.id,
        label: `Harbour style (night)${suffix}`,
        subtitle: "",
        moveDrafts: false
      })
      yield* saveField(api, fork.id, ["prompts", "identifier=main", "content"], "Write {{char}}'s next reply at night.")
      yield* saveField(
        api,
        parent.id,
        ["prompts", "identifier=main", "content"],
        "Write {{char}}'s next reply in the harbour."
      )
      yield* saveField(
        api,
        parent.id,
        ["prompts", "identifier=jailbreak", "content"],
        "Stay in character; never speak for {{user}}."
      )
      return { parent, fork }
    })
  )
