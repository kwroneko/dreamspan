// Display-only tokenization: assembly's scale gate keeps the inexpensive budget cut.
// Uses the assembler's replaceable local text counters; never a provider endpoint.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { UserId } from "@rp/shared/domain.ts"
import { TokenizerInfo } from "@rp/shared/generation.ts"
import type { Assembler } from "../assembler/assembler.ts"
import type { ModelInput } from "../assembler/types.ts"
import { withAssemblyModules } from "../assembler/modules.ts"
import { countTokens } from "../importer/tokenizer.ts"
import { calibrateText } from "../providers/textCalibration.ts"
import { TokenCountError } from "../providers/textCounters.ts"
import { readTextCalibration } from "./textCalibration.ts"

export const textDisplay = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  model: ModelInput | null,
  assembler: Assembler,
  texts: ReadonlyArray<string>,
  asOf?: number
) =>
  withAssemblyModules(
    assembler,
    Effect.gen(function* () {
      const target = { kind: model?.kind ?? "", api: model?.api ?? "", model: model?.key ?? "", baseUrl: "" }
      const counter = assembler.textCounters
        .list()
        .toReversed()
        .find((c) => !c.remote && c.appliesTo(target))
      const encode = (encoding: Parameters<typeof countTokens>[0], input: ReadonlyArray<string>) =>
        Effect.tryPromise({
          try: () => countTokens(encoding, input),
          catch: () => new TokenCountError({ message: "The local tokenizer failed." })
        })
      const raw = yield* (
        counter
          ? counter.count({
              ...target,
              texts,
              encode,
              apiKey: null,
              headers: {},
              fetch: (() => {
                throw new Error("Display counters cannot contact providers")
              }) as typeof globalThis.fetch,
              scrub: (s) => s
            })
          : encode("o200k_base", texts)
      ).pipe(
        Effect.map((counts) => ({
          counts,
          tokenizer: new TokenizerInfo({
            id: counter?.id ?? "approximate",
            label: counter?.label(target.model) ?? "o200k_base, as an approximation",
            exact: counter !== undefined
          })
        })),
        Effect.orElseSucceed(() => ({
          counts: texts.map((s) => Math.ceil(s.length / 4)),
          tokenizer: new TokenizerInfo({
            id: "estimate",
            label: "four characters a token",
            exact: false,
            note: "The tokenizer couldn't run."
          })
        }))
      )
      const calibration = model
        ? yield* readTextCalibration(sql, userId, model.connectionId, model.key, raw.tokenizer.id, asOf)
        : null
      return calibrateText(raw, calibration)
    })
  )
