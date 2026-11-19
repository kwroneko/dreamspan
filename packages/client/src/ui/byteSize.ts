import { decimalSizeValue, SIZE_UNITS } from "@dreamspan/shared/byteSize.ts"

export type SizeUnit = keyof typeof SIZE_UNITS

/** Prefer GB when one decimal converts back to the saved whole-byte count.
 * Keep all MB precision for older arbitrary-byte limits, so opening and saving never loses data.
 */
export function editableByteSize(bytes: number): { text: string; unit: SizeUnit } {
  const gb = decimalSizeValue(bytes, "GB")
  const unit = gb !== null ? "GB" : "MB"
  const decimal = gb ?? decimalSizeValue(bytes, "MB")
  return {
    text:
      decimal !== null
        ? String(decimal)
        : (bytes / SIZE_UNITS.MB).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }),
    unit
  }
}

/** Refuse empty, negative, non-finite and unsafe limits. */
export function parseByteSize(text: string, unit: SizeUnit): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null
  const bytes = Number(text) * SIZE_UNITS[unit]
  // Decimal GB amounts can land between bytes; store the nearest byte.
  const rounded = Math.round(bytes)
  return Number.isSafeInteger(rounded) && rounded >= 1 ? rounded : null
}
