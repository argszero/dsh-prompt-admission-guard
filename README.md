# @argszero/dsh-prompt-admission-guard

Refuse a person's prompt **before the session records it**.

A DeepSeek Harness agent writes an incoming prompt to its durable log first and
notifies plugins afterwards: `Inbox.mutate()` calls
`session.append('agent/inbox/spliced', splice)` and only then emits
`agent/inbox/inserted`
(`packages/core/agent-loop/src/inbox.ts`). A plugin listening on that event — or
on `agent/pre-step` — therefore meets a prompt that is already durable. It can
keep the prompt from a model; it cannot keep it from the record.

This plugin takes the log's single acceptance boundary, `Session.append`, and
fans it out to a registry of synchronous filters:

```text
composer ──▶ agent.followup()/steer() ──▶ Inbox.splice() ──▶ Session.append()
                                                              │
                                              filter registry ┴─ refuse ⇒ throw
                                                                  (no row, no event,
                                                                   no driver wake)
```

The wrapper is an own property on each session instance — the class is never
patched — and it is removed exactly when the row unloads. Filters register
against one service (`promptAdmission`), so N plugins share one wrapper instead
of replacing each other's.

## Why the throw is the answer

`Inbox.mutate()` does not wrap the append in a `try`, so a throw travels back out
of `agent.followup()` / `agent.steer()`. The session controller's `prompt()`
turns any throw that is not already a `RemoteError` into
`RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })`
(`packages/api/session-controller/src/commands.ts`), so the sender reads the
refusal sentence in the composer and nothing was written.

The error stringifies to the refusal text alone, which is what a host that only
prints `String(error)` will show.

## Install

```sh
dsh plugin add @argszero/dsh-prompt-admission-guard
```

`npm install` alone does not mount a plugin in a profile — `dsh plugin add` is
what records it. The bundle patch ships one row with the defaults below; edit
them in your profile after mounting.

## Configuration

| key | default | meaning |
|---|---|---|
| `mode` | `enforce` | `enforce` refuses what a filter refuses. `observe` runs every filter and counts what it would have refused, but writes every message unchanged — mount this first on a deployment whose behaviour you do not want to change yet. `off` installs no wrapper at all. |
| `kinds` | `['user']` | The `source.kind` values that make a message a person's prompt. `user` is what the session controller attaches to a composer prompt. |
| `report` | `true` | Log each refusal, would-be refusal and filter failure. |

A bad configuration is refused at mount, naming the key and what was received.

## Registering a filter

```ts
export const inject = ['promptAdmission']

export function apply(ctx: Context): void {
  ctx.promptAdmission.registry.use((input) => {
    if (input.kind !== 'user') return undefined
    if (/^\s*\d{6}\s*$/.test(input.text)) return { refuse: 'That looks like a one-time code.' }
    return undefined
  }, { id: 'one-time-code' })
}
```

* `input`: `{ session, target, message, kind, text, messageId }`. `text` is read
  from the message's text blocks without assuming their shape.
* Return `{ refuse: '<sentence>' }` to refuse, `undefined` to admit.
* The first refusal wins; later filters do not run for that message.
* A refusal with no sentence is treated as no refusal — refusing with nothing to
  read is worse than admitting, because the sender gets an error and no reason.
* A filter that throws is failed open and counted (`filterFailures`): a guard bug
  must not become a session that cannot accept input.
* `registry.use()` returns a disposer, and disposal is idempotent.

## Reading it back

`ctx.promptAdmission.snapshot()` returns the mode, the resolved kinds, the
sessions currently shadowed, the install failures, `refused`, `wouldRefuse`,
`filters`, `admitted`, `filterFailures`, and the blind spots this plugin is
honest about.

## Boundaries

* **Synchronous only.** A filter can recognise a prompt; it cannot ask a model, a
  network service or a person before deciding. Anything that needs a round trip
  belongs before the composer, not here.
* **`source.kind` decides, not the author.** A plugin that injects context with
  `kind: 'user'` is filtered like a person would be; one that injects `test` or
  its own kind is admitted by construction, because refusing it would refuse its
  injector.
* **A refusal leaves no trace in the session log.** That is the point — a durable
  "refused" row would be the very record this plugin exists to prevent. Use
  `report: true` logs or `mode: observe` counts for an audit trail.
* **Nothing already written is rewritten.** A prompt recorded before this row
  mounted stays recorded; the guard prevents a write, it does not repair history.
* **The wire code is the host's own.** A refusal reaches the client as
  `session/agent-busy` with the sentence in `reason`; this plugin cannot mint a
  dedicated failure code, because a code a client has no locale entry for renders
  worse than the text it replaced.
* **Other wrappers compose in install order.** A second plugin that shadows
  `Session.append` is chained, not clobbered, and this plugin's disposer takes out
  only its own wrapper — including when the two unload out of order.
* **The seam is the Session, so the coverage is.** Prompts that reach the session
  through `agent.followup`/`agent.steer` (both shipped send paths) are covered, and
  so is any client that appends an `agent/inbox/spliced` payload directly. A
  client that writes a log of its own outside `Session.append` is not.

## Tests

```sh
npm test          # builds, then runs 28 tests on Node's runner
```

The suite mounts the real artifacts, not stand-ins: a `Session` from the
published `@deepseek-ai/dsh-session`, and the shipped `AgentLoop` composition
through the project's own testkit. The two properties that matter are measured
there — a refused prompt leaves the log at the same length with no
`agent/inbox/spliced` row and no `turn/start`, and the throw comes back out of
`followup`/`steer` carrying the sentence.

## Provenance

Answers discussion
[#14022](https://github.com/deepseek-ai/deepseek-harness/discussions/14022).

MIT.
