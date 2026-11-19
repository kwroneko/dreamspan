// The file manager's RPCs (filesApi.ts; spec/FILES-AND-ENVIRONMENT.md §8.2): the editor's unsaved
// edits as `file` drafts of the user's own paths. The bytes go over the HTTP routes (files/routes.ts).
import { CurrentUser } from "@dreamspan/shared/api.ts"
import { TextTooLong } from "@dreamspan/shared/composerApi.ts"
import { fileDraftKey } from "@dreamspan/shared/drafts.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { FILES_TOP } from "@dreamspan/shared/files.ts"
import type { FilesApi } from "@dreamspan/shared/filesApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { DraftTooLarge } from "../db/ops.ts"
import { resolveFilesPath } from "../files/environment.ts"
import { internal } from "./internal.ts"

/** A path of the user's Files, as the tools and routes spell it; anything else names nothing. */
const filePath = (path: string) =>
  Effect.try({
    try: () => resolveFilesPath(path, FILES_TOP),
    catch: () => new NotFound({ entity: "file", id: path })
  }).pipe(
    Effect.flatMap(({ full, segments }) =>
      segments.length === 0 || full !== path
        ? Effect.fail(new NotFound({ entity: "file", id: path }))
        : Effect.succeed(full)
    )
  )

export const makeFilesHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  return {
    GetFileDraft: ({ path }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const full = yield* filePath(path)
        return yield* reader.GetDraft({ userId: user.id, key: fileDraftKey(full) })
      }).pipe(internal("GetFileDraft")),
    SaveFileDraft: ({ path, baseSha256, ...save }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const full = yield* filePath(path)
        return yield* writer.SaveDraft({ userId: user.id, key: fileDraftKey(full), ...save, baseRevision: baseSha256 })
      }).pipe(
        Effect.catchIf(
          (error): error is DraftTooLarge => error instanceof DraftTooLarge,
          ({ length, max }) => Effect.fail(new TextTooLong({ length, max }))
        ),
        internal("SaveFileDraft")
      ),
    EndFileDraft: ({ path, draftId, expectedRowVersion, outcome }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const full = yield* filePath(path)
        return yield* writer.ClearDraft({
          userId: user.id,
          key: fileDraftKey(full),
          draftId,
          outcome,
          expectedRowVersion
        })
      }).pipe(internal("EndFileDraft"))
  } satisfies Parameters<typeof FilesApi.of>[0]
})
