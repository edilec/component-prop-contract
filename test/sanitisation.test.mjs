/**
 * Every untrusted string that reaches output is stripped of the characters
 * that forge or hide lines -- not only an excerpt field.
 *
 * Both documents are untrusted here, and the TypeScript source is the one that
 * matters most: a prop NAME and its TYPE TEXT are read straight out of a file
 * this tool did not write, and both reach the report.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { CONTROL_CLASSES, excerpt, hasForbiddenCharacter, isUsableText } from '../src/index.mjs'
import { componentEntry, contractDocument, makeRoot, removeRoot, runCli } from './support.mjs'

const roots = []
after(async () => { await Promise.all(roots.map(removeRoot)) })

const FORBIDDEN = Object.entries(CONTROL_CLASSES).flatMap(
  ([className, points]) => points.map((point) => ({ className, point, char: String.fromCharCode(point) })),
)

/**
 * A line feed is allowed through the stream check and only there: the JSON is
 * pretty-printed and the human summary is a list of lines, so both carry
 * structural newlines the tool itself wrote. What may never appear is a
 * newline inside a VALUE, which `forbiddenInReport` checks by walking the
 * parsed report rather than its serialisation.
 */
function forbiddenInStream(text) {
  return FORBIDDEN.filter((entry) => entry.point !== 0x0a).filter((entry) => text.includes(entry.char))
    .map((entry) => entry.className)
}

function forbiddenInReport(value) {
  if (typeof value === 'string') return FORBIDDEN.filter((entry) => value.includes(entry.char)).map((entry) => entry.className)
  if (Array.isArray(value)) return value.flatMap(forbiddenInReport)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [...forbiddenInReport(key), ...forbiddenInReport(item)])
  }
  return []
}

describe('the character classes, one at a time', () => {
  for (const entry of FORBIDDEN) {
    const label = `${entry.className} U+${entry.point.toString(16).padStart(4, '0').toUpperCase()}`

    test(`${label} is removed from a contract identifier`, async () => {
      const root = await makeRoot({
        'prop-contract.json': contractDocument({
          components: [componentEntry({
            id: `But${entry.char}ton`,
            props: [{ name: 'gone', type: 'string', required: true }],
            events: [],
          })],
        }),
        'src/Button.tsx': 'export interface ButtonProps { here: string; }',
      })
      roots.push(root)

      const { stdout, stderr } = await runCli(['--root', root])
      const report = JSON.parse(stdout)
      assert.deepEqual(forbiddenInReport(report), [], 'no string in the report carries a forbidden character')
      assert.deepEqual(forbiddenInStream(stdout), [], 'and none survives serialisation')
      assert.deepEqual(forbiddenInStream(stderr), [], 'nor does the human summary carry one')
      assert.ok(report.findings.length > 0)
    })

    test(`${label} is removed from type text read out of a source`, async () => {
      // A type is text from a file this tool did not write, and it reaches the
      // report through evidence and through a message.
      const root = await makeRoot({
        'prop-contract.json': contractDocument({
          components: [componentEntry({
            props: [{ name: 'label', type: 'string', required: true }],
            events: [],
          })],
        }),
        'src/Button.tsx': `export interface ButtonProps { label: 'a${entry.char}b'; }`,
      })
      roots.push(root)

      const { stdout, stderr } = await runCli(['--root', root])
      if (stdout === '') throw new Error('stdout must carry a report')
      assert.deepEqual(forbiddenInReport(JSON.parse(stdout)), [])
      assert.deepEqual(forbiddenInStream(stdout), [])
      assert.deepEqual(forbiddenInStream(stderr), [])
    })
  }
})

