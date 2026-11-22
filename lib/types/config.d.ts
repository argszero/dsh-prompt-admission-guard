/**
 * The row's configuration: what it defaults to, and what it refuses.
 *
 * @module
 */
/** How the installed wrapper treats a filter's refusal. */
export type Mode = 'enforce' | 'observe' | 'off';
/** Every mode this plugin honours. */
export declare const MODES: readonly ["enforce", "observe", "off"];
/**
 * The `source.kind` values that make a message a person's prompt.
 *
 * `user` is what the session controller attaches to a prompt a person typed in
 * the composer — it is the same discriminator the controller itself uses when it
 * asks whether pending input came from a person
 * (`packages/api/session-controller/src/commands.ts`). Every other kind —
 * `test`, `tool-registry`, a plugin's own kind — is context a plugin or the
 * harness injected, and refusing one of those would be refusing the injector,
 * not a person.
 */
export declare const DEFAULT_KINDS: readonly ["user"];
/** Validated settings a mount runs with. */
export interface Settings {
    /**
     * `enforce` (default) refuses what a filter refuses: the message is never
     * written, so no `agent/inbox/spliced`, no `agent/inbox/inserted`, no driver
     * wake, and the sender receives the refusal text.
     * `observe` runs every filter and counts what it would have refused, but every
     * message is written unchanged — the shape to mount first on a deployment
     * whose behaviour you do not want to change yet.
     * `off` installs no wrapper at all.
     */
    readonly mode: Mode;
    /** The `source.kind` values treated as a person's prompt. */
    readonly kinds: readonly string[];
    /** Log each refusal, each would-be refusal and each filter failure. */
    readonly report: boolean;
}
/**
 * Validate one row's configuration.
 * @param raw - the row's `config`, or nothing.
 * @returns frozen settings.
 * @throws TypeError naming the refused key.
 */
export declare function normalizeConfig(raw?: unknown): Settings;
/** The defaults a caller can read without mounting. */
export declare const defaultConfig: Settings;
//# sourceMappingURL=config.d.ts.map