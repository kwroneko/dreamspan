import { putUserSetting } from "./settings.ts"
// Favourite cards, per user: one `settings` row (`cards.favourites`), so a database made
// before favourites existed needs no schema change. `on` lists the favourite cards' entity ids;
// `here` the cards whose favourite the user set in this app, which an import's `fav` (ST's
// favourite flag, `extensions.fav` in the card) no longer changes.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

const CARD_FAVOURITES = "cards.favourites"

interface Favourites {
  readonly on: ReadonlyArray<string>
  readonly here: ReadonlyArray<string>
}

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []

/** As stored; a value that isn't one reads as none. */
export const readFavourites = (sql: SqlClient.SqlClient, userId: string) =>
  sql<{
    value_json: string
  }>`SELECT value_json FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = ${CARD_FAVOURITES}`.pipe(
    Effect.map(([row]): Favourites => {
      const stored = row ? (JSON.parse(row.value_json) as { on?: unknown; here?: unknown } | null) : null
      return { on: strings(stored?.on), here: strings(stored?.here) }
    })
  )

const put = (sql: SqlClient.SqlClient, userId: string, value: Favourites) =>
  putUserSetting(sql, userId, CARD_FAVOURITES, value)

const toggled = (list: ReadonlyArray<string>, id: string, on: boolean) =>
  on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id)

/** The user's own choice: kept from then on over what an import says. */
export const setFavourite = (sql: SqlClient.SqlClient, userId: string, entityId: string, favourite: boolean) =>
  Effect.gen(function* () {
    const stored = yield* readFavourites(sql, userId)
    yield* put(sql, userId, { on: toggled(stored.on, entityId, favourite), here: toggled(stored.here, entityId, true) })
  })

/** An import's `fav`, unless the user set this card's favourite here since. */
export const importFavourite = (sql: SqlClient.SqlClient, userId: string, entityId: string, favourite: boolean) =>
  Effect.gen(function* () {
    const stored = yield* readFavourites(sql, userId)
    if (stored.here.includes(entityId) || stored.on.includes(entityId) === favourite) return
    yield* put(sql, userId, { on: toggled(stored.on, entityId, favourite), here: stored.here })
  })

/** ST writes `fav` as a boolean, and older cards as the text "true". */
export const isFav = (value: unknown) => value === true || value === "true" || value === 1
