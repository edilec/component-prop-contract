/**
 * `location.pointer` is a JSON Pointer into the CONTRACT, whatever
 * `location.file` names.
 *
 * Every comparison finding carries `file` = the TypeScript source the
 * observation is about and `pointer` = the place in `prop-contract.json` that
 * states the requirement. The two name different documents on purpose -- the
 * source has no field path to point at, and the contract has no line the
 * reader cares about -- and that convention is worth nothing unless a consumer
 * can rely on it, so it is asserted here by RESOLVING each pointer against the
 * contract rather than by reading the sentence in the README.
 *
 * The same test exercises RFC 6901 escaping, which had no test in either tree:
 * `escapePointerSegment` emitted `~0` and `~1` correctly, and removing the
 * escaping left the whole suite green while emitting a pointer that resolves
 * to the wrong field or to nothing at all.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { escapePointerSegment } from '../src/index.mjs'
import {
  BUTTON_SOURCE, PROJECT_ROOT, componentEntry, contractDocument, makeRoot, removeRoot,
  reportFor, runCli,
} from './support.mjs'

const roots = []
after(async () => { await Promise.all(roots.map(removeRoot)) })

async function track(root) {
  roots.push(root)
  return root
}

/** Resolve one RFC 6901 pointer, or report where it stopped. */
function resolvePointer(document, pointer) {
  if (pointer === '') return { ok: true, value: document }
  if (!pointer.startsWith('/')) return { ok: false, at: pointer }
  let value = document
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (value === null || typeof value !== 'object') return { ok: false, at: key }
    if (Array.isArray(value)) {
      if (!/^\d+$/.test(key) || Number(key) >= value.length) return { ok: false, at: key }
      value = value[Number(key)]
      continue
    }
    if (!Object.hasOwn(value, key)) return { ok: false, at: key }
    value = value[key]
  }
  return { ok: true, value }
}

describe('a pointer resolves in the contract, even when the file names a source', () => {
  test('every finding of the broken example points somewhere real in prop-contract.json', async () => {
    const root = join(PROJECT_ROOT, 'examples', 'broken')
    const { code, stdout } = await runCli(['--root', root, '--json'])
    const report = JSON.parse(stdout)
    const contract = JSON.parse(await readFile(join(root, 'prop-contract.json'), 'utf8'))
    assert.equal(code, 1)
    assert.ok(report.findings.length >= 5)

    let crossDocument = 0
    for (const finding of report.findings) {
      const resolved = resolvePointer(contract, finding.location.pointer)
      assert.equal(
        resolved.ok,
        true,
        `${finding.ruleId}: ${finding.location.pointer} does not resolve in the contract (stopped at ${resolved.at})`,
      )
      if (finding.location.file !== 'prop-contract.json') crossDocument += 1
    }
    assert.ok(
      crossDocument > 0,
      'the cross-document case is the one being pinned, so it has to occur here',
    )
  })

  test('the pointer names the field the finding is about, not merely a field', async () => {
    const root = join(PROJECT_ROOT, 'examples', 'broken')
    const { stdout } = await runCli(['--root', root, '--json'])
    const report = JSON.parse(stdout)
    const contract = JSON.parse(await readFile(join(root, 'prop-contract.json'), 'utf8'))

    const missing = report.findings.find((finding) => finding.ruleId === 'prop-missing')
    assert.ok(missing)
    assert.equal(missing.location.file, 'src/Chip.tsx', 'the file is the source the member is absent from')
    const resolved = resolvePointer(contract, missing.location.pointer)
    assert.equal(resolved.ok, true)
    assert.deepEqual(resolved.value, { type: { name: 'enum', value: ['neutral', 'danger'] } })
  })
})

describe('a field name carrying a pointer metacharacter is escaped, per RFC 6901', () => {
  test('a "/" in an unknown field name becomes ~1 and still resolves to that field', async () => {
    const contract = contractDocument({
      components: [componentEntry({ 'a/b': 'planted' })],
    })
    const root = await track(await makeRoot({
      'prop-contract.json': contract,
      'src/Button.tsx': BUTTON_SOURCE,
    }))
    const { report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'component-unknown-field')
    assert.ok(finding)
    assert.equal(finding.location.pointer, '/components/0/a~1b')
    assert.deepEqual(resolvePointer(contract, finding.location.pointer), { ok: true, value: 'planted' })
  })

  test('a "~" in an unknown field name becomes ~0 and still resolves to that field', async () => {
    const contract = contractDocument({
      components: [componentEntry({ 'c~d': 'planted' })],
    })
    const root = await track(await makeRoot({
      'prop-contract.json': contract,
      'src/Button.tsx': BUTTON_SOURCE,
    }))
    const { report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'component-unknown-field')
    assert.ok(finding)
    assert.equal(finding.location.pointer, '/components/0/c~0d')
    assert.deepEqual(resolvePointer(contract, finding.location.pointer), { ok: true, value: 'planted' })
  })

  test('an argTypes key carrying both metacharacters resolves to that member', async () => {
    const contract = contractDocument({
      components: [componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { 'a/b~c': { type: { name: 'string', required: true } } },
      })],
    })
    const root = await track(await makeRoot({
      'prop-contract.json': contract,
      'src/Button.tsx': BUTTON_SOURCE,
    }))
    const { report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'prop-missing')
    assert.ok(finding, 'the source declares no such member, so the requirement is reported missing')
    assert.equal(finding.location.pointer, '/components/0/argTypes/a~1b~0c')
    const resolved = resolvePointer(contract, finding.location.pointer)
    assert.equal(resolved.ok, true)
    assert.deepEqual(resolved.value, { type: { name: 'string', required: true } })
  })

  test('an unescaped segment would resolve to the wrong place, which is why it is escaped', () => {
    assert.equal(escapePointerSegment('a/b'), 'a~1b')
    assert.equal(escapePointerSegment('c~d'), 'c~0d')
    assert.equal(escapePointerSegment('~/'), '~0~1')
    assert.equal(escapePointerSegment('plain'), 'plain')
    assert.deepEqual(
      resolvePointer({ components: [{ 'a/b': 'planted' }] }, '/components/0/a/b'),
      { ok: false, at: 'a' },
      'the unescaped spelling resolves to nothing at all',
    )
  })
})
