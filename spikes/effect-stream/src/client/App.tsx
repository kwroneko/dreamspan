import { RegistryContext, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Cause, Exit, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useContext, useEffect, useRef, useState } from "react"
import type { ChatEvent, Slot, Version } from "../shared/api.ts"
import { perf } from "./perf.ts"
import { ChatClient, editFn, generateFn, makeSubscriptionAtom, stopFn, touchFn } from "./rpc.ts"
import { createAtomStore, createPlainStore, type VersionState, type VersionStore } from "./store.ts"

const CHAT_ID = "c1"
const slotsAtom = ChatClient.query("ListSlots", { chatId: CHAT_ID })

/**
 * Collects stream deltas and applies them once per animation frame, so a burst of
 * batches costs one store update per version per frame.
 */
const createIngest = (store: VersionStore, onVersionCreated: (version: Version) => void) => {
  const appended = new Map<string, string>()
  const statuses = new Map<string, VersionState["status"]>()
  let scheduled = false

  const flush = () => {
    scheduled = false
    const ids = new Set([...appended.keys(), ...statuses.keys()])
    const entries: Array<readonly [string, VersionState]> = []
    for (const id of ids) {
      const prev = store.get(id)
      entries.push([id, { ...prev, text: prev.text + (appended.get(id) ?? ""), status: statuses.get(id) ?? prev.status }])
    }
    appended.clear()
    statuses.clear()
    perf.rowUpdates += entries.length
    store.setMany(entries)
  }

  return (batch: ReadonlyArray<ChatEvent>) => {
    perf.batches++
    for (const event of batch) {
      switch (event._tag) {
        case "Delta":
          perf.deltas++
          appended.set(event.versionId, (appended.get(event.versionId) ?? "") + event.text)
          break
        case "StatusChanged":
          statuses.set(event.versionId, event.status)
          break
        case "VersionCreated":
          store.setMany([[event.version.id, {
            text: event.version.content,
            status: event.version.status,
            rowVersion: event.version.rowVersion
          }]])
          onVersionCreated(event.version)
          break
        case "ContentReplaced": {
          const prev = store.get(event.versionId)
          store.setMany([[event.versionId, { ...prev, text: event.content, rowVersion: event.rowVersion }]])
          break
        }
      }
    }
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(flush)
    }
  }
}

export function App({ mode }: { mode: "atom" | "plain" }) {
  const registry = useContext(RegistryContext)
  const [store] = useState(() => mode === "atom" ? createAtomStore(registry) : createPlainStore())
  const result = useAtomValue(slotsAtom)

  if (AsyncResult.isSuccess(result)) return <Chat initialSlots={result.value} store={store} />
  if (AsyncResult.isFailure(result)) return <pre className="error">{Cause.pretty(result.cause)}</pre>
  return <p className="loading">Loading…</p>
}

function Chat({ initialSlots, store }: { initialSlots: ReadonlyArray<Slot>; store: VersionStore }) {
  const [slots, setSlots] = useState(() => {
    store.setMany(initialSlots.flatMap((slot) =>
      slot.versions.map((v) => [v.id, { text: v.content, status: v.status, rowVersion: v.rowVersion }] as const)
    ))
    return initialSlots
  })

  const [subscription] = useState(() =>
    makeSubscriptionAtom(CHAT_ID, createIngest(store, (version) => {
      setSlots((prev) => {
        const index = prev.findLastIndex((s) => s.id === version.slotId)
        if (index < 0) return prev
        const slot = prev[index]!
        const next = prev.slice()
        next[index] = { ...slot, selectedVersionId: version.id, versions: [...slot.versions, version] } as Slot
        return next
      })
    }))
  )
  useAtomMount(subscription)

  const generate = useAtomSet(generateFn, { mode: "promiseExit" })
  const stop = useAtomSet(stopFn, { mode: "promiseExit" })
  const [rate, setRate] = useState(300)
  const running = useRef<Array<string>>([])

  useEffect(() => {
    window.__startStreams = async (tokensPerSecond, tokens) => {
      // Three parallel versions under the last slot, plus three other visible slots.
      const last = slots.length - 1
      const targets = [last, last, last, last - 1, last - 2, last - 3].map((i) => slots[i]!.id)
      const exits = await Promise.all(targets.map((slotId) => generate({ slotId, tokensPerSecond, tokens })))
      running.current = exits.flatMap((exit) => Exit.isSuccess(exit) ? [exit.value.id] : [])
    }
    window.__stopAll = async () => {
      await Promise.all(running.current.map((id) => stop(id)))
    }
  })

  return (
    <div className="app">
      <header>
        <strong>{store.kind === "atom" ? "Effect atoms" : "Plain store"}</strong>
        <span>{slots.length.toLocaleString()} slots</span>
        <label>
          tok/s <input type="number" value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        </label>
        <button onClick={() => window.__startStreams(rate, rate * 10)}>Start 6 streams</button>
        <button onClick={() => window.__stopAll()}>Stop all</button>
        <a href={store.kind === "atom" ? "?store=plain" : "?store=atom"}>switch store</a>
      </header>
      <ChatList slots={slots} store={store} />
      <Composer />
    </div>
  )
}

