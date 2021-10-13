/**
 * The three acceptance criteria for this tool, item by item:
 *
 *   1. Removing a required prop contract fails.
 *   2. Private implementation details are excluded.
 *   3. Unsupported syntax is reported.
 *
 * All three are asserted against what the real entry point emits, never
 * against a constant this file also owns.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import {
  BUTTON_SOURCE, componentEntry, contractDocument, makeCase, makeRoot, removeRoot, reportFor,
} from './support.mjs'

const roots = []
async function caseRoot(contract, source) {
  const root = await makeCase(contract, source)
  roots.push(root)
  return root
}
after(async () => { await Promise.all(roots.map(removeRoot)) })

describe('removing a required prop contract fails', () => {
  test('a required prop the source no longer declares is an error, and the run exits 1', async () => {
    const root = await caseRoot(contractDocument(), `export interface ButtonProps {
  variant?: 'primary' | 'secondary';
  onClick?: (event: MouseEvent) => void;
}
`)

    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    assert.equal(report.status, 'fail')

    const missing = report.findings.filter((finding) => finding.ruleId === 'prop-missing')
    assert.equal(missing.length, 1)
    const [finding] = missing
    assert.equal(finding.severity, 'error')
    assert.match(finding.message, /"label"/)
    assert.match(finding.message, /"Button"/)
    assert.equal(finding.location.file, 'src/Button.tsx')
    assert.equal(finding.location.pointer, '/components/0/props/0')
    assert.equal(finding.evidence, 'public members of ButtonProps: onClick, variant')
    assert.equal(report.summary.membersMissing, 1)
  })

  test('the same prop restored passes', async () => {
    const root = await caseRoot()
    const { code, report } = await reportFor(root)
    assert.equal(code, 0)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.membersMissing, 0)
    assert.equal(report.summary.membersMatched, 3)
  })

  test('a required event the source no longer declares fails too', async () => {
    const root = await caseRoot(contractDocument(), `export interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
}
`)
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const finding = report.findings.find((entry) => entry.ruleId === 'event-missing')
    assert.ok(finding)
    assert.match(finding.message, /"onClick"/)
    assert.equal(finding.location.pointer, '/components/0/events/0')
  })

  test('a member declared with argTypes and dropped from the source fails identically', async () => {
    const root = await caseRoot(
      contractDocument({
        components: [{
          id: 'Button',
          source: 'src/Button.tsx',
          propsType: 'ButtonProps',
          argTypes: {
            label: { type: { name: 'string', required: true } },
            tone: { type: { name: 'enum', value: ['quiet', 'loud'] } },
          },
        }],
      }),
      BUTTON_SOURCE,
    )
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const finding = report.findings.find((entry) => entry.ruleId === 'prop-missing')
    assert.ok(finding)
    assert.match(finding.message, /"tone"/)
    assert.equal(finding.location.pointer, '/components/0/argTypes/tone')
  })

  test('the other incompatible changes fail as well, and the compatible ones do not', async () => {
    const root = await caseRoot(contractDocument(), `export interface ButtonProps {
  label: string;
  variant: 'primary' | 'secondary';
  onClick?: (event: KeyboardEvent) => void;
  loading?: boolean;
}
`)
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const fired = new Set(report.findings.map((finding) => finding.ruleId))
    assert.ok(fired.has('prop-now-required'), 'an optional prop the source now requires breaks callers')
    assert.ok(fired.has('event-type-changed'), 'a changed event payload breaks callers')
    assert.ok(fired.has('prop-added'), 'an addition is reported')
    assert.equal(
      report.findings.find((finding) => finding.ruleId === 'prop-added').severity,
      'warning',
      'an addition is compatible and must not fail the run on its own',
    )
    assert.equal(report.summary.madeRequired, 1)
    assert.equal(report.summary.membersAdded, 1)
  })

  test('an addition on its own is a pass', async () => {
    const root = await caseRoot(contractDocument(), `export interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
  onClick?: (event: MouseEvent) => void;
  loading?: boolean;
}
`)
    const { code, report } = await reportFor(root)
    assert.equal(code, 0)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.membersAdded, 1)
    assert.equal(report.summary.warnings, 1)
  })
})

describe('private implementation details are excluded', () => {
  const PRIVATE_SOURCE = `export interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
  onClick?: (event: MouseEvent) => void;
  /** @internal harness wiring */
  instrumentation?: (name: string) => void;
  /** @private legacy shim */
  legacyBridge?: unknown;
  _renderCount?: number;
}
`

  test('an @internal, a @private and an underscore member are none of them reported as additions', async () => {
    const root = await caseRoot(contractDocument(), PRIVATE_SOURCE)
    const { code, report } = await reportFor(root)
    assert.equal(code, 0, 'three members the contract does not list, and the run still passes')
    assert.equal(report.status, 'pass')
    assert.equal(
      report.findings.some((finding) => finding.ruleId === 'prop-added'),
      false,
      'a private member is not part of the public surface, so it is not an addition',
    )
    assert.equal(report.summary.privateMembersExcluded, 3)
    assert.equal(report.summary.publicMembers, 3)
  })

  test('each exclusion is visible in the report, with the reason', async () => {
    const root = await caseRoot(contractDocument(), PRIVATE_SOURCE)
    const { report } = await reportFor(root)
    const excluded = report.findings.filter((finding) => finding.ruleId === 'private-member-excluded')
    assert.equal(excluded.length, 3)
    for (const finding of excluded) assert.equal(finding.severity, 'info')
    const reasons = excluded.map((finding) => finding.message).join('\n')
    assert.match(reasons, /an @internal tag/)
    assert.match(reasons, /a @private tag/)
    assert.match(reasons, /a leading underscore/)
  })

  test('a private member is not compared against a contract that names it either', async () => {
    // Excluded in BOTH directions: the contract asking for `_renderCount` does
    // not make it public, so it is reported as missing rather than matched.
    const root = await caseRoot(
      contractDocument({
        components: [componentEntry({
          props: [
            { name: 'label', type: 'string', required: true },
            { name: '_renderCount', type: 'number', required: false },
          ],
          events: [],
        })],
      }),
      PRIVATE_SOURCE,
    )
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const finding = report.findings.find((entry) => entry.ruleId === 'prop-missing')
    assert.ok(finding, 'a private member does not satisfy a public contract')
    assert.match(finding.message, /_renderCount/)
  })

  test('a props type that is declared but not exported is not a public surface', async () => {
    const root = await caseRoot(contractDocument(), `interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
  onClick?: (event: MouseEvent) => void;
}
`)
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const finding = report.findings.find((entry) => entry.ruleId === 'props-type-not-exported')
    assert.ok(finding)
    assert.match(finding.message, /not exported/)
    assert.equal(
      report.findings.some((entry) => entry.ruleId === 'prop-missing'),
      false,
      'the members are not reported one by one: the whole declaration is the problem',
    )
    assert.equal(report.summary.componentsCompared, 0)
  })
})

describe('unsupported syntax is reported', () => {
  const UNSUPPORTED = [
    { name: 'a generic declaration', source: 'export interface ButtonProps<T> { label: T; }', match: /generic declaration/ },
    { name: 'an extends clause', source: 'export interface ButtonProps extends Base { label: string; }', match: /"extends" clause/ },
    { name: 'a type alias that is a union', source: "export type ButtonProps = { label: string } | { title: string }", match: /not a plain object literal/ },
    { name: 'a type alias that is an intersection', source: 'export type ButtonProps = { label: string } & Base;', match: /not a plain object literal/ },
    { name: 'a mapped or derived alias', source: "export type ButtonProps = Omit<Base, 'x'>;", match: /not a plain object literal/ },
    { name: 'an index signature', source: 'export interface ButtonProps { [key: string]: unknown; label: string; }', match: /index signature/ },
    { name: 'a method signature', source: 'export interface ButtonProps { render(): void; label: string; }', match: /method signature/ },
    { name: 'a call signature', source: 'export interface ButtonProps { (x: number): void; label: string; }', match: /call or construct signature/ },
    { name: 'a member with no type', source: 'export interface ButtonProps { label; }', match: /no type annotation/ },
    { name: 'a member with no terminator', source: 'export interface ButtonProps {\n  label: string\n  variant?: string;\n}', match: /spans a line break/ },
    { name: 'a declaration appearing twice', source: 'export interface ButtonProps { label: string; }\nexport interface ButtonProps { title: string; }', match: /declared more than once/ },
    { name: 'an unterminated block comment', source: 'export interface ButtonProps { label: string; }\n/* oops', match: /unterminated block comment/ },
    { name: 'a template literal with a substitution', source: 'export interface ButtonProps { label: `a${1}`; }', match: /template literal/ },
  ]

  for (const scenario of UNSUPPORTED) {
    test(`${scenario.name} is named, and the component is not compared`, async () => {
      const root = await caseRoot(contractDocument(), scenario.source)
      const { code, report } = await reportFor(root)

      assert.equal(report.status, 'incomplete', 'a surface that was not established is not evidence')
      assert.equal(code, 2)

      const finding = report.findings.find(
        (entry) => entry.ruleId === 'source-unsupported-syntax' || entry.ruleId === 'props-type-ambiguous',
      )
      assert.ok(finding, 'the construct is reported by name rather than guessed at')
      assert.match(finding.message, scenario.match)

      // The consequence, and the reason this matters at all.
      assert.equal(
        report.findings.some((entry) => ['prop-missing', 'event-missing', 'prop-added', 'prop-type-changed'].includes(entry.ruleId)),
        false,
        'nothing is reported as missing from, or added to, a surface that was never established',
      )
      assert.equal(report.summary.componentsCompared, 0)
      assert.equal(report.summary.membersMissing, 0)
      assert.equal(report.summary.membersMatched, 0)
    })
  }

  test('the finding says where, so the construct can be found', async () => {
    const root = await caseRoot(contractDocument(), `// a comment first
