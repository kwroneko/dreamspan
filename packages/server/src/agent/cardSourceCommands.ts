// The workshop's card-source commands (job cardextools1; spec/CARD-SOURCES.md): the assistant
// searches, opens and adds cards through the same `CardSources` calls the browse view makes, under
// the same consent: nothing reaches a source the user has turned off (§5.1), and a search uses the
// user's content rating (§5.3), which the assistant may only narrow to the source's safe choice.
// The registered tools over these are in `exposures/cardSources.ts`.
import { CurrentUser } from "@rp/shared/api.ts"
import {
  SourceFilterValue,
  type SourceCapabilities,
  type SourceFailed,
  type SourceInfo,
  type SourceQuery
} from "@rp/shared/cardSources.ts"
import type { User } from "@rp/shared/domain.ts"
import { HistoryRejected } from "@rp/shared/historyApi.ts"
import { Effect, Schema } from "effect"
import { makeCommand, type Command } from "../commands.ts"
import { Writer } from "../db/Database.ts"
import type { Registry } from "../registry.ts"
import { CardSources } from "../sources/CardSources.ts"
import { OperationCall } from "./operations.ts"
import { withoutCardSkills } from "./toolLoading.ts"

const refuse = (message: string) => new HistoryRejected({ message })

/** A source's refusal in words the assistant can act on. */
export const sourceRefusal = (error: SourceFailed, name = error.sourceId) =>
  refuse(
    error.reason === "disabled"
      ? `${name} is turned off. Only the user can turn it on, in Settings → Card sources.`
      : error.reason === "rate_limited"
        ? `${name} asks to wait${error.retryAfterMs ? ` ${Math.ceil(error.retryAfterMs / 1000)} s` : ""}. Try again later.`
        : error.reason === "unreachable"
          ? `${name} can't be reached right now. Try again later.`
          : error.reason === "not_found"
            ? `${name} has no such card.`
            : error.message
  )

/** The tools' own failures pass; a source's are worded; anything else is the command boundary's. */
const worded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error: unknown) => {
      const e = error as { _tag?: string; entity?: string }
      if (e._tag === "SourceFailed") return Effect.fail(sourceRefusal(error as SourceFailed))
      if (e._tag === "NotFound" && e.entity === "card source")
        return Effect.fail(refuse("There's no such card source. Use list_card_sources."))
      return Effect.fail(error)
    })
  )

/** The source a call names, else the only one this user has on. */
const chosenSource = (sources: ReadonlyArray<SourceInfo>, wanted: string | null) => {
  if (wanted !== null) {
    const source = sources.find((s) => s.id === wanted || s.name.toLowerCase() === wanted.toLowerCase())
    if (!source) return refuse(`There's no card source ${JSON.stringify(wanted)}. Use list_card_sources.`)
    if (!source.enabled)
      return refuse(`${source.name} is turned off. Only the user can turn it on, in Settings → Card sources.`)
    return source
  }
  const on = sources.filter((s) => s.enabled)
  if (on.length === 1) return on[0]!
  return refuse(
    on.length === 0
      ? "No card source is turned on. Only the user can turn one on, in Settings → Card sources."
      : `Name a source: ${on.map((s) => s.id).join(", ")}.`
  )
}

/** The rating the user's searches use: the one they chose last, else the source's default (§5.3). */
export const userRating = (caps: SourceCapabilities, info: Pick<SourceInfo, "rating">) =>
  caps.ratings ? (info.rating ?? caps.ratings.default) : null

const labelOf = (caps: SourceCapabilities, filterId: string, value: string) => {
  const filter = caps.filters.find((f) => f.id === filterId)
  return filter?.kind === "choice" ? (filter.options.find((o) => o.value === value)?.label ?? value) : value
}

