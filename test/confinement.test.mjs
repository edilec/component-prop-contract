/**
 * Path confinement is resolved, not lexical -- for the contract AND for every
 * source path the contract names.
 *
 * Source paths are untrusted input: they come out of a document this tool did
 * not write and they name files it will open. Rejecting `../` is not
 * confinement, because a symbolic link planted inside the root leaves it
 * without a `..` anywhere in sight.
 *
 * This tool writes nothing, so no destination guard applies: there is no
 * --out, no mkdir and no file it can destroy. What is guarded here is what it
 * READS.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { isInside, isUsableSourcePath } from '../src/index.mjs'
import {
  BUTTON_SOURCE, componentEntry, contractDocument, makeCase, makeRoot, removeRoot, runCli,
} from './support.mjs'

const roots = []
async function track(root) {
  roots.push(root)
  return root
}
after(async () => { await Promise.all(roots.map(removeRoot)) })

describe('a symbolic link is not a way out of the root', () => {
  test('a source that is a link to a file outside the root is refused, and its content is not read', async () => {
    const outside = await track(await mkdtemp(join(tmpdir(), 'component-prop-contract-outside-')))
    await writeFile(join(outside, 'real.tsx'), 'export interface ButtonProps { NOTHING_FROM_HERE: string; }')

    const root = await track(await mkdtemp(join(tmpdir(), 'component-prop-contract-root-')))
    await writeFile(join(root, 'prop-contract.json'), JSON.stringify(contractDocument()))
    await mkdir(join(root, 'src'))
    await symlink(join(outside, 'real.tsx'), join(root, 'src', 'Button.tsx'))

    const { code, stdout } = await runCli(['--root', root, '--json'])
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'source-path-escapes-root'))
    assert.equal(stdout.includes('NOTHING_FROM_HERE'), false, 'out-of-root content never reaches the report')
    assert.equal(report.summary.componentsCompared, 0)
  })

  test('the contract itself being a link out of the root is refused too', async () => {
    const outside = await track(await mkdtemp(join(tmpdir(), 'component-prop-contract-outside2-')))
    await writeFile(join(outside, 'real.json'), JSON.stringify(contractDocument()))

    const root = await track(await mkdtemp(join(tmpdir(), 'component-prop-contract-root2-')))
    await symlink(join(outside, 'real.json'), join(root, 'prop-contract.json'))

    const { code, stdout } = await runCli(['--root', root, '--json'])
    assert.equal(code, 2)
    assert.ok(JSON.parse(stdout).findings.some((finding) => finding.ruleId === 'path-escapes-root'))
  })

  test('a link that stays inside the root is followed normally', async () => {
    const root = await track(await mkdtemp(join(tmpdir(), 'component-prop-contract-inner-')))
    await writeFile(join(root, 'prop-contract.json'), JSON.stringify(contractDocument()))
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'Real.tsx'), BUTTON_SOURCE)
    await symlink(join(root, 'src', 'Real.tsx'), join(root, 'src', 'Button.tsx'))

    const { code } = await runCli(['--root', root, '--json'])
    assert.equal(code, 0, 'a link that stays inside the root is not an escape')
  })

  test('a root reached through a link is not itself refused', async () => {
    // On macOS the temp directory is already behind a link
    // (/var -> /private/var), so a guard that refuses every symbolic ancestor
    // refuses every run here. A false refusal is a defect too.
    const real = await track(await makeCase())
    const parent = await track(await mkdtemp(join(tmpdir(), 'component-prop-contract-link-')))
    const linked = join(parent, 'root')
    await symlink(real, linked)

    const { code } = await runCli(['--root', linked, '--json'])
    assert.equal(code, 0)
  })
})

describe('a source path out of the contract is checked before anything is opened', () => {
  const BAD_PATHS = ['/etc/hosts', '../outside.tsx', 'src/../../outside.tsx', `src/a${String.fromCharCode(0x0a)}b.tsx`, '', 'C:\\Windows\\x.tsx']

  for (const path of BAD_PATHS) {
    test(`${JSON.stringify(path)} is refused`, async () => {
      const root = await track(await makeCase(contractDocument({
        components: [componentEntry({ source: path })],
      })))
      const { code, stdout } = await runCli(['--root', root, '--json'])
      const report = JSON.parse(stdout)
      assert.equal(code, 2)
      assert.equal(report.status, 'incomplete')
      assert.ok(report.findings.some((finding) => finding.ruleId === 'source-path-invalid'))
      assert.equal(report.summary.componentsCompared, 0)
    })
  }

  test('an ordinary nested relative path is allowed', async () => {
    // The other half: a guard that refuses every path passes every test above
    // while making the tool useless.
    const root = await track(await makeRoot({
      'prop-contract.json': contractDocument({
        components: [componentEntry({ source: 'packages/ui/src/Button.tsx' })],
      }),
      'packages/ui/src/Button.tsx': BUTTON_SOURCE,
    }))
    const { code } = await runCli(['--root', root, '--json'])
    assert.equal(code, 0, 'confinement must not refuse a legitimate path inside the root')
  })
})

describe('a --contract name that leaves the root is a configuration error', () => {
  test('an absolute --contract is refused before anything is opened', async () => {
    const root = await track(await makeCase())
    const { code, stdout, stderr } = await runCli(['--root', root, '--contract', '/etc/hosts'])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(stderr, /must be relative to --root/)
  })

  test('a --contract stepping out with ".." is refused', async () => {
    const root = await track(await makeCase())
    const { code, stdout, stderr } = await runCli(['--root', root, '--contract', '../elsewhere.json'])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(stderr, /must not step outside --root/)
  })

  test('a root that is not a readable directory is a configuration error', async () => {
    const { code, stdout, stderr } = await runCli(['--root', join(tmpdir(), 'component-prop-contract-absent-root')])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(stderr, /root is not a readable directory/)
  })
})

describe('the confinement predicates', () => {
  test('isInside accepts the root itself and its descendants, and nothing else', () => {
    assert.equal(isInside('/a/b', '/a/b'), true)
    assert.equal(isInside('/a/b', '/a/b/c'), true)
    assert.equal(isInside('/a/b', '/a/bc'), false, 'a shared prefix is not containment')
    assert.equal(isInside('/a/b', '/a'), false)
  })

  test('isUsableSourcePath accepts a relative path and refuses the ways out', () => {
    assert.equal(isUsableSourcePath('src/Button.tsx'), true)
    assert.equal(isUsableSourcePath('Button.tsx'), true)
    assert.equal(isUsableSourcePath('a/b/c/d.tsx'), true)
    assert.equal(isUsableSourcePath('/src/Button.tsx'), false)
    assert.equal(isUsableSourcePath('../Button.tsx'), false)
    assert.equal(isUsableSourcePath('src/../../Button.tsx'), false)
    assert.equal(isUsableSourcePath('C:\\Button.tsx'), false)
    assert.equal(isUsableSourcePath(`a${String.fromCharCode(0x0a)}b.tsx`), false)
    assert.equal(isUsableSourcePath(''), false)
    assert.equal(isUsableSourcePath(42), false)
  })
})
