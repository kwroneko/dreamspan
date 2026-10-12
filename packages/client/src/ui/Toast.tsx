// Toasts: short notices in a corner, announced politely, with up to two actions. Base UI
// carries the timing, focus and announcements; `showToast` works from anywhere.
import { Toast as BaseToast } from "@base-ui/react/toast"
import { buttonClass } from "./Button.tsx"

interface ToastAction {
  readonly label: string
  readonly onClick: () => void
}

interface ToastData {
  readonly actions: ReadonlyArray<ToastAction>
}

const manager = BaseToast.createToastManager<ToastData>()

/** Shows a toast for eight seconds, or until dismissed. */
export const showToast = (options: {
  readonly title: string
  readonly description?: string
  readonly actions?: ReadonlyArray<ToastAction>
}) =>
  manager.add({
    title: options.title,
    ...(options.description ? { description: options.description } : {}),
    timeout: 8000,
    data: { actions: options.actions ?? [] }
  })

function ToastList() {
  const { toasts, close } = BaseToast.useToastManager<ToastData>()
  return toasts.map((toast) => (
    <BaseToast.Root
      key={toast.id}
      toast={toast}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-sm text-text shadow-lg outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <BaseToast.Title className="font-medium [overflow-wrap:anywhere]" />
          <BaseToast.Description className="truncate text-muted" />
        </div>
        <BaseToast.Close aria-label="Dismiss" className={buttonClass("ghost")}>
          ×
        </BaseToast.Close>
      </div>
      {(toast.data?.actions.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          {toast.data!.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={buttonClass("secondary")}
              onClick={() => {
                close(toast.id)
                action.onClick()
              }}
            >
              {action.label}
            </button>
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
        <BaseToast.Viewport className="fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  )
}
