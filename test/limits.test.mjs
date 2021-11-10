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

import { DEFAULT_LIMITS, HARD_LIMITS, byCodeUnit, checkPropContract, validateLimits } from '../src/index.mjs'
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

/**
 * The library entry point refuses configuration that never gave the run a
 * subject -- and each refusal needs its own case.
 *
 * Every guard below was removed on its own with the suite green. What follows
 * a missing guard is not a clean run: `options` that is not an object walks
 * into `Object.keys`, a `monotonic` that is not callable is called anyway, a
 * root that is not a string is handed to `realpath`, and a `contract` name
 * carrying a control character or stepping outside the root is resolved. The
 * CLI sees the same guards, because it calls the same function.
 */
describe('the library entry point refuses configuration it cannot use', () => {
  test('options that are not an object', async () => {
    for (const value of ['root', 7, [], null, true]) {
      await assert.rejects(() => checkPropContract(value), /Options must be an object/, JSON.stringify(value))
    }
  })

  test('an unknown option, rather than a silently ignored one', async () => {
    await assert.rejects(() => checkPropContract({ root: '.', contarct: 'x.json' }), /Unknown option "contarct"/)
  })

  test('limits that are not an object', () => {
    for (const value of ['none', 7, [], true]) {
      assert.throws(() => validateLimits(value), /limits must be an object/, JSON.stringify(value))
    }
  })

  test('a monotonic clock that is not callable', async () => {
    await assert.rejects(
      () => checkPropContract({ root: '.', monotonic: 0 }),
      /monotonic must be a function/,
    )
  })

  test('a root that is absent or not a string', async () => {
    for (const options of [{}, { root: 7 }, { root: '' }, { root: null }, { root: [] }]) {
      await assert.rejects(() => checkPropContract(options), /root is required/, JSON.stringify(options))
    }
  })

  test('a contract name that is not a usable file name', async () => {
    const root = await makeRoot({ 'prop-contract.json': contractDocument() })
    roots.push(root)
    // `contract: null` is not in this list on purpose: the reader spells the
    // default with `??`, so null means "use the default" and is accepted.
    for (const name of [7, '', [], true, 'a'.repeat(201)]) {
      await assert.rejects(
        () => checkPropContract({ root, contract: name }),
        /contract must be a relative file name/,
        JSON.stringify(name),
      )
    }
  })

  test('a contract name carrying a control, separator or bidi character', async () => {
    const root = await makeRoot({ 'prop-contract.json': contractDocument() })
    roots.push(root)
    for (const code of [0x01, 0x0a, 0x85, 0x2028, 0x202e]) {
      await assert.rejects(
        () => checkPropContract({ root, contract: `a${String.fromCharCode(code)}b.json` }),
        /contract must not contain a control, separator or bidi character/,
        code.toString(16),
      )
    }
  })

  test('a contract name that is absolute or steps outside the root', async () => {
    const root = await makeRoot({ 'prop-contract.json': contractDocument() })
    roots.push(root)
    await assert.rejects(() => checkPropContract({ root, contract: '/etc/passwd' }), /must be relative to --root/)
    await assert.rejects(() => checkPropContract({ root, contract: '../x.json' }), /must not step outside --root/)
  })

  test('and an ordinary configuration is accepted, so none of this refuses everything', async () => {
    const root = await makeRoot({ 'prop-contract.json': contractDocument(), 'src/Button.tsx': BUTTON_SOURCE })
    roots.push(root)
    const report = await checkPropContract({ root, contract: 'prop-contract.json', limits: { maxMembers: 10 } })
    assert.equal(report.status, 'pass')
  })
})

describe('the diagnostics for a refused limit are ordered, not incidental', () => {
  test('the unknown key reported first is the first by code unit, not by collation', () => {
    // Two unknown keys: a collator puts `alpha` before `Zed`, code units put
    // `Zed` first. Whichever comes first is the one the message names, so the
    // comparator is observable here and nowhere else.
    assert.throws(() => validateLimits({ Zed: 1, alpha: 1 }), /Unknown limit "Zed"/)
    assert.throws(() => validateLimits({ alpha: 1, Zed: 1 }), /Unknown limit "Zed"/)
  })

  test('the known limits are listed in code-unit order', () => {
    try {
      validateLimits({ nope: 1 })
      assert.fail('an unknown limit must throw')
    } catch (error) {
      const listed = error.message.split('known limits are ')[1].split(', ')
      assert.deepEqual(listed, [...listed].sort(byCodeUnit))
      assert.deepEqual(listed, Object.keys(DEFAULT_LIMITS).sort(byCodeUnit))
    }
  })
})
