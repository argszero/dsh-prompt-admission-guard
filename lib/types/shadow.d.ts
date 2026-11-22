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
import type { AdmissionRegistry } from './filters.ts';
/** What one shadow installation produced. */
export type InstallOutcome = 'patched' | 'not-a-session' | 'sealed';
/** A shadow that is installed, and how to remove it. */
export interface Installed {
    /** What happened. */
    readonly outcome: InstallOutcome;
    /** Puts the displaced method back; a no-op unless `outcome` is `patched`. */
    readonly restore: () => void;
}
/** How the wrapper reports what it decided. */
export interface ShadowPolicy {
    /** The `source.kind` values treated as a person's prompt. */
    readonly kinds: readonly string[];
    /** When true, refusals are counted and the row is written unchanged. */
    readonly observe: boolean;
    /** Called just before a refusal is thrown. */
    readonly onRefuse: (refusal: {
        readonly text: string;
        readonly filterId: string;
    }, input: object) => void;
    /** Called when a filter threw and the message was admitted. */
    readonly onFailure: (error: unknown, filterId: string) => void;
}
/**
 * Read the person-originated messages out of one `agent/inbox/spliced` payload.
 * @param data - the payload the caller passed to `append`.
 * @param kinds - the `source.kind` values that count as a person's prompt.
 * @returns the messages that a filter may refuse, with their kind and target.
 */
export declare function promptMessages(data: unknown, kinds: readonly string[]): {
    readonly target: string;
    readonly inserted: readonly {
        readonly message: unknown;
        readonly kind: string;
    }[];
} | undefined;
/**
 * Decide one append call, and throw when a filter refuses it.
 * @param registry - the filters.
 * @param session - the session being written to.
 * @param type - `append`'s first argument: an event type or an array of inputs.
 * @param data - `append`'s second argument, when the first was a type.
 * @param policy - kinds, mode and reporting.
 * @throws PromptRefused when a filter refuses the message in enforce mode.
 */
export declare function decideAppend(registry: AdmissionRegistry, session: object, type: unknown, data: unknown, policy: ShadowPolicy): void;
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
export declare function shadowAppend(session: object, registry: AdmissionRegistry, policy: ShadowPolicy): Installed;
//# sourceMappingURL=shadow.d.ts.map