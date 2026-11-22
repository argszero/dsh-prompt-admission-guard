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
    filterId;
    /**
     * @param message - the sentence the sender will read.
     * @param filterId - the refusing filter's id, when it has one.
     */
    constructor(message, filterId) {
        super(message);
        this.name = 'PromptRefused';
        this.filterId = filterId;
    }
    /** @returns the refusal text alone, so a host that stringifies gets a sentence. */
    toString() {
        return this.message;
    }
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
    #entries = [];
    #refused = 0;
    #failures = 0;
    #admitted = 0;
    #nextId = 0;
    /**
     * Register one filter.
     * @param filter - the filter to run.
     * @param options - an optional stable id for logs and refusal records.
     * @returns a disposer removing this filter.
     * @throws TypeError when the argument is not a function.
     */
    use(filter, options = {}) {
        if (typeof filter !== 'function') {
            throw new TypeError('prompt-admission-guard: a filter must be a function');
        }
        this.#nextId += 1;
        const entry = { id: options.id ?? `filter-${this.#nextId}`, filter };
        this.#entries.push(entry);
        let removed = false;
        return () => {
            if (removed)
                return;
            removed = true;
            const index = this.#entries.indexOf(entry);
            if (index >= 0)
                this.#entries.splice(index, 1);
        };
    }
    /** @returns a point-in-time copy of the counters. */
    counts() {
        return {
            filters: this.#entries.length,
            refused: this.#refused,
            failures: this.#failures,
            admitted: this.#admitted,
        };
    }
    /**
     * Run every filter over one message about to be written.
     *
     * @param input - the message as it would be written.
     * @param onFailure - receives a filter that threw; the message is admitted.
     * @returns the first refusal, or `undefined` when every filter admitted it.
     */
    decide(input, onFailure = () => { }) {
        for (const entry of this.#entries) {
            let verdict;
            try {
                verdict = entry.filter(input);
            }
            catch (error) {
                this.#failures += 1;
                onFailure(error, entry.id);
                continue;
            }
            if (verdict !== undefined && verdict !== null && typeof verdict === 'object'
                && typeof verdict.refuse === 'string') {
                const text = verdict.refuse;
                if (text.trim().length > 0) {
                    this.#refused += 1;
                    return { refuse: text, filterId: entry.id };
                }
            }
        }
        this.#admitted += 1;
        return undefined;
    }
    /** Record a refusal that was counted but not applied, for observe mode. */
    recordWouldRefuse() {
        // `decide` already counted it; this hook exists so callers do not have to
        // reach into private state to keep the two modes' counters identical.
    }
}
/**
 * Read the text of a message without assuming its shape.
 * @param message - a candidate message.
 * @returns the joined text blocks, or an empty string.
 */
export function messageText(message) {
    if (message === null || typeof message !== 'object')
        return '';
    const content = message.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const text = block.text;
        if (typeof text === 'string')
            parts.push(text);
    }
    return parts.join('\n');
}
