/**
 * Unknown is never a pass.
 *
 * Every case here is evidence the tool wanted and did not get. Each must
 * produce `status: "incomplete"`, exit 2, and a report on stdout naming which
 * file was not read -- and must never be reported as a member being absent.
 *
 * The second half of each assertion is the one that matters: the component is
 * NOT compared. A surface this tool only half established would report a
 * contract member as missing from a source that declares it perfectly well.
 */

import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { checkPropContract, exitCodeFor } from '../src/index.mjs'
import {
  BUTTON_SOURCE, componentEntry, contractDocument, makeCase, makeRoot, removeRoot, reportFor,
} from './support.mjs'

const roots = []
async function track(root) {
  roots.push(root)
  return root
}
after(async () => { await Promise.all(roots.map(removeRoot)) })

const COMPARISON_RULES = ['prop-missing', 'event-missing', 'prop-added', 'event-added', 'prop-type-changed', 'prop-now-required']

function assertNothingCompared(report) {
  for (const ruleId of COMPARISON_RULES) {
    assert.equal(
      report.findings.some((finding) => finding.ruleId === ruleId),
      false,
      `${ruleId} was reported about a surface nobody established`,
    )
  }
  assert.equal(report.summary.membersMissing, 0)
  assert.equal(report.summary.membersMatched, 0)
  assert.equal(report.summary.componentsCompared, 0)
}

describe('a contract that did not arrive', () => {
  const CASES = [
    { name: 'is not there', files: { 'src/Button.tsx': BUTTON_SOURCE }, ruleId: 'input-unreadable' },
    { name: 'is not valid JSON', files: { 'prop-contract.json': '{ "components": [', 'src/Button.tsx': BUTTON_SOURCE }, ruleId: 'input-not-json' },
    { name: 'parsed as an array', files: { 'prop-contract.json': '[]', 'src/Button.tsx': BUTTON_SOURCE }, ruleId: 'input-not-json' },
    {
      name: 'declares a schema version this build does not understand',
      files: { 'prop-contract.json': contractDocument({ schemaVersion: '2' }), 'src/Button.tsx': BUTTON_SOURCE },
      ruleId: 'schema-version-unsupported',
    },
  ]

  for (const scenario of CASES) {
    test(scenario.name, async () => {
      const root = await track(await makeRoot(scenario.files))
      const { code, report } = await reportFor(root)
      assert.equal(report.status, 'incomplete')
      assert.equal(code, 2)
      assert.ok(report.findings.some((finding) => finding.ruleId === scenario.ruleId))
      assertNothingCompared(report)
    })
  }

  test('is not valid UTF-8', async () => {
    const root = await track(await makeRoot({ 'src/Button.tsx': BUTTON_SOURCE }))
    await writeFile(join(root, 'prop-contract.json'), Buffer.from([0x7b, 0x80, 0x7d]))
    const { code, report } = await reportFor(root)
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'input-not-utf8'))
  })

  test('leaves a report on stdout naming which file failed', async () => {
    const root = await track(await makeRoot({ 'src/Button.tsx': BUTTON_SOURCE }))
    const { stdout } = await reportFor(root)
    assert.notEqual(stdout, '')
    const report = JSON.parse(stdout)
    assert.equal(report.findings[0].location.file, 'prop-contract.json')
  })
})

