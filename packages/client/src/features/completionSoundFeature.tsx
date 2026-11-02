import { useState } from "react"
import { Switch } from "../ui/Choice.tsx"
import { Alert } from "../ui/Surface.tsx"
import { activateSound, canSound, playCompletionSound, setSoundWanted, soundWanted } from "./completionSound.ts"
import { noticeChannels } from "./noticeContributions.tsx"

function CompletionSoundSettings() {
  const [sound, setSound] = useState(soundWanted)
  return canSound() ? (
    <Switch
      checked={sound}
      onCheckedChange={(next) => {
        setSoundWanted(next)
        setSound(next)
        if (next) activateSound()
      }}
      about="Hear when a reply finishes in another chat. Applies in this browser; click or type once after opening the app to allow sound."
    >
      Completion sound
    </Switch>
  ) : (
    <Alert>This browser can't play completion sounds.</Alert>
  )
}

export const register = () =>
  noticeChannels.register({
    id: "notifications.completion-sound",
    component: CompletionSoundSettings,
    activate: activateSound,
    receive: playCompletionSound
  })
