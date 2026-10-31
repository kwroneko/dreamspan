// Address lists whose entries may be host names besides IPs and CIDR ranges
// (TRUSTED_PROXIES, ALLOWED_IPS). A container's address changes when it restarts, and its
// name doesn't: a list of addresses alone turned every request away after the proxy moved.
//
// Names are resolved at startup and again in the background, never on a connection: the
// gate only reads the current set. The set fails closed, since everyone it admits is
// trusted (in proxy mode, anyone who can connect can send the identity header):
// - A name that doesn't resolve admits nothing.
// - A successful resolution replaces the name's addresses at once, so an address the
//   proxy left, which the network may hand to another container, stops being trusted.
// - When the resolver can't answer at all (a timeout, a resolver that's down), the last
//   addresses are kept for STALE_AFTER and then dropped. Five minutes is ten background
//   attempts: a resolver restart or a short outage doesn't lock everyone out, and an
//   address nobody can confirm doesn't stay trusted for long.
import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import { Clock, Context, Duration, Effect, Latch } from "effect"
import { addAddressRange } from "./addresses.ts"

/**
 * Every address `name` has (its A and AAAA records). An empty list means the name doesn't
 * exist; a failure means the resolver couldn't answer, so the last answer may stand.
 */
export type Resolve = (name: string) => Promise<ReadonlyArray<string>>

const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA"])

/** getaddrinfo, as everything else on the host resolves: /etc/hosts, then Docker's or the system's DNS. */
export const AddressResolver = Context.Reference<Resolve>("rp/AddressResolver", {
  defaultValue: () => (name) =>
    lookup(name, { all: true, verbatim: true }).then(
      (found) => found.map((entry) => entry.address),
      (error: NodeJS.ErrnoException) => (NOT_FOUND.has(error.code ?? "") ? [] : Promise.reject(error))
    )
})

/** How often names are resolved again. */
export const REFRESH_EVERY = Duration.seconds(30)
/** The least time between two resolutions, when connections from unknown addresses ask for one. */
export const REFRESH_SOON = Duration.seconds(5)
/** How long a name's last addresses stand while the resolver can't answer. */
export const STALE_AFTER = Duration.minutes(5)
const LOOKUP_TIMEOUT = Duration.seconds(5)

const HOST_NAME = /^(?=.{1,253}\.?$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.?$/
/** A name, not a malformed address: like URLs, a last label of digits only is an IPv4 attempt. */
const isHostName = (entry: string) => HOST_NAME.test(entry) && !/(^|\.)\d+\.?$/.test(entry)

export interface AddressSet {
  /** The entries as configured, trimmed and without blanks. */
  readonly entries: ReadonlyArray<string>
  /** Entries that are neither an IP, a CIDR range nor a host name. */
  readonly invalid: ReadonlyArray<string>
  /** Whether `ip` is in the set now. Only reads: safe on every connection. */
  readonly has: (ip: string) => boolean
  /** The entries with what each name resolves to now, for logs. */
  readonly describe: () => string
  /** Resolves the names again soon, at most once every REFRESH_SOON. */
  readonly refreshSoon: () => void
}

/**
 * The set for `entries`, with its names resolved once before it's returned, then kept
 * fresh by a fiber that lives as long as the scope. `label` names the setting in logs.
 */
export const makeAddressSet = (label: string, raw: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const resolve = yield* AddressResolver
    const entries = raw.map((entry) => entry.trim()).filter((entry) => entry !== "")
    const literals: Array<string> = []
    const names: Array<string> = []
    const invalid: Array<string> = []
    for (const entry of entries) {
      const lower = entry.toLowerCase()
      const kind = addAddressRange(new BlockList(), lower)
      if (kind === "added") literals.push(lower)
      else if (kind === "other" && isHostName(lower)) names.push(lower.replace(/\.$/, ""))
      else invalid.push(entry)
    }
    const resolved = new Map<string, { readonly addresses: ReadonlyArray<string>; readonly at: number }>()
    const failing = new Set<string>()

    let current = new BlockList()
    const rebuild = () => {
      const list = new BlockList()
      for (const literal of literals) addAddressRange(list, literal)
      for (const { addresses } of resolved.values()) for (const address of addresses) addAddressRange(list, address)
      current = list
    }
    rebuild()

    const resolveName = (name: string) =>
      Effect.tryPromise(() => resolve(name)).pipe(
        Effect.timeoutOption(LOOKUP_TIMEOUT),
        Effect.map((found) =>
          found._tag === "Some" ? found.value.filter((address) => isIP(address) !== 0) : undefined
        ),
        Effect.orElseSucceed(() => undefined)
      )

    let lastRefresh = 0
    const refresh = Effect.gen(function* () {
      const answers = yield* Effect.forEach(names, resolveName, { concurrency: "unbounded" })
      const now = yield* Clock.currentTimeMillis
      lastRefresh = now
      for (const [index, name] of names.entries()) {
        const addresses = answers[index]
        const previous = resolved.get(name)
        if (addresses !== undefined) {
          failing.delete(name)
          const before = previous?.addresses.join(", ") ?? ""
          resolved.set(name, { addresses, at: now })
          const after = addresses.join(", ")
          if (after !== before) {
            if (addresses.length === 0)
              yield* Effect.logWarning(`${label}: ${name} doesn't resolve, so it trusts nothing`)
            else yield* Effect.logInfo(`${label}: ${name} resolves to ${after}`)
          }
        } else if (
          previous !== undefined &&
          previous.addresses.length > 0 &&
          now - previous.at >= Duration.toMillis(STALE_AFTER)
        ) {
          resolved.delete(name)
          yield* Effect.logWarning(
            `${label}: ${name} couldn't be resolved for ${Duration.format(STALE_AFTER)}, so ${previous.addresses.join(", ")} is no longer trusted`
          )
        } else if (!failing.has(name)) {
          failing.add(name)
          yield* Effect.logWarning(
            previous?.addresses.length
              ? `${label}: ${name} couldn't be resolved; keeping ${previous.addresses.join(", ")} for at most ${Duration.format(STALE_AFTER)}`
              : `${label}: ${name} couldn't be resolved, so it trusts nothing yet`
          )
        }
      }
      rebuild()
    })

    const wake = Latch.makeUnsafe(false)
    if (names.length > 0) {
      yield* refresh
      yield* Effect.gen(function* () {
        yield* Effect.raceFirst(Effect.sleep(REFRESH_EVERY), wake.await)
        const since = (yield* Clock.currentTimeMillis) - lastRefresh
        if (since < Duration.toMillis(REFRESH_SOON)) yield* Effect.sleep(Duration.toMillis(REFRESH_SOON) - since)
        // Closed after the wait, so connections that asked meanwhile don't start another at once.
        wake.closeUnsafe()
        yield* refresh
      }).pipe(Effect.forever, Effect.forkScoped)
    }

    return {
      entries,
      invalid,
      has: (ip) => {
        const family = isIP(ip)
        return family !== 0 && current.check(ip, family === 4 ? "ipv4" : "ipv6")
      },
      describe: () =>
        entries
          .map((entry) => {
            const name = entry.toLowerCase().replace(/\.$/, "")
            if (!names.includes(name)) return entry
            const addresses = resolved.get(name)?.addresses ?? []
            return `${entry} (${addresses.length > 0 ? addresses.join(", ") : "unresolved"})`
          })
          .join(", "),
      refreshSoon: () => {
        if (names.length > 0) wake.openUnsafe()
      }
    } satisfies AddressSet
  })
