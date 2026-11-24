// Where an Allow always is seen and taken back (spec/WORKSHOP-CARDS.md §2.5): Settings → Assistant
// tools lists every one, the account's and each assistant card's; an assistant card's own Extra tab
// lists its own, only while it has one. Remove asks nothing: the next workshop just asks again.
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { LibraryGrants } from "@dreamspan/shared/workshopApi.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { linkMenuProps } from "../../ui/linkMenuState.ts"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { EditorStore } from "../editor/store.ts"
import { openNearProps } from "../workbench/kinds.ts"
import { CAPABILITIES_KEY, LIBRARY_GRANTS_KEY, libraryGrantsAtom } from "./capabilities.ts"

const link =
  "rounded-sm outline-none [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-focus"

const labelOf = (grants: LibraryGrants, id: string) => grants.classes.find((c) => c.id === id)?.label ?? id

/** One class allowed always, with Remove. */
function GrantRow({
  label,
  capability,
  entityId,
  hint
}: {
  label: string
  capability: string
  entityId?: string
  hint: string
}) {
  const action = useAction()
  return (
    <li
      data-library-grant={capability}
      {...(entityId ? { "data-library-grant-card": entityId } : {})}
      className="flex flex-col gap-1 py-1.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{label}</span>
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          pending={action.pending}
          hint={hint}
          onClick={() =>
            void action.run(
              (client) =>
                client("RemoveLibraryGrant", { capability, ...(entityId ? { entityId: entityId as EntityId } : {}) }),
              [LIBRARY_GRANTS_KEY, CAPABILITIES_KEY]
            )
          }
        >
          Remove
        </Button>
      </div>
      <ErrorAlert error={action.error} title="Not removed" />
    </li>
  )
}

/** Settings → Assistant tools: every Allow always, the account's first, then each card's. */
export function LibraryGrantsSection() {
  const result = useAtomValue(libraryGrantsAtom)
  const grants = AsyncResult.isSuccess(result) ? result.value : undefined
  return (
    <Card>
      <CardHeader
        title="What the assistant may look at"
        about="What you allowed always when the assistant asked to look through your library. What you attach, and what it makes, it can always read and change."
      />
      {!grants ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : grants.always.length === 0 && grants.cards.length === 0 ? (
        <p className="text-sm text-muted" data-library-grants-empty>
          Nothing is allowed always. Each workshop asks first.
        </p>
      ) : (
        <div className="flex flex-col gap-3" data-library-grants>
          {grants.always.length > 0 && (
            <section className="flex flex-col gap-1" aria-label="In every workshop">
              <h3 className="text-sm font-medium">In every workshop</h3>
              <ul className="flex flex-col divide-y divide-border">
                {grants.always.map((id) => (
                  <GrantRow
                    key={id}
                    label={labelOf(grants, id)}
                    capability={id}
                    hint="Every workshop will ask again, unless its assistant or the workshop allows it."
                  />
                ))}
              </ul>
            </section>
          )}
          {grants.cards.map((card) => (
            <section key={card.entityId} className="flex flex-col gap-1" aria-label={`For ${card.name}`}>
              <h3 className="text-sm font-medium [overflow-wrap:anywhere]">
                For{" "}
                {card.refId ? (
                  <Tooltip label={`Opens ${card.name}.`}>
                    <a
                      href={`/library/${encodeURIComponent(card.refId)}`}
                      className={link}
                      {...openNearProps("library.editor")}
                      {...linkMenuProps}
                    >
                      {card.name}
                    </a>
                  </Tooltip>
                ) : (
                  card.name
                )}
              </h3>
              <ul className="flex flex-col divide-y divide-border">
                {card.classes.map((id) => (
                  <GrantRow
                    key={id}
                    label={labelOf(grants, id)}
                    capability={id}
                    entityId={card.entityId}
                    hint={`Workshops with ${card.name} will ask again.`}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  )
}

/**
 * The card editor's Extra tab: what this card, as a workshop's assistant, may look at always.
 * Nothing on a card without a grant, so no blank section.
 */
export function CardLibraryGrants({ store }: { store: EditorStore }) {
  const result = useAtomValue(libraryGrantsAtom)
  const card = AsyncResult.isSuccess(result) ? result.value.cards.find((c) => c.refId === store.refId) : undefined
  if (!AsyncResult.isSuccess(result) || !card) return null
  return (
    <section aria-label="Allowed for this assistant" data-card-library-grants>
      <Card>
        <CardHeader
          title="Allowed for this assistant"
          about="In every workshop whose assistant is this card, it may look at these without asking. Change them here or in Settings → Assistant tools."
        />
        <ul className="flex flex-col divide-y divide-border">
          {card.classes.map((id) => (
            <GrantRow
              key={id}
              label={labelOf(result.value, id)}
              capability={id}
              entityId={card.entityId}
              hint="Workshops with this assistant will ask again."
            />
          ))}
        </ul>
      </Card>
    </section>
  )
}
