/**
 * The host's own send path, end to end.
 *
 * `agent.followup()` and `agent.steer()` are what the session controller calls
 * for a composer prompt (`packages/api/session-controller/src/commands.ts`).
 * Each reaches `Inbox.splice()`, which appends `agent/inbox/spliced` and only
 * then emits `agent/inbox/inserted`. With the guard mounted, the refusal happens
 * inside that append: the agent records nothing, and the throw comes back out of
 * `followup` — which is exactly the value the controller turns into the error a
 * sender reads, because `prompt()` wraps a throw that is not already a
 * `RemoteError` as `RemoteError('session/agent-busy', 'prompt rejected',
 * { reason: String(error) })`.
 *
 * The composition is the project's own: `mountAgentLoopTestDependencies` mounts
 * the real `LlmRuntime`, `SessionStore`, projection registry, system prompt, tool
 * runtime and agent registry, over one adapter that answers without a network.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import plugin, { SERVICE_NAME } from '../lib/index.js'

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

/** The loop is here to drive the real inbox, not to exercise a provider. */
class SilentAdapter extends LlmAdapter {
  async * stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The shipped composition, with the guard in front of the inbox. */
async function harness(config) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new SilentAdapter())
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(plugin, config)
  await tick()
  const agent = await ctx.agentLoop.create('a1', { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

const prompt = (text, kind = 'user') =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind } })

test('a refused composer prompt never enters the session log', async () => {
  const { ctx, agent } = await harness({ mode: 'enforce', report: false })
  const service = ctx.get(SERVICE_NAME)
  service.registry.use(input => (input.kind === 'user' && input.text.includes('123456')
    ? { refuse: 'That looks like a one-time code.' }
    : undefined), { id: 'otp' })

  const before = agent.session.snapshotEvents().length
  let thrown
  try {
    agent.followup(prompt('my code is 123456'))
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown !== undefined, 'the send path received the refusal instead of recording it')
  assert.equal(String(thrown), 'That looks like a one-time code.')
  const after = agent.session.snapshotEvents()
  assert.equal(after.length, before, 'no row was appended at all')
  assert.equal(after.some(event => event.type === 'agent/inbox/spliced'), false, 'not even the inbox row')
  assert.equal(after.some(event => event.type === 'turn/start'), false, 'the driver was not woken')
  assert.equal(service.snapshot().refused, 1)
  await tick(20)
})

test('an admitted prompt still reaches the inbox and starts a turn', async () => {
  const { agent } = await harness({ mode: 'enforce', report: false })
  const before = agent.session.snapshotEvents().length
  agent.followup(prompt('an ordinary question'))
  const after = agent.session.snapshotEvents()
  assert.ok(after.length > before, 'the ordinary prompt was recorded')
  // The driver claims the message in the same turn and appends a second splice
  // that inserts nothing (`inserted: 0`, measured), so the row carrying the
  // prompt is the first one, not the last.
  const recorded = after
    .filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted)
  assert.ok(
    recorded.some(message => message.content?.[0]?.text === 'an ordinary question'),
    'the ordinary prompt was recorded in the inbox',
  )
  await tick(50)
})

test('a steered prompt is filtered by the same rule', async () => {
  const { ctx, agent } = await harness({ mode: 'enforce', report: false })
  ctx.get(SERVICE_NAME).registry.use(() => ({ refuse: 'steering refused too' }))
  const before = agent.session.snapshotEvents().length
  assert.throws(() => agent.steer(prompt('a steering message')), /steering refused too/)
  assert.equal(agent.session.snapshotEvents().length, before)
  await tick(20)
})

test('an injected message is not a person prompt and is admitted', async () => {
  const { ctx, agent } = await harness({ mode: 'enforce', report: false })
  ctx.get(SERVICE_NAME).registry.use(() => ({ refuse: 'never reaches an injected message' }))
  agent.inject(prompt('plugin-supplied context', 'test'))
  const rows = agent.session.snapshotEvents()
  assert.ok(rows.some(event => event.type === 'agent/inbox/spliced'))
  const last = rows.findLast(event => event.type === 'agent/inbox/spliced')
  assert.equal(last.data.inserted[0].source.kind, 'test')
  assert.equal(ctx.get(SERVICE_NAME).snapshot().refused, 0)
  await tick(50)
})

test('the row restores the class when it unloads', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.get('sessions').create()
  await tick()
  const before = session.append
  const fiber = ctx.plugin(plugin, { mode: 'enforce', report: false })
  await fiber
  await tick()
  assert.notEqual(session.append, before, 'the shadow is in place')
  await fiber.dispose()
  assert.equal(session.append, before, 'unloading put the real method back')
})
