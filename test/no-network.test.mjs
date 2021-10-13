/**
 * No network access, at any time, including in tests.
 *
 * The check is over the source text rather than over behaviour because the
 * claim is an absence: there is no request to observe. What can be asserted is
 * that nothing in the shipped source can reach a socket, a host or a browser,
 * and that the package declares no dependency that could.
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { PROJECT_ROOT } from './support.mjs'

const FORBIDDEN_IMPORTS = [
  'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'node:dns',
  'node:worker_threads', 'node:child_process', 'node:cluster',
  'undici', 'playwright', 'puppeteer', 'jsdom',
]

const FORBIDDEN_CALLS = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'navigator.', 'new Request(']

async function shippedSources() {
  const files = []
  for (const directory of ['src', 'bin']) {
    for (const name of await readdir(join(PROJECT_ROOT, directory))) {
      if (name.endsWith('.mjs')) files.push(join(PROJECT_ROOT, directory, name))
    }
  }
  return files
}

describe('nothing in the shipped source can reach the network', () => {
  test('no forbidden module is imported', async () => {
    const sources = await shippedSources()
    assert.ok(sources.length >= 4, 'the source really was enumerated')
    for (const file of sources) {
      const text = await readFile(file, 'utf8')
      for (const moduleName of FORBIDDEN_IMPORTS) {
        assert.equal(text.includes(`'${moduleName}'`), false, `${file} imports ${moduleName}`)
        assert.equal(text.includes(`"${moduleName}"`), false, `${file} imports ${moduleName}`)
      }
    }
  })

  test('no forbidden call appears', async () => {
    for (const file of await shippedSources()) {
      const text = await readFile(file, 'utf8')
      for (const call of FORBIDDEN_CALLS) {
        assert.equal(text.includes(call), false, `${file} uses ${call}`)
      }
    }
  })

  test('the only node builtins used are the filesystem, paths, the process and a monotonic clock', async () => {
    const used = new Set()
    for (const file of await shippedSources()) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/from '(node:[a-z/_]+)'/g)) used.add(match[1])
    }
    assert.deepEqual([...used].sort(), ['node:fs/promises', 'node:path', 'node:perf_hooks', 'node:process'])
  })

  test('the package declares no dependency of any kind', async () => {
    const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      assert.equal(manifest[field], undefined, `package.json declares ${field}`)
    }
  })

  test('no lockfile is committed, because there is nothing to lock', async () => {
    const entries = await readdir(PROJECT_ROOT)
    for (const name of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'node_modules']) {
      assert.equal(entries.includes(name), false, `${name} should not exist`)
    }
  })
})
