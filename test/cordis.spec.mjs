/** Mounted the way a profile mounts it: a real Cordis context and a real row. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import plugin, { SERVICE_NAME } from '../lib/index.js'
import * as manifest from '../lib/index.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

const spliceOf = (text, kind) => ({
  target: 'next-turn',
  start: 0,
  inserted: [createUserMessage({ content: [{ type: 'text', text }], source: { kind } })],
})

async function composed(config) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(plugin, config)
  await tick()
  return ctx
}

test('mounting provides the registry under its service name', async () => {
  const ctx = await composed({ mode: 'enforce', report: false })
  const service = ctx.get(SERVICE_NAME)
  assert.ok(service !== undefined)
  assert.equal(typeof service.registry.use, 'function')
  assert.deepEqual(service.snapshot().kinds, ['user'])
  assert.deepEqual(service.snapshot().filters, 0)
})

test('a session created after the mount is guarded, and refused before any row', async () => {
  const ctx = await composed({ mode: 'enforce', report: false })
  const service = ctx.get(SERVICE_NAME)
  service.registry.use(input => (input.text === 'secret' ? { refuse: 'Not here.' } : undefined))
  const session = ctx.get('sessions').create()
  await tick()

  assert.equal(service.snapshot().sessionsShadowed, 1, 'session/created announced it and the shadow landed')
  const before = session.snapshotEvents().length
  assert.throws(() => session.append('agent/inbox/spliced', spliceOf('secret', 'user')), /Not here\./)
  assert.equal(session.snapshotEvents().length, before)
  assert.equal(service.snapshot().refused, 1)
})

test('a session that already exists when the row mounts is caught up', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const early = ctx.get('sessions').create()
  await tick()
  await ctx.plugin(plugin, { mode: 'enforce', report: false })
  await tick()
  const service = ctx.get(SERVICE_NAME)
  assert.equal(service.snapshot().sessionsShadowed, 1, 'the catch-up shadowed the pre-existing session')
  service.registry.use(() => ({ refuse: 'caught up' }))
  assert.throws(() => early.append('agent/inbox/spliced', spliceOf('late', 'user')), /caught up/)
})

test('observe mode counts a would-be refusal and records the prompt', async () => {
  const ctx = await composed({ mode: 'observe', report: false })
  const service = ctx.get(SERVICE_NAME)
  service.registry.use(() => ({ refuse: 'would refuse' }))
  const session = ctx.get('sessions').create()
  await tick()
  session.append('agent/inbox/spliced', spliceOf('recorded anyway', 'user'))
  const snapshot = service.snapshot()
  assert.equal(snapshot.mode, 'observe')
  assert.equal(snapshot.wouldRefuse, 1)
  assert.equal(snapshot.refused, 0)
  assert.equal(session.snapshotEvents().at(-1).data.inserted[0].content[0].text, 'recorded anyway')
})

test('a filter that throws is failed open: the prompt is admitted', async () => {
  const ctx = await composed({ mode: 'enforce', report: false })
  const service = ctx.get(SERVICE_NAME)
  service.registry.use(() => { throw new Error('filter bug') })
  const session = ctx.get('sessions').create()
  await tick()
  session.append('agent/inbox/spliced', spliceOf('admitted despite the bug', 'user'))
  const snapshot = service.snapshot()
  assert.equal(snapshot.filterFailures, 1)
  assert.equal(snapshot.admitted, 1)
  assert.equal(session.snapshotEvents().at(-1).data.inserted[0].content[0].text, 'admitted despite the bug')
})

test('off mounts no listener: the row is written and the service still answers', async () => {
  const ctx = await composed({ mode: 'off', report: false })
  const service = ctx.get(SERVICE_NAME)
  assert.equal(service.snapshot().sessionsShadowed, 0)
  service.registry.use(() => ({ refuse: 'never consulted' }))
  const session = ctx.get('sessions').create()
  await tick()
  session.append('agent/inbox/spliced', spliceOf('written in off mode', 'user'))
  assert.equal(session.snapshotEvents().at(-1).data.inserted[0].content[0].text, 'written in off mode')
  assert.equal(Object.hasOwn(session, 'append'), false, 'nothing was shadowed in off mode')
})

test('the row exposes the loader shape it is loaded by', () => {
  // `vendor/loader/src/index.ts:203` — the loader mounts `exports.default ?? exports`,
  // so the default export is what a profile entry really loads. A package that
  // drops it still exports `name`/`inject`/`apply`, which is why the selection
  // itself is asserted here rather than the presence of the fields.
  const mounted = manifest.default ?? manifest
  assert.equal(mounted, plugin, 'the loader selects the default export')
  assert.equal(mounted.name, 'prompt-admission-guard')
  assert.deepEqual(mounted.inject, [])
  assert.equal(typeof mounted.apply, 'function')
  assert.deepEqual(manifest.inject, [], 'the named exports agree with the object the loader mounts')
})

test('a bad configuration is refused at mount with the key named', async () => {
  const ctx = new Context()
  await assert.rejects(
    async () => ctx.plugin(plugin, { mode: 'sometimes' }),
    /mode must be one of enforce, observe, off/,
  )
})
