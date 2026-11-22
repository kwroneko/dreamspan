// Settings → Media sites (spec/SAVED-MEDIA.md §3.2): the sites this account saves card media
// from without asking. Removing one doesn't delete what was saved from it.
import { useDurableText } from "../editor/durable.tsx"
import { isHostName, normalizeHost, type MediaHosts } from "@dreamspan/shared/savedMedia.ts"
import { useEffect, useState, type FormEvent } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { savedMedia } from "../../ui/html/savedMedia.ts"
import { useCaller } from "../editor/caller.ts"
import { useTitle } from "../shell.tsx"
import { askMediaApproval } from "./approval.ts"

export function MediaSitesPage() {
  useTitle("Media sites")
  const call = useCaller()
  const [hosts, setHosts] = useState<MediaHosts | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const typed = useDurableText("media-sites:add", "Site", "")
  const host = typed.text
  const [subdomains, setSubdomains] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void call((client) => client("GetMediaHosts", undefined)).then((result) => {
      if (!active) return
      if (result.ok) setHosts(result.value)
      else setError(result.error)
    })
    return () => {
      active = false
    }
  }, [call])

  const change = async (key: string, payload: Parameters<typeof changeHosts>[1]) => {
    setPending(key)
    setError(null)
    const result = await changeHosts(call, payload)
    setPending(null)
    if (!result.ok) return setError(result.error)
    setHosts(result.value)
    savedMedia.forget()
    return true
  }
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = normalizeHost(host)
    if (!isHostName(name)) return setInvalid("Enter a site's name, like i.example.com.")
    setInvalid(null)
    if (await change("add", { add: { host: name, subdomains } })) {
      void typed.commit(async () => true)
      setSubdomains(false)
    }
  }

  return (
    <>
      <CardHeader
        center
        title="Media sites"
        about="When you import or save a card, its images, sounds and fonts from these sites are saved here, so viewing it never contacts them. Files on other sites wait until you approve their site."
      />
      <div className="flex flex-col gap-6">
        <ErrorAlert error={error} />
        <Card>
          <CardHeader
            title="Approved sites"
            actions={
              <Button
                hint="Lists every file waiting for a site you haven't approved, from all your entries."
                onClick={() => askMediaApproval(null)}
              >
                Review waiting files
              </Button>
            }
          />
          {hosts === null ? (
            <Spinner />
          ) : hosts.hosts.length === 0 ? (
            <EmptyState title="No approved sites">Every new site asks first.</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {hosts.hosts.map((entry) => (
                <li key={entry.host} className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium [overflow-wrap:anywhere]">{entry.host}</span>
                    {entry.subdomains && <span className="text-sm text-muted">and its subdomains</span>}
                  </div>
                  <Button
                    variant="ghost"
                    hint="Stops saving new files from this site without asking. Files already saved stay."
                    pending={pending === entry.host}
                    onClick={() => void change(entry.host, { remove: entry.host })}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Add a site" />
          <form className="flex flex-col gap-3" onSubmit={(event) => void add(event)}>
            <Field label="Site" error={invalid}>
              <Input
                value={host}
                readOnly={!typed.ready}
                onChange={(event) => typed.setText(event.target.value)}
                placeholder="i.example.com"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Checkbox
              checked={subdomains}
              onCheckedChange={setSubdomains}
              hint="Also approves every site under it, like i.example.com for example.com."
            >
              Include subdomains
            </Checkbox>
            <Button
              type="submit"
              variant="primary"
              className="self-start"
              hint="Adds the site and saves the files waiting for it."
              pending={pending === "add"}
            >
              Add
            </Button>
          </form>
        </Card>
      </div>
    </>
  )
}

const changeHosts = (
  call: ReturnType<typeof useCaller>,
  payload: { readonly add?: { host: string; subdomains: boolean }; readonly remove?: string }
) => call((client) => client("ChangeMediaHosts", payload), ["mediaHosts", "savedMedia"])
