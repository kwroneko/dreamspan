// The side panel's Cast tab (DESIGN §2.3, §3.5): members present or absent, played by the
// user or not, removed; and anyone added. Every change is a state event at the leaf shown,
// so it applies from there on, on this branch.
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import { useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { useCast } from "./cast.ts"
import type { ChatSession } from "./session.ts"

export function CastTab({ session }: { session: ChatSession }) {
  const { cast, cards } = useCast()
  const action = useAction()
  const [error, setError] = useState<AppError | null>(null)
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  const [all, setAll] = useState<ReadonlyArray<CastCard>>([])
  useEffect(() => {
    void action.run((client) => client("ListCards", undefined)).then((result) => result.ok && setAll(result.value))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [])
  const participants = cast?.participants ?? []
  const playedByMe = cast?.playedByMe ?? []
  const addable = all.filter((card) => !participants.includes(card.entityId))
  const togglePlayed = (id: EntityId, on: boolean) =>
    change({ _tag: "PlayedByMe", entityIds: on ? [...playedByMe, id] : playedByMe.filter((x) => x !== id) })
  const problem = error ?? action.error
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">Changes apply from the latest message on, on this branch.</p>
      {participants.length === 0 ? (
        <p className="text-sm text-muted">No one has joined this chat.</p>
      ) : (
        <ul aria-label="Members" className="flex flex-col divide-y divide-border">
          {participants.map((id) => {
            const card = cards.get(id)
            const name = card?.name ?? "Unknown card"
            return (
              <li key={id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <Avatar id={id} name={name} />
                  <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                  {card?.persona && <Badge>persona</Badge>}
                  <Button
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    onClick={() => void change({ _tag: "Leave", entityId: id })}
                  >
                    Remove
                  </Button>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2 pl-10">
                  <Switch
                    checked={!cast!.absent.includes(id)}
                    onCheckedChange={(present) => void change({ _tag: "Presence", entityId: id, present })}
                  >
                    Present
                  </Switch>
                  <Checkbox checked={playedByMe.includes(id)} onCheckedChange={(on) => void togglePlayed(id, on)}>
                    I play them
                  </Checkbox>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {addable.length > 0 && (
        <Field label="Add someone">
          <Select
            items={addable.map((card) => ({
              value: card.entityId,
              label: card.label === card.name ? card.name : `${card.name} (${card.label})`
            }))}
            value={null}
            placeholder="Pick a card"
            onValueChange={(entityId) => void change({ _tag: "Join", entityId })}
          />
        </Field>
      )}
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {problem.message}
        </p>
      )}
    </div>
  )
}