describe('a source that did not arrive', () => {
  test('a source that is not there is incomplete, and nothing is reported as missing from it', async () => {
    const root = await track(await makeRoot({ 'prop-contract.json': contractDocument() }))
    const { code, report } = await reportFor(root)
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    const finding = report.findings.find((entry) => entry.ruleId === 'source-unreadable')
    assert.ok(finding)
    assert.match(finding.message, /An unread file is not a file with no props/)
    assertNothingCompared(report)
  })

  test('a source that is not valid UTF-8 is incomplete', async () => {
    const root = await track(await makeCase())
    await writeFile(join(root, 'src', 'Button.tsx'), Buffer.from([0x65, 0x80, 0x66]))
    const { code, report } = await reportFor(root)
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'source-not-utf8'))
    assertNothingCompared(report)
  })

  test('a source holding a literal replacement character still decodes and is compared normally', async () => {
    // The sibling defect: inferring "not UTF-8" from a U+FFFD in decoded text
    // disables the guard for any file that legitimately contains one.
    const root = await track(await makeCase(contractDocument(), `export interface ButtonProps {
  /** shows � when the encoding is wrong */
  label: string;
  variant?: 'primary' | 'secondary';
  onClick?: (event: MouseEvent) => void;
}
`))
    const { code, report } = await reportFor(root)
    assert.equal(report.status, 'pass')
    assert.equal(code, 0)
  })

  test('a source the process may not read is incomplete, not absent', async () => {
    const root = await track(await makeCase())
    const source = join(root, 'src', 'Button.tsx')
    await chmod(source, 0o000)
    try {
      const { code, report } = await reportFor(root)
      if (report.status === 'pass') return // running as root defeats the permission bit
      assert.equal(report.status, 'incomplete')
      assert.equal(code, 2)
      assertNothingCompared(report)
    } finally {
      await chmod(source, 0o644)
    }
  })

  test('a contract naming a source path outside the root is refused before it is resolved', async () => {
    const root = await track(await makeCase(contractDocument({
      components: [componentEntry({ source: '../elsewhere/Button.tsx' })],
    })))
    const { code, report } = await reportFor(root)
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    const finding = report.findings.find((entry) => entry.ruleId === 'source-path-invalid')
    assert.ok(finding, 'the path comes out of an untrusted document and is checked before anything is opened')
    assertNothingCompared(report)
  })

  test('a contract naming an absolute source path is refused', async () => {
    const root = await track(await makeCase(contractDocument({
      components: [componentEntry({ source: '/etc/hosts' })],
    })))
    const { code, report } = await reportFor(root)
    assert.equal(code, 2)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'source-path-invalid'))
  })

  /**
   * The recogniser's own refusals, driven through the real CLI.
   *
   * `test/typescript.test.mjs` asserts the reason each one records; that is a
   * unit test of a function. What decides whether an unread surface reports a
   * pass is the EXIT CODE, and each case below is a member this tool could not
   * classify -- so the component must not be compared and the run must not be
   * green. Each of these guards survived a deletion with the whole suite
   * passing before these tests existed.
   */
  const UNREAD_MEMBER_CASES = [
    {
      name: 'a member whose name is not an identifier',
      source: 'export interface ButtonProps {\n  label: string;\n  3d: number;\n}\n',
      reason: /a member whose name could not be read/,
    },
    {
      name: 'a member with an empty type annotation',
      source: 'export interface ButtonProps {\n  label: string;\n  other: ;\n}\n',
      reason: /a member with no type annotation/,
    },
    {
      name: 'a member with no type annotation at all',
      source: 'export interface ButtonProps {\n  label: string;\n  other;\n}\n',
      reason: /a member with no type annotation/,
    },
  ]

  for (const item of UNREAD_MEMBER_CASES) {
    test(`${item.name} makes the run incomplete and compares nothing`, async () => {
      const root = await track(await makeCase(
        contractDocument({
          components: [componentEntry({
            props: [{ name: 'label', type: 'string', required: true }],
            events: [],
          })],
        }),
        item.source,
      ))
      const { code, report } = await reportFor(root)
      assert.equal(code, 2, 'a half-established surface is never a pass')
      assert.equal(report.status, 'incomplete')
      const finding = report.findings.find((entry) => entry.ruleId === 'source-unsupported-syntax')
      assert.ok(finding, `expected source-unsupported-syntax, got ${report.findings.map((entry) => entry.ruleId).join(', ')}`)
      assert.match(finding.message, item.reason)
      assert.match(finding.message, /at line 3/)
      assertNothingCompared(report)
    })
  }

  test('and the same sources with the offending member removed are compared and pass', async () => {
    const root = await track(await makeCase(
      contractDocument({
        components: [componentEntry({
          props: [{ name: 'label', type: 'string', required: true }],
          events: [],
        })],
      }),
      'export interface ButtonProps {\n  label: string;\n}\n',
    ))
    const { code, report } = await reportFor(root)
    assert.equal(code, 0, 'the guard refuses the unreadable member, not every source')
    assert.equal(report.summary.componentsCompared, 1)
  })
})

describe('a budget that expires mid-run leaves nothing looking compared', () => {
  test('the run is incomplete and reports no verdict for the components it never reached', async () => {
    const root = await track(await makeCase())
    let ticks = 0
    const report = await checkPropContract({
      root,
      limits: { maxRuntimeMs: 1 },
      monotonic: () => { ticks += 1; return ticks === 1 ? 0 : 5000 },
    })
    assert.equal(report.status, 'incomplete')
    assert.equal(exitCodeFor(report), 2)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'time-budget-exceeded'))
    assertNothingCompared(report)
  })

  test('the same files with the budget intact do reach a verdict', async () => {
    const root = await track(await makeCase())
    const report = await checkPropContract({ root })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.membersMatched, 3)
  })
})

describe('a pass over no evidence is refused', () => {
  test('a contract governing no components fails rather than reporting a green nothing', async () => {
    const root = await track(await makeCase(contractDocument({ components: [] })))
    const { code, report } = await reportFor(root)
    assert.equal(report.summary.checked, 0)
    assert.equal(report.status, 'fail')
    assert.equal(code, 1)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'no-components-declared'))
  })

  test('a component declaring no members at all is refused', async () => {
    const root = await track(await makeCase(contractDocument({
      components: [{ id: 'Button', source: 'src/Button.tsx', propsType: 'ButtonProps' }],
    })))
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'no-members-declared'))
    assert.equal(report.summary.components, 0)
  })

  test('a props type with no public members is reported rather than matched against silently', async () => {
    const root = await track(await makeCase(contractDocument({
      components: [componentEntry({ props: [{ name: 'label', type: 'string', required: true }], events: [] })],
    }), 'export interface ButtonProps { _private?: string; }'))
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'props-type-empty'))
  })

  test('a contract with no version fails, because a verdict has to be about a version somebody can name', async () => {
    const root = await track(await makeCase({ schemaVersion: '1', components: [componentEntry()] }))
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'contract-version-missing'))
    assert.equal(report.summary.contractVersion, null)
  })
})
