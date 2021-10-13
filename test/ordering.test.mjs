/**
 * Ordering is observable output, and it is pinned behaviourally.
 *
 * A source scan for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text, so the scan passes while two correct machines start disagreeing about
 * the same report. Every assertion here drives real files through the real
 * entry point and asserts the exact emitted order.
 *
 * Prop names are where this bites hardest, because the characters that divide
 * code-unit from collation ordering are exactly the ones prop names use:
 * `aria-label` against `ariaLabel` (a hyphen is ignorable punctuation to a
 * collator) and `onBlur` against `onblur` (case folds).
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { byCodeUnit, listNames } from '../src/index.mjs'
import { componentEntry, contractDocument, makeRoot, removeRoot, runCli } from './support.mjs'

const roots = []
after(async () => { await Promise.all(roots.map(removeRoot)) })

const MIXED_SOURCE = `export interface ButtonProps {
  Z?: string;
  'aria-label'?: string;
  ariaLabel?: string;
  onBlur?: () => void;
  onblur?: () => void;
}
`

async function report(files, args = []) {
  const root = await makeRoot(files)
  roots.push(root)
  const result = await runCli(['--root', root, '--json', ...args])
  return { ...result, report: JSON.parse(result.stdout) }
}

describe('findings sort by code unit, not by collation', () => {
  test('a name list in an evidence field is ordered by code unit', async () => {
    // By code unit:  Z, aria-label, ariaLabel, onBlur, onblur
    // By collation:  the hyphen is ignorable and case folds, so both pairs
    //                swap and Z moves to the end.
    const { report: emitted } = await report({
      'prop-contract.json': contractDocument({
        components: [componentEntry({
          props: [{ name: 'label', type: 'string', required: true }],
          events: [],
        })],
      }),
      'src/Button.tsx': MIXED_SOURCE,
    })

    const finding = emitted.findings.find((entry) => entry.ruleId === 'prop-missing')
    assert.ok(finding)
    assert.equal(
      finding.evidence,
      'public members of ButtonProps: Z, aria-label, ariaLabel, onBlur, onblur',
      'the member names are listed in code-unit order, which is not the order a collator produces',
    )
  })

  test('findings about several sources order by file name the way code units order them', async () => {
    // Z (0x5A) precedes a (0x61) by code unit; every collation table this
    // catalog has met reverses that.
    const { report: emitted } = await report({
      'prop-contract.json': contractDocument({
        components: [
          componentEntry({ id: 'A', source: 'a.tsx', propsType: 'AProps', props: [{ name: 'gone', type: 'string', required: true }], events: [] }),
          componentEntry({ id: 'Z', source: 'Z.tsx', propsType: 'ZProps', props: [{ name: 'gone', type: 'string', required: true }], events: [] }),
        ],
      }),
      'a.tsx': 'export interface AProps { here: string; }',
      'Z.tsx': 'export interface ZProps { here: string; }',
    })

    const files = emitted.findings.map((finding) => finding.location.file)
    assert.ok(files.includes('Z.tsx') && files.includes('a.tsx'))
    assert.deepEqual(files, [...files].sort(byCodeUnit))
    assert.equal(files[0], 'Z.tsx', 'Z sorts before a by code unit; a collator would put it last')
  })

  test('several findings sharing one pointer order by message, which is by member name', async () => {
    const { report: emitted } = await report({
      'prop-contract.json': contractDocument({
        components: [componentEntry({
          props: [{ name: 'label', type: 'string', required: true }],
          events: [],
        })],
      }),
      'src/Button.tsx': `export interface ButtonProps {
  label: string;
  Z?: string;
  'aria-label'?: string;
  ariaLabel?: string;
}
`,
    })

    const added = emitted.findings
      .filter((finding) => finding.ruleId === 'prop-added')
      .map((finding) => finding.message)
    assert.equal(added.length, 3)
    assert.deepEqual(added, [...added].sort(byCodeUnit))
    assert.match(added[0], /"Z"/, 'Z first by code unit')
    assert.match(added[1], /"aria-label"/)
    assert.match(added[2], /"ariaLabel"/)
  })

  test('a union type is compared as a set, so member order in the source is not a change', async () => {
    const { code } = await report({
      'prop-contract.json': contractDocument({
        components: [componentEntry({
          props: [{ name: 'tone', type: "'a' | 'b' | 'c'", required: false }],
          events: [],
        })],
      }),
      'src/Button.tsx': "export interface ButtonProps { tone?: 'c' | 'a' | 'b'; }",
    })
    assert.equal(code, 0)
  })
})

describe('the ordering primitive itself', () => {
  test('byCodeUnit puts Z before a, aria-label before ariaLabel, onBlur before onblur', () => {
    assert.equal(byCodeUnit('Z', 'a'), -1)
    assert.equal(byCodeUnit('aria-label', 'ariaLabel'), -1)
    assert.equal(byCodeUnit('onBlur', 'onblur'), -1)
    assert.equal(byCodeUnit('README', 'assets'), -1)
    assert.equal(byCodeUnit('same', 'same'), 0)
  })

  test('listNames deduplicates, orders and bounds', () => {
    assert.equal(listNames([]), 'none')
    assert.equal(listNames(['b', 'a', 'b']), 'a, b')
    assert.equal(listNames(['d', 'c', 'b', 'a'], 2), 'a, b and 2 more')
  })
})
