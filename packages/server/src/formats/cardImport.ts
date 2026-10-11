// Card import: a file's bytes to our card document, the images it carries, and its import
// report. The format is detected from the bytes, never trusted from the file name.
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { ImportReport } from "@rp/shared/importReport.ts"
import type { Effect } from "effect"
import { cardFromJson } from "./card.ts"
import { attempt, defaultLimits, fail, type FormatError, Issues, type Limits, parseJson } from "./safety.ts"

/** A file that came with the card. `uri` is how the card's `assets` refer to it. */
export interface CardFile {
  readonly uri: string
  readonly ext: string
  readonly bytes: Uint8Array
}

export interface CardImport {
  readonly card: CardDoc
  readonly avatar: CardFile | null
  /** Embedded assets other than the avatar. */
  readonly assets: ReadonlyArray<CardFile>
  readonly report: ImportReport
}

export const importCard = (bytes: Uint8Array, limits: Limits = defaultLimits): Effect.Effect<CardImport, FormatError> =>
  attempt(() => {
    if (bytes.byteLength > limits.maxFileBytes) {
      fail("file.too_large", `The file is larger than ${limits.maxFileBytes} bytes.`)
    }
    const issues = new Issues()
    const { card, version } = cardFromJson(parseJson(bytes, limits, issues), issues)
    return {
      card,
      avatar: null,
      assets: [],
      report: new ImportReport({ format: `card-${version}-json`, issues: issues.list })
    }
  })