/** What the assistant asked for, before it's checked against the source's filters. */
export interface AssistantQuery {
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly excludeTags: ReadonlyArray<string>
  readonly filters: Readonly<Record<string, SourceFilterValue>>
  readonly sort: string | null
  readonly reverse: boolean
  readonly rating: string | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The query the browse view would send for the same choices (`SourceQuery`), checked against the
 * source's own filters and sorts as its Filters panel offers them: a filter or sort by its id or
 * label, a choice by its value or label. The rating is the user's, or narrower (its safe choice).
 * Returns the problem in words instead when something doesn't fit.
 */
export const checkedQuery = (
  caps: SourceCapabilities,
  info: Pick<SourceInfo, "rating" | "name">,
  asked: AssistantQuery
): { readonly query: SourceQuery; readonly rating: string | null } | { readonly problem: string } => {
  const problems: Array<string> = []
  if (!caps.text && asked.text.trim() !== "") problems.push(`${info.name} doesn't search by words; use filters.`)
  if (asked.tags.length > 0 && !caps.tags.include) problems.push(`${info.name} doesn't filter by tags.`)
  if (asked.excludeTags.length > 0 && !caps.tags.exclude) problems.push(`${info.name} doesn't leave tags out.`)
  const find = (key: string) => {
    const wanted = key.trim().toLowerCase()
    return caps.filters.find((f) => f.id === key || f.label.toLowerCase() === wanted)
  }
  const ratingId = caps.ratings?.filterId
  const filters: Record<string, SourceFilterValue> = {}
  for (const [key, value] of Object.entries(asked.filters)) {
    const filter = find(key)
    if (!filter) {
      problems.push(`No filter ${JSON.stringify(key)}. Use card_source_filters.`)
      continue
    }
    if (filter.id === ratingId) {
      problems.push("Set the content rating with rating, not as a filter.")
      continue
    }
    const option = (v: string) =>
      filter.kind === "choice"
        ? filter.options.find((o) => o.value === v || o.label.toLowerCase() === v.trim().toLowerCase())?.value
        : undefined
    switch (filter.kind) {
      case "choice": {
        const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : null
        if (values === null || values.length === 0) {
          problems.push(`${filter.label} takes ${filter.multi ? "one or more of" : "one of"} its choices.`)
          break
        }
        if (!filter.multi && values.length > 1) {
          problems.push(`${filter.label} takes one choice.`)
          break
        }
        const chosen = values.map(option)
        const unknown = values.filter((_, at) => chosen[at] === undefined)
        if (unknown.length > 0) {
          problems.push(
            `${filter.label} has no choice ${unknown.map((v) => JSON.stringify(v)).join(", ")}. Choices: ${filter.options.map((o) => o.value).join(", ")}.`
          )
          break
        }
        filters[filter.id] = filter.multi ? [...new Set(chosen as Array<string>)] : chosen[0]!
        break
      }
      case "range": {
        const range =
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as { readonly min?: number; readonly max?: number })
            : null
        if (range === null || (range.min === undefined && range.max === undefined)) {
          problems.push(`${filter.label} takes {"min": …, "max": …}, either one or both.`)
          break
        }
        const out = [range.min, range.max].filter((n): n is number => n !== undefined)
        if (
          out.some((n) => (filter.min !== undefined && n < filter.min) || (filter.max !== undefined && n > filter.max))
        ) {
          problems.push(`${filter.label} goes from ${filter.min ?? "any"} to ${filter.max ?? "any"}.`)
          break
        }
        if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
          problems.push(`${filter.label}'s min is above its max.`)
          break
        }
        filters[filter.id] = {
          ...(range.min === undefined ? {} : { min: range.min }),
          ...(range.max === undefined ? {} : { max: range.max })
        }
        break
      }
      case "toggle": {
        if (typeof value !== "boolean") {
          problems.push(`${filter.label} takes true or false.`)
          break
        }
        if (value) filters[filter.id] = true
        break
      }
      case "text": {
        if (typeof value !== "string" || value.trim() === "") {
          problems.push(`${filter.label} takes text.`)
          break
        }
        if (filter.format === "date" && (!DATE.test(value.trim()) || Number.isNaN(Date.parse(value.trim())))) {
          problems.push(`${filter.label} takes a date as YYYY-MM-DD.`)
          break
        }
        filters[filter.id] = value.trim()
        break
      }
    }
  }
  // A switch the source takes only with one choice elsewhere (Chub's marks need Site to be Chub alone).
  for (const filter of caps.filters) {
    if (filter.kind !== "toggle" || !filter.requires || filters[filter.id] !== true) continue
    const other = filters[filter.requires.filterId]
    const values = typeof other === "string" ? [other] : Array.isArray(other) ? other : []
    if (values.length === 0 || values.some((v) => !filter.requires!.values.includes(v)))
      problems.push(`${filter.label}: ${filter.requires.about}`)
  }
  let sort: string | null = null
  if (asked.sort !== null) {
    const wanted = asked.sort.trim().toLowerCase()
    const found = caps.sorts.find((s) => s.id === asked.sort || s.label.toLowerCase() === wanted)
    if (!found)
      problems.push(`No sort ${JSON.stringify(asked.sort)}. Sorts: ${caps.sorts.map((s) => s.id).join(", ")}.`)
    else {
      sort = found.id
      if (asked.reverse && !found.reversible) problems.push(`${found.label} can't be reversed.`)
    }
  } else if (asked.reverse) problems.push("Reverse needs a sort.")
  // The rating: the user's own, or narrower (the source's safe choice). Never wider.
  const mine = userRating(caps, info)
  let rating = mine
  if (asked.rating !== null) {
    if (!caps.ratings) problems.push(`${info.name} has no content rating.`)
    else {
      const value = (() => {
        const filter = caps.filters.find((f) => f.id === caps.ratings!.filterId)
        const wanted = asked.rating!.trim().toLowerCase()
        return filter?.kind === "choice"
          ? filter.options.find((o) => o.value === asked.rating || o.label.toLowerCase() === wanted)?.value
          : undefined
      })()
      if (value === undefined) problems.push(`No rating ${JSON.stringify(asked.rating)}.`)
      else if (value !== mine && value !== caps.ratings.safe)
        problems.push(
          `The user's rating for ${info.name} is ${mine === null ? "the source's default" : labelOf(caps, caps.ratings.filterId, mine)}. You can keep it${caps.ratings.safe ? ` or narrow it to ${labelOf(caps, caps.ratings.filterId, caps.ratings.safe)}` : ""}; only the user can change it, in the browse view's filters.`
        )
      else rating = value
    }
  }
  if (ratingId && rating !== null) filters[ratingId] = rating
  if (problems.length > 0) return { problem: problems.join(" ") }
  return {
    rating,
    query: {
      text: asked.text.trim(),
      tags: [...new Set(asked.tags.map((t) => t.trim()).filter((t) => t !== ""))],
      excludeTags: [...new Set(asked.excludeTags.map((t) => t.trim()).filter((t) => t !== ""))],
      filters,
      sort,
      reverse: sort !== null && asked.reverse
    }
  }
}

