/**
 * The package ships what it says it ships.
 *
 * TOOL_ID equal to the directory name is what the catalog audit keys on, and a
 * script the README names but package.json does not have is an overclaim.
 */

import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, test } from 'node:test'

import { TOOL_ID } from '../src/index.mjs'
import { PROJECT_ROOT, runCli } from './support.mjs'

async function manifest() {
  return JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'))
}

describe('identity', () => {
  test('TOOL_ID equals the directory name', () => {
    assert.equal(TOOL_ID, basename(PROJECT_ROOT))
    assert.equal(TOOL_ID, 'component-prop-contract')
  })

  test('the package name, the binary and the report all use it', async () => {
    const pkg = await manifest()
    assert.equal(pkg.name, TOOL_ID)
    assert.deepEqual(Object.keys(pkg.bin), [TOOL_ID])
    assert.equal(pkg.bin[TOOL_ID], `./bin/${TOOL_ID}.mjs`)
  })
})

describe('scripts', () => {
  test('lint, test and check are all present', async () => {
    const pkg = await manifest()
    for (const script of ['lint', 'test', 'check', 'example', 'example:failing', 'example:unsupported', 'pack:check']) {
      assert.ok(pkg.scripts[script], `package.json has no ${script} script`)
    }
  })

  test('check runs lint, the tests, every example and the pack dry run', async () => {
    const pkg = await manifest()
    for (const part of ['lint', 'test', 'example', 'example:failing', 'example:unsupported', 'pack:check']) {
      assert.ok(pkg.scripts.check.includes(part), `check does not run ${part}`)
    }
  })

  test('lint covers every .mjs file in the tree', async () => {
    const pkg = await manifest()
    for (const directory of ['bin', 'src', 'test']) {
      assert.ok(pkg.scripts.lint.includes(directory), `lint does not cover ${directory}`)
    }
  })
})

describe('layout', () => {
  test('every file the package claims to ship exists', async () => {
    const pkg = await manifest()
    for (const entry of pkg.files) await access(join(PROJECT_ROOT, entry))
  })

  test('src holds the library and bin holds the CLI', async () => {
    assert.ok((await readdir(join(PROJECT_ROOT, 'src'))).includes('index.mjs'))
    assert.ok((await readdir(join(PROJECT_ROOT, 'bin'))).includes(`${TOOL_ID}.mjs`))
  })

  test('the examples directory holds a passing, a failing and an incomplete case', async () => {
    const examples = await readdir(join(PROJECT_ROOT, 'examples'))
    assert.ok(examples.includes('honoured'))
    assert.ok(examples.includes('broken'))
    assert.ok(examples.includes('unsupported'))
  })

  test('the CLI is executable as a module entry point', async () => {
    const { code } = await runCli(['--version'])
    assert.equal(code, 0)
  })
})

describe('documentation matches behaviour', () => {
  test('the README has the sections this catalog requires', async () => {
    const readme = await readFile(join(PROJECT_ROOT, 'README.md'), 'utf8')
    assert.match(readme, /## Exit codes/)
    assert.match(readme, /## Non-goals/)
    assert.match(readme, /## Limits/)
    assert.match(readme, /npm run check/)
    assert.match(readme, /## Quick start/)
  })

  test('the README does not claim a confinement or a capability the tool does not have', async () => {
    const readme = await readFile(join(PROJECT_ROOT, 'README.md'), 'utf8')
    // This tool writes nothing, so it must not claim an output-destination
    // guard. Documenting a check the code does not perform reads as coverage
    // and is worse than the silence it replaces.
    assert.match(readme, /It writes nothing/)
    assert.match(readme, /It runs no compiler/)
    assert.match(readme, /It reads no clock/)
    // It also must not imply it type-checks.
    assert.match(readme, /this is not type\s+checking and never claims to be/)
  })

  test('the recognised subset is documented, with every refused construct named', async () => {
    const rules = await readFile(join(PROJECT_ROOT, 'docs', 'prop-rules.md'), 'utf8')
    for (const construct of [
      'generic declaration', 'extends', 'index or call or construct signature',
      'method signature', 'no type annotation', 'top-level line break', 'declaration appearing twice',
    ]) {
      assert.ok(rules.includes(construct), `${construct} is not documented as refused`)
    }
  })

  test('nothing in the tree claims an author it does not have', async () => {
    const pkg = await manifest()
    assert.equal(pkg.author, 'Edilec Private Limited')
  })
})
