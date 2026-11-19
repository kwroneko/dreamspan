// The built-in HTML parts (parts.ts), registered like a plugin's, so a plugin can replace or
// disable each by id.
import { DocumentFrame } from "./DocumentFrame.tsx"
import { documentRenderers, htmlClassifiers, htmlSchemas, isDocumentBlock, panelApis } from "./parts.ts"
import { htmlSchema } from "./schema.ts"

export const registerHtmlParts = () => [
  htmlSchemas.register({ id: "html.inline", order: 0, schema: htmlSchema }),
  htmlClassifiers.register({ id: "html.classifier", order: 0, isDocument: (code) => isDocumentBlock(code) }),
  documentRenderers.register({ id: "html.frame", order: 0, component: DocumentFrame }),
  // Tier B: Tavern Helper's read calls, answered from the panel's message and those before it.
  panelApis.register({ id: "frames.tavernHelper", order: 0, read: (source, slotId) => source.read(slotId) })
]
