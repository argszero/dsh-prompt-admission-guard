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
import { messageText, PromptRefused } from "./filters.js";
/** One chain per session, reachable from every wrapper's disposer. */
const chains = new WeakMap();
/**
 * Read the person-originated messages out of one `agent/inbox/spliced` payload.
 * @param data - the payload the caller passed to `append`.
 * @param kinds - the `source.kind` values that count as a person's prompt.
 * @returns the messages that a filter may refuse, with their kind and target.
 */
export function promptMessages(data, kinds) {
    if (data === null || typeof data !== 'object')
        return undefined;
    const inserted = data.inserted;
    if (!Array.isArray(inserted) || inserted.length === 0)
        return undefined;
    const target = data.target;
    const picked = [];
    for (const message of inserted) {
        if (message === null || typeof message !== 'object')
            continue;
        const source = message.source;
        const kind = source !== null && typeof source === 'object'
            ? source.kind
            : undefined;
        if (typeof kind === 'string' && kinds.includes(kind))
            picked.push({ message, kind });
    }
    if (picked.length === 0)
        return undefined;
    return { target: typeof target === 'string' ? target : 'unknown', inserted: picked };
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
export function decideAppend(registry, session, type, data, policy) {
    const events = Array.isArray(type)
        ? type
        : [{ type, data }];
    for (const event of events) {
        if (event.type !== 'agent/inbox/spliced')
            continue;
        const found = promptMessages(event.data, policy.kinds);
        if (found === undefined)
            continue;
        for (const entry of found.inserted) {
            const input = {
                session,
                target: found.target,
                message: entry.message,
                kind: entry.kind,
                text: messageText(entry.message),
                messageId: typeof entry.message.id === 'string'
                    ? entry.message.id
                    : undefined,
            };
            const refusal = registry.decide(input, policy.onFailure);
            if (refusal === undefined)
                continue;
            policy.onRefuse({ text: refusal.refuse, filterId: refusal.filterId }, input);
            if (policy.observe)
                continue;
            throw new PromptRefused(refusal.refuse, refusal.filterId);
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
export function shadowAppend(session, registry, policy) {
    const holder = session;
    const original = holder.append;
    if (typeof original !== 'function')
        return { outcome: 'not-a-session', restore: () => { } };
    let chain = chains.get(session);
    if (chain === undefined) {
        chain = {
            base: original,
            baseHadOwn: Object.prototype.hasOwnProperty.call(session, 'append'),
            entries: [],
        };
        chains.set(session, chain);
    }
    const wrapper = function (type, data, ...rest) {
        decideAppend(registry, session, type, data, policy);
        return Reflect.apply(original, this, [type, data, ...rest]);
    };
    /** Install one value on the property the way the class spell it: writable, enumerable: false. */
    const write = (value) => {
        Object.defineProperty(session, 'append', {
            value,
            writable: true,
            configurable: true,
            enumerable: false,
        });
    };
    try {
        write(wrapper);
    }
    catch {
        // A session that refuses a new own property is unguarded, not broken; drop a
        // chain this call created so the next attempt reads the property afresh.
        if (chain.entries.length === 0)
            chains.delete(session);
        return { outcome: 'sealed', restore: () => { } };
    }
    const entry = { wrapper };
    chain.entries.push(entry);
    return {
        outcome: 'patched',
        restore: () => {
            const index = chain.entries.indexOf(entry);
            if (index === -1)
                return;
            chain.entries.splice(index, 1);
            if (chain.entries.length === 0)
                chains.delete(session);
            // Only the wrapper that owns the property right now may put something back:
            // a wrapper installed on top of this one belongs to a plugin still loaded,
            // and writing over it would break the chain that plugin is running inside.
            if (Reflect.get(session, 'append') !== wrapper)
                return;
            const top = chain.entries[chain.entries.length - 1];
            if (top !== undefined)
                write(top.wrapper);
            else if (chain.baseHadOwn)
                write(chain.base);
            else
                delete session.append;
        },
    };
}
