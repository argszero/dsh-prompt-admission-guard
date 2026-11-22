/**
 * Seam: `Session.append` is the durable log's single acceptance boundary.
 *
 * The inbox writes through it — `Inbox.mutate` calls
 * `this.session.append('agent/inbox/spliced', splice)` and only then emits
 * `agent/inbox/inserted` for each message
 * (`packages/core/agent-loop/src/inbox.ts`). Every listener on that inserted
 * event therefore runs after the row exists, which is exactly the gap a prompt
 * that must never be recorded falls into.
 *
 * `append` is a prototype method, so an own-property wrapper in front of it is
 * what a plugin can install without touching the class. A throw before the
 * original is reached leaves the log untouched: `Inbox.mutate` does not wrap the
 * append in a `try`, so the throw travels back through `splice` to
 * `agent.send()` and out to whoever sent the prompt.
 *
 * @module
 */

import { messageText, PromptRefused } from './filters.ts'
import type { AdmissionRegistry } from './filters.ts'

/** What one shadow installation produced. */
export type InstallOutcome = 'patched' | 'not-a-session' | 'sealed'

/** A shadow that is installed, and how to remove it. */
export interface Installed {
  /** What happened. */
  readonly outcome: InstallOutcome
  /** Puts the displaced method back; a no-op unless `outcome` is `patched`. */
  readonly restore: () => void
}

/** How the wrapper reports what it decided. */
export interface ShadowPolicy {
  /** The `source.kind` values treated as a person's prompt. */
  readonly kinds: readonly string[]
  /** When true, refusals are counted and the row is written unchanged. */
  readonly observe: boolean
  /** Called just before a refusal is thrown. */
  readonly onRefuse: (refusal: { readonly text: string; readonly filterId: string }, input: object) => void
  /** Called when a filter threw and the message was admitted. */
  readonly onFailure: (error: unknown, filterId: string) => void
}

/** The one method this module needs; nothing else about a session is touched. */
interface Appendable {
  append?: unknown
}

/** The shape of the method this module wraps. */
type AppendMethod = (this: unknown, type: unknown, data?: unknown, ...rest: unknown[]) => unknown

/**
 * The wrappers this module installed on one session, oldest first.
 *
 * Restoring out of order is the case this exists for: a second plugin that hides
 * `append` after this one owns the property, so a disposer may only take its own
 * wrapper out of the chain and put back whatever is left on top — never the
 * value it happened to find at install time, which by then may be a wrapper a
 * still-loaded plugin is running inside.
 */
interface Chain {
  /** What the property held before this module's first wrapper, as it was found. */
  readonly base: unknown
  /** Whether that value was an own property; `false` means it came from the class. */
  readonly baseHadOwn: boolean
  /** Installed wrappers, oldest first. */
  readonly entries: { readonly wrapper: AppendMethod }[]
}

/** One chain per session, reachable from every wrapper's disposer. */
const chains = new WeakMap<object, Chain>()

/** One event as the array overload receives it. */
interface EventInput {
  readonly type?: unknown
  readonly data?: unknown
}

/**
 * Read the person-originated messages out of one `agent/inbox/spliced` payload.
 * @param data - the payload the caller passed to `append`.
 * @param kinds - the `source.kind` values that count as a person's prompt.
 * @returns the messages that a filter may refuse, with their kind and target.
 */
export function promptMessages(
  data: unknown,
  kinds: readonly string[],
): { readonly target: string; readonly inserted: readonly { readonly message: unknown; readonly kind: string }[] } | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const inserted = (data as { inserted?: unknown }).inserted
  if (!Array.isArray(inserted) || inserted.length === 0) return undefined
  const target = (data as { target?: unknown }).target
  const picked: { message: unknown; kind: string }[] = []
  for (const message of inserted) {
    if (message === null || typeof message !== 'object') continue
    const source = (message as { source?: unknown }).source
    const kind = source !== null && typeof source === 'object'
      ? (source as { kind?: unknown }).kind
      : undefined
    if (typeof kind === 'string' && kinds.includes(kind)) picked.push({ message, kind })
  }
  if (picked.length === 0) return undefined
  return { target: typeof target === 'string' ? target : 'unknown', inserted: picked }
}

