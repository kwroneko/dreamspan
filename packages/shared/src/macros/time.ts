// Moment.js formatting and humanizing in the "en" locale, for ST's time macros. ST formats
// with moment 2.30; this follows its sources (src/lib/format/format.js, the unit tokens,
// src/lib/duration/humanize.js and as.js) without the dependency. Week-based tokens (w, W,
// gg, GG, e, E) and era tokens (N, y) aren't supported and come out literally.

/** A point in time as seen in one time zone: `wall` holds the local time in UTC fields. */
export interface WallTime {
  readonly instant: number
  readonly wall: number
  /** Minutes east of UTC. */
  readonly offset: number
  /** moment's UTC mode, which only changes the `z` token. */
  readonly utc: boolean
}

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterFor = (timeZone: string) => {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** The time in an IANA zone. An unknown zone is treated as UTC. */
export const inZone = (instant: number, timeZone: string): WallTime => {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = formatterFor(timeZone)
  } catch {
    formatter = formatterFor("UTC")
  }
  const parts: Record<string, number> = {}
  for (const part of formatter.formatToParts(instant)) parts[part.type] = Number(part.value)
  const ms = ((instant % 1000) + 1000) % 1000
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!, ms)
  return { instant, wall, offset: Math.round((wall - instant) / 60000), utc: false }
}

/** moment().utc().utcOffset(offset): offsets under 16 are hours, others minutes. */
export const atOffset = (instant: number, offset: number): WallTime => {
  const minutes = Math.abs(offset) < 16 ? offset * 60 : offset
  return { instant, wall: instant + minutes * 60000, offset: minutes, utc: true }
}

const MONTHS = "January February March April May June July August September October November December".split(" ")
const WEEKDAYS = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ")

const pad = (n: number, length: number, forceSign = false) => {
  const digits = String(Math.abs(n))
  return (n >= 0 ? (forceSign ? "+" : "") : "-") + "0".repeat(Math.max(0, length - digits.length)) + digits
}

const ordinal = (n: number) => {
  const b = n % 10
  const suffix = Math.trunc((n % 100) / 10) === 1 ? "th" : b === 1 ? "st" : b === 2 ? "nd" : b === 3 ? "rd" : "th"
  return `${n}${suffix}`
}

const zone = (offset: number, separator: string) => {
  const abs = Math.abs(offset)
  return (offset < 0 ? "-" : "+") + pad(Math.trunc(abs / 60), 2) + separator + pad(abs % 60, 2)
}

type TokenFormat = (t: WallTime, d: Date) => string