describe('a name that renders as nothing is refused, not accepted and then rendered blank', () => {
  test('a component id made only of bidi controls is refused', async () => {
    // `value.trim().length > 0` passes for this string: trim removes
    // ECMAScript whitespace only. Validate what will be RENDERED.
    const invisible = `${String.fromCharCode(0x200e)}${String.fromCharCode(0x202e)}`
    assert.equal(invisible.trim().length > 0, true, 'trim is satisfied by it, which is the trap')
    assert.equal(isUsableText(invisible), false, 'and the real check is not')

    const root = await makeRoot({
      'prop-contract.json': contractDocument({ components: [componentEntry({ id: invisible })] }),
      'src/Button.tsx': 'export interface ButtonProps { label: string; }',
    })
    roots.push(root)

    const { code, stdout } = await runCli(['--root', root, '--json'])
    const report = JSON.parse(stdout)
    assert.equal(code, 1)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'component-invalid'))
    assert.equal(report.summary.components, 0)
  })

  test('a declared member name made only of C0 controls is refused', async () => {
    const invisible = `${String.fromCharCode(0x01)}${String.fromCharCode(0x02)}`
    const root = await makeRoot({
      'prop-contract.json': contractDocument({
        components: [componentEntry({ props: [{ name: invisible, required: true }], events: [] })],
      }),
      'src/Button.tsx': 'export interface ButtonProps { label: string; }',
    })
    roots.push(root)

    const { code, stdout } = await runCli(['--root', root, '--json'])
    assert.equal(code, 1)
    assert.ok(JSON.parse(stdout).findings.some((finding) => finding.ruleId === 'member-invalid'))
  })
})

describe('an unknown field name is untrusted too', () => {
  test('a field name carrying a newline cannot forge a line in the report', async () => {
    const forged = 'ok\nERROR  forged-rule  nothing.json'
    const root = await makeRoot({
      'prop-contract.json': contractDocument({ components: [componentEntry({ [forged]: 1 })] }),
      'src/Button.tsx': 'export interface ButtonProps { label: string; }',
    })
    roots.push(root)

    const { stdout, stderr } = await runCli(['--root', root])
    assert.equal(/^ERROR/m.test(stderr), false, 'the forged line never starts a line of its own')
    assert.ok(JSON.parse(stdout).findings.some((finding) => finding.ruleId === 'component-unknown-field'))
  })

  test('an argTypes key carrying a control character is refused and sanitised', async () => {
    const root = await makeRoot({
      'prop-contract.json': contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { [`a${String.fromCharCode(0x0a)}b`]: { type: { name: 'string' } } },
        })],
      }),
      'src/Button.tsx': 'export interface ButtonProps { label: string; }',
    })
    roots.push(root)

    const { stdout, stderr } = await runCli(['--root', root])
    assert.deepEqual(forbiddenInReport(JSON.parse(stdout)), [])
    assert.deepEqual(forbiddenInStream(stderr), [])
  })
})

describe('the sanitising primitives', () => {
  test('excerpt flattens, bounds and trims', () => {
    assert.equal(excerpt('a\nb'), 'a b')
    assert.equal(excerpt('   padded   '), 'padded')
    assert.equal(excerpt('abcdef', 3), 'abc...')
    assert.throws(() => excerpt('x', 0), TypeError)
  })

  test('hasForbiddenCharacter sees every class', () => {
    for (const entry of FORBIDDEN) {
      assert.equal(hasForbiddenCharacter(`a${entry.char}b`), true, `missed ${entry.className}`)
    }
    assert.equal(hasForbiddenCharacter('plain text'), false)
  })

  test('the class list covers C0, DEL, C1, the line separators and the bidi controls', () => {
    assert.deepEqual(Object.keys(CONTROL_CLASSES).sort(), ['bidi', 'c0', 'c1', 'del', 'lineSeparators'])
    assert.ok(CONTROL_CLASSES.c1.includes(0x85), 'NEL starts a line on a terminal exactly as a line feed does')
    assert.ok(CONTROL_CLASSES.c1.includes(0x9b), '8-bit CSI opens an escape sequence')
    assert.ok(CONTROL_CLASSES.bidi.includes(0x202e), 'RIGHT-TO-LEFT OVERRIDE reverses displayed text')
  })
})
