/**
 * The parse-failure helper: ordering is the whole guard.
 *
 * V8 reports a JSON parse failure two ways and one of them quotes the input
 * back. A helper that looks for `at position \d+` FIRST finds that phrase
 * inside the quoted span whenever the document itself contains it, and slices
 * the document straight back out. Nineteen of thirty-eight tools in this
 * catalog shipped exactly that bug; the eleven groups that wrote this test
 * found it.
 *
 * The helper is exported rather than module-local so the catalog audit can
 * probe it, and so these cases exercise the same function the reader uses.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { BUTTON_SOURCE, makeRoot, removeRoot, runCli } from './support.mjs'

const roots = []
after(async () => { await Promise.all(roots.map(removeRoot)) })

function detailFor(text) {
  try {
    JSON.parse(text)
  } catch (error) {
    return { message: error.message, detail: parseFailureDetail(error) }
  }
  throw new Error('that document parsed')
}

const CREDENTIAL = 'AKIAIOSFODNN7EXAMPLE'

describe('the document is never reproduced', () => {
  test('a document whose own text reads "at position 1"', () => {
    // The case that catches a position-first helper: V8 says
    // `Unexpected token 'a', "at position 1" is not valid JSON`, and matching
    // the offset first slices the document out of its own error message.
    const { message, detail } = detailFor('at position 1')
    assert.match(message, /"at position 1"/, 'V8 really does quote the document here')
    assert.equal(detail, "unexpected token 'a' at the start of the document")
    assert.equal(detail.includes('at position 1'), false)
  })

  test('a document that is only a credential', () => {
    const { message, detail } = detailFor(CREDENTIAL)
    assert.ok(message.includes(CREDENTIAL), 'the raw message carries the whole secret')
    assert.equal(detail.includes(CREDENTIAL), false)
    assert.equal(detail, "unexpected token 'A' at the start of the document")
  })

  test('a long document with a sensitive prefix', () => {
    const document = `password=hunter2${'x'.repeat(4000)}`
    const { message, detail } = detailFor(document)
    assert.match(message, /"password=h"\.\.\./, 'V8 quotes a ten-character prefix')
    assert.equal(detail.includes('password'), false)
    assert.equal(detail, "unexpected token 'p' at the start of the document")
  })

  test('a quoted span containing a newline', () => {
    // Without the `s` flag the pattern silently fails to recognise the shape it
    // exists to catch, and the document falls through to a branch that keeps it.
    const { message, detail } = detailFor(`aa\nbb`)
    assert.ok(message.includes('\n'), 'the quoted span really does span a line break')
    assert.equal(detail, "unexpected token 'a' at the start of the document")
    assert.equal(detail.includes('bb'), false)
  })

  test('a quoted window taken from the middle of the document', () => {
    // "truncate the front" is not a fix: the window is taken from wherever the
    // offence is.
    const { message, detail } = detailFor(`{"alpha": ZQXJVBMP7W${CREDENTIAL}}`)
    assert.match(message, /\.\.\."/, 'the window is preceded by an ellipsis')
    assert.equal(detail, "unexpected token 'Z' inside the document")
    assert.equal(detail.includes('ZQXJVBMP7W'), false)
  })
})

describe('the safe form keeps the useful half', () => {
  test('position, line and column all survive', () => {
    const { detail } = detailFor('{"alpha": 1 "beta": 2}')
    assert.equal(detail, "Expected ',' or '}' after property value in JSON at position 12 (line 1 column 13)")
    assert.match(detail, /position 12/)
    assert.match(detail, /line 1/)
    assert.match(detail, /column 13/)
  })

  test('an empty document keeps its own sentence', () => {
    assert.equal(detailFor('').detail, 'Unexpected end of JSON input')
  })
})

describe('the backstop catches wordings the branches have never seen', () => {
  test('any surviving double quote falls back to the generic sentence', () => {
    // A message this helper was never taught. Across 500,206 distinct V8 parse
    // messages, every one with no quoted snippet also had no double quote at
    // all -- V8 quotes JSON punctuation with apostrophes -- so a surviving
    // double quote means a snippet survived, whatever the branches concluded.
    const invented = `Something new about "${CREDENTIAL}" at position 4`
    const detail = parseFailureDetail(new Error(invented))
    assert.equal(detail.includes(CREDENTIAL), false)
    assert.equal(detail, 'the document could not be parsed as JSON')
  })

  test('a non-Error, a missing message and a null all produce a sentence rather than a throw', () => {
    assert.equal(parseFailureDetail(null), 'the document could not be parsed as JSON')
    assert.equal(parseFailureDetail({}), 'the document could not be parsed as JSON')
    assert.equal(parseFailureDetail({ message: 'Unexpected end of JSON input' }), 'Unexpected end of JSON input')
  })
})

describe('end to end, through the real CLI', () => {
  test('a credential in an unparseable contract never reaches either stream', async () => {
    const root = await makeRoot({
      'prop-contract.json': CREDENTIAL,
      'src/Button.tsx': BUTTON_SOURCE,
    })
    roots.push(root)

    const { code, stdout, stderr } = await runCli(['--root', root])
    assert.equal(code, 2)
    assert.equal(stdout.includes(CREDENTIAL), false)
    assert.equal(stderr.includes(CREDENTIAL), false)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    const finding = report.findings.find((entry) => entry.ruleId === 'input-not-json')
    assert.ok(finding)
    assert.match(finding.message, /not valid JSON/)
  })
})
