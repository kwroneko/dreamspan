// A card's page (DESIGN §2.1, §4): the card without entering a chat. Continue (its latest
// chat), New chat and every chat it's in as peers, then its definition to read, each field
// folded to a few lines. Its library label is the title; the in-chat name, what `{{char}}`
// resolves to, is shown apart when it differs.
import type { CardUsage } from "@rp/shared/chatSetupApi.ts"
import type { Doc } from "@rp/shared/library.ts"
import { Link, useParams } from "@tanstack/react-router"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { AsyncView } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { buttonClass } from "../../ui/Button.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { ChatList } from "../chat/ChatList.tsx"
import { useTitle } from "../shell.tsx"
import { openTarget, usageAtom, usageLine } from "./data.ts"

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
const texts = (value: unknown) => (Array.isArray(value) ? value.map(text).filter((item) => item !== "") : [])

/** Creator notes are often HTML from the card site; they read as text here. */
const plain = (value: string) =>
  value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

/** A field's text, folded to a few lines with "Show more" when it's longer. */
function Folded({ title, children }: { title: string; children: string }) {
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const body = useRef<HTMLParagraphElement>(null)
  // Measured again whenever its width changes (a window resized, a phone turned), which can
  // fold text that fit before; open or not stays as the user left it.
  useLayoutEffect(() => {
    const element = body.current
    if (!element || open) return
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [children, open])
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <p
        ref={body}
        className={`text-sm whitespace-pre-wrap text-muted [overflow-wrap:anywhere] ${open ? "" : "line-clamp-4"}`}
      >
        {children}
      </p>
      {(long || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="self-start rounded text-sm text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          {open ? "Show less" : "Show more"}
          <span className="sr-only"> of {title.toLowerCase()}</span>
        </button>
      )}
    </section>
  )
}

function Definition({ doc }: { doc: Doc }) {
  const alternates = texts(doc.alternate_greetings)
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["Description", text(doc.description)],
    ["Personality", text(doc.personality)],
    ["Scenario", text(doc.scenario)],
    ["First message", text(doc.first_mes)],
    ["Example dialogue", text(doc.mes_example)],
    ["Creator's notes", plain(text(doc.creator_notes))]
  ]
  const shown = fields.filter(([, value]) => value !== "")
  const tags = texts(doc.tags)
  const creator = text(doc.creator)
  const version = text(doc.character_version)
  return (
    <div className="flex flex-col gap-4">
      {shown.length === 0 && <p className="text-sm text-muted">This card's definition is empty.</p>}
      {shown.map(([title, value]) => (
        <Folded key={title} title={title}>
          {value}
        </Folded>
      ))}
      {(alternates.length > 0 || tags.length > 0 || creator || version) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {alternates.length > 0 && (
            <>
              <dt className="text-muted">Other greetings</dt>
              <dd>{alternates.length} more, to pick from when a chat starts</dd>
            </>
          )}
          {tags.length > 0 && (
            <>
              <dt className="text-muted">Tags</dt>
              <dd className="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </dd>
            </>
          )}
          {creator && (
            <>
              <dt className="text-muted">Creator</dt>
              <dd className="[overflow-wrap:anywhere]">{creator}</dd>
            </>
          )}
          {version && (
            <>
              <dt className="text-muted">Version</dt>
              <dd className="[overflow-wrap:anywhere]">{version}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  )
}

function Chats({ card }: { card: CardUsage }) {
  return card.chats === 0 ? (
    <EmptyState title="No chats yet">
      <p>New chat shows its greeting; nothing is saved until you send the first message.</p>
    </EmptyState>
  ) : (
    <ChatList entityId={card.entityId} findable={card.chats > 8} />
  )
}

function Page({ card }: { card: CardUsage }) {
  useTitle(card.label)
  const docAtom = useMemo(
    () =>
      AppClient.query(
        "GetRevision",
        { refId: card.refId, revisionId: card.headRevisionId },
        { reactivityKeys: ["library"] }
      ),
    [card.refId, card.headRevisionId]
  )
  const used = card.chats > 0
  return (
    <div className="flex flex-col gap-5">
      <Link to="/" className="self-start text-sm text-muted hover:text-text">
        ← Characters
      </Link>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Avatar
          id={card.entityId}
          name={card.name}
          mediaId={card.avatarMediaId}
          size="2xl"
          className="rounded-xl"
          shape="square"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{card.label}</h1>
          {card.subtitle && <p className="text-muted [overflow-wrap:anywhere]">{card.subtitle}</p>}
          {card.name !== card.label && (
            <p className="text-sm text-muted">
              In chats as <span className="font-medium text-text">{card.name}</span>
            </p>
          )}
          <p className="text-sm text-muted">{usageLine(card)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {used && (
              <Link {...openTarget(card)} className={buttonClass("primary")}>
                Continue
              </Link>
            )}
            <Link
              to="/cards/$entityId/chat"
              params={{ entityId: card.entityId }}
              className={buttonClass(used ? "secondary" : "primary")}
            >
              New chat
            </Link>
            <Link to="/library/$refId" params={{ refId: card.refId }} className={buttonClass("ghost")}>
              Edit card
            </Link>
          </div>
        </div>
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
        <Card className="lg:order-2">
          <CardHeader
            title={used ? `Chats (${card.chats.toLocaleString()})` : "Chats"}
            description={used ? "Latest message first." : undefined}
          />
          <Chats card={card} />
        </Card>
        <Card className="lg:order-1">
          <CardHeader title="Definition" />
          <AsyncView atom={docAtom} loading="Loading the card…">
            {(doc) => <Definition doc={doc} />}
          </AsyncView>
        </Card>
      </div>
    </div>
  )
}

export function CardPage() {
  const { entityId } = useParams({ strict: false })
  return (
    <AsyncView atom={usageAtom} loading="Loading the card…">
      {(cards) => {
        const card = cards.find((it) => it.entityId === entityId)
        return card ? (
          <Page key={card.entityId} card={card} />
        ) : (
          <EmptyState title="This card isn't one of your characters">
            <p>It may be a persona, or in the bin. The library lists every card.</p>
            <Link to="/library" className={buttonClass()}>
              Open the library
            </Link>
          </EmptyState>
        )
      }}
    </AsyncView>
  )
}
