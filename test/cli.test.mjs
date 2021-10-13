/**
 * The CLI surface, and the two shapes of exit 2.
 *
 * A configuration error means the run never had a subject, so stdout stays
 * EMPTY. An input that could not be read means the run had a subject and
 * failed to obtain evidence about it, so stdout carries an `incomplete`
 * report. A consumer that pipes stdout must handle both, which is why the
 * distinction is asserted rather than assumed.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { TOOL_ID } from '../src/index.mjs'
import { componentEntry, contractDocument, makeCase, makeRoot, removeRoot, runCli } from './support.mjs'

const roots = []
async function track(root) {
  roots.push(root)
  return root
}
after(async () => { await Promise.all(roots.map(removeRoot)) })

describe('help and version', () => {
  test('--help prints the help on stdout and exits 0', async () => {
    const { code, stdout } = await runCli(['--help'])
    assert.equal(code, 0)
    assert.match(stdout, /component-prop-contract/)
    assert.match(stdout, /Exit codes:/)
  })

  test('-h is the same', async () => {
    const { code, stdout } = await runCli(['-h'])
    assert.equal(code, 0)
    assert.match(stdout, /Usage:/)
  })

  test('--version prints a version', async () => {
    const { code, stdout } = await runCli(['--version'])
    assert.equal(code, 0)
    assert.match(stdout, /^\d+\.\d+\.\d+\n$/)
  })

  test('the help states what this tool does not do, and what it cannot read', async () => {
    const { stdout } = await runCli(['--help'])
    assert.match(stdout, /runs no\s+compiler/)
    assert.match(stdout, /writes no file/)
    assert.match(stdout, /Private implementation details are excluded/)
    assert.match(stdout, /Unsupported syntax is reported, never guessed at/)
    assert.match(stdout, /There is no clock in this tool/)
  })
})

describe('a configuration error leaves stdout empty', () => {
  const CASES = [
    { name: 'an unknown option', args: ['--nope'], match: /Unknown option "--nope"/ },
    { name: 'a missing --root', args: [], match: /--root is required/ },
    { name: 'a flag with no value', args: ['--root'], match: /--root requires a value/ },
    { name: 'a repeated flag', args: ['--root', 'a', '--root', 'b'], match: /--root was given more than once/ },
    { name: 'a repeated limit', args: ['--root', 'a', '--max-members', '2', '--max-members', '3'], match: /more than once/ },
    { name: 'a limit that is not a positive integer', args: ['--root', 'a', '--max-members', '0'], match: /requires a positive integer/ },
  ]

  for (const scenario of CASES) {
    test(scenario.name, async () => {
      const { code, stdout, stderr } = await runCli(scenario.args)
      assert.equal(code, 2)
      assert.equal(stdout, '', 'stdout is reserved for a report about a subject this run never had')
      assert.match(stderr, scenario.match)
    })
  }

  test('an unknown option is flattened before it reaches stderr', async () => {
    const { stderr } = await runCli([`--evil${String.fromCharCode(0x0a)}forged`])
    assert.equal(/^forged/m.test(stderr), false)
  })
})

describe('an unreadable input leaves stdout carrying a report', () => {
  test('the other shape of exit 2', async () => {
    const root = await track(await makeRoot({ 'src/Button.tsx': 'export interface ButtonProps { a: string; }' }))
    const { code, stdout } = await runCli(['--root', root, '--json'])
    assert.equal(code, 2)
    assert.notEqual(stdout, '')
    assert.equal(JSON.parse(stdout).status, 'incomplete')
  })
})

describe('the streams stay separated', () => {
  test('stdout is the JSON report and nothing else', async () => {
    const root = await track(await makeCase())
    const { stdout } = await runCli(['--root', root])
    const report = JSON.parse(stdout)
    assert.equal(report.tool, TOOL_ID)
    assert.equal(report.schemaVersion, '1')
    assert.equal(stdout.trimEnd().endsWith('}'), true)
  })

  test('--json suppresses the human summary and nothing else', async () => {
    const root = await track(await makeCase())
    const quiet = await runCli(['--root', root, '--json'])
    const loud = await runCli(['--root', root])
    assert.equal(quiet.stdout, loud.stdout, 'the report does not depend on how it is displayed')
    assert.equal(quiet.stderr, '')
    assert.match(loud.stderr, /component-prop-contract: pass/)
    assert.match(loud.stderr, /contract version 1\.0\.0/)
  })

  test('an incomplete run says on stderr that it is not a pass', async () => {
    const root = await track(await makeCase(contractDocument(), 'export interface ButtonProps extends Base { label: string; }'))
    const { stderr } = await runCli(['--root', root])
    assert.match(stderr, /incomplete: this run is not a pass/)
  })

  test('a --contract naming a different file is honoured', async () => {
    const root = await track(await makeRoot({
      'api.json': contractDocument(),
      'src/Button.tsx': 'export interface ButtonProps { label: string; variant?: \'primary\' | \'secondary\'; onClick?: (event: MouseEvent) => void; }',
    }))
    const { code } = await runCli(['--root', root, '--contract', 'api.json', '--json'])
    assert.equal(code, 0)
  })
})

describe('exit codes', () => {
  test('0 for a pass, 1 for a fail, 2 for incomplete', async () => {
    const passing = await track(await makeCase())
    assert.equal((await runCli(['--root', passing, '--json'])).code, 0)

    const failing = await track(await makeCase(contractDocument({
      components: [componentEntry({ props: [{ name: 'gone', type: 'string', required: true }], events: [] })],
    })))
    assert.equal((await runCli(['--root', failing, '--json'])).code, 1)

    const unreadable = await track(await makeRoot({ 'prop-contract.json': contractDocument() }))
    assert.equal((await runCli(['--root', unreadable, '--json'])).code, 2)
  })
})
