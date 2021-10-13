/**
 * The rule table and the documented catalog agree, in both directions.
 *
 * This is a consistency check, NOT the defence. Three declarations that agree
 * with each other -- a table, a document, and a test's expected map -- are
 * satisfied by one coordinated edit, and a tool in this catalog had 40 of 52
 * error rules survive exactly that. The behavioural defence is
 * test/severity-outcomes.test.mjs.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { RULE_SEVERITY, createFinding } from '../src/index.mjs'
import { PROJECT_ROOT } from './support.mjs'

const ROW = /^\| `([a-z0-9-]+)` \| (error|warning|info) \|/gm

async function documentedRules() {
  const text = await readFile(join(PROJECT_ROOT, 'docs', 'prop-rules.md'), 'utf8')
  const rules = new Map()
  for (const match of text.matchAll(ROW)) rules.set(match[1], match[2])
  return rules
}

describe('the documented catalog', () => {
  test('every rule in the table is documented, with the same severity', async () => {
    const documented = await documentedRules()
    for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
      assert.equal(documented.get(ruleId), severity, `docs/prop-rules.md disagrees about ${ruleId}`)
    }
  })

  test('every documented rule is in the table', async () => {
    const documented = await documentedRules()
    for (const [ruleId, severity] of documented) {
      assert.equal(RULE_SEVERITY[ruleId], severity, `RULE_SEVERITY has no ${ruleId}`)
    }
  })

  test('the two sets are the same size, so neither direction is vacuous', async () => {
    const documented = await documentedRules()
    assert.equal(documented.size, Object.keys(RULE_SEVERITY).length)
    assert.ok(documented.size > 40, 'the catalog really was parsed')
  })

  test('the README names the same rule file', async () => {
    const readme = await readFile(join(PROJECT_ROOT, 'README.md'), 'utf8')
    assert.match(readme, /docs\/prop-rules\.md/)
  })
})

describe('severity comes from the table and nowhere else', () => {
  test('an unknown rule id throws rather than defaulting to something', () => {
    assert.throws(
      () => createFinding({ ruleId: 'not-a-rule', message: 'x', file: 'f.json' }),
      /not in RULE_SEVERITY/,
    )
  })

  test('a finding takes the value in the table, not one passed in beside it', () => {
    const finding = createFinding({ ruleId: 'prop-missing', message: 'x', file: 'f.json', severity: 'info' })
    assert.equal(finding.severity, 'error', 'a severity handed to the constructor is ignored')
  })

  test('every severity is one of the three the contract allows', () => {
    for (const severity of Object.values(RULE_SEVERITY)) {
      assert.ok(['error', 'warning', 'info'].includes(severity), severity)
    }
  })

  test('rule ids are stable kebab-case', () => {
    for (const ruleId of Object.keys(RULE_SEVERITY)) {
      assert.match(ruleId, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, ruleId)
    }
  })
})