export interface ButtonProps extends Base {
  label: string;
}
`)
    const { report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'source-unsupported-syntax')
    assert.match(finding.message, /at line 2/)
    assert.equal(finding.location.file, 'src/Button.tsx')
  })

  test('one component using unsupported syntax does not suppress another that is fine', async () => {
    const root = await makeRoot({
      'prop-contract.json': contractDocument({
        components: [
          componentEntry(),
          componentEntry({ id: 'Panel', source: 'src/Panel.tsx', propsType: 'PanelProps', props: [
            { name: 'title', type: 'string', required: true },
          ], events: [] }),
        ],
      }),
      'src/Button.tsx': BUTTON_SOURCE,
      'src/Panel.tsx': 'export interface PanelProps extends Base { title: string; }',
    })
    roots.push(root)

    const { code, report } = await reportFor(root)
    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.componentsCompared, 1, 'the readable component was still compared')
    assert.equal(report.summary.membersMatched, 3)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'source-unsupported-syntax'))
  })

  test('the supported subset really is supported, so the guard is not refusing everything', async () => {
    // A guard that refuses every source passes every test above while making
    // the tool useless.
    const root = await caseRoot(
      contractDocument({
        components: [componentEntry({
          propsType: 'ButtonProps',
          props: [
            { name: 'label', type: 'string', required: true },
            { name: 'meta', type: '{ a: string; b: number }', required: false },
            { name: 'data-testid', type: 'string', required: false },
          ],
          events: [],
        })],
      }),
      `export type ButtonProps = {
  readonly label: string;
  meta?: { a: string; b: number };
  'data-testid'?: string,
};
`,
    )
    const { code, report } = await reportFor(root)
    assert.equal(code, 0, 'a quoted name, a readonly modifier, a nested literal and a trailing comma are all read')
    assert.equal(report.summary.membersMatched, 3)
    assert.equal(report.summary.typesMatched, 3)
  })
})