function ChatList({ slots, store }: { slots: ReadonlyArray<Slot>; store: VersionStore }) {
  // TanStack Virtual's instance is mutable, which React Compiler's memoization can't see.
  "use no memo"
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: slots.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    getItemKey: (index) => slots[index]!.id,
    overscan: 6,
    anchorTo: "end",
    followOnAppend: true
  })

  useEffect(() => {
    virtualizer.scrollToIndex(slots.length - 1, { align: "end" })
    const timer = setTimeout(() => { window.__ready = true }, 500)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div ref={parentRef} className="list" data-testid="list">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="row"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <SlotRow slot={slots[item.index]!} store={store} />
          </div>
        ))}
      </div>
    </div>
  )
}

function SlotRow({ slot, store }: { slot: Slot; store: VersionStore }) {
  const generating = slot.versions.filter((v) => v.id === slot.selectedVersionId || v.ordinal > 0)
  const parallel = generating.length > 1 ? generating : null
  return (
    <article className="message">
      <div className="meta">
        #{slot.depth} · {slot.versions.length} version{slot.versions.length === 1 ? "" : "s"}
      </div>
      {parallel
        ? <div className="parallel">{parallel.map((v) => <VersionView key={v.id} id={v.id} store={store} />)}</div>
        : <VersionView id={slot.selectedVersionId} store={store} />}
    </article>
  )
}

function VersionView({ id, store }: { id: string; store: VersionStore }) {
  const version = store.useVersion(id)
  const [editing, setEditing] = useState(false)
  useEffect(() => { perf.renders++ })

  if (editing) return <EditBox id={id} store={store} version={version} onDone={() => setEditing(false)} />
  return (
    <div className={`version ${version.status}`}>
      <VersionText text={version.text} />
      <div className="actions">
        {version.status === "generating" ? <StopButton id={id} /> : <button onClick={() => setEditing(true)}>Edit</button>}
        <span className="status">{version.status} · r{version.rowVersion}</span>
      </div>
    </div>
  )
}

/**
 * Finished paragraphs are separate, unchanging elements; only the last one grows
 * while streaming. The browser then re-lays out one paragraph per frame instead of
 * the whole message.
 */
function VersionText({ text }: { text: string }) {
  const paragraphs = text.split("\n\n")
  return (
    <div className="text">
      {paragraphs.map((paragraph, i) => <Paragraph key={i} text={paragraph} />)}
    </div>
  )
}

function Paragraph({ text }: { text: string }) {
  return <p>{text}</p>
}

function StopButton({ id }: { id: string }) {
  const stop = useAtomSet(stopFn, { mode: "promiseExit" })
  return <button onClick={() => stop(id)}>Stop</button>
}

function EditBox({ id, store, version, onDone }: {
  id: string
  store: VersionStore
  version: VersionState
  onDone: () => void
}) {
  const edit = useAtomSet(editFn, { mode: "promiseExit" })
  const touch = useAtomSet(touchFn, { mode: "promiseExit" })
  const [draft, setDraft] = useState(version.text)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const before = store.get(id)
    store.setMany([[id, { ...before, text: draft }]]) // optimistic
    const exit = await edit({ versionId: id, content: draft, expectedRowVersion: before.rowVersion })
    if (Exit.isSuccess(exit)) {
      store.setMany([[id, { ...before, text: exit.value.content, rowVersion: exit.value.rowVersion }]])
      onDone()
      return
    }
    store.setMany([[id, before]]) // roll back
    const failure = Cause.findErrorOption(exit.cause)
    setError(Option.match(failure, {
      onNone: () => Cause.pretty(exit.cause),
      onSome: (e) => e._tag === "StaleWrite"
        ? `Changed elsewhere (you had r${e.expected}, server has r${e.actual}). Your edit was not saved.`
        : e._tag === "NotFound" ? "This version no longer exists." : `Connection problem: ${e._tag}`
    }))
  }

  return (
    <div className="edit">
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
      <div className="actions">
        <button onClick={save}>Save</button>
        <button onClick={onDone}>Cancel</button>
        <button onClick={() => touch(id)} title="Bump the row version as if another tab saved">
          Simulate other tab
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function Composer() {
  const [text, setText] = useState("")
  return (
    <footer>
      <textarea
        data-testid="composer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type while streams run…"
        rows={2}
      />
      <span>{text.length} chars</span>
    </footer>
  )
}
