// The working-folder chip (spec/FILES-AND-ENVIRONMENT.md §2.2; owner: "we have space next to model
// and preset"): in a workshop's next-reply strip after Model and Preset, the folder the assistant's
// commands start in on this branch, by its last name ("All files" at the top). Its popover, the
// strip's usual full-width rows: the full path, the assistant card's remembered folder when it
// differs, the folders picked last, the folders of Files one level at a time, New folder here and
// Use the top of Files. Choosing one writes `workshop.folder` on this branch (`WorkshopFolder`),
// which the server also remembers for the card (§2.3). A folder gone outside the app, and not found
// again by its inode, shows the warning tone: the next turn starts at the top.
import { FILES_TOP, isTop, joinPath, nameOf, nameProblem } from "@dreamspan/shared/files.ts"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { ComposerControlContext } from "../chat/composerControls.tsx"
import { ChipText, chipClass, LoadingChip } from "../chat/nextReplyStrip.tsx"
import type { ChatSession } from "../chat/session.ts"
import { FolderTree } from "./FolderTree.tsx"
import { onFolderChanged } from "./live.ts"
import { useFilesSource } from "./source.ts"

interface Choices {
  readonly current: string | null
  readonly recent: ReadonlyArray<string>
  readonly card: string | null
}

const folderLabel = (path: string) => (isTop(path) ? "All files" : nameOf(path))

/** The branch's stored folder and the workshop's assistant card, from the cast at the leaf shown. */
const useStored = (session: ChatSession) => {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const stored = cast?.workshopFolder ?? null
  const card = cast?.cards.find((c) => !c.persona && cast.participants.includes(c.entityId)) ?? null
  return { cast, stored, cardId: card?.entityId ?? null, cardName: card?.name ?? null }
}

/**
 * Where the folder is now, the recent ones and the card's: read again when the stored one changes.
 * `enabled` false (a chat that isn't a workshop) reads nothing.
 */
