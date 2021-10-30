/**
 * The package ships what it says it ships.
 *
 * TOOL_ID equal to the directory name is what the catalog audit keys on, and a
 * script the README names but package.json does not have is an overclaim.
 */

import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { after, describe, test } from 'node:test'

import { TOOL_ID } from '../src/index.mjs'
import { PROJECT_ROOT, makeRoot, removeRoot, runCli } from './support.mjs'

const roots = []
after(async () => { await Promise.all(roots.map(removeRoot)) })

async function manifest() {
  return JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'))
}

/** Every text file in the working tree, skipping build output and version control. */
async function treeFiles(directory = PROJECT_ROOT, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.DS_')) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      await treeFiles(full, found)
      continue
    }
    if (entry.name.endsWith('.tgz')) continue
    found.push(full)
  }
  return found
}

/**
 * The shapes a file uses to attach a NAME to an authorship claim.
 *
 * Deliberately narrow: `AUTHORS OR COPYRIGHT HOLDERS` in the MIT warranty
 * clause attaches no name to anybody, and a test that flagged it would be
 * noise rather than a check. Each pattern captures the name being claimed, and
 * the assertion is that every name claimed anywhere in the tree is the one the
 * manifest declares.
 */
const AUTHORSHIP_CLAIMS = [
  /Copyright \(c\)\s*\d{4}\s*(.+)$/,
  /^\s*"author":\s*"(.+)",?$/,
  /^\s*(?:Signed-off-by|Attribution|Author|Maintainer):\s*(.+)$/i,
]

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

  /**
   * The body has to scan the tree, because the title says it does.
   *
   * The previous version of this test asserted one field of package.json and
   * was named as though it had walked every file. Nothing in the tree was
   * wrong -- the assertion simply could not have found out. An assertion that
   * cannot fail for the reason its name gives is not a test.
   */
  test('nothing in the tree claims an author it does not have', async () => {
    const files = await treeFiles()
    assert.ok(files.length > 10, 'the scan walked the tree rather than nothing')

    const claims = []
    for (const file of files) {
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        for (const pattern of AUTHORSHIP_CLAIMS) {
          const match = pattern.exec(line)
          if (match === null) continue
          claims.push({ file: relative(PROJECT_ROOT, file), claimed: match[1].trim() })
        }
      }
    }

    assert.ok(claims.length >= 2, `expected the licence and the manifest to claim an author, found ${claims.length}`)
    for (const claim of claims) {
      assert.ok(
        claim.claimed.includes('Edilec Private Limited'),
        `${claim.file} attributes this work to "${claim.claimed}"`,
      )
    }
  })

  test('every exit code the README documents is one the tool can produce', async () => {
    const readme = await readFile(join(PROJECT_ROOT, 'README.md'), 'utf8')
    const table = readme.slice(readme.indexOf('## Exit codes'))
    const documented = [...table.matchAll(/^\| `(\d)` \|/gm)].map((match) => Number(match[1]))
    assert.deepEqual(documented, [0, 1, 2], 'the README documents exactly these three')

    const produced = new Set()
    for (const example of ['honoured', 'broken', 'unsupported']) {
      const { code } = await runCli(['--root', join(PROJECT_ROOT, 'examples', example), '--json'])
      produced.add(code)
    }
    // And the other shape of exit 2: a configuration error, with empty stdout.
    const bad = await runCli(['--root', PROJECT_ROOT, '--nonsense'])
    produced.add(bad.code)
    assert.equal(bad.stdout, '', 'a run that never had a subject reports nothing')

    for (const code of documented) {
      assert.ok(produced.has(code), `the README documents exit ${code} and no run produced it`)
    }
  })

  test('the two shapes of exit 2 the README documents are both real', async () => {
    const root = await makeRoot({ 'prop-contract.json': '{ "version": ' })
    roots.push(root)
    const { code, stdout } = await runCli(['--root', root, '--json'])
    assert.equal(code, 2)
    assert.notEqual(stdout, '', 'an input that could not be parsed still reports WHICH input')
    assert.equal(JSON.parse(stdout).status, 'incomplete')
  })
})
