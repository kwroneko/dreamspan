import { useDurableForm, useOpenPlace } from "../editor/durable.tsx"
import type { BinLimits } from "@dreamspan/shared/bin.ts"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { editableByteSize, parseByteSize, type SizeUnit } from "../../ui/byteSize.ts"
import { Field, Input } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Disclosure } from "../../ui/Surface.tsx"

const limitsAtom = AppClient.query("GetBinLimits", undefined, { reactivityKeys: ["bin.limits"] })
const fields = [
  ["deletedItems", "Deleted items: item limit"],
  ["deletedBytes", "Deleted items: size limit"],
  ["recoveredTexts", "Recovered text: item limit"],
  ["recoveredBytes", "Recovered text: size limit"]
] as const
const unitItems = [
  { value: "MB" as const, label: "MB", description: "Set the size in megabytes." },
  { value: "GB" as const, label: "GB", description: "Set the size in gigabytes." }
]
const grouped = (text: string) => (/^\d+$/.test(text) ? text.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : text)

function CapacityField({ field, label, value }: { field: keyof BinLimits; label: string; value: number }) {
  const size = field === "deletedBytes" || field === "recoveredBytes"
  const initial = editableByteSize(value)
  const form = useDurableForm(`bin-capacity:${field}`, label, {
    text: size ? initial.text : grouped(String(value)),
    unit: initial.unit as SizeUnit
  })
  const { text, unit } = form.values
  const setText = (next: string) => form.edit({ text: next })
  const setUnit = (next: SizeUnit) => form.edit({ unit: next })
  const action = useAction()
  const plain = size ? text.replace(",", ".") : text.replaceAll(",", "")
  const number = size ? parseByteSize(plain, unit) : /^\d+$/.test(plain) ? Number(plain) : null
  const valid = number !== null && Number.isSafeInteger(number) && number >= 1
  return (
    <form
      className="flex min-w-0 flex-col items-start gap-2"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (valid)
          void form.commit(async () => {
            const result = await action.run(
              (client) => client("ChangeBinLimit", { key: field, value: number }),
              ["bin.limits"]
            )
            return result.ok
          })
      }}
    >
      <Field
        label={label}
        about="Set how much this section keeps before older eligible items are removed."
        error={
          valid
            ? null
            : size
              ? "Enter a positive size within the supported range."
              : "Enter a positive whole number up to 9,007,199,254,740,991."
        }
        className="w-full"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Input
            inputMode={size ? "decimal" : "numeric"}
            value={text}
            onBlur={() => {
              if (!size) setText(grouped(text))
            }}
            onChange={(event) => {
              const value = event.currentTarget.value
              setText(size ? value : value.replaceAll(",", ""))
            }}
            required
          />
          {size && (
            <Select<SizeUnit>
              ariaLabel={`${label} unit`}
              items={unitItems}
              value={unit}
              onValueChange={setUnit}
              className="w-20! shrink-0"
            />
          )}
          <Button
            type="submit"
            disabled={!valid || number === value}
            pending={action.pending}
            hint={`Save the ${label.toLowerCase()}.`}
          >
            Save
          </Button>
        </div>
      </Field>
      <ErrorAlert error={action.error} />
    </form>
  )
}

export function BinCapacity() {
  const [open, setOpen] = useOpenPlace("bin-capacity")
  return (
    <Disclosure title="Bin capacity" className="rounded-md border border-border p-3" open={open} onOpenChange={setOpen}>
      <AsyncView atom={limitsAtom} loading="Reading capacities…">
        {(limits) => (
          <div className="grid min-w-0 gap-3 pb-2 lg:grid-cols-2">
            {fields.map(([field, label]) => (
              <CapacityField key={`${field}:${limits[field]}`} field={field} label={label} value={limits[field]} />
            ))}
          </div>
        )}
      </AsyncView>
    </Disclosure>
  )
}
