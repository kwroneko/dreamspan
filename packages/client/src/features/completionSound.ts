// Browser-local, as for system notifications. A notice never resumes suspended audio:
// only an interaction does, so a blocked sound cannot play late after the user returns.
const KEY = "rp.notifications.sound"
let audio: AudioContext | undefined

export const soundWanted = () => {
  try {
    return localStorage.getItem(KEY) === "on"
  } catch {
    return false
  }
}
export const canSound = () => typeof AudioContext !== "undefined"
export const setSoundWanted = (wanted: boolean) => {
  try {
    localStorage.setItem(KEY, wanted ? "on" : "off")
  } catch {
    /* Browser storage unavailable. */
  }
}
export const activateSound = () => {
  if (!soundWanted() || !canSound()) return
  try {
    audio ??= new AudioContext()
    void audio.resume().catch(() => {})
  } catch {
    /* Audio unavailable in this browser. */
  }
}
export const playCompletionSound = () => {
  if (!soundWanted() || audio?.state !== "running") return
  try {
    const tone = audio.createOscillator()
    const gain = audio.createGain()
    const at = audio.currentTime
    tone.frequency.setValueAtTime(660, at)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.12, at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.22)
    tone.connect(gain)
    gain.connect(audio.destination)
    tone.onended = () => {
      tone.disconnect()
      gain.disconnect()
    }
    tone.start(at)
    tone.stop(at + 0.24)
  } catch {
    /* A device change must not interrupt notices. */
  }
}