/**
 * Decide one append call, and throw when a filter refuses it.
 * @param registry - the filters.
 * @param session - the session being written to.
 * @param type - `append`'s first argument: an event type or an array of inputs.
 * @param data - `append`'s second argument, when the first was a type.
 * @param policy - kinds, mode and reporting.
 * @throws PromptRefused when a filter refuses the message in enforce mode.
 */
export function decideAppend(
  registry: AdmissionRegistry,
  session: object,
  type: unknown,
  data: unknown,
  policy: ShadowPolicy,
): void {
  const events: readonly EventInput[] = Array.isArray(type)
    ? type as readonly EventInput[]
    : [{ type, data }]
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const found = promptMessages(event.data, policy.kinds)
    if (found === undefined) continue
    for (const entry of found.inserted) {
      const input = {
        session,
        target: found.target,
        message: entry.message,
        kind: entry.kind,
        text: messageText(entry.message),
        messageId: typeof (entry.message as { id?: unknown }).id === 'string'
          ? (entry.message as { id: string }).id
          : undefined,
      }
      const refusal = registry.decide(input, policy.onFailure)
      if (refusal === undefined) continue
      policy.onRefuse({ text: refusal.refuse, filterId: refusal.filterId }, input)
      if (policy.observe) continue
      throw new PromptRefused(refusal.refuse, refusal.filterId)
    }
  }
}

/**
 * Shadow one session's `append`.
 *
 * The previous method is captured as it is found — an own property installed by
 * an earlier wrapper included — and called with the receiver it was read from,
 * so chaining works and a displaced method that reads `this` still sees its
 * session.
 *
 * @param session - the session to shadow.
 * @param registry - the filters.
 * @param policy - kinds, mode and reporting.
 * @returns the installation outcome and, when installed, its disposer.
 */
export function shadowAppend(session: object, registry: AdmissionRegistry, policy: ShadowPolicy): Installed {
  const holder = session as Appendable
  const original = holder.append as AppendMethod
  if (typeof original !== 'function') return { outcome: 'not-a-session', restore: () => {} }

  let chain = chains.get(session)
  if (chain === undefined) {
    chain = {
      base: original,
      baseHadOwn: Object.prototype.hasOwnProperty.call(session, 'append'),
      entries: [],
    }
    chains.set(session, chain)
  }

  const wrapper = function (this: unknown, type: unknown, data?: unknown, ...rest: unknown[]): unknown {
    decideAppend(registry, session, type, data, policy)
    return Reflect.apply(original, this, [type, data, ...rest])
  }

  /** Install one value on the property the way the class spell it: writable, enumerable: false. */
  const write = (value: unknown): void => {
    Object.defineProperty(session, 'append', {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }

  try {
    write(wrapper)
  } catch {
    // A session that refuses a new own property is unguarded, not broken; drop a
    // chain this call created so the next attempt reads the property afresh.
    if (chain.entries.length === 0) chains.delete(session)
    return { outcome: 'sealed', restore: () => {} }
  }
  const entry: { readonly wrapper: AppendMethod } = { wrapper }
  chain.entries.push(entry)

  return {
    outcome: 'patched',
    restore: (): void => {
      const index = chain.entries.indexOf(entry)
      if (index === -1) return
      chain.entries.splice(index, 1)
      if (chain.entries.length === 0) chains.delete(session)
      // Only the wrapper that owns the property right now may put something back:
      // a wrapper installed on top of this one belongs to a plugin still loaded,
      // and writing over it would break the chain that plugin is running inside.
      if (Reflect.get(session, 'append') !== wrapper) return
      const top = chain.entries[chain.entries.length - 1]
      if (top !== undefined) write(top.wrapper)
      else if (chain.baseHadOwn) write(chain.base)
      else delete (session as { append?: unknown }).append
    },
  }
}
