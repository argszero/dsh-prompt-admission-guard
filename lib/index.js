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
import { defaultConfig, normalizeConfig } from "./config.js";
import { AdmissionRegistry } from "./filters.js";
import { shadowAppend } from "./shadow.js";
export * from "./config.js";
export * from "./filters.js";
export * from "./shadow.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'prompt-admission-guard';
/**
 * No service is a hard requirement: the seam is the Session each
 * `session/created` announces, and a composition with no session yet still
 * mounts — it simply has nothing to shadow until one exists.
 */
export const inject = [];
/** The Cordis name this plugin's registry is provided under. */
export const SERVICE_NAME = 'promptAdmission';
/** The properties this plugin is honest about not having. */
export const BLIND_SPOTS = [
    'Only messages whose `source.kind` the configuration lists are filtered. Context a plugin injects is admitted by construction, because refusing it would refuse its injector rather than a person.',
    'The filter is synchronous, so it can recognise a prompt but cannot ask a model, a network service or a person before deciding.',
    'A prompt already written before this row mounted is not removed: the guard prevents the write, it does not rewrite history.',
    'The wire code stays the host\'s own `session/agent-busy` with the refusal text in its reason; this plugin cannot mint a dedicated failure code, because a code a client has no locale entry for renders worse than the text it replaced.',
    'A plugin that replaces `Session.append` itself, outside this registry, composes only in the order the two wrappers happen to be installed.',
];
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
export function apply(ctx, config = {}) {
    const settings = normalizeConfig(config);
    const registry = new AdmissionRegistry();
    const handles = new Map();
    let installFailures = 0;
    let refused = 0;
    let wouldRefuse = 0;
    let filterFailures = 0;
    const say = (level, message) => {
        if (!settings.report)
            return;
        if (level === 'warn')
            ctx.logger.warn(`prompt-admission-guard: ${message}`);
        else if (level === 'info')
            ctx.logger.info(`prompt-admission-guard: ${message}`);
        else
            ctx.logger.debug(`prompt-admission-guard: ${message}`);
    };
    const service = {
        registry,
        snapshot: () => ({
            mode: settings.mode,
            kinds: settings.kinds,
            sessionsShadowed: handles.size,
            installFailures,
            refused,
            wouldRefuse,
            filters: registry.counts().filters,
            admitted: registry.counts().admitted,
            filterFailures,
            blindSpots: BLIND_SPOTS,
        }),
    };
    if (settings.mode === 'off') {
        say('info', 'mode is off: no listener and no shadow installed');
        ctx.provide(SERVICE_NAME, service);
        return;
    }
    const observe = settings.mode === 'observe';
    const install = (session) => {
        if (handles.has(session))
            return;
        let installed;
        try {
            installed = shadowAppend(session, registry, {
                kinds: settings.kinds,
                observe,
                onRefuse: (refusal, input) => {
                    if (observe) {
                        wouldRefuse += 1;
                        say('info', `would refuse (${refusal.filterId}): ${refusal.text} [target ${String(input.target)}]`);
                    }
                    else {
                        refused += 1;
                        say('info', `refused (${refusal.filterId}): ${refusal.text}`);
                    }
                },
                onFailure: (error, filterId) => {
                    filterFailures += 1;
                    say('warn', `filter ${filterId} threw and the message was admitted: ${String(error)}`);
                },
            });
        }
        catch (error) {
            // Fail open: a session whose `append` could not be shadowed is a session
            // this plugin does not guard, not a session that cannot be created.
            installFailures += 1;
            say('warn', `could not shadow one session: ${String(error)}`);
            return;
        }
        if (installed.outcome !== 'patched') {
            installFailures += 1;
            say('warn', `one session refused the shadow (${installed.outcome})`);
            return;
        }
        handles.set(session, installed.restore);
    };
    // `session/created` is a cordis runtime signal, announced inside the creation
    // transaction: the shipped session refuses an append before it completes
    // ("cannot append before session/created completes"), so shadowing there
    // covers every row of every session from its first one.
    const on = ctx.on.bind(ctx);
    const disposers = [
        on('session/created', (payload) => {
            if (payload !== null && typeof payload === 'object')
                install(payload);
        }),
        on('session/disposed', (payload) => {
            if (payload === null || typeof payload !== 'object')
                return;
            const restore = handles.get(payload);
            if (restore === undefined)
                return;
            handles.delete(payload);
            restore();
        }),
    ];
    // A session that already exists when this row mounts — a hot reload, or a row
    // added to a running composition — hears no creation signal. Reach the store
    // when the composition supplies one, and shadow what is already there.
    try {
        const store = ctx.get?.('sessions');
        const list = store !== null && typeof store === 'object'
            ? store.list
            : undefined;
        if (typeof list === 'function') {
            for (const session of list.call(store)) {
                if (session !== null && typeof session === 'object')
                    install(session);
            }
        }
    }
    catch {
        // Optional catch-up only: a composition without a session store is not an
        // error, and `session/created` still covers every session created later.
    }
    ctx.effect(() => () => {
        for (const restore of handles.values())
            restore();
        handles.clear();
        for (const dispose of disposers)
            dispose();
    }, 'prompt-admission-guard: append shadow');
    say('info', `mounted in ${settings.mode} mode for kinds ${settings.kinds.join(', ')} `
        + `(${handles.size} session(s) already present)`);
    ctx.provide(SERVICE_NAME, service);
}
/** The shape a cordis loader entry loads. */
export default { name, inject, apply, defaultConfig };
