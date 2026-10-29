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
      description="In this browser only, for replies that finish elsewhere. After opening or reloading the app, interact with it once to allow audio. Blocked sounds are skipped."
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
