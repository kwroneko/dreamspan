// What reaches a run while it works (spec/SUBAGENTS.md §3.2, §4): its background subagents'
// reports and progress, and, for a subagent, the messages its parent sends it. Each arrives at the
// run's next request boundary as an app message in its transcript; a run whose model ended its
// turn waits here while background subagents still run, and goes on when the next report comes.
import type { AgentMessage } from "@earendil-works/pi-agent-core"

export class Mailbox {
  private mail: Array<AgentMessage> = []
  /** At most one undelivered progress note per subagent: a later one replaces it. */
  private readonly notes = new Map<string, AgentMessage>()
  /** Background subagents still running, by the call that started them. */
  private readonly running = new Set<string>()
  private wake: (() => void) | null = null
  private closed = false

  /** Queues a message for the next boundary; false once the run has ended and can't take it. */
  post(message: AgentMessage): boolean {
    if (this.closed) return false
    this.mail.push(message)
    this.ring()
    return true
  }

  /** A progress note: delivered with the next boundary, replacing an undelivered one by `key`. */
  note(key: string, message: AgentMessage) {
    if (!this.closed) this.notes.set(key, message)
  }

  /** A background subagent started by `callId` runs: the run won't end before it reports. */
  start(callId: string) {
    this.running.add(callId)
  }

  /** It ended (its report posted, or it was stopped with the run). */
  end(callId: string) {
    if (this.running.delete(callId)) this.ring()
  }

  /** How many background subagents the run still waits for. */
  get waitingFor() {
    return this.running.size
  }

  /** Whether a message waits to be delivered (progress alone doesn't wake a run). */
  get hasMail() {
    return this.mail.length > 0
  }

  /** What the next request takes: the messages, then the progress notes. */
  drain(): Array<AgentMessage> {
    const out = [...this.mail, ...this.notes.values()]
    this.mail = []
    this.notes.clear()
    return out
  }

  /** Resolves when a message arrives or a background subagent ends. */
  next(): Promise<void> {
    if (this.mail.length > 0) return Promise.resolve()
    return new Promise((resolve) => {
      const previous = this.wake
      this.wake = () => {
        previous?.()
        resolve()
      }
    })
  }

  /** The run has ended: later posts are refused, so a sender knows it wasn't delivered. */
  close() {
    this.closed = true
    this.ring()
  }

  get isClosed() {
    return this.closed
  }

  private ring() {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}
