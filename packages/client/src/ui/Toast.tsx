// Toasts: short notices in a corner, announced politely, with up to two actions. Base UI
// carries the timing, focus and announcements; `showToast` works from anywhere.
import { Toast as BaseToast } from "@base-ui/react/toast"
import { iconButtonClass, Tooltip } from "./Tooltip.tsx"
import { buttonClass } from "./Button.tsx"
import { Icon } from "./Icon.tsx"

interface ToastAction {
  readonly label: string
  readonly hint?: string
  readonly onClick: () => void
}

interface ToastData {
  readonly actions: ReadonlyArray<ToastAction>
}

const manager = BaseToast.createToastManager<ToastData>()

/**
 * Shows a toast for eight seconds (or `timeout` ms), or until dismissed. Its time stands
 * still while the pointer is over the toasts or focus is in them.
 */
export const showToast = (options: {
  readonly title: string
  readonly description?: string
  readonly actions?: ReadonlyArray<ToastAction>
  readonly timeout?: number
}) =>
  manager.add({
    title: options.title,
    ...(options.description ? { description: options.description } : {}),
    timeout: options.timeout ?? 8000,
    data: { actions: options.actions ?? [] }
  })

function ToastList() {
  const { toasts, close } = BaseToast.useToastManager<ToastData>()
  return toasts.map((toast) => (
    <BaseToast.Root
      key={toast.id}
      toast={toast}
      data-toast
      // A toast past the limit stays in Base UI's list, inert until one above it goes: hidden
      // meanwhile, where it used to show as a toast whose buttons did nothing.
      className="relative flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-sm text-text shadow-lg outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-limited:hidden data-starting-style:opacity-0 motion-reduce:transition-none"
    >
      {/* Room on the right for the corner's × (its 28px, less the padding it overlaps). */}
      <div className="flex min-w-0 flex-col gap-0.5 pr-6">
        <BaseToast.Title className="font-medium [overflow-wrap:anywhere]" />
        <BaseToast.Description className="truncate text-muted" />
      </div>
      <Tooltip label="Dismiss">
        <BaseToast.Close
          aria-label="Dismiss"
          data-toast-close
          className={`${iconButtonClass()} absolute top-1.5 right-1.5 size-7`}
        >
          <Icon name="close" />
        </BaseToast.Close>
      </Tooltip>
      {(toast.data?.actions.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          {toast.data!.actions.map((action) => (
            <Tooltip key={action.label} label={action.hint ?? action.label}>
              <button
                type="button"
                className={buttonClass("secondary")}
                onClick={() => {
                  close(toast.id)
                  action.onClick()
                }}
              >
                {action.label}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
    </BaseToast.Root>
  ))
}

/** Where toasts show: mounted once, around the app. */
export function Toasts({ children }: { children: React.ReactNode }) {
  return (
    <BaseToast.Provider toastManager={manager} limit={3}>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport
          data-layout-overlay="Notices float over the page; their own contents keep normal spacing"
          className="fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none"
        >
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  )
}
