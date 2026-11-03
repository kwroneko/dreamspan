import { HistoryDiff, HistoryPreviewContext } from "./historyPreview.tsx"
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useId, type RefObject } from "react"
import type { HistoryHit, HistoryRecord, HistorySearch, HistoryCursor } from "@rp/shared/historyApi.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import { Button } from "../../ui/Button.tsx"
import { SearchReplace } from "../../ui/SearchReplace.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { revealAdded, revealIfHidden } from "../../ui/reveal.ts"
import { showToast } from "../../ui/Toast.tsx"
import type { ChatSession, ChatView } from "./session.ts"

type Record = typeof HistoryRecord.Type
const keyOf = (hit: HistoryHit) => `${hit.kind}:${hit.targetId}`
const initial: HistorySearch = {
  pairs: [{ find: "", replace: "" }],
  matchCase: false,
  wholeWord: false,
  regex: false,
  preserveCase: false,
  messages: true,
  swipes: true,
  summaries: true
}

export function HistoryPanel({
  session,
  view,
  onJump,
  onSummaries,
  active
}: {
  session: ChatSession
  view: ChatView
  onJump: (slot: SlotId) => void
  onSummaries: (summary: string) => void
  active: boolean
}) {
  const { publish } = useContext(HistoryPreviewContext)
  const [pairs, setPairs] = useState([0])
  const next = useRef(1)
  const added = useRef<number | null>(null)
  const boxes = useRef(new Map<number, HTMLElement>())
  const [selected, setSelected] = useState(0)
  const [records, setRecords] = useState<ReadonlyArray<Record>>([])
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const group = useRef<string | undefined>(undefined)
  const forkId = view.forkId ?? view.chat?.currentForkId
  const target = forkId ? { chatId: session.id, forkId } : null
  const history = useCallback(async () => {
    if (!forkId) return
    const result = await session.call((c) => c("ListHistoryEdits", { chatId: session.id, forkId }))
    if (result.ok) setRecords(result.value)
    else setError(result.error.message)
  }, [session, forkId])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (active) void history()
    }, 0)
    return () => clearTimeout(timer)
  }, [active, history])
  const undo = async (record: Record, slotId?: string, itemIds?: ReadonlyArray<number>) => {
    if (!target) return
    setPending(true)
    const result = await session.call((c) =>
      c("UndoHistoryEdit", {
        ...target,
        changesetId: record.id,
        ...(slotId ? { slotId } : {}),
        ...(itemIds ? { itemIds } : {})
      })
    )
    setPending(false)
    if (!result.ok) setError(result.error.message)
    else {
      setError(result.value.conflicts.length ? `${result.value.conflicts.length} later edits were kept.` : "")
      void history()
      setRefresh((value) => value + 1)
    }
  }
  useEffect(() => {
    if (added.current === null) return
    const box = boxes.current.get(added.current)
    added.current = null
    if (!box) return
    revealAdded(box)
    // A preview above the added box can finish after the first reveal and move the box
    // without resizing it. Follow the list while it settles; only the latest addition.
    const settling = new ResizeObserver(() => revealIfHidden(box))
    if (box.parentElement) settling.observe(box.parentElement)
    const timer = setTimeout(() => settling.disconnect(), 1000)
    return () => {
      clearTimeout(timer)
      settling.disconnect()
    }
  }, [pairs])
  useEffect(() => () => publish([]), [publish])
  return (
    <div className="flex min-w-0 flex-col gap-4 p-3 text-sm" data-history-panel>
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">Searches</h2>
        <IconButton
          icon="plus"
          label="Add search and replace"
          hint={pairs.length >= 20 ? "At most 20 searches can be open." : "Add another search and replace"}
          disabled={pairs.length >= 20}
          onClick={() => {
            const id = next.current++
            added.current = id
            setSelected(id)
            setPairs((old) => [...old, id])
          }}
        />
      </div>
      {pairs.map((id, index) => (
        <section
          key={id}
          aria-label={`Search and replace ${index + 1}`}
          ref={(box) => {
            if (box) boxes.current.set(id, box)
            else boxes.current.delete(id)
          }}
          onFocusCapture={() => setSelected(id)}
          className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2"
        >
          {pairs.length > 1 && (
            <div className="flex justify-end">
              <IconButton
                icon="close"
                label="Remove this search and replace"
                hint="Remove this search and replace"
                onClick={() => {
                  setPairs((old) => old.filter((pair) => pair !== id))
                  if (selected === id) setSelected(pairs.find((pair) => pair !== id)!)
                }}
              />
            </div>
          )}
          <HistorySearchPair
            session={session}
            view={view}
            onJump={onJump}
            onSummaries={onSummaries}
            active={active}
            selected={selected === id}
            refresh={refresh}
            groupRef={group}
            pending={pending}
            setPending={setPending}
            onApplied={async (changesetId) => {
              setRefresh((value) => value + 1)
              if (!target) return
              const result = await session.call((c) => c("ListHistoryEdits", target))
              if (result.ok) {
                setRecords(result.value)
                const record = result.value.find((item) => item.id === changesetId)
                showToast({
                  title: "History replaced",
                  actions: record ? [{ label: "Undo", onClick: () => void undo(record) }] : []
                })
              }
            }}
          />
        </section>
      ))}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h2 className="font-semibold">Applied edits</h2>
        {!records.length && <p className="text-muted">No edits applied yet.</p>}
        {records.map((record) => (
          <article key={record.id} className="rounded-md border border-border p-2">
            <div className="font-medium">{record.title}</div>
            <p className="text-muted">
              {record.inherited ? `Made in ${record.madeInName} · ` : ""}
              {record.status}
            </p>
            <Button
              disabled={pending || record.status === "undone"}
              hint="Puts back everything this edit changed in this branch. Text changed again since is kept."
              onClick={() => void undo(record)}
            >
              Undo all
            </Button>
            {record.items.map((item) => (
              <details key={item.id} className="mt-2">
                <summary>
                  {item.kind === "summary_revision" ? "Summary" : "Message"} ·{" "}
                  {item.applied ? "applied" : "undone or changed"}
                </summary>
                <div className="my-2 whitespace-pre-wrap break-words font-mono text-xs">
                  <del>{item.before}</del> → <ins>{item.after}</ins>
                </div>
                <Button
                  disabled={pending || !item.applied}
                  hint={
                    item.kind === "summary_revision"
                      ? "Restores this summary's text before this edit."
                      : item.kind === "state_event"
                        ? "Restores the chat setting before this edit."
                        : "Puts this message back, with the summaries of it that this edit changed."
                  }
                  onClick={() =>
                    void (item.kind === "version_replace" && item.slotId
                      ? undo(record, item.slotId)
                      : undo(record, undefined, [item.id]))
                  }
                >
                  {item.kind === "summary_revision"
                    ? "Undo this summary"
                    : item.kind === "state_event"
                      ? "Undo this state change"
                      : "Undo this message"}
                </Button>
              </details>
            ))}
          </article>
        ))}
      </section>
    </div>
  )
}

