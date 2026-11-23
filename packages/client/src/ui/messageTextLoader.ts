// The message text box's code (MessageTextSurface.tsx, CodeMirror and the message styling),
// fetched once. A page that shows the box as it opens (the chat's composer) waits for it with its
// own code (chatPageLoader.ts), so the box is drawn in the page's first frame, never its loading
// line first. Kept apart from MessageTextEditor.tsx so waiting for it brings nothing else along.
type SurfaceComponent = typeof import("./MessageTextSurface.tsx").default

let loaded: SurfaceComponent | null = null
let loading: Promise<{ default: SurfaceComponent }> | null = null

export const loadMessageTextEditor = () =>
  (loading ??= import("./MessageTextSurface.tsx").then(
    (module) => {
      loaded = module.default
      return module
    },
    (error: unknown) => {
      // Asked again on the next try.
      loading = null
      throw error
    }
  ))

/** The box's component once its code is here; null before. */
export const loadedMessageTextEditor = () => loaded
