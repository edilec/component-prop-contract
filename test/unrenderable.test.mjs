/**
 * A value that cannot be stringified must not cost the report.
 *
 * `String({toString: {}})` throws `Cannot convert object to primitive value`.
 * Five of ten tools in a recent batch aborted on it with EMPTY stdout -- the
 * shape this contract reserves for a configuration error -- so one malformed
 * document suppressed the findings for everything else in the run.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { excerpt, renderable } from '../src/index.mjs'
import { BUTTON_SOURCE, contractDocument, makeRoot, removeRoot, runCli } from './support.mjs'

const roots = []
after(async () => { await Promise.all(roots.map(removeRoot)) })

const HOSTILE = '{"toString": {}}'

describe('the primitive', () => {
  test('String() really does throw on it', () => {
    assert.throws(() => String(JSON.parse(HOSTILE)), /Cannot convert object to primitive value/)
  })

  test('renderable describes it by shape instead', () => {
    assert.equal(renderable(JSON.parse(HOSTILE)), '[object]')
    assert.equal(renderable(Object.assign([], { toString: {} })), '[array]')
    assert.equal(renderable('plain'), 'plain')
    assert.equal(renderable(null), 'null')
    assert.equal(renderable(42), '42')
  })

  test('the description carries nothing of the value', () => {
    assert.equal(excerpt(JSON.parse('{"toString": {}, "secret": "AKIAIOSFODNN7EXAMPLE"}')), '[object]')
  })
})

const COMPONENT = '{"id": "Button", "source": "src/Button.tsx", "propsType": "ButtonProps"'

const PLANTS = [
  { name: 'the schemaVersion, read before any schema check', contract: `{"schemaVersion": ${HOSTILE}, "version": "1.0.0", "components": []}` },
  { name: 'the contract version', contract: `{"schemaVersion": "1", "version": ${HOSTILE}, "components": []}` },
  { name: 'the components field', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": ${HOSTILE}}` },
  { name: 'a whole component entry', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${HOSTILE}]}` },
  { name: 'a component id', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [{"id": ${HOSTILE}, "source": "src/Button.tsx", "propsType": "ButtonProps"}]}` },
  { name: 'a component source path', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [{"id": "Button", "source": ${HOSTILE}, "propsType": "ButtonProps"}]}` },
  { name: 'a component propsType', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [{"id": "Button", "source": "src/Button.tsx", "propsType": ${HOSTILE}}]}` },
  { name: 'the props array', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${COMPONENT}, "props": ${HOSTILE}}]}` },
  { name: 'a declared member', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${COMPONENT}, "props": [${HOSTILE}]}]}` },
  { name: 'a declared member name', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${COMPONENT}, "props": [{"name": ${HOSTILE}, "required": true}]}]}` },
  { name: 'a declared member type', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${COMPONENT}, "props": [{"name": "label", "type": ${HOSTILE}, "required": true}]}]}` },
  { name: 'a declared member required flag', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${COMPONENT}, "props": [{"name": "label", "required": ${HOSTILE}}]}]}` },
  { name: 'the argTypes map', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${COMPONENT}, "argTypes": ${HOSTILE}}]}` },
  { name: 'an argTypes entry', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${COMPONENT}, "argTypes": {"label": ${HOSTILE}}}]}` },
  { name: 'an argTypes type', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${COMPONENT}, "argTypes": {"label": {"type": ${HOSTILE}}}}]}` },
  { name: 'an argTypes required flag', contract: `{"schemaVersion": "1", "version": "1.0.0", "components": [${COMPONENT}, "argTypes": {"label": {"type": {"name": "string", "required": ${HOSTILE}}}}}]}` },
  { name: 'the description', contract: `{"schemaVersion": "1", "version": "1.0.0", "description": ${HOSTILE}, "components": []}` },
]

describe('a hostile value never empties stdout', () => {
  for (const plant of PLANTS) {
    test(plant.name, async () => {
      const root = await makeRoot({ 'prop-contract.json': plant.contract, 'src/Button.tsx': BUTTON_SOURCE })
      roots.push(root)

      const { code, stdout } = await runCli(['--root', root, '--json'])
      assert.notEqual(stdout, '', 'stdout is reserved for the report; empty means a configuration error, which this is not')
      const report = JSON.parse(stdout)
      assert.ok(['fail', 'incomplete'].includes(report.status), `unexpected status ${report.status}`)
      assert.ok([1, 2].includes(code), `unexpected exit ${code}`)
      assert.ok(report.findings.length > 0, 'the run still says what it found')
      assert.equal(JSON.stringify(report).includes('Cannot convert object'), false)
    })
  }

  test('one hostile component does not suppress the findings for another', async () => {
    const root = await makeRoot({
      'prop-contract.json': `{"schemaVersion": "1", "version": "1.0.0", "components": [
        {"id": "Button", "source": "src/Button.tsx", "propsType": "ButtonProps", "props": [{"name": "gone", "type": "string", "required": true}]},
        {"id": "Broken", "source": "src/Button.tsx", "propsType": "ButtonProps", "props": [{"name": ${HOSTILE}, "required": true}]}
      ]}`,
      'src/Button.tsx': BUTTON_SOURCE,
    })
    roots.push(root)

    const { stdout } = await runCli(['--root', root, '--json'])
    const report = JSON.parse(stdout)
    const fired = new Set(report.findings.map((finding) => finding.ruleId))
    assert.ok(fired.has('prop-missing'), 'the readable component was still compared')
    assert.ok(fired.has('member-invalid'))
  })
})
