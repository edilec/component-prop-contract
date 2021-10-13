/**
 * Every documented limit is enforced, and an unknown one is refused.
 *
 * A config key accepted and silently ignored is how a one-character typo turns
 * a real failure into a green run -- a defect this catalog has already
 * shipped. Reaching a limit is an `incomplete` result with a finding naming
 * it, never a silent truncation and never a pass over the part reached.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, checkPropContract, validateLimits } from '../src/index.mjs'
import {
  BUTTON_SOURCE, componentEntry, contractDocument, makeCase, makeRoot, removeRoot, runCli,
} from './support.mjs'

const roots = []
async function track(root) {
  roots.push(root)
  return root
}
after(async () => { await Promise.all(roots.map(removeRoot)) })

async function reportWith(files, args) {
  const root = await track(await makeRoot(files))
  const result = await runCli(['--root', root, '--json', ...args])
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

const BASE = { 'prop-contract.json': contractDocument(), 'src/Button.tsx': BUTTON_SOURCE }

describe('each limit stops the run and says which one', () => {
  test('maxContractBytes', async () => {
    const { code, report } = await reportWith(
      { ...BASE, 'prop-contract.json': contractDocument({ description: 'x'.repeat(4000) }) },
      ['--max-contract-bytes', '100'],
    )
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.match(report.findings.find((entry) => entry.ruleId === 'input-too-large').message, /maxContractBytes limit of 100/)
  })

  test('maxSourceBytes', async () => {
    const { code, report } = await reportWith(BASE, ['--max-source-bytes', '10'])
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.match(report.findings.find((entry) => entry.ruleId === 'source-too-large').message, /maxSourceBytes limit of 10/)
    assert.equal(report.summary.componentsCompared, 0)
  })

  test('maxComponents', async () => {
    const components = Array.from({ length: 4 }, (item, index) => componentEntry({ id: `C${index}` }))
    const { code, report } = await reportWith({ ...BASE, 'prop-contract.json': contractDocument({ components }) }, ['--max-components', '2'])
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.match(report.findings.find((entry) => entry.ruleId === 'too-many-components').message, /maxComponents limit of 2/)
    assert.equal(report.summary.components, 0, 'nothing is read out of a list nobody examined')
  })

  test('maxMembers', async () => {
    const { code, report } = await reportWith(BASE, ['--max-members', '2'])
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.match(report.findings.find((entry) => entry.ruleId === 'too-many-members').message, /maxMembers limit of 2/)
    assert.equal(report.summary.componentsCompared, 0)
  })

  test('maxTypeChars', async () => {
    const { code, report } = await reportWith(BASE, ['--max-type-chars', '3'])
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.match(report.findings.find((entry) => entry.ruleId === 'type-too-complex').message, /maxTypeChars limit of 3/)
  })

  test('maxTypeDepth', async () => {
    const { code, report } = await reportWith(
      { ...BASE, 'src/Button.tsx': 'export interface ButtonProps { label: { a: { b: { c: string } } }; }' },
      ['--max-type-depth', '2'],
    )
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.ok(report.findings.some((entry) => entry.ruleId === 'type-too-complex'))
  })

  test('maxFindings', async () => {
    const source = `export interface ButtonProps {
  a?: string;
  b?: string;
  c?: string;
  d?: string;
  e?: string;
}
`
    const { code, report } = await reportWith({ ...BASE, 'src/Button.tsx': source }, ['--max-findings', '3'])
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.equal(report.findings.length, 3)
    assert.match(report.findings.find((entry) => entry.ruleId === 'too-many-findings').message, /maxFindings limit of 3/)
  })

  test('maxRuntimeMs', async () => {
    const root = await track(await makeCase())
    let ticks = 0
    const report = await checkPropContract({
      root,
      limits: { maxRuntimeMs: 5 },
      monotonic: () => { ticks += 1; return ticks === 1 ? 0 : 5000 },
    })
    assert.equal(report.status, 'incomplete')
    assert.match(report.findings.find((entry) => entry.ruleId === 'time-budget-exceeded').message, /maxRuntimeMs budget of 5 ms/)
  })
})

describe('the limits above their thresholds do not fire', () => {
  test('a run comfortably inside every default limit passes', async () => {
    const { code, report } = await reportWith(BASE, [])
    assert.equal(report.status, 'pass')
    assert.equal(code, 0)
  })
})

describe('configuration that was never valid is refused, not ignored', () => {
  test('an unknown limit key throws rather than being dropped', () => {
    assert.throws(() => validateLimits({ maxMember: 5 }), /Unknown limit "maxMember"/)
  })

  test('a limit past its hard cap, below one, or not an integer is refused', () => {
    for (const [key, cap] of Object.entries(HARD_LIMITS)) {
      assert.throws(() => validateLimits({ [key]: cap + 1 }), new RegExp(`limits\\.${key}`))
      assert.throws(() => validateLimits({ [key]: 0 }), new RegExp(`limits\\.${key}`))
      assert.throws(() => validateLimits({ [key]: 1.5 }), new RegExp(`limits\\.${key}`))
    }
  })

  test('every default is inside its own cap, and every cap has a default', () => {
    assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), Object.keys(HARD_LIMITS).sort())
    for (const [key, value] of Object.entries(DEFAULT_LIMITS)) assert.ok(value <= HARD_LIMITS[key], key)
  })

  test('an unknown option to the library throws', async () => {
    const root = await track(await makeCase())
    await assert.rejects(() => checkPropContract({ root, contracts: 'x.json' }), /Unknown option "contracts"/)
  })

  test('every limit flag the help documents is wired to a real limit', async () => {
    const { stdout } = await runCli(['--help'])
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
      assert.ok(stdout.includes(flag), `${flag} is not documented`)
    }
  })

  test('every documented limit flag really changes a run', async () => {
    // A flag that is accepted and never compared against is the defect this
    // catalog has already shipped once. Each is exercised above; this asserts
    // the set is complete rather than a subset somebody remembered.
    assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [
      'maxComponents', 'maxContractBytes', 'maxFindings', 'maxMembers',
      'maxRuntimeMs', 'maxSourceBytes', 'maxTypeChars', 'maxTypeDepth',
    ])
  })
})
