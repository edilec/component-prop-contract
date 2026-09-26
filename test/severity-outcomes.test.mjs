/**
 * Severity, pinned behaviourally.
 *
 * A severity table asserted against a document is not a pinned severity: the
 * table, the document and a test's expected map are three declarations, and
 * one coordinated edit satisfies all three. One tool in this catalog had 40 of
 * 52 error rules survive exactly that flip with its suite still green.
 *
 * So every rule below is driven through the REAL CLI with real files, and what
 * is asserted is the process exit code. Flip any `error` in RULE_SEVERITY to
 * `warning` and the run that should exit 1 exits 0 instead.
 */

import assert from 'node:assert/strict'
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { RULE_SEVERITY, checkPropContract, exitCodeFor } from '../src/index.mjs'
import {
  BUTTON_SOURCE, componentEntry, contractDocument, makeCase, makeRoot, removeRoot, runCli,
} from './support.mjs'

const roots = []
async function track(root) {
  roots.push(root)
  return root
}
after(async () => { await Promise.all(roots.map(removeRoot)) })

const ONE_PROP = [{ name: 'label', type: 'string', required: true }]

function withComponent(overrides) {
  return contractDocument({ components: [componentEntry(overrides)] })
}

/**
 * One scenario per rule id. `exit` is what the process must return:
 *   1 -- an error-severity rule about files that were read completely
 *   2 -- an error-severity rule that also marks the run incomplete
 *   0 -- a warning or info rule, which must NOT change the verdict
 */
const SCENARIOS = {
  'component-id-duplicate': { exit: 1, contract: contractDocument({ components: [componentEntry(), componentEntry()] }) },
  'component-invalid': { exit: 1, contract: contractDocument({ components: ['Button'] }) },
  'component-unknown-field': { exit: 1, contract: withComponent({ colour: 'red' }) },
  'contract-invalid': { exit: 1, contract: contractDocument({ components: { Button: [] } }) },
  'contract-unknown-field': { exit: 1, contract: contractDocument({ owner: 'design-systems' }) },
  'contract-version-invalid': { exit: 1, contract: contractDocument({ version: '2.3' }) },
  'contract-version-missing': { exit: 1, contract: { schemaVersion: '1', components: [componentEntry()] } },
  'event-added': {
    exit: 0,
    contract: withComponent({ props: ONE_PROP, events: [] }),
    source: 'export interface ButtonProps { label: string; onClick?: () => void; }',
  },
  'event-missing': {
    exit: 1,
    source: 'export interface ButtonProps { label: string; variant?: \'primary\' | \'secondary\'; }',
  },
  'event-type-changed': {
    exit: 1,
    source: 'export interface ButtonProps { label: string; variant?: \'primary\' | \'secondary\'; onClick?: (event: KeyboardEvent) => void; }',
  },
  'input-not-json': { exit: 2, raw: { 'prop-contract.json': '{ "components": [' } },
  'input-not-utf8': { exit: 2, bytes: { 'prop-contract.json': Buffer.from([0x7b, 0x80, 0x7d]) } },
  'input-too-large': { exit: 2, args: ['--max-contract-bytes', '40'] },
  'input-unreadable': { exit: 2, omit: ['prop-contract.json'] },
  'member-duplicate': {
    exit: 1,
    contract: withComponent({ props: ONE_PROP, events: [], argTypes: { label: { type: { name: 'string' } } } }),
  },
  'member-invalid': { exit: 1, contract: withComponent({ props: [{ name: 'label', type: 'string' }], events: [] }) },
  'member-misclassified': {
    exit: 1,
    contract: withComponent({ props: [{ name: 'onClick', type: '() => void', required: false }], events: [] }),
  },
  'no-components-declared': { exit: 1, contract: contractDocument({ components: [] }) },
  'no-members-declared': {
    exit: 1,
    contract: contractDocument({ components: [{ id: 'Button', source: 'src/Button.tsx', propsType: 'ButtonProps' }] }),
  },
  'path-escapes-root': { exit: 2, linkContract: true },
  'private-member-excluded': {
    exit: 0,
    source: 'export interface ButtonProps { label: string; variant?: \'primary\' | \'secondary\'; onClick?: (event: MouseEvent) => void; _cache?: number; }',
  },
  'prop-added': {
    exit: 0,
    source: 'export interface ButtonProps { label: string; variant?: \'primary\' | \'secondary\'; onClick?: (event: MouseEvent) => void; loading?: boolean; }',
  },
  'prop-missing': { exit: 1, contract: withComponent({ props: [{ name: 'gone', type: 'string', required: true }], events: [] }) },
  'prop-now-optional': {
    exit: 0,
    contract: withComponent({ props: [{ name: 'variant', type: "'primary' | 'secondary'", required: true }], events: [] }),
  },
  'prop-now-required': {
    exit: 1,
    contract: withComponent({ props: [{ name: 'label', type: 'string', required: false }], events: [] }),
  },
  'prop-type-changed': {
    exit: 1,
    contract: withComponent({ props: [{ name: 'label', type: 'number', required: true }], events: [] }),
  },
  'prop-type-unconstrained': { exit: 0, contract: withComponent({ props: [{ name: 'label', required: true }], events: [] }) },
  'props-type-ambiguous': {
    exit: 2,
    source: 'export interface ButtonProps { label: string; }\nexport interface ButtonProps { other: string; }',
  },
  'props-type-empty': {
    exit: 1,
    contract: withComponent({ props: ONE_PROP, events: [] }),
    source: 'export interface ButtonProps { _hidden?: string; }',
  },
  'props-type-missing': { exit: 1, source: 'export interface OtherProps { label: string; }' },
  'props-type-not-exported': { exit: 1, source: 'interface ButtonProps { label: string; }' },
  'schema-version-unsupported': { exit: 2, contract: contractDocument({ schemaVersion: '2' }) },
  'source-not-utf8': { exit: 2, bytes: { 'src/Button.tsx': Buffer.from([0x65, 0x80, 0x66]) } },
  'source-path-escapes-root': { exit: 2, linkSource: true },
  'source-path-invalid': { exit: 2, contract: withComponent({ source: '../outside.tsx' }) },
  'source-too-large': { exit: 2, args: ['--max-source-bytes', '10'] },
  'source-unreadable': { exit: 2, omit: ['src/Button.tsx'] },
  'source-unsupported-syntax': { exit: 2, source: 'export interface ButtonProps extends Base { label: string; }' },
  'time-budget-exceeded': { exit: 2, library: true },
  'too-many-components': {
    exit: 2,
    contract: contractDocument({ components: [componentEntry(), componentEntry({ id: 'Chip' })] }),
    args: ['--max-components', '1'],
  },
  'too-many-findings': {
    exit: 2,
    source: 'export interface ButtonProps { a?: string; b?: string; c?: string; d?: string; }',
    args: ['--max-findings', '2'],
  },
  'too-many-members': { exit: 2, args: ['--max-members', '2'] },
  'type-too-complex': { exit: 2, args: ['--max-type-chars', '3'] },
}

