/**
 * Two runs over identical inputs produce byte-identical stdout.
 *
 * Nothing in the report may depend on wall-clock time, locale, hash-map
 * iteration order or filesystem enumeration order. This tool reads no clock at
 * all, so the report carries no timestamp -- which is asserted here, because a
 * timestamp is the usual way a report stops being reproducible.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { byCodeUnit } from '../src/index.mjs'
import { componentEntry, contractDocument, makeRoot, removeRoot, runCli } from './support.mjs'

const roots = []
after(async () => { await Promise.all(roots.map(removeRoot)) })

const FILES = {
  'prop-contract.json': contractDocument({
    version: '3.1.4',
    components: [
      componentEntry({
        id: 'Zebra',
        source: 'Z.tsx',
        propsType: 'ZebraProps',
        props: [
          { name: 'label', type: 'string', required: true },
          { name: 'gone', type: 'number', required: true },
        ],
        events: [],
      }),
      componentEntry({
        id: 'apple',
        source: 'a.tsx',
        propsType: 'AppleProps',
        props: [{ name: 'tone', type: "'a' | 'b'", required: false }],
        events: [{ name: 'onPick', type: '() => void', required: true }],
      }),
    ],
  }),
  'Z.tsx': `export interface ZebraProps {
  label: string;
  Z?: string;
  'aria-label'?: string;
  ariaLabel?: string;
  /** @internal */
  hidden?: string;
}
`,
  'a.tsx': `export interface AppleProps {
  tone?: 'b' | 'a';
  onBlur?: () => void;
  onblur?: () => void;
}
`,
}

async function runTwice() {
  const root = await makeRoot(FILES)
  roots.push(root)
  const first = await runCli(['--root', root, '--json'])
  const second = await runCli(['--root', root, '--json'])
  return { first, second }
}

function compareEmitted(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file)
    || byCodeUnit(a.location.pointer, b.location.pointer)
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

describe('byte-identical output', () => {
  test('the same files twice', async () => {
    const { first, second } = await runTwice()
    assert.equal(first.stdout, second.stdout)
    assert.equal(first.code, second.code)
    assert.ok(first.stdout.length > 800, 'a real report, not an empty one')
  })

  test('two roots holding the same files agree', async () => {
    const one = await makeRoot(FILES)
    const two = await makeRoot(FILES)
    roots.push(one, two)
    const first = await runCli(['--root', one, '--json'])
    const second = await runCli(['--root', two, '--json'])
    assert.equal(first.stdout, second.stdout, 'nothing in the report depends on where the files live')
  })

  test('the report carries no timestamp and no host path', async () => {
    const { first } = await runTwice()
    const report = JSON.parse(first.stdout)
    const text = JSON.stringify(report)
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), false, 'no ISO instant anywhere in the report')
    assert.equal(Object.hasOwn(report.summary, 'evaluatedAt'), false)
    for (const finding of report.findings) {
      assert.equal(finding.location.file.startsWith('/'), false, finding.location.file)
      assert.ok(['prop-contract.json', 'Z.tsx', 'a.tsx'].includes(finding.location.file))
    }
  })

  test('the finding order is the documented sort key, not insertion order', async () => {
    const { first } = await runTwice()
    const emitted = JSON.parse(first.stdout).findings
    assert.deepEqual(emitted, [...emitted].sort(compareEmitted))
    assert.ok(emitted.length >= 6)
    // Not tautological: the findings span both sources and several pointers,
    // so reversing any key in the real comparator changes the order.
    assert.ok(new Set(emitted.map((finding) => finding.location.file)).size > 1)
    assert.ok(new Set(emitted.map((finding) => finding.location.pointer)).size > 3)
    assert.ok(new Set(emitted.map((finding) => finding.ruleId)).size > 2)
  })

  test('the summary is a stable set of keys', async () => {
    const { first } = await runTwice()
    assert.deepEqual(Object.keys(JSON.parse(first.stdout).summary), [
      'checked', 'errors', 'warnings', 'contractVersion', 'components', 'componentsCompared',
      'publicMembers', 'privateMembersExcluded', 'membersMatched', 'membersMissing',
      'membersAdded', 'typesMatched', 'typesChanged', 'madeRequired', 'madeOptional',
      'typesUnconstrained',
    ])
  })

  test('the envelope is the one the contract specifies', async () => {
    const { first } = await runTwice()
    const report = JSON.parse(first.stdout)
    assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
    assert.equal(report.schemaVersion, '1')
    assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
    for (const finding of report.findings) {
      assert.deepEqual(
        Object.keys(finding).filter((key) => !['evidence', 'suggestion'].includes(key)),
        ['ruleId', 'severity', 'message', 'location'],
      )
      assert.deepEqual(Object.keys(finding.location), ['file', 'pointer'])
    }
  })
})