export const useFolderChoices = (session: ChatSession, enabled = true) => {
  const { cast, stored, cardId, cardName } = useStored(session)
  const read = useAction()
  const run = read.run
  const [choices, setChoices] = useState<{ key: string; value: Choices } | null>(null)
  const [version, setVersion] = useState(0)
  const key = `${stored?.path ?? ""}\0${stored?.inode ?? ""}\0${cardId ?? ""}\0${version}`
  useEffect(() => {
    if (cast === null || !enabled) return
    let live = true
    void run((client) => client("WorkshopFolderChoices", { chatId: session.chatId, stored, cardId })).then((result) => {
      if (live && result.ok) setChoices({ key, value: result.value })
    })
    return () => {
      live = false
    }
    // `run` is a new function each render; the key names what the answer is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cast === null, enabled])
  // A folder renamed or deleted elsewhere: look again.
  useEffect(() => {
    if (!stored) return
    const parent = stored.path.slice(0, stored.path.lastIndexOf("/")) || FILES_TOP
    return onFolderChanged(parent, () => setVersion((v) => v + 1))
  }, [stored])
  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  const choose = useCallback(
    async (path: string) => {
      const outcome = await session.changeCast({ _tag: "WorkshopFolder", path })
      if (!outcome.ok) throw new Error(outcome.error.message)
    },
    [session]
  )
  return {
    ready: cast !== null && choices !== null && choices.key === key,
    choices: choices?.value ?? null,
    stored,
    cardName,
    refresh,
    choose
  }
}

export function FolderChip({ session }: ComposerControlContext) {
  const folder = useFolderChoices(session)
  const source = useFilesSource()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [pending, setPending] = useState(false)
  if (!folder.ready || !folder.choices) return <LoadingChip label="Working folder" />
  const { current, recent, card } = folder.choices
  const gone = current === null
  const shown = current ?? FILES_TOP
  const pick = async (path: string) => {
    setPending(true)
    setError(null)
    try {
      await folder.choose(path)
      setOpen(false)
      setNaming(false)
    } catch (cause) {
      setError(`The folder wasn't changed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setPending(false)
    }
  }
  const makeFolder = async (name: string) => {
    const problem = nameProblem(name)
    if (problem) return setError(problem)
    if (!source) return
    setPending(true)
    try {
      const made = await source.createFolder(joinPath(shown, name))
      setPending(false)
      await pick(made.path)
    } catch (cause) {
      setPending(false)
      setError(`The folder wasn't made: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  const others = recent.filter((path) => path !== shown && path !== card).slice(0, 5)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) folder.refresh()
        else setNaming(false)
      }}
      trigger={
        <ChipText>
          <span className="inline-flex min-w-0 items-center gap-1" data-folder-chip={shown}>
            <Icon name="folder" size={14} />
            <span className="min-w-0 truncate">{gone ? "Folder not found" : folderLabel(shown)}</span>
          </span>
        </ChipText>
      }
      triggerLabel={gone ? "Working folder: not found" : `Working folder: ${shown}`}
      hint={
        gone
          ? `${folder.stored?.path ?? "The folder"} isn't in your files any more. Commands start at the top of your files until you choose another.`
          : "Where the assistant's commands start. It can still reach all your files."
      }
      triggerClassName={chipClass(gone ? "warning" : "neutral")}
      title="Working folder"
    >
      <div className="-mx-2 flex min-h-0 flex-col gap-2 overflow-y-auto px-2" data-folder-popover="">
        <p className="px-2 text-sm [overflow-wrap:anywhere]" data-folder-current="">
          {gone ? (
            <span className="text-warning">Not found: {folder.stored?.path}</span>
          ) : (
            <>
              Commands start in <span className="font-medium">{shown}</span>
            </>
          )}
        </p>
        {card && (
          <FolderRow
            path={card}
            label={`Use ${folder.cardName ?? "the assistant"}'s folder: ${card}`}
            hint={`The folder you last chose for ${folder.cardName ?? "this assistant"}.`}
            disabled={pending}
            onPick={(path) => void pick(path)}
          />
        )}
        {others.length > 0 && (
          <section aria-label="Recent" className="flex flex-col">
            <h3 className="px-2 text-xs font-medium text-muted">Recent</h3>
            {others.map((path) => (
              <FolderRow
                key={path}
                path={path}
                label={path}
                hint="A folder you chose recently."
                disabled={pending}
                onPick={(at) => void pick(at)}
              />
            ))}
          </section>
        )}
        {source && (
          <section aria-label="Your files" className="flex flex-col gap-1">
            <h3 className="px-2 text-xs font-medium text-muted">Your files</h3>
            <FolderTree source={source} folder={shown} onFolder={(path) => void pick(path)} version={0} />
          </section>
        )}
        {naming ? (
          <form
            className="flex min-w-0 flex-wrap items-center gap-2 px-2"
            onSubmit={(event) => {
              event.preventDefault()
              const value = new FormData(event.currentTarget).get("name")
              void makeFolder(String(value ?? "").trim())
            }}
          >
            <Input
              name="name"
              aria-label="Name of the new folder"
              defaultValue="New folder"
              autoFocus
              className="min-w-0 flex-1 basis-32"
            />
            <Button
              type="submit"
              variant="primary"
              hint={`Makes the folder in ${shown} and works there.`}
              pending={pending}
            >
              Make folder
            </Button>
            <Button hint="Leaves the folder as it is." onClick={() => setNaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2 px-2">
            <Button
              hint={`Makes a new folder in ${shown} and works there.`}
              disabled={pending || !source}
              onClick={() => setNaming(true)}
            >
              <Icon name="plus" />
              New folder here
            </Button>
            {!isTop(shown) || gone ? (
              <Button
                hint="Commands start at the top of your files."
                disabled={pending}
                onClick={() => void pick(FILES_TOP)}
              >
                Use the top of Files
              </Button>
            ) : null}
          </div>
        )}
        {error && (
          <p role="alert" className="px-2 text-sm text-danger [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
        <p className="shrink-0 border-t border-border px-2 pt-2 text-xs text-muted">This holds for this branch only.</p>
      </div>
    </Popover>
  )
}

function FolderRow({
  path,
  label,
  hint,
  disabled,
  onPick
}: {
  path: string
  label: string
  hint: string
  disabled: boolean
  onPick: (path: string) => void
}) {
  return (
    <Tooltip label={hint}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick(path)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
      >
        <Icon name="folder" size={14} className="shrink-0 text-muted" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
      </button>
    </Tooltip>
  )
}
