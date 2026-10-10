// Typed provider errors (spec/PROVIDERS.md §7.1). Classified from pi-ai's final message,
// the HTTP status seen by onResponse, and pi-ai's own overflow and retry checks, rather
// than tagged inside error strings as reference-harness must do under pi-agent-core.
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow"
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry"
import { ProviderError, type ProviderErrorReason } from "@rp/shared/errors.ts"

export { ProviderError, ProviderErrorReason } from "@rp/shared/errors.ts"

export const providerError = (
  reason: ProviderErrorReason,
  message: string,
  extra: Partial<Pick<ProviderError, "status" | "retryAfterMs" | "category" | "afterTokens">> = {}
) =>
  new ProviderError({
    reason,
    message,
    status: extra.status ?? null,
    retryAfterMs: extra.retryAfterMs ?? null,
    category: extra.category ?? null,
    afterTokens: extra.afterTokens ?? false
  })

/** Retrying these before any output is safe; anything else needs the user. */
export const RETRYABLE: ReadonlySet<ProviderErrorReason> = new Set(["rate_limited", "overloaded", "network"])

const REFUSAL_STOPS = new Set(["refusal", "content_filter", "safety", "SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"])

const NETWORK_PATTERN =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|terminated|other side closed/i

/** Parses Retry-After: seconds, or an HTTP date. */
export const parseRetryAfter = (value: string | undefined, now = Date.now()): number | null => {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

/** The typed error for a failed request, or null if it succeeded. */
export const classify = (
  message: AssistantMessage,
  seen: { readonly status: number | null; readonly retryAfterMs: number | null; readonly category: string | null },
  contextWindow: number,
  afterTokens: boolean
): ProviderError | null => {
  const text = message.errorMessage ?? message.rawStopReason ?? "request failed"
  const extra = { status: seen.status, retryAfterMs: seen.retryAfterMs, category: seen.category, afterTokens }
  if (message.stopReason === "aborted") return providerError("aborted", text, extra)
  if (message.rawStopReason && REFUSAL_STOPS.has(message.rawStopReason)) {
    return providerError("refused", text, extra)
  }
  if (message.stopReason !== "error") {
    // Some providers accept an overflowing request and report it only through usage.
    return isContextOverflow(message, contextWindow) ? providerError("context_overflow", text, extra) : null
  }
  if (isContextOverflow(message, contextWindow)) return providerError("context_overflow", text, extra)
  const status = seen.status ?? Number(/^(\d{3})\b/.exec(text)?.[1] ?? NaN)
  const known = Number.isNaN(status) ? null : status
  const withStatus = { ...extra, status: known }
  if (known === 401 || known === 403) return providerError("auth", text, withStatus)
  if (known === 429 || (known === 503 && seen.retryAfterMs !== null))
    return providerError("rate_limited", text, withStatus)
  if (known !== null && [500, 502, 503, 504, 529].includes(known)) return providerError("overloaded", text, withStatus)
  if (known !== null && known >= 400 && known < 500) return providerError("bad_request", text, withStatus)
  if (NETWORK_PATTERN.test(text)) return providerError("network", text, withStatus)
  if (isRetryableAssistantError(message)) return providerError("overloaded", text, withStatus)
  return providerError("unknown", text, withStatus)
}
