/**
 * The admission registry: the one place a refusal can be decided.
 *
 * A filter is synchronous on purpose. It runs inside `Session.append`, which is
 * synchronous and is the durable log's acceptance boundary — an asynchronous
 * filter could only answer after the row it is meant to refuse had already been
 * written.
 *
 * @module
 */

/** What a filter is shown. Attachment bytes are never part of it. */
export interface AdmissionInput {
  /** The session the prompt is about to be written to. */
  readonly session: object
  /** Which pending list the message would join. */
  readonly target: string
  /** The message as it would be written, untouched. */
  readonly message: unknown
  /** The message's `source.kind`. */
  readonly kind: string
  /** The message's text blocks joined; empty when it carries no text. */
  readonly text: string
  /** Stable identity of the message, when it has one. */
  readonly messageId: string | undefined
}

/** What a filter answers: nothing admits the message, a reason refuses it. */
export type AdmissionVerdict = void | undefined | { readonly refuse: string }

/** One admission filter. */
export type AdmissionFilter = (input: AdmissionInput) => AdmissionVerdict

/** What the registry counts. */
export interface RegistryCounts {
  /** Registered filters, live. */
  readonly filters: number
  /** Messages a filter refused (or, in observe mode, would have refused). */
  readonly refused: number
  /** Filter calls that threw and were failed open. */
  readonly failures: number
  /** Messages that passed every filter. */
  readonly admitted: number
}

/**
 * The refusal a filter asked for.
 *
 * `toString()` answers the refusal text alone — no `Error:` prefix — because the
 * session controller turns a foreign throw from the send path into a
 * `RemoteError` whose `details.reason` is `String(error)`, and that sentence is
 * what the composer ends up showing. The wire code stays the host's own
 * (`session/agent-busy`): a code this plugin invented would have no locale entry
 * in any client and would render worse than the text it replaced.
 */
export class PromptRefused extends Error {
  /** The filter that refused, when it named itself. */
  readonly filterId: string | undefined

  /**
   * @param message - the sentence the sender will read.
   * @param filterId - the refusing filter's id, when it has one.
   */
  constructor(message: string, filterId?: string) {
    super(message)
    this.name = 'PromptRefused'
    this.filterId = filterId
  }

  /** @returns the refusal text alone, so a host that stringifies gets a sentence. */
  override toString(): string {
    return this.message
  }
}

/** One registered filter and its identity. */
interface Entry {
  readonly id: string
  readonly filter: AdmissionFilter
}

/**
 * The registry a mount fans admission decisions out to.
 *
 * Filters run in registration order and the first refusal wins, so a filter that
 * only recognises its own case never has to reason about the others. A filter
 * that throws is failed open and counted: a guard that turns its own bug into a
 * refused prompt has become the outage it was installed to prevent.
 */
export class AdmissionRegistry {
  readonly #entries: Entry[] = []
  #refused = 0
  #failures = 0
  #admitted = 0
  #nextId = 0

  /**
   * Register one filter.
   * @param filter - the filter to run.
   * @param options - an optional stable id for logs and refusal records.
   * @returns a disposer removing this filter.
   * @throws TypeError when the argument is not a function.
   */
  use(filter: AdmissionFilter, options: { readonly id?: string } = {}): () => void {
    if (typeof filter !== 'function') {
      throw new TypeError('prompt-admission-guard: a filter must be a function')
    }
    this.#nextId += 1
    const entry: Entry = { id: options.id ?? `filter-${this.#nextId}`, filter }
    this.#entries.push(entry)
    let removed = false
    return (): void => {
      if (removed) return
      removed = true
      const index = this.#entries.indexOf(entry)
      if (index >= 0) this.#entries.splice(index, 1)
    }
  }

  /** @returns a point-in-time copy of the counters. */
  counts(): RegistryCounts {
    return {
      filters: this.#entries.length,
      refused: this.#refused,
      failures: this.#failures,
      admitted: this.#admitted,
    }
  }

  /**
   * Run every filter over one message about to be written.
   *
   * @param input - the message as it would be written.
   * @param onFailure - receives a filter that threw; the message is admitted.
   * @returns the first refusal, or `undefined` when every filter admitted it.
   */
  decide(
    input: AdmissionInput,
    onFailure: (error: unknown, filterId: string) => void = () => {},
  ): { readonly refuse: string; readonly filterId: string } | undefined {
    for (const entry of this.#entries) {
      let verdict: AdmissionVerdict
      try {
        verdict = entry.filter(input)
      } catch (error) {
        this.#failures += 1
        onFailure(error, entry.id)
        continue
      }
      if (verdict !== undefined && verdict !== null && typeof verdict === 'object'
        && typeof (verdict as { refuse?: unknown }).refuse === 'string') {
        const text = (verdict as { refuse: string }).refuse
        if (text.trim().length > 0) {
          this.#refused += 1
          return { refuse: text, filterId: entry.id }
        }
      }
    }
    this.#admitted += 1
    return undefined
  }

  /** Record a refusal that was counted but not applied, for observe mode. */
  recordWouldRefuse(): void {
    // `decide` already counted it; this hook exists so callers do not have to
    // reach into private state to keep the two modes' counters identical.
  }
}

/**
 * Read the text of a message without assuming its shape.
 * @param message - a candidate message.
 * @returns the joined text blocks, or an empty string.
 */
export function messageText(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}
