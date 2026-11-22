/**
 * Refuse a person's prompt before it is recorded.
 *
 * A prompt a person sends reaches the agent through `followup` / `steer`
 * (`packages/core/agent-loop/src/agent.ts`, `send()`), which calls
 * `Inbox.splice()`. `Inbox.mutate()` appends the `agent/inbox/spliced` event to
 * the Session first and only then emits `agent/inbox/inserted`
 * (`packages/core/agent-loop/src/inbox.ts`). A plugin therefore first sees the
 * prompt after the Session has recorded it; `agent/pre-step` can keep it from the
 * model, never from the record.
 *
 * This plugin installs the one wrapper around that acceptance boundary —
 * `Session.append` — and fans it out to a registry of synchronous filters. A
 * refusal is thrown before the original is reached, so the row is never written,
 * nothing is emitted, the driver is not woken, and the throw travels back through
 * `splice` to the sender. `Session.append` is a prototype method and the wrapper
 * is an own property on the instance, so no class is patched and the displaced
 * method is put back when the row unloads.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Settings } from './config.ts';
import { AdmissionRegistry } from './filters.ts';
export * from './config.ts';
export * from './filters.ts';
export * from './shadow.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "prompt-admission-guard";
/**
 * No service is a hard requirement: the seam is the Session each
 * `session/created` announces, and a composition with no session yet still
 * mounts — it simply has nothing to shadow until one exists.
 */
export declare const inject: readonly string[];
/** The Cordis name this plugin's registry is provided under. */
export declare const SERVICE_NAME = "promptAdmission";
/** The properties this plugin is honest about not having. */
export declare const BLIND_SPOTS: readonly string[];
/** What an operator may read back. */
export interface Snapshot {
    /** The resolved mode. */
    readonly mode: Settings['mode'];
    /** The `source.kind` values treated as a person's prompt. */
    readonly kinds: readonly string[];
    /** Sessions whose `append` this plugin currently shadows. */
    readonly sessionsShadowed: number;
    /** Sessions whose `append` refused the shadow. */
    readonly installFailures: number;
    /** Prompts refused before the row was written. */
    readonly refused: number;
    /** Prompts a filter refused that were written anyway, in observe mode. */
    readonly wouldRefuse: number;
    /** Registered filters, live. */
    readonly filters: number;
    /** Messages that passed every filter. */
    readonly admitted: number;
    /** Filter calls that threw and were failed open. */
    readonly filterFailures: number;
    /** The properties this plugin does not have, stated where an operator will read them. */
    readonly blindSpots: readonly string[];
}
/** The view this plugin provides under {@link SERVICE_NAME}. */
export interface PromptAdmissionService {
    /** The registry filters register with. */
    readonly registry: AdmissionRegistry;
    /** A point-in-time copy of the counters. */
    snapshot(): Snapshot;
}
/**
 * Mount the plugin.
 *
 * `apply` is where a loader entry lands, and the configuration reaches it as the
 * second argument — never through an exported `Config`, which cordis would try to
 * validate through a `~standard` key a plain defaults object does not have.
 *
 * @param ctx - the context this plugin is mounted on.
 * @param config - what the operator wrote.
 */
export declare function apply(ctx: Context, config?: unknown): void;
/** The shape a cordis loader entry loads. */
declare const _default: {
    name: string;
    inject: readonly string[];
    apply: typeof apply;
    defaultConfig: Settings;
};
export default _default;
//# sourceMappingURL=index.d.ts.map