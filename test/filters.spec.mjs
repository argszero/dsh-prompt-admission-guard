/** The registry on its own: order, first-refusal-wins, fail-open, disposal. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AdmissionRegistry, messageText, PromptRefused } from '../lib/index.js'

const input = {
  session: {},
  target: 'next-turn',
  message: { id: 'm1', content: [{ type: 'text', text: 'the code is 123456' }] },
  kind: 'user',
  text: 'the code is 123456',
  messageId: 'm1',
}

test('an empty registry admits everything and counts it', () => {
  const registry = new AdmissionRegistry()
  assert.equal(registry.decide(input), undefined)
  assert.deepEqual(registry.counts(), { filters: 0, refused: 0, failures: 0, admitted: 1 })
})

test('the first refusal wins and later filters do not run', () => {
  const registry = new AdmissionRegistry()
  const ran = []
  registry.use(() => ({ refuse: 'first' }), { id: 'a' })
  registry.use(() => { ran.push('b'); return { refuse: 'second' } }, { id: 'b' })
  const verdict = registry.decide(input)
  assert.equal(verdict.refuse, 'first')
  assert.equal(verdict.filterId, 'a')
  assert.deepEqual(ran, [], 'a later filter runs only after an admitting one')
})

test('a filter that throws is failed open and counted', () => {
  const registry = new AdmissionRegistry()
  const failures = []
  registry.use(() => { throw new Error('filter bug') }, { id: 'broken' })
  registry.use(() => ({ refuse: 'still runs' }), { id: 'after' })
  const verdict = registry.decide(input, (error, id) => failures.push([id, String(error)]))
  assert.equal(verdict.filterId, 'after', 'the throw did not admit the message by itself')
  assert.deepEqual(failures, [['broken', 'Error: filter bug']])
  assert.equal(registry.counts().failures, 1)
})

test('a blank refusal admits, because it gives the sender nothing to read', () => {
  const registry = new AdmissionRegistry()
  registry.use(() => ({ refuse: '   ' }))
  assert.equal(registry.decide(input), undefined)
})

test('disposal removes one filter and is idempotent', () => {
  const registry = new AdmissionRegistry()
  const off = registry.use(() => ({ refuse: 'gone' }), { id: 'x' })
  assert.equal(registry.counts().filters, 1)
  off()
  off()
  assert.equal(registry.counts().filters, 0)
  assert.equal(registry.decide(input), undefined)
})

test('the refusal error stringifies to its sentence alone', () => {
  const error = new PromptRefused('That looks like a one-time code; paste it in the sign-in card.', 'filter-1')
  assert.equal(String(error), 'That looks like a one-time code; paste it in the sign-in card.')
  assert.equal(error.filterId, 'filter-1')
  assert.ok(error instanceof Error)
})

test('message text is read from text blocks without assuming the shape', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { text: 'b' }] }), 'a\nb')
  assert.equal(messageText({ content: [] }), '')
  assert.equal(messageText(null), '')
  assert.equal(messageText({}), '')
})