const SourceArg = Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))
const RemoteArg = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))

export const installCardSourceCommands = (commands: Registry<Command>) =>
  Effect.gen(function* () {
    const sources = yield* CardSources
    // The writer itself: the add below is the receipted workshop operation.
    const writer = yield* Writer
    const sourceFor = (user: User, wanted: string | null) =>
      Effect.gen(function* () {
        const listed = yield* sources.list(user)
        const chosen = chosenSource(listed.sources, wanted)
        if (chosen instanceof HistoryRejected) return yield* chosen
        return chosen
      })
    const ratingOf = (caps: SourceCapabilities, info: SourceInfo, rating: string | null) =>
      rating === null || !caps.ratings
        ? null
        : {
            value: rating,
            label: labelOf(caps, caps.ratings.filterId, rating),
            usersOwn: rating === userRating(caps, info)
          }

    yield* commands.register(
      makeCommand({
        id: "sources.filters",
        description: "A card source's filters and sorts, as its Filters panel offers them.",
        input: Schema.Struct({ sourceId: SourceArg }),
        output: Schema.Unknown,
        execute: ({ sourceId }) =>
          worded(
            Effect.gen(function* () {
              const user = yield* CurrentUser
              const info = yield* sourceFor(user, sourceId)
              const caps = yield* sources.capabilities(user, info.id)
              const rating = userRating(caps, info)
              return { source: info, caps, rating: ratingOf(caps, info, rating) }
            })
          )
      })
    )
    yield* commands.register(
      makeCommand({
        id: "sources.search",
        description: "Search a card source with the browse view's filters and sorts.",
        input: Schema.Struct({
          sourceId: SourceArg,
          text: Schema.String.check(Schema.isMaxLength(500)),
          tags: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(20)),
          excludeTags: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(20)),
          filters: Schema.Record(Schema.String, SourceFilterValue),
          sort: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
          reverse: Schema.Boolean,
          rating: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
          page: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000)))
        }),
        output: Schema.Unknown,
        execute: ({ sourceId, page, ...asked }) =>
          worded(
            Effect.gen(function* () {
              const user = yield* CurrentUser
              const info = yield* sourceFor(user, sourceId)
              const caps = yield* sources.capabilities(user, info.id)
              const checked = checkedQuery(caps, info, asked)
              if ("problem" in checked) return yield* refuse(checked.problem)
              const found = yield* sources.search(user, info.id, checked.query, page)
              return { source: info, rating: ratingOf(caps, info, checked.rating), query: checked.query, found }
            })
          )
      })
    )
    yield* commands.register(
      makeCommand({
        id: "sources.card",
        description: "Open a card on a card source: its listing and its definitions.",
        input: Schema.Struct({ sourceId: SourceArg, remoteId: RemoteArg }),
        output: Schema.Unknown,
        execute: ({ sourceId, remoteId }) =>
          worded(
            Effect.gen(function* () {
              const user = yield* CurrentUser
              const info = yield* sourceFor(user, sourceId)
              const caps = yield* sources.capabilities(user, info.id)
              const opened = yield* sources.card(user, info.id, remoteId)
              // A card the user's Safe rating would leave out of their results stays closed (§5.3).
              const safe = caps.ratings?.safe
              if (safe !== undefined && userRating(caps, info) === safe && opened.summary.rating !== undefined)
                return yield* refuse(
                  `This card is rated ${opened.summary.rating}, and the user's ${info.name} rating shows ${labelOf(caps, caps.ratings!.filterId, safe)} cards only.`
                )
              let doc: unknown = null
              if (opened.docJson !== null)
                doc = withoutCardSkills(JSON.parse(opened.docJson) as { extensions?: Record<string, unknown> })
              return { source: info, summary: opened.summary, doc, problems: opened.problems }
            })
          )
      })
    )
    yield* commands.register(
      makeCommand({
        id: "sources.family",
        description: "A card's family on its source: what it was forked from, its versions and its forks.",
        input: Schema.Struct({ sourceId: SourceArg, remoteId: RemoteArg }),
        output: Schema.Unknown,
        execute: ({ sourceId, remoteId }) =>
          worded(
            Effect.gen(function* () {
              const user = yield* CurrentUser
              const info = yield* sourceFor(user, sourceId)
              const caps = yield* sources.capabilities(user, info.id)
              if (!caps.families) return yield* refuse(`${info.name} doesn't list cards' families.`)
              return { source: info, family: yield* sources.family(user, info.id, remoteId) }
            })
          )
      })
    )
    yield* commands.register(
      makeCommand({
        id: "sources.adopt",
        description: "Add a card from a card source to the user's cards, as Add to my cards does.",
        input: Schema.Struct({ sourceId: Schema.String.check(Schema.isMaxLength(100)), remoteId: RemoteArg }),
        output: Schema.Unknown,
        execute: ({ sourceId, remoteId }) =>
          worded(
            Effect.gen(function* () {
              const call = yield* OperationCall
              const user = yield* CurrentUser
              if (!call) return yield* refuse("This command needs a workshop call.")
              const info = yield* sourceFor(user, sourceId)
              const added = yield* sources.adopt(user, info.id, remoteId, (payload) =>
                writer.RunWorkshopOperation({ ...call, userId: user.id, operation: "AdoptRemoteCard", payload }).pipe(
                  Effect.map((result) => result as { entityId: string; refId: string; existing: boolean }),
                  Effect.mapError((error) =>
                    refuse(
                      error._tag === "EffectUndoRefused"
                        ? error.message
                        : error._tag === "InvalidDocument"
                          ? error.problems.join("; ")
                          : "The card could not be added. Try again."
                    )
                  )
                )
              )
              return { source: info, ...added }
            })
          )
      })
    )
  })
