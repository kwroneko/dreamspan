import type { BinLimits } from "@rp/shared/bin.ts"
import { useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"

const limitsAtom = AppClient.query("GetBinLimits", undefined, { reactivityKeys: ["bin.limits"] })
const fields = [
  ["deletedItems", "Deleted items: item limit"],
  ["deletedBytes", "Deleted items: byte limit"],
  ["recoveredTexts", "Recovered text: item limit"],
  ["recoveredBytes", "Recovered text: byte limit"]
] as const

function CapacityField({ field, label, value }: { field: keyof BinLimits; label: string; value: number }) {
  const [text, setText] = useState(String(value))
  const action = useAction()
  const number = Number(text)
  const valid = Number.isSafeInteger(number) && number >= 1
  return (
    <form
      className="flex min-w-0 flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) void action.run((client) => client("ChangeBinLimit", { key: field, value: number }), ["bin.limits"])
      }}
    >
      <Field
        label={label}
        about="Limit how much this section keeps. Older eligible items are permanently removed when new items need room. Saving a limit removes nothing immediately."
        className="min-w-0 flex-1"
      >
        <Input
          type="number"
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          step={1}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          required
        />
      </Field>
      <Button type="submit" disabled={!valid || number === value} pending={action.pending}>
        Save
      </Button>
      <ErrorAlert error={action.error} />
    </form>
  )
}

export function BinCapacity() {
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer font-medium">Bin capacity</summary>
      <AsyncView atom={limitsAtom} loading="Reading capacities…">
        {(limits) => (
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {fields.map(([field, label]) => (
              <CapacityField key={`${field}:${limits[field]}`} field={field} label={label} value={limits[field]} />
            ))}
          </div>
        )}
      </AsyncView>
    </details>
  )
}
