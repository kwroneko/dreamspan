// What the connection's price endpoint answered last (spec/PRICES.md §4.5, §7), under the
// "Fetch prices from this server" switch of a saved connection that has it on.
import { useAtomValue } from "@effect/atom-react"
import type { ConnectionId, PriceFeedState } from "@dreamspan/shared/providers.ts"
import { AsyncResult } from "effect/reactivity"
import { useMemo } from "react"
import { AppClient } from "../../rpc.ts"

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

/** The state in a sentence; exported for its unit test. */
export const priceFeedText = (state: PriceFeedState | null) => {
  if (state === null) return "Not asked yet. Prices are asked for when you refresh models."
  const when = timeFormat.format(state.at)
  switch (state.state) {
    case "supported":
      return `Prices fetched ${when}.`
    case "unsupported":
      return "This server doesn’t publish prices. It’s asked again when you refresh models."
    case "denied":
      return "This server didn’t accept the key for prices. The app’s prices apply."
    case "failed":
      return `Prices couldn’t be fetched (${when}). The last prices stay in use, and it’s tried again soon.`
  }
}

export function PriceFeedStatus({ connectionId }: { connectionId: ConnectionId }) {
  const atom = useMemo(
    () => AppClient.query("GetPriceFeedState", { connectionId }, { reactivityKeys: ["models", "connections"] }),
    [connectionId]
  )
  const result = useAtomValue(atom)
  if (!AsyncResult.isSuccess(result)) return null
  return (
    <p className="text-sm text-muted" data-price-feed={result.value?.state ?? "none"}>
      {priceFeedText(result.value)}
    </p>
  )
}
