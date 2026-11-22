/**
 * The shadow measured on the class it displaces.
 *
 * The suite builds a real `Session` from the published `@deepseek-ai/dsh-session`
 * rather than a stand-in object: the wrapper calls the displaced method with the
 * receiver it was read from, and only a real session's `append` reads `this`
 * (it commits through `this.commit`) — a fake that closes over its own state
 * would stay green with the binding broken, which is the defect this file exists
 * to catch.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AdmissionRegistry, PromptRefused, shadowAppend } from '../lib/index.js'

/** A real session, created the way the store creates one. */
async function realSession() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.get('sessions').create()
  await new Promise(resolve => setTimeout(resolve, 20))
  return session
}

const spliceOf = (text, kind) => ({
  target: 'next-turn',
  start: 0,
  inserted: [createUserMessage({ content: [{ type: 'text', text }], source: { kind } })],
})

const policy = (overrides = {}) => ({
  kinds: ['user'],
  observe: false,
  onRefuse: () => {},
  onFailure: () => {},
  ...overrides,
})

test('the wrapper is an own property; the prototype method is untouched', async () => {
  const session = await realSession()
  const proto = Object.getPrototypeOf(session)
  const prototypeAppend = proto.append
  const registry = new AdmissionRegistry()
  const installed = shadowAppend(session, registry, policy())
  assert.equal(installed.outcome, 'patched')
  assert.equal(Object.hasOwn(session, 'append'), true)
  assert.equal(proto.append, prototypeAppend, 'no class was patched')
  installed.restore()
  assert.equal(Object.hasOwn(session, 'append'), false, 'restore leaves no own property')
  assert.equal(typeof session.append, 'function')
})

test('a refused prompt writes nothing, and the error carries the sentence', async () => {
  const session = await realSession()
  const registry = new AdmissionRegistry()
  registry.use(input => (input.text.includes('123456') ? { refuse: 'That is a one-time code.' } : undefined), { id: 'code' })
  const installed = shadowAppend(session, registry, policy())
  const before = session.snapshotEvents().length

  let thrown
  try {
    session.append('agent/inbox/spliced', spliceOf('the code is 123456', 'user'))
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof PromptRefused, 'the refusal is thrown, not swallowed')
  assert.equal(String(thrown), 'That is a one-time code.', 'a host that stringifies gets the sentence')
  assert.equal(session.snapshotEvents().length, before, 'no row was written')
  assert.equal(session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'), false)
  installed.restore()
})

test('an admitted prompt is written through the real method, on the real receiver', async () => {
  const session = await realSession()
  const registry = new AdmissionRegistry()
  registry.use(() => undefined)
  const installed = shadowAppend(session, registry, policy())
  const before = session.snapshotEvents().length
  const event = session.append('agent/inbox/spliced', spliceOf('ordinary question', 'user'))
  assert.equal(event.type, 'agent/inbox/spliced')
  assert.equal(session.snapshotEvents().length, before + 1, 'the displaced method really ran on the session')
  assert.equal(session.snapshotEvents().at(-1).data.inserted[0].content[0].text, 'ordinary question')
  installed.restore()
})

test('a kind the configuration does not list is admitted', async () => {
  const session = await realSession()
  const registry = new AdmissionRegistry()
  registry.use(() => ({ refuse: 'never reached' }))
  const installed = shadowAppend(session, registry, policy())
  session.append('agent/inbox/spliced', spliceOf('injected preamble', 'test'))
  assert.equal(session.snapshotEvents().at(-1).data.inserted[0].source.kind, 'test')
  assert.equal(registry.counts().refused, 0, 'an injected message is not a person prompt')
  installed.restore()
})

test('events other than the inbox splice pass straight through', async () => {
  const session = await realSession()
  const registry = new AdmissionRegistry()
  registry.use(() => ({ refuse: 'never reached' }))
  const installed = shadowAppend(session, registry, policy())
  session.append('session/title', { title: 'a title' })
  assert.equal(session.snapshotEvents().at(-1).type, 'session/title')
  installed.restore()
})

test('the array overload is filtered too', async () => {
  const session = await realSession()
  const registry = new AdmissionRegistry()
  registry.use(() => ({ refuse: 'refused in batch' }))
  const installed = shadowAppend(session, registry, policy())
  const before = session.snapshotEvents().length
  assert.throws(
    () => session.append([{ type: 'agent/inbox/spliced', data: spliceOf('batched', 'user') }]),
    /refused in batch/,
  )
  assert.equal(session.snapshotEvents().length, before)
  installed.restore()
})

test('observe mode counts the refusal and writes the row anyway', async () => {
  const session = await realSession()
  const registry = new AdmissionRegistry()
  registry.use(() => ({ refuse: 'would refuse' }))
  const seen = []
  const installed = shadowAppend(session, registry, policy({ observe: true, onRefuse: r => seen.push(r.text) }))
  session.append('agent/inbox/spliced', spliceOf('still recorded', 'user'))
  assert.deepEqual(seen, ['would refuse'])
  assert.equal(session.snapshotEvents().at(-1).data.inserted[0].content[0].text, 'still recorded')
  installed.restore()
})

test('restore does not unwind a wrapper installed on top of it', async () => {
  const session = await realSession()
  const first = shadowAppend(session, new AdmissionRegistry(), policy())
  const ours = session.append
  const later = shadowAppend(session, new AdmissionRegistry(), policy())
  assert.notEqual(session.append, ours, 'the second wrapper is the one in front')
  later.restore()
  assert.equal(session.append, ours)
  first.restore()
  assert.equal(Object.hasOwn(session, 'append'), false)

  // and the chain-safe case: restoring an inner wrapper while an outer one owns
  // the property must leave the outer wrapper in place.
  const inner = shadowAppend(session, new AdmissionRegistry(), policy())
  const outer = shadowAppend(session, new AdmissionRegistry(), policy())
  const outerWrapper = session.append
  inner.restore()
  assert.equal(session.append, outerWrapper, 'the outer wrapper still owns the property')
  outer.restore()
  assert.equal(Object.hasOwn(session, 'append'), false)
})
