import { Field as BaseField } from "@base-ui/react/field"
import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset"
import { Input as BaseInput } from "@base-ui/react/input"
import type { ComponentProps, ReactNode } from "react"

// 16px text on touch screens, so iOS doesn't zoom into a focused field.
const control =
  "w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base text-text shadow-xs outline-none transition-shadow placeholder:text-muted focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-50 data-invalid:border-danger sm:text-sm"

/**
 * A labelled form control. Base UI ties the label, description and error to the control,
 * so screen readers announce them together.
 */
export function Field({
  label,
  description,
  error,
  children,
  className = ""
}: {
  label: ReactNode
  description?: ReactNode
  /** Shown under the control, and marks it invalid. */
  error?: string | null | undefined
  children: ReactNode
  className?: string
}) {
  return (
    <BaseField.Root invalid={error ? true : undefined} className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <BaseField.Label className="text-sm font-medium text-text">{label}</BaseField.Label>
      {children}
      {description && <BaseField.Description className="text-sm text-muted">{description}</BaseField.Description>}
      {error && (
        <BaseField.Error match className="text-sm text-danger">
          {error}
        </BaseField.Error>
      )}
    </BaseField.Root>
  )
}

export function Input({ className = "", ...props }: ComponentProps<typeof BaseInput>) {
  return <BaseInput className={`h-9 ${control} ${className}`} {...props} />
}

export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <BaseField.Control render={<textarea className={`min-h-24 py-2 ${control} ${className}`} {...props} />} />
}

/** A group of related controls with a legend, such as a set of radio buttons. */
export function Fieldset({
  legend,
  description,
  children,
  className = ""
}: {
  legend: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <BaseFieldset.Root className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <BaseFieldset.Legend className="text-sm font-medium text-text">{legend}</BaseFieldset.Legend>
      {description && <p className="text-sm text-muted">{description}</p>}
      {children}
    </BaseFieldset.Root>
  )
}
