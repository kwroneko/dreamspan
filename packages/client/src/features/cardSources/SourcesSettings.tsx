// Settings → Card sources (spec/CARD-SOURCES.md §5.2): per source, the user's switch, the
// admin's switch for every account, the API key (write-only) and clearing what's cached; for
// admins, the instance's cache cap. Nothing here contacts a source.
import type { SourceInfo, SourceList } from "@dreamspan/shared/cardSources.ts"
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import { useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { editableByteSize, parseByteSize, type SizeUnit } from "../../ui/byteSize.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Field, formText, Input, SecretInput } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { SOURCES_KEY, sourcesAtom } from "./remote.ts"

const unitItems = [
  { value: "MB" as const, label: "MB", description: "Set the size in megabytes." },
  { value: "GB" as const, label: "GB", description: "Set the size in gigabytes." }
]

function KeyForm({ source }: { source: SourceInfo }) {
  const action = useAction()
  const [empty, setEmpty] = useState(true)
  const [saved, setSaved] = useState<"saved" | "removed" | null>(null)
  const save = async (key: string | null) => {
    setSaved(null)
    const result = await action.run((client) => client("SetCardSourceKey", { sourceId: source.id, key }), [SOURCES_KEY])
    if (result.ok) setSaved(key === null ? "removed" : "saved")
  }
  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const key = formText(form, "key").trim()
        if (key === "") return
        void save(key).then(() => form.reset())
      }}
    >
      <Field
        label="API key"
        about={
          source.key === "required"
            ? `${source.name} needs a key. It's kept on this server and never shown again.`
            : `Optional. Kept on this server and never shown again.`
        }
        description={source.hasKey ? "A key is saved." : "No key saved."}
      >
        <SecretInput name="key" onEmptyChange={setEmpty} placeholder={source.hasKey ? "Enter a new key" : undefined} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" hint={`Saves this key for ${source.name}.`} pending={action.pending} disabled={empty}>
          Save key
        </Button>
        <Button
          variant="ghost"
          hint={source.hasKey ? `Removes the saved key for ${source.name}.` : "No key is saved."}
          disabled={!source.hasKey || action.pending}
          onClick={() => void save(null)}
        >
          Remove key
        </Button>
      </div>
      <ErrorAlert error={action.error} title="Not saved" />
      {saved && <Alert tone="success">{saved === "saved" ? "Key saved." : "Key removed."}</Alert>}
    </form>
  )
}

function SourceCard({ source, isAdmin }: { source: SourceInfo; isAdmin: boolean }) {
  const action = useAction()
  const [cleared, setCleared] = useState(false)
  const name = source.name
  return (
    <Card>
      <div data-card-source={source.id} className="flex min-w-0 flex-col gap-4">
        <CardHeader title={name} />
        <Switch
          checked={source.userEnabled}
          disabled={source.adminDisabled || action.pending}
          onCheckedChange={(enabled) =>
            void action.run((client) => client("SetCardSourceEnabled", { sourceId: source.id, enabled }), [SOURCES_KEY])
          }
          hint={
            source.adminDisabled
              ? `Unavailable until an admin allows ${name} on this server again.`
              : source.userEnabled
                ? `Click to remove ${name} from the Show choices on the home page and in the side panel.`
                : `Click to add ${name} to the Show choices on the home page and in the side panel.`
          }
          description={
            source.adminDisabled
              ? `An admin turned ${name} off for this server.`
              : `Nothing is sent to ${name} until you open it.`
          }
        >
          Show {name}
        </Switch>
        {isAdmin && (
          <Switch
            checked={!source.adminDisabled}
            disabled={action.pending}
            onCheckedChange={(allowed) =>
              void action.run(
                (client) => client("SetCardSourceAdminDisabled", { sourceId: source.id, disabled: !allowed }),
                [SOURCES_KEY]
              )
            }
            hint={
              source.adminDisabled
                ? `Click to let every account turn ${name} on.`
                : `Click to turn ${name} off for every account on this server.`
            }
            description="Admins only."
          >
            Allow {name} on this server
          </Switch>
        )}
        {source.key !== "none" && <KeyForm source={source} />}
        <div className="flex flex-col items-start gap-2">
          <Button
            hint={`Removes the cards, pages and pictures cached for you from ${name}, and your recently viewed list.`}
            pending={action.pending}
            onClick={async () => {
              setCleared(false)
              const result = await action.run(
                (client) => client("ClearSourceCache", { sourceId: source.id }),
                [SOURCES_KEY]
              )
              setCleared(result.ok)
            }}
          >
            Clear cached cards
          </Button>
          {cleared && <Alert tone="success">Cleared.</Alert>}
        </div>
        <ErrorAlert error={action.error} />
      </div>
    </Card>
  )
}

function CacheCap({ cache }: { cache: NonNullable<SourceList["cache"]> }) {
  const initial = editableByteSize(cache.capBytes)
  const [text, setText] = useState(initial.text)
  const [unit, setUnit] = useState<SizeUnit>(initial.unit)
  const action = useAction()
  const bytes = parseByteSize(text, unit)
  const valid = bytes !== null && bytes >= 16 * 1024 ** 2 && bytes <= 1024 ** 4
  return (
    <Card>
      <form
        className="flex min-w-0 flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) void action.run((client) => client("SetSourceCacheCap", { bytes }), [SOURCES_KEY])
        }}
      >
        <CardHeader
          title="Cache"
          description={`${formatByteSize(cache.usedBytes)} of ${formatByteSize(cache.capBytes)} used, for every account.`}
        />
        <Field
          label="Cache size limit"
          about="The oldest cached cards and pictures are removed past this size. Admins only."
          error={valid ? null : "Enter a size from 16 MB to 1024 GB."}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Input inputMode="decimal" value={text} onChange={(event) => setText(event.currentTarget.value)} />
            <Select<SizeUnit>
              ariaLabel="Cache size limit unit"
              items={unitItems}
              value={unit}
              onValueChange={setUnit}
              className="w-20! shrink-0"
            />
            <Button
              type="submit"
              disabled={!valid || bytes === cache.capBytes}
              pending={action.pending}
              hint="Saves the cache size limit."
            >
              Save
            </Button>
          </div>
        </Field>
        <ErrorAlert error={action.error} title="Not saved" />
      </form>
    </Card>
  )
}

export function SourcesSettingsPage() {
  useTitle("Card sources")
  const session = useSession()
  const isAdmin = session.user.role === "admin"
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AsyncView atom={sourcesAtom} loading="Reading card sources…">
        {(list) =>
          list.sources.length === 0 ? (
            <Card>
              <CardHeader center title="Card sources" />
              <p className="text-sm text-muted">No card sources are set up on this server.</p>
            </Card>
          ) : (
            <>
              {list.sources.map((source) => (
                <SourceCard key={source.id} source={source} isAdmin={isAdmin} />
              ))}
              {isAdmin && list.cache && <CacheCap key={list.cache.capBytes} cache={list.cache} />}
            </>
          )
        }
      </AsyncView>
    </div>
  )
}
