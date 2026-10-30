// Which of the path's images a request sends, and why the others aren't (ARCHITECTURE §15).
import { Effect } from "effect"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ImageLeftOut } from "@rp/shared/inspectorApi.ts"
import { need, type AssemblerStage, type Assembly } from "./pipeline.ts"
import type { HistoryImage, RequestMessage } from "./types.ts"

/** Images every request carries at most when the model doesn't say (DESIGN §10.2a). */
export const DEFAULT_MAX_IMAGES = 4

/**
 * The images of `messages` a request to a model taking at most `max` sends: the newest ones,
 * as `${message}:${image}` positions. Replies, summaries and the stage below count the same.
 */
export const newestImages = (messages: ReadonlyArray<Pick<RequestMessage, "images">>, max: number) => {
  const kept = new Set<string>()
  let left = Math.max(0, Math.floor(max))
  for (let m = messages.length - 1; m >= 0 && left > 0; m--) {
    const images = messages[m]!.images ?? []
    for (let i = images.length - 1; i >= 0 && left > 0; i--, left--) kept.add(`${m}:${i}`)
  }
  return kept
}

/**
 * The history images a request message carries, in order, with the version each is of: those
 * of the message pieces it holds, less the ones the fork took out (`excluded`).
 */
export const messageImages = (assembly: Assembly, pieces: ReadonlyArray<number>) => {
  const byVersion = new Map(assembly.resolved?.map(({ entry }) => [entry.versionId, entry.images ?? []]))
  return pieces.flatMap((p) => {
    const source = assembly.pieces[p]?.source
    if (source?.kind !== "message") return []
    return (byVersion.get(source.version) ?? []).flatMap((image: HistoryImage, index) =>
      image.excluded ? [] : [{ version: source.version, index, image }]
    )
  })
}

/**
 * The `images` stage: every image of the path this request doesn't send, with the rule that
 * leaves it out, computed from the request the earlier stages built. A plugin's stage after
 * it can add its own (`<plugin>/<rule>`), or replace it.
 */
export const imagesStage: AssemblerStage = {
  id: "images",
  run: (assembly) =>
    Effect.sync(() => {
      const messages = need(assembly, "messages")
      const result = need(assembly, "result")
      const model = assembly.model
      const max = model?.maxImages ?? DEFAULT_MAX_IMAGES
      const newest = newestImages(result.messages, max)
      // Where each image the request carries is: its message and place there.
      const sent = new Map<string, string>()
      messages.forEach((message, m) =>
        messageImages(assembly, message.pieces).forEach(({ version, index }, i) =>
          sent.set(`${version}:${index}`, `${m}:${i}`)
        )
      )
      const images: Array<ImageLeftOut> = []
      for (const entry of assembly.history ?? []) {
        for (const [index, image] of (entry.images ?? []).entries()) {
          const at = sent.get(`${entry.versionId}:${index}`)
          const [rule, message] = image.excluded
            ? ["user", "Taken out of the context by you"]
            : !entry.inContext
              ? ["hidden", "Its message isn't sent to the model"]
              : at === undefined
                ? ["history", "Its message doesn't fit in this context"]
                : model?.vision === false
                  ? ["vision", `${model.key} can't see images`]
                  : !newest.has(at)
                    ? [
                        "limit",
                        max === 1
                          ? "Only the last image is sent to this model"
                          : `Only the last ${max} images are sent to this model`
                      ]
                    : [null, null]
          if (rule === null) continue
          images.push({
            slotId: entry.slotId as SlotId,
            versionId: entry.versionId as VersionId,
            mediaId: image.mediaId,
            depth: entry.depth,
            index,
            rule,
            message: message!
          })
        }
      }
      const ranges: Array<NonNullable<Assembly["imagesLeftOut"]>["ranges"][number]> = []
      const summarized = assembly.lcm?.cursorDepth ?? -1
      if (summarized >= 0) ranges.push({ from: 0, to: summarized, rule: "summary", message: "Covered by a summary" })
      const first = assembly.history?.[0]?.depth ?? need(assembly, "target").depth
      if ((assembly.historyOmitted ?? 0) > 0 && first - 1 > summarized)
        ranges.push({
          from: summarized + 1,
          to: first - 1,
          rule: "history",
          message: "Its message doesn't fit in this context"
        })
      assembly.imagesLeftOut = { images, ranges }
      return assembly
    })
}
