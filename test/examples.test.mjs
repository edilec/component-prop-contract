/**
 * The examples in the repository really run, and really produce the outcome
 * the README claims for them.
 *
 * An example that does not run is documentation that is wrong, and this
 * catalog counts a documentation overclaim as a defect.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { PROJECT_ROOT, runCli } from './support.mjs'

function example(name) {
  return runCli(['--root', join(PROJECT_ROOT, 'examples', name), '--json'])
}

describe('examples/honoured', () => {
  test('passes, with the private members excluded rather than reported as additions', async () => {
    const { code, stdout } = await example('honoured')
    assert.equal(code, 0)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.contractVersion, '2.3.0')
    assert.equal(report.summary.componentsCompared, 2)
    assert.equal(report.summary.membersMissing, 0)
    assert.equal(report.summary.membersAdded, 0)
    assert.equal(report.summary.privateMembersExcluded, 2)
  })

  test('it exercises both contract spellings', async () => {
    const contract = JSON.parse(await readFile(join(PROJECT_ROOT, 'examples', 'honoured', 'prop-contract.json'), 'utf8'))
    assert.ok(contract.components.some((entry) => Object.hasOwn(entry, 'props')))
    assert.ok(contract.components.some((entry) => Object.hasOwn(entry, 'argTypes')))
  })
})

describe('examples/broken', () => {
  test('fails, and demonstrates every classification this tool makes', async () => {
    const { code, stdout } = await example('broken')
    assert.equal(code, 1)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'fail')
    const fired = new Set(report.findings.map((finding) => finding.ruleId))
    for (const ruleId of ['prop-missing', 'prop-type-changed', 'prop-now-required', 'prop-added', 'private-member-excluded']) {
      assert.ok(fired.has(ruleId), `the failing example should demonstrate ${ruleId}`)
    }
    assert.equal(report.summary.membersMissing, 1)
    assert.equal(report.summary.typesChanged, 1)
    assert.equal(report.summary.madeRequired, 1)
    assert.equal(report.summary.membersAdded, 1)
  })

  test('the finding the README quotes is the finding the tool emits', async () => {
    const { stdout } = await example('broken')
    const report = JSON.parse(stdout)
    const quoted = report.findings.find((finding) => finding.ruleId === 'prop-missing')
    assert.ok(quoted)

    const readme = await readFile(join(PROJECT_ROOT, 'README.md'), 'utf8')
    assert.ok(readme.includes(quoted.evidence), 'the README quotes an evidence string the tool no longer produces')
    assert.ok(readme.includes(quoted.location.pointer), 'the README quotes a pointer the tool no longer produces')
    assert.ok(readme.includes(quoted.suggestion), 'the README quotes a suggestion the tool no longer produces')
  })
})

describe('examples/unsupported', () => {
  test('is incomplete, and reports nothing as missing from a surface it never established', async () => {
    const { code, stdout } = await example('unsupported')
    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    const finding = report.findings.find((entry) => entry.ruleId === 'source-unsupported-syntax')
    assert.ok(finding)
    assert.match(finding.message, /"extends" clause/)

    // The contract declares `elevation`, which the source really does not
    // carry. It is NOT reported, because the surface was never established.
    assert.equal(
      report.findings.some((entry) => entry.ruleId === 'prop-missing'),
      false,
      'a half-read surface must not produce an absence',
    )
    assert.equal(report.summary.componentsCompared, 0)
  })
})

describe('the quick start in the README is runnable as written', () => {
  test('all three commands appear with the roots that produce the stated exits', async () => {
    const readme = await readFile(join(PROJECT_ROOT, 'README.md'), 'utf8')
    for (const name of ['honoured', 'broken', 'unsupported']) {
      assert.ok(readme.includes(`--root examples/${name}`), `examples/${name} is not in the quick start`)
    }
  })

  test('the package check runs all three', async () => {
    const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'))
    assert.ok(pkg.scripts.check.includes('example '), 'check does not run the passing example')
    assert.ok(pkg.scripts.check.includes('example:failing'))
    assert.ok(pkg.scripts.check.includes('example:unsupported'))
    assert.match(pkg.scripts['example:failing'], /test \$\? -eq 1/)
    assert.match(pkg.scripts['example:unsupported'], /test \$\? -eq 2/)
  })
})
