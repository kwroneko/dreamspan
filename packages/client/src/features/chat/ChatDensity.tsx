// Message spacing (the compact reading mode; ST-COMPARISON "less story per screen"): per account,
// in Settings → Interface and the chat's Interface panel. Comfortable is the look every chat had
// before; Compact tightens the list. The list (`MessageList`) puts the choice on its scroller as
// `data-chat-density`, which styles.css and the `compact:` variant read, so rows restyle without
// rendering again; the numbers the virtualizer needs, and how it keeps the reader's place when
// the choice changes, are in readingPlace.ts.
import { RadioGroup } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"

export function ChatDensitySetting() {
  const viewer = useViewPrefs()
  return (
    <Fieldset legend="Message spacing" about="Sets how much room messages take in a chat, on all your devices.">
      <RadioGroup
        value={viewer.prefs.chatDensity}
        disabled={!viewer.ready}
        onValueChange={(chatDensity) => void viewer.change({ chatDensity })}
        options={[
          { value: "comfortable", label: "Comfortable", description: "Roomy spacing, with every control in view." },
          {
            value: "compact",
            label: "Compact",
            description:
              "Fits more of the story on screen. A message's version arrows show when you point at it or tap it; the newest message always shows them."
          }
        ]}
      />
    </Fieldset>
  )
}
