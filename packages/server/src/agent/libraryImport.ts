// The workshop's file import (spec/WORKSHOP.md §3.2): the library page's own steps, a file parsed
// in a format worker and stored by the writer's `ImportFile`, for text the assistant was given.
// Nothing is fetched and nothing is sent anywhere: the text is read, and one new entry is saved.
import { CurrentUser } from "@rp/shared/api.ts"
import { HistoryRejected } from "@rp/shared/historyApi.ts"
import { Effect, Schema } from "effect"
import { makeCommand, type Command } from "../commands.ts"
import { Writer } from "../db/Database.ts"
import { Formats } from "../importer/Formats.ts"
import type { Registry } from "../registry.ts"
import { OperationCall } from "./operations.ts"

const refuse = (message: string) => new HistoryRejected({ message })
/** A file name as an upload's is taken: no folders or control characters, bounded. */
const fileNameFrom = (raw: string) =>
  raw
    .replace(/\p{Cc}+/gu, "")
    .split(/[/\\]/)
    .pop()!
    .slice(0, 255)

export const installLibraryImport = (commands: Registry<Command>) =>
  Effect.gen(function* () {
    const formats = yield* Formats
    // The writer itself: the call below is already the receipted workshop operation.
    const writer = yield* Writer
    yield* commands.register(
      makeCommand({
        id: "library.import",
        description: "Import one card, preset or lorebook from a file's text as a new library entry.",
        input: Schema.Struct({ name: Schema.String, content: Schema.String }),
        output: Schema.Unknown,
        execute: ({ name, content }) =>
          Effect.gen(function* () {
            const call = yield* OperationCall
            const user = yield* CurrentUser
            if (!call) return yield* refuse("This command needs a workshop call.")
            const fileName = fileNameFrom(name)
            const parsed = yield* formats
              .parse(new TextEncoder().encode(content), fileName)
              .pipe(Effect.mapError(() => refuse("The file could not be read. Check that it is whole.")))
            if (parsed.library === null) return { report: parsed.report, library: null }
            if (parsed.media.length > 0)
              return yield* refuse("This file carries pictures or other files. Import it from the library page.")
            // Where the card says it came from stays unread: no card source is linked here.
            const { links: _links, ...library } = parsed.library
            const saved = yield* writer
              .RunWorkshopOperation({
                ...call,
                userId: user.id,
                operation: "ImportFile",
                payload: {
                  userId: user.id,
                  intoRefId: null,
                  ...library,
                  sourceName: fileName,
                  sourceHash: parsed.sha256,
                  media: []
                }
              })
              .pipe(
                Effect.mapError((error) =>
                  refuse(
                    error._tag === "EffectUndoRefused"
                      ? error.message
                      : error._tag === "InvalidDocument"
                        ? error.problems.join("; ")
                        : "The file could not be imported. Try again."
                  )
                )
              )
            return { report: parsed.report, library: saved }
          })
      })
    )
  })