function HistorySearchPair({
  session,
  view,
  onJump,
  onSummaries,
  active,
  selected,
  refresh,
  groupRef,
  pending,
  setPending,
  onApplied
}: {
  session: ChatSession
  view: ChatView
  onJump: (slot: SlotId) => void
  onSummaries: (summary: string) => void
  active: boolean
  selected: boolean
  refresh: number
  groupRef: RefObject<string | undefined>
  pending: boolean
  setPending: (pending: boolean) => void
  onApplied: (changesetId: string) => Promise<void>
}) {
  const { publish } = useContext(HistoryPreviewContext)
  const id = useId()
  const [search, setSearch] = useState(initial)
  const [hits, setHits] = useState<ReadonlyArray<HistoryHit>>([])
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [cost, setCost] = useState<{ messages: number; summaries: number; tokens: number } | null>(null)
  const [error, setError] = useState("")
  const [scanning, setScanning] = useState(false)
  const [completedSearch, setCompletedSearch] = useState("")
  const [current, setCurrent] = useState(0)
  const revision = useRef(0)
  const searched = useRef<typeof search | null>(null)
  const forkId = view.forkId ?? view.chat?.currentForkId
  const target = forkId ? { chatId: session.id, forkId } : null
  const searchKey = JSON.stringify([search, refresh])
  const idle = search.pairs.some((p) => !p.find)
  useEffect(() => {
    const request = ++revision.current

    const timer = setTimeout(async () => {
      if (!forkId || search.pairs.some((p) => !p.find)) {
        setHits([])
        setScanning(false)
        return
      }
      setError("")
      setScanning(true)
      // A new search starts with nothing skipped; the summaries or the history start reading
      // again (opening the Summaries tab, say) keeps what was skipped.
      if (searched.current !== search) setSkipped(new Set())
      searched.current = search
      let cursor: typeof HistoryCursor.Type | undefined
      const all: HistoryHit[] = []
      do {
        const result = await session.call((c) =>
          c("PreviewHistory", { chatId: session.id, forkId, search, ...(cursor ? { cursor } : {}) })
        )
        if (revision.current !== request) return
        if (!result.ok) {
          setError(result.error.message)
          setHits([])
          setScanning(false)
          return
        }
        all.push(...result.value.hits)
        cursor = result.value.next ?? undefined
        if (all.length > 10000) {
          setError("Too many results. Narrow the search.")
          setScanning(false)
          return
        }
      } while (cursor)
      setHits(all)
      const raw = all.filter((h) => h.kind === "version_replace" && h.selected)
      const summaries = view.lcm?.layer ?? []
      const firstSummary = summaries.findIndex((s) =>
        all.some((h) => h.kind === "summary_revision" && h.targetId === s.id)
      )
      const firstDepth = firstSummary >= 0 ? 0 : Math.min(...raw.map((h) => h.depth), Number.MAX_SAFE_INTEGER)
      const estimate = await session.call((c) =>
        c("HistoryEditCost", {
          chatId: session.id,
          forkId,
          fromDepth: firstDepth,
          // CacheWarmth.historyStart.depth is the display position (including insertions).
          retainedDepth: view.history?.historyStart?.depth ?? 0,
          summaryIds: firstSummary < 0 ? [] : summaries.slice(firstSummary).map((s) => s.id)
        })
      )
      if (revision.current !== request) return
      setCost(estimate.ok ? estimate.value : null)
      setCurrent(0)
      setCompletedSearch(searchKey)
      setScanning(false)
    }, 250)
    return () => {
      clearTimeout(timer)
      if (revision.current === request) revision.current = request + 1
    }
  }, [search, session, forkId, view.lcm, view.history, refresh, searchKey])
  const included = useMemo(
    () =>
      hits
        .filter((h) => !skipped.has(keyOf(h)))
        .flatMap((h) => {
          const matches = h.matches.filter((_, i) => !skipped.has(`${keyOf(h)}:${i}`))
          if (!matches.length) return []
          let after = "",
            end = 0
          for (const match of matches) {
            after += h.before.slice(end, match.start) + match.replacement
            end = match.end
          }
          return [{ ...h, matches, after: after + h.before.slice(end) }]
        }),
    [hits, skipped]
  )
  useEffect(() => {
    if (selected) publish(completedSearch === searchKey ? included : [], active)
  }, [active, selected, completedSearch, searchKey, included, publish])
  const apply = async (one: boolean) => {
    if (!target || searchKey !== completedSearch) return
    let edits = included
    if (one) {
      const matches = included.flatMap((hit) => hit.matches.map((match) => ({ hit, match })))
      const chosen = matches[current % matches.length]
      if (!chosen) return
      const { hit, match } = chosen
      edits = [{ ...hit, after: hit.before.slice(0, match.start) + match.replacement + hit.before.slice(match.end) }]
    }
    setPending(true)
    const result = await session.call((c) =>
      c("ApplyHistoryEdits", {
        title: "Search and replace",
        ...(groupRef.current ? { groupId: groupRef.current } : {}),
        applications: [
          {
            ...target,
            summariesIncluded: !one && search.summaries && skipped.size === 0,
            edits: edits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
    )
    setPending(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    groupRef.current = result.value.groupId
    await onApplied(result.value.changesetIds[0]!)
    setSearch((s) => ({ ...s }))
  }
  const counts = (test: (h: HistoryHit) => boolean) => hits.filter(test).reduce((n, h) => n + h.matches.length, 0)
  const openHit = (hit: HistoryHit) => {
    if (hit.kind === "summary_revision") onSummaries(hit.targetId)
    else onJump(hit.slotId as SlotId)
  }
  const step = (back: boolean) => {
    const matches = included.flatMap((hit) => hit.matches.map((match) => ({ hit, match })))
    if (!matches.length) return
    const next = (current + (back ? -1 : 1) + matches.length) % matches.length
    setCurrent(next)
    openHit(matches[next]!.hit)
  }
  const navigationBlocked = idle
    ? "Enter the text to find before visiting matches."
    : scanning || searchKey !== completedSearch
      ? "Wait for this search to finish."
      : error
        ? "Correct this search before visiting matches."
        : !included.length
          ? "No matches to visit in this search."
          : null
  const replacementBlocked = pending
    ? "Wait for this replacement to finish."
    : idle
      ? "Enter the text to find before replacing."
      : scanning || searchKey !== completedSearch
        ? "Wait for this search to finish."
        : error
          ? "Correct this search before replacing text."
          : !included.length
            ? "No matches to replace in this search."
            : null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SearchReplace
        find={search.pairs[0]!.find}
        setFind={(find) => setSearch({ ...search, pairs: [{ ...search.pairs[0]!, find }] })}
        replace={search.pairs[0]!.replace}
        setReplace={(replace) => setSearch({ ...search, pairs: [{ ...search.pairs[0]!, replace }] })}
        wholeWord={search.wholeWord}
        setWholeWord={(wholeWord) => setSearch({ ...search, wholeWord })}
        preserveCase={search.preserveCase}
        setPreserveCase={(preserveCase) => setSearch({ ...search, preserveCase })}
        regex={search.regex}
        setRegex={(regex) => setSearch({ ...search, regex })}
        caseSensitive={search.matchCase}
        setCaseSensitive={(matchCase) => setSearch({ ...search, matchCase })}
        idPrefix={id}
        inline
        alwaysShowOptions
        onFindKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            step(event.shiftKey)
          }
        }}
        findActions={
          <>
            <Button
              className="px-2!"
              onClick={() => step(true)}
              disabled={!!navigationBlocked}
              hint={navigationBlocked ?? "Shows the previous match in this search."}
            >
              Previous
            </Button>
            <Button
              className="px-2!"
              onClick={() => step(false)}
              disabled={!!navigationBlocked}
              hint={navigationBlocked ?? "Shows the next match in this search."}
            >
              Next
            </Button>
          </>
        }
        replaceActions={
          <>
            <Button
              className="px-2!"
              disabled={pending || scanning || searchKey !== completedSearch || !included.length || !!error}
              hint={replacementBlocked ?? "Replaces the current match in this search."}
              onClick={() => void apply(true)}
            >
              Replace
            </Button>
            <Button
              className="px-2!"
              disabled={pending || scanning || searchKey !== completedSearch || !included.length || !!error}
              hint={replacementBlocked ?? "Replaces every match in this search that you haven't skipped."}
              onClick={() => void apply(false)}
            >
              Replace all
            </Button>
          </>
        }
        scopeControl={
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-xs text-muted">Look in:</span>
            <Segmented
              label="Look in"
              multiple
              value={(["messages", "swipes", "summaries"] as const).filter((key) => search[key])}
              onValueChange={(value) =>
                setSearch({
                  ...search,
                  messages: value.includes("messages"),
                  swipes: value.includes("swipes"),
                  summaries: value.includes("summaries")
                })
              }
              options={[
                { value: "messages", label: "Messages", description: "Searches the version each message shows." },
                { value: "swipes", label: "Swipes", description: "Searches each message's other versions." },
                {
                  value: "summaries",
                  label: "Summaries",
                  description: "Searches this branch's summaries of older messages."
                }
              ]}
            />
          </div>
        }
      />
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {/* Until something is searched for there is nothing to count, and nothing a replacement re-reads. */}
      <p role="status">
        {idle
          ? ""
          : scanning
            ? "Searching…"
            : `${counts((h) => h.kind === "version_replace" && h.selected)} in messages, ${counts((h) => h.kind === "version_replace" && !h.selected)} in swipes, ${counts((h) => h.kind === "summary_revision")} in summaries`}
      </p>
      {!idle && !scanning && (
        <p className="text-muted">
          {cost
            ? `The model will re-read about ${cost.messages} messages and ${cost.summaries} summaries on the next reply (cache: ~${cost.tokens.toLocaleString()} tokens).`
            : "The next reply reads the history as edited."}
        </p>
      )}
      {(["Messages", "Swipes", "Summaries"] as const).map((kind) => {
        const found = hits.filter((h) =>
          kind === "Summaries"
            ? h.kind === "summary_revision"
            : h.kind === "version_replace" && h.selected === (kind === "Messages")
        )
        // A group shows once it has something found: before a search, no empty headings.
        if (found.length === 0) return null
        return (
          <section key={kind} className="flex flex-col gap-2">
            <h3 className="font-medium">{kind}</h3>
            {found.map((hit) => (
              <article key={keyOf(hit)} className="rounded-md border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <button className="text-accent underline" onClick={() => openHit(hit)}>
                    {hit.level
                      ? `Level ${hit.level} summary, messages ${hit.depth + 1}–${hit.toDepth + 1}`
                      : `Message ${hit.depth + 1}`}
                  </button>
                  <label className="flex gap-1">
                    <input
                      type="checkbox"
                      checked={skipped.has(keyOf(hit))}
                      onChange={(e) =>
                        setSkipped((old) => {
                          const next = new Set(old)
                          if (e.target.checked) next.add(keyOf(hit))
                          else next.delete(keyOf(hit))
                          return next
                        })
                      }
                    />
                    Skip
                  </label>
                </div>
                <div className="my-2 flex flex-col gap-1">
                  {hit.matches.map((match, i) => (
                    <label key={i} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        aria-label={`Skip match ${i + 1} in message ${hit.depth + 1}`}
                        checked={skipped.has(`${keyOf(hit)}:${i}`)}
                        onChange={(e) =>
                          setSkipped((old) => {
                            const next = new Set(old)
                            const key = `${keyOf(hit)}:${i}`
                            if (e.target.checked) next.add(key)
                            else next.delete(key)
                            return next
                          })
                        }
                      />
                      <span>
                        Skip “{hit.before.slice(match.start, match.end)}” → “{match.replacement}”
                      </span>
                    </label>
                  ))}
                </div>
                <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                  <HistoryDiff hit={included.find((h) => keyOf(h) === keyOf(hit)) ?? { ...hit, matches: [] }} />
                </div>
              </article>
            ))}
          </section>
        )
      })}
    </div>
  )
}
