import { TokenizerInfo } from "@rp/shared/generation.ts"

interface TextCalibration {
  readonly ratio: number
  readonly samples: number
}

/** Kept separate from cached raw counts: another reply immediately changes the correction. */
export const calibrateText = (
  counted: { readonly counts: ReadonlyArray<number>; readonly tokenizer: TokenizerInfo },
  calibration: TextCalibration | null
) =>
  calibration === null
    ? counted
    : {
        counts: counted.counts.map((n) => (n === 0 ? 0 : Math.ceil(n * calibration.ratio))),
        tokenizer: new TokenizerInfo({
          ...counted.tokenizer,
          exact: false,
          note: `${counted.tokenizer.note ? `${counted.tokenizer.note} ` : ""}Calibrated from ${calibration.samples} reported requests for this model.`
        })
      }
