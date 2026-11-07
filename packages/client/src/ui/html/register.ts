// The built-in HTML parts (parts.ts), registered like a plugin's, so a plugin can replace or
// disable each by id.
import { htmlClassifiers, htmlSchemas, isDocumentBlock } from "./parts.ts"
import { htmlSchema } from "./schema.ts"

export const registerHtmlParts = () => [
  htmlSchemas.register({ id: "html.inline", order: 0, schema: htmlSchema }),
  htmlClassifiers.register({ id: "html.classifier", order: 0, isDocument: (code) => isDocumentBlock(code) })
]
