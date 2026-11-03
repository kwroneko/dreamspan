/** UI sizes use binary multiples, labelled MB/GB consistently with the existing limits. */
export const SIZE_UNITS = { MB: 1024 ** 2, GB: 1024 ** 3 } as const
const digits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

/** A one-decimal size that converts back to the same whole-byte count. */
export function decimalSizeValue(bytes: number, unit: keyof typeof SIZE_UNITS): number | null {
  const value = Math.round((bytes / SIZE_UNITS[unit]) * 10) / 10
  return value > 0 && Math.round(value * SIZE_UNITS[unit]) === bytes ? value : null
}

/** Compact read-only sizes, from small files through whole-folder imports. */
export function formatByteSize(bytes: number): string {
  const unit =
    decimalSizeValue(bytes, "GB") !== null || bytes >= SIZE_UNITS.GB
      ? "GB"
      : decimalSizeValue(bytes, "MB") !== null || bytes >= SIZE_UNITS.MB
        ? "MB"
        : bytes >= 1024
          ? "KB"
          : "B"
  const divisor = unit === "B" ? 1 : unit === "KB" ? 1024 : SIZE_UNITS[unit]
  return `${digits.format(bytes / divisor)} ${unit}`
}
