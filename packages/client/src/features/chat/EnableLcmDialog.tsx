// Turning summaries on for a chat that has history already (DESIGN §8.1, spec/LCM.md §2.7,
// §2.11): an imported chat chooses between keeping ST's summary as the first level over the
// messages it covers and summarizing from scratch, and either way sees what it will cost before
// anything is spent. Enabling generates nothing; the next reply or "Summarize now" begins.
import { useEffect, useState } from "react"
import type { BackfillEstimate, EnableChoice, LcmEnableOffer } from "@rp/shared/lcm.ts"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { RadioGroup } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { countText, durationText, moneyText, rangeText, tokensText } from "./lcm.ts"
import type { ChatSession } from "./session.ts"

/** Where spending stops, as a share of the estimate (spec/LCM.md §2.11). */
const CAP_PERCENT = 150

/** What the work comes to, in the terms of spec/LCM.md §2.11, with the limit that holds it. */
export function EstimateList({ estimate, title }: { estimate: BackfillEstimate; title: string }) {
  const jobs = estimate.l1Jobs + estimate.condensations
  if (estimate.blocked === "no_model")
    return (
      <Alert tone="warning">
        No model is chosen to summarize with, so nothing would be summarized. Choose the chat's model in the side
        panel's Model tab.
      </Alert>
    )
  if (estimate.blocked === "runway")
    return (
      <Alert tone="warning">
        Two summary chunks don't fit between the recent messages' target and maximum. Move them further apart, or make
        the chunk size smaller, in Summary settings at the end of the Summaries tab.
      </Alert>
    )
  if (jobs === 0)
    return (
      <p aria-label={title} className="text-sm text-muted">
        Nothing needs summarizing yet. Summaries start once the chat outgrows what the model is sent.
      </p>
    )
  return (
    <div aria-label={title} role="group" className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">To summarize</dt>
        <dd>
          {estimate.messages} messages ({tokensText(estimate.tokens)})
        </dd>
        <dt className="text-muted">Requests</dt>
        <dd>
          {estimate.l1Jobs + estimate.condensations}: {estimate.l1Jobs} summaries
          {estimate.condensations > 0 ? `, ${estimate.condensations} condensing them` : ""}
        </dd>
        <dt className="text-muted">Tokens sent</dt>
        <dd>
          {countText(estimate.uncachedInput + (estimate.cached ? estimate.cachedInput : 0))}
          {estimate.cached ? `, ${countText(estimate.cachedInput)} of them from the cache` : ""}
          {estimate.cacheWrite > 0 ? `; ${countText(estimate.cacheWrite)} written to it` : ""}
        </dd>
        <dt className="text-muted">Tokens written</dt>
        <dd>{countText(estimate.output)}</dd>
        <dt className="text-muted">Cost</dt>
        <dd data-testid="estimate-cost">
          {estimate.cost ? moneyText(estimate.cost.amount, estimate.cost.currency) : "Not priced for this model"}
        </dd>
        <dt className="text-muted">Time</dt>
        <dd>
          {estimate.seconds === null
            ? "Unknown until this model has answered a few requests"
            : durationText(estimate.seconds)}
        </dd>
      </dl>
      {(!estimate.cached || (estimate.model && !estimate.model.sharesCache)) && (
        <p className="text-muted">
          {estimate.cached ? "" : "This model has no cache lifetime, so every request is sent in full."}
          {estimate.model && !estimate.model.sharesCache
            ? ` ${estimate.model.name} is not the chat's model, so the first request starts without the chat's cache.`
            : ""}
        </p>
      )}
      <p>
        It pauses at {CAP_PERCENT}% of this
        {estimate.cost
          ? ` (${moneyText((estimate.cost.amount * CAP_PERCENT) / 100, estimate.cost.currency)})`
          : ""}{" "}
        until you continue.
      </p>
    </div>
  )
}

export function EnableLcmDialog({
  session,
  onOpenChange
}: {
  session: ChatSession
  onOpenChange: (open: boolean) => void
}) {
  const [offer, setOffer] = useState<LcmEnableOffer | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [choice, setChoice] = useState<EnableChoice>("adopt")
  const [pending, setPending] = useState(false)
  // The branch shown when the dialog opened: what is asked and enabled is about its path.
  const [forkId] = useState(() => session.snapshot().forkId)
  const [leafSlotId] = useState(() => session.snapshot().leafSlotId)
  useEffect(() => {
    if (leafSlotId === null) return
    let live = true
    void session
      .call((client) => client("GetLcmEnableOffer", { chatId: session.id, leafSlotId, forkId }))
      .then((result) => {
        if (!live) return
        if (result.ok) {
          setOffer(result.value)
          setChoice(result.value.imported ? "adopt" : "scratch")
        } else setError(result.error)
      })
    return () => {
      live = false
    }
  }, [session, leafSlotId, forkId])
  const enable = async () => {
    if (offer === null) return
    setPending(true)
    const result = await session.call((client) =>
      client("EnableLcm", {
        chatId: session.id,
        leafSlotId: offer.leafSlotId,
        forkId,
        choice,
        approved: choice === "adopt" ? offer.adopted! : offer.fromScratch
      })
    )
    setPending(false)
    if (result.ok) onOpenChange(false)
    else {
      setError(result.error)
      if (result.error.tag === "LcmEstimateChanged") {
        const updated = await session.call((client) =>
          client("GetLcmEnableOffer", { chatId: session.id, leafSlotId: offer.leafSlotId, forkId })
        )
        if (updated.ok) {
          setOffer(updated.value)
          if (updated.value.adopted === null) setChoice("scratch")
        }
      }
    }
  }
  const estimate = offer === null ? null : choice === "adopt" && offer.adopted ? offer.adopted : offer.fromScratch
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Summarize older messages"
      description="Keep the story in what the model reads: summaries stand in for older messages. They're written with your next reply, or at once with Summarize now."
    >
      {offer === null ? (
        error ? (
          <Alert tone="danger">{error.message}</Alert>
        ) : leafSlotId === null ? (
          <Alert tone="warning">The chat has no messages to summarize yet.</Alert>
        ) : (
          <Loading label="Working out what it would take…" />
        )
      ) : (
        <>
          {offer.imported && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">This chat came with a summary</legend>
              <blockquote className="line-clamp-3 border-l-2 border-border pl-3 text-sm text-muted">
                {offer.imported.preview}
              </blockquote>
              <RadioGroup<EnableChoice>
                aria-label="How to start"
                value={choice}
                onValueChange={setChoice}
                options={[
                  {
                    value: "adopt",
                    label: "Keep the imported summary",
                    description: `It stands in for ${rangeText(1, offer.imported.to).toLowerCase()} (${tokensText(offer.imported.tokens)}). They're shown again, and the rest is summarized from there.`
                  },
                  {
                    value: "scratch",
                    label: "Summarize from scratch",
                    description:
                      "Those messages are shown again and summarized with the rest. The imported summary stays in its note."
                  }
                ]}
              />
            </fieldset>
          )}
          {offer.summaryNoteOn && (
            <p role="note" className="text-sm text-muted">
              Its note is switched off, so it isn't sent twice. You can switch it back on in the Notes tab.
            </p>
          )}
          {estimate && <EstimateList estimate={estimate} title="Estimate" />}
          {error && <Alert tone="danger">{error.message}</Alert>}
          <DialogActions>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" pending={pending} onClick={() => void enable()}>
              Enable summaries
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  )
}