const hour12 = (d: Date) => d.getUTCHours() % 12 || 12
const dayOfYear = (d: Date) =>
  Math.round(
    (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5
  ) + 1
const fraction = (digits: number) => (_: WallTime, d: Date) =>
  pad(Math.trunc(d.getUTCMilliseconds() * 10 ** (digits - 3)), digits)

// In the order of moment's `formattingTokens` alternation, which picks the first match.
const TOKENS: ReadonlyArray<readonly [string, TokenFormat]> = [
  ["Hmmss", (_, d) => `${d.getUTCHours()}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`],
  ["Hmm", (_, d) => `${d.getUTCHours()}${pad(d.getUTCMinutes(), 2)}`],
  ["hmmss", (_, d) => `${hour12(d)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`],
  ["hmm", (_, d) => `${hour12(d)}${pad(d.getUTCMinutes(), 2)}`],
  ["Mo", (_, d) => ordinal(d.getUTCMonth() + 1)],
  ["MMMM", (_, d) => MONTHS[d.getUTCMonth()]!],
  ["MMM", (_, d) => MONTHS[d.getUTCMonth()]!.slice(0, 3)],
  ["MM", (_, d) => pad(d.getUTCMonth() + 1, 2)],
  ["M", (_, d) => String(d.getUTCMonth() + 1)],
  ["Do", (_, d) => ordinal(d.getUTCDate())],
  ["DDDo", (_, d) => ordinal(dayOfYear(d))],
  ["DDDD", (_, d) => pad(dayOfYear(d), 3)],
  ["DDD", (_, d) => String(dayOfYear(d))],
  ["DD", (_, d) => pad(d.getUTCDate(), 2)],
  ["D", (_, d) => String(d.getUTCDate())],
  ["dddd", (_, d) => WEEKDAYS[d.getUTCDay()]!],
  ["ddd", (_, d) => WEEKDAYS[d.getUTCDay()]!.slice(0, 3)],
  ["dd", (_, d) => WEEKDAYS[d.getUTCDay()]!.slice(0, 2)],
  ["do", (_, d) => ordinal(d.getUTCDay())],
  ["d", (_, d) => String(d.getUTCDay())],
  ["Qo", (_, d) => ordinal(Math.ceil((d.getUTCMonth() + 1) / 3))],
  ["Q", (_, d) => String(Math.ceil((d.getUTCMonth() + 1) / 3))],
  ["YYYYYY", (_, d) => pad(d.getUTCFullYear(), 6, true)],
  ["YYYYY", (_, d) => pad(d.getUTCFullYear(), 5)],
  ["YYYY", (_, d) => pad(d.getUTCFullYear(), 4)],
  ["YY", (_, d) => pad(d.getUTCFullYear() % 100, 2)],
  ["a", (_, d) => (d.getUTCHours() > 11 ? "pm" : "am")],
  ["A", (_, d) => (d.getUTCHours() > 11 ? "PM" : "AM")],
  ["hh", (_, d) => pad(hour12(d), 2)],
  ["h", (_, d) => String(hour12(d))],
  ["HH", (_, d) => pad(d.getUTCHours(), 2)],
  ["H", (_, d) => String(d.getUTCHours())],
  ["kk", (_, d) => pad(d.getUTCHours() || 24, 2)],
  ["k", (_, d) => String(d.getUTCHours() || 24)],
  ["mm", (_, d) => pad(d.getUTCMinutes(), 2)],
  ["m", (_, d) => String(d.getUTCMinutes())],
  ["ss", (_, d) => pad(d.getUTCSeconds(), 2)],
  ["s", (_, d) => String(d.getUTCSeconds())],
  ...[9, 8, 7, 6, 5, 4, 3].map((n) => ["S".repeat(n), fraction(n)] as const),
  ["SS", (_, d) => pad(Math.trunc(d.getUTCMilliseconds() / 10), 2)],
  ["S", (_, d) => String(Math.trunc(d.getUTCMilliseconds() / 100))],
  ["x", (t) => String(t.instant)],
  ["X", (t) => String(Math.floor(t.instant / 1000))],
  ["zz", (t) => (t.utc ? "UTC" : "")],
  ["z", (t) => (t.utc ? "UTC" : "")],
  ["ZZ", (t) => zone(t.offset, "")],
  ["Z", (t) => zone(t.offset, ":")],
  ["Y", (_, d) => (d.getUTCFullYear() <= 9999 ? pad(d.getUTCFullYear(), 4) : `+${d.getUTCFullYear()}`)]
]

const LONG_FORMATS: Readonly<Record<string, string>> = {
  LTS: "h:mm:ss A",
  LT: "h:mm A",
  L: "MM/DD/YYYY",
  LL: "MMMM D, YYYY",
  LLL: "MMMM D, YYYY h:mm A",
  LLLL: "dddd, MMMM D, YYYY h:mm A",
  l: "M/D/YYYY",
  ll: "MMM D, YYYY",
  lll: "MMM D, YYYY h:mm A",
  llll: "ddd, MMM D, YYYY h:mm A"
}
const LONG_TOKENS = ["LTS", "LT", "LLLL", "LLL", "LL", "L", "llll", "lll", "ll", "l"]

/** Where a `[literal]` starting at `i` ends (after "]"), or -1 if there's none. */
const bracketEnd = (format: string, i: number) => {
  for (let j = i + 1; j < format.length; j++) {
    if (format[j] === "]") return j + 1
    if (format[j] === "[") return -1
  }
  return -1
}

/** moment's expandFormat: replaces long-date tokens, skipping literals and escapes. */
const expandLong = (format: string) => {
  let out = ""
  for (let i = 0; i < format.length;) {
    const end = format[i] === "[" ? bracketEnd(format, i) : -1
    if (end > 0) {
      out += format.slice(i, end)
      i = end
      continue
    }
    const escaped = format[i] === "\\" ? 1 : 0
    const token = LONG_TOKENS.find((t) => format.startsWith(t, i + escaped))
    if (token && !escaped) {
      out += LONG_FORMATS[token]
      i += token.length
    } else {
      const length = escaped + (token?.length ?? 1)
      out += format.slice(i, i + length)
      i += length
    }
  }
  return out
}

/** moment().format(format) in the "en" locale. */
export const formatMoment = (t: WallTime, format: string): string => {
  const date = new Date(t.wall)
  const expanded = expandLong(format)
  let out = ""
  for (let i = 0; i < expanded.length;) {
    const end = expanded[i] === "[" ? bracketEnd(expanded, i) : -1
    if (end > 0) {
      out += expanded.slice(i + 1, end - 1)
      i = end
      continue
    }
    const escaped = expanded[i] === "\\" ? 1 : 0
    const token = TOKENS.find(([name]) => expanded.startsWith(name, i + escaped))
    const length = token ? token[0].length : 1
    if (token && !escaped) out += token[1](t, date)
    else out += expanded.slice(i + escaped, i + escaped + length)
    i += escaped + length
  }
  return out
}

const RELATIVE: Readonly<Record<string, string>> = {
  s: "a few seconds",
  m: "a minute",
  mm: "%d minutes",
  h: "an hour",
  hh: "%d hours",
  d: "a day",
  dd: "%d days",
  M: "a month",
  MM: "%d months",
  y: "a year",
  yy: "%d years"
}

/** moment.duration(ms).humanize(withSuffix), with moment's default thresholds. */
export const humanize = (ms: number, withSuffix: boolean): string => {
  if (!Number.isFinite(ms)) return "Invalid date"
  const abs = Math.abs(ms)
  const seconds = Math.round(abs / 1000)
  const minutes = Math.round(abs / 6e4)
  const hours = Math.round(abs / 36e5)
  const days = Math.round(abs / 864e5)
  const months = Math.round(((abs / 864e5) * 4800) / 146097)
  const years = Math.round(((abs / 864e5) * 4800) / 146097 / 12)
  const [key, n]: readonly [string, number] =
    seconds <= 44
      ? ["s", seconds]
      : minutes <= 1
        ? ["m", minutes]
        : minutes < 45
          ? ["mm", minutes]
          : hours <= 1
            ? ["h", hours]
            : hours < 22
              ? ["hh", hours]
              : days <= 1
                ? ["d", days]
                : days < 26
                  ? ["dd", days]
                  : months <= 1
                    ? ["M", months]
                    : months < 11
                      ? ["MM", months]
                      : years <= 1
                        ? ["y", years]
                        : ["yy", years]
  const text = RELATIVE[key]!.replace("%d", String(n))
  if (!withSuffix) return text
  return ms > 0 ? `in ${text}` : `${text} ago`
}

const ISO = /^\s*(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d)(?::(\d\d)(?::(\d\d)(?:[.,](\d+))?)?)?)?\s*(Z|[+-]\d\d(?::?\d\d)?)?$/

/**
 * moment(text) as a timestamp, for differences between two of them: ISO 8601 dates without
 * an offset are read as UTC, anything else falls back to Date.parse as moment does.
 */
export const parseMoment = (text: string): number => {
  const m = ISO.exec(text)
  if (!m) return Date.parse(text)
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0
  const local = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), ms)
  const tz = m[8]
  if (!tz || tz === "Z") return local
  const digits = tz.replace(":", "")
  const offset = (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5) || 0)) * (tz[0] === "-" ? -1 : 1)
  return local - offset * 60000
}