describe('every rule is pinned by the exit code it produces', () => {
  for (const [ruleId, scenario] of Object.entries(SCENARIOS)) {
    test(`${ruleId} (${RULE_SEVERITY[ruleId]}) exits ${scenario.exit}`, async () => {
      if (scenario.library) {
        // The time budget needs an injected monotonic clock, which no flag can
        // supply; the exit code is computed from the same report the CLI would
        // have written.
        const root = await track(await makeCase())
        let ticks = 0
        const report = await checkPropContract({
          root,
          limits: { maxRuntimeMs: 1 },
          monotonic: () => { ticks += 1; return ticks === 1 ? 0 : 9999 },
        })
        assert.ok(report.findings.some((finding) => finding.ruleId === ruleId), `${ruleId} did not fire`)
        assert.equal(exitCodeFor(report), scenario.exit)
        return
      }

      const files = {}
      if (!(scenario.omit ?? []).includes('prop-contract.json')) {
        files['prop-contract.json'] = scenario.contract ?? contractDocument()
      }
      if (!(scenario.omit ?? []).includes('src/Button.tsx')) {
        files['src/Button.tsx'] = scenario.source ?? BUTTON_SOURCE
      }
      Object.assign(files, scenario.raw ?? {})

      const root = await track(await makeRoot(files))
      for (const [name, bytes] of Object.entries(scenario.bytes ?? {})) {
        await mkdir(join(root, 'src'), { recursive: true })
        await writeFile(join(root, name), bytes)
      }
      if (scenario.linkSource || scenario.linkContract) {
        const outside = await track(await makeRoot({
          'real.tsx': BUTTON_SOURCE,
          'real.json': JSON.stringify(contractDocument()),
        }))
        if (scenario.linkSource) {
          await unlink(join(root, 'src', 'Button.tsx'))
          await symlink(join(outside, 'real.tsx'), join(root, 'src', 'Button.tsx'))
        } else {
          await unlink(join(root, 'prop-contract.json'))
          await symlink(join(outside, 'real.json'), join(root, 'prop-contract.json'))
        }
      }

      const { code, stdout } = await runCli(['--root', root, '--json', ...(scenario.args ?? [])])
      const report = JSON.parse(stdout)
      assert.ok(
        report.findings.some((finding) => finding.ruleId === ruleId),
        `${ruleId} did not fire; got ${[...new Set(report.findings.map((f) => f.ruleId))].join(', ')}`,
      )
      assert.equal(code, scenario.exit, `${ruleId} produced exit ${code}`)
    })
  }

  test('every rule in the table has a scenario here', () => {
    assert.deepEqual(
      Object.keys(SCENARIOS).sort(),
      Object.keys(RULE_SEVERITY).sort(),
      'a rule with no behavioural scenario is a severity nothing defends',
    )
  })

  test('the exit codes really follow the severities', () => {
    for (const [ruleId, scenario] of Object.entries(SCENARIOS)) {
      const severity = RULE_SEVERITY[ruleId]
      if (severity === 'error') assert.ok(scenario.exit > 0, `${ruleId} is an error and must not exit 0`)
      else assert.equal(scenario.exit, 0, `${ruleId} is ${severity} and must not change the verdict`)
    }
  })

  test('a warning-only run really is a pass, not a fail with the errors hidden', async () => {
    const root = await track(await makeCase(contractDocument(), `export interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
  onClick?: (event: MouseEvent) => void;
  loading?: boolean;
}
`))
    const { code, stdout } = await runCli(['--root', root, '--json'])
    const report = JSON.parse(stdout)
    assert.equal(code, 0)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.errors, 0)
    assert.equal(report.summary.warnings, 1)
  })
})
