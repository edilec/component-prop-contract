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

  test('several findings sharing one pointer order by message, not by the order they were emitted', async () => {
    // The `message` key is the fourth and last, and it only shows itself where
    // emission order and message order DISAGREE. Every earlier attempt at this
    // test used findings the emission loop had already sorted by name, so
    // `Array.prototype.sort` being stable made the assertion pass with the key
    // removed. Private members are emitted in SOURCE order, so declaring
    // `_zeta` before `_alpha` makes the two orders differ.
    const { report: emitted } = await report({
      'prop-contract.json': contractDocument({
        components: [componentEntry({
          props: [{ name: 'label', type: 'string', required: true }],
          events: [],
        })],
      }),
      'src/Button.tsx': `export interface ButtonProps {
  label: string;
  _zeta?: string;
  _alpha?: string;
}
`,
    })

    const excluded = emitted.findings.filter((finding) => finding.ruleId === 'private-member-excluded')
    assert.equal(excluded.length, 2)
    assert.equal(
      new Set(excluded.map((finding) => finding.location.pointer)).size,
      1,
      'both findings share one pointer, so only the message can order them',
    )
    assert.match(excluded[0].message, /"_alpha"/, 'the message key orders these, not the source order they were read in')
    assert.match(excluded[1].message, /"_zeta"/)
    assert.deepEqual(excluded.map((finding) => finding.message), [...excluded.map((finding) => finding.message)].sort(byCodeUnit))
  })

  /**
   * The pointer key is SECOND, and a collator reorders it.
   *
   * Dropping the key fails a test; substituting `Intl.Collator` for it did
   * not, because every fixture used pointers the two orders agree about. An
   * `argTypes` key is part of the pointer, and `Z` against `a` is exactly the
   * pair collation reverses.
   */
  test('findings sharing a file order by pointer the way code units order them', async () => {
    const { report: emitted } = await report({
      'prop-contract.json': contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: {
            Z: { type: { name: 'string', required: true } },
            a: { type: { name: 'string', required: true } },
          },
        })],
      }),
      'src/Button.tsx': `export interface ButtonProps {
  Z: number;
  a: number;
}
`,
    })

    const pointers = emitted.findings.map((finding) => finding.location.pointer)
    assert.deepEqual(pointers, ['/components/0/argTypes/Z', '/components/0/argTypes/a'])
    assert.equal(
      new Set(emitted.findings.map((finding) => finding.location.file)).size,
      1,
      'both findings name one file, so only the pointer can order them',
    )
    assert.deepEqual(pointers, [...pointers].sort(byCodeUnit))
  })

  /**
   * Ordering decides a VERDICT here, not only a report's shape.
   *
   * A union is compared as a set: both sides are sorted and compared element
   * by element, so the comparator inside `matchesType` decides whether a type
   * matches. Substituting a collator at either sort site -- or for the
   * primitive itself -- turned this run from exit 0 into `prop-type-changed`
   * at exit 1, with the whole suite green. `'Z'` against `'a'` is the pair
   * that shows it.
   */
  test('a union whose members collate differently from their code units still matches', async () => {
    const { code, report: emitted } = await report({
      'prop-contract.json': contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { tone: { type: { name: 'enum', value: ['Z', 'a'], required: true } } },
        })],
      }),
      'src/Button.tsx': `export interface ButtonProps {
  tone: 'Z' | 'a';
}
`,
    })
    assert.equal(code, 0, 'the contract states exactly the type the source declares')
    assert.equal(emitted.status, 'pass')
    assert.equal(emitted.summary.typesMatched, 1)
    assert.equal(emitted.summary.typesChanged, 0)
  })

  /**
   * And the pair that catches the comparator being swapped WHOLESALE.
   *
   * Sorting both sides with the same collator keeps most unions matching, so
   * replacing the primitive rather than one call site survived the case above.
   * A collator does not merely order differently -- it calls distinct strings
   * EQUAL. U+00AD (SOFT HYPHEN) is ignorable to `Intl.Collator('en')` and is
   * not one of the characters this tool strips, so `ab` and `a<U+00AD>b` are
   * two different values that a collator cannot tell apart: the two sides tie,
   * the stable sort leaves each in the order it arrived, and a union that
   * matches is reported as changed.
   */
  test('a union carrying a character a collator ignores is still compared by code unit', async () => {
    const soft = `a${String.fromCharCode(0x00ad)}b`
    const { code, report: emitted } = await report({
      'prop-contract.json': contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { tone: { type: { name: 'enum', value: [soft, 'ab'], required: true } } },
        })],
      }),
      'src/Button.tsx': `export interface ButtonProps {
  tone: 'ab' | '${soft}';
}
`,
    })
    assert.equal(code, 0, 'the two sides state the same set, in the orders a collator would tie')
    assert.equal(emitted.summary.typesMatched, 1)
    assert.equal(emitted.summary.typesChanged, 0)
  })

  test('and a union that really differs still fails, so the comparison is not simply agreeing', async () => {
    const { code, report: emitted } = await report({
      'prop-contract.json': contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { tone: { type: { name: 'enum', value: ['Z', 'a'], required: true } } },
        })],
      }),
      'src/Button.tsx': `export interface ButtonProps {
  tone: 'Z' | 'b';
}
`,
    })
    assert.equal(code, 1)
    assert.equal(emitted.summary.typesChanged, 1)
  })

  test('several added props sharing one pointer are listed in code-unit order', async () => {
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
