/**
 * The row's configuration: what it defaults to, and what it refuses.
 *
 * @module
 */
/** Every mode this plugin honours. */
export const MODES = Object.freeze(['enforce', 'observe', 'off']);
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
export const DEFAULT_KINDS = Object.freeze(['user']);
const DEFAULTS = Object.freeze({ mode: 'enforce', kinds: DEFAULT_KINDS, report: true });
/**
 * Validate one row's configuration.
 * @param raw - the row's `config`, or nothing.
 * @returns frozen settings.
 * @throws TypeError naming the refused key.
 */
export function normalizeConfig(raw) {
    if (raw === undefined || raw === null)
        return DEFAULTS;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TypeError('prompt-admission-guard: config must be an object');
    }
    const input = raw;
    const mode = input['mode'] ?? DEFAULTS.mode;
    if (typeof mode !== 'string' || !MODES.includes(mode)) {
        throw new TypeError(`prompt-admission-guard: mode must be one of ${MODES.join(', ')}; received ${JSON.stringify(mode)}`);
    }
    const rawKinds = input['kinds'];
    let kinds = DEFAULT_KINDS;
    if (rawKinds !== undefined) {
        if (!Array.isArray(rawKinds) || rawKinds.length === 0) {
            throw new TypeError('prompt-admission-guard: kinds must be a non-empty array of strings');
        }
        const seen = [];
        for (const entry of rawKinds) {
            if (typeof entry !== 'string' || entry.length === 0) {
                throw new TypeError(`prompt-admission-guard: kinds must contain non-empty strings; received ${JSON.stringify(entry)}`);
            }
            if (!seen.includes(entry))
                seen.push(entry);
        }
        kinds = Object.freeze(seen);
    }
    const report = input['report'] ?? DEFAULTS.report;
    if (typeof report !== 'boolean') {
        throw new TypeError(`prompt-admission-guard: report must be a boolean; received ${JSON.stringify(report)}`);
    }
    return Object.freeze({ mode: mode, kinds, report });
}
/** The defaults a caller can read without mounting. */
export const defaultConfig = DEFAULTS;
