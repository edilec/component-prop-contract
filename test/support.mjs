import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(PROJECT_ROOT, 'bin', 'component-prop-contract.mjs')

/** A source whose surface matches `contractDocument()` exactly. */
export const BUTTON_SOURCE = `export interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
  onClick?: (event: MouseEvent) => void;
}
`

/** A contract that passes against BUTTON_SOURCE, as a base for tests that break one thing. */
export function contractDocument(overrides = {}) {
  return {
    schemaVersion: '1',
    version: '1.0.0',
    components: [componentEntry()],
    ...overrides,
  }
}

export function componentEntry(overrides = {}) {
  return {
    id: 'Button',
    source: 'src/Button.tsx',
    propsType: 'ButtonProps',
    props: [
      { name: 'label', type: 'string', required: true },
      { name: 'variant', type: "'primary' | 'secondary'", required: false },
    ],
    events: [
      { name: 'onClick', type: '(event: MouseEvent) => void', required: false },
    ],
    ...overrides,
  }
}

/**
 * Write a throwaway directory of files and hand back its path.
 *
 * Values that are strings are written verbatim, so a test can plant a contract
 * that is not valid JSON or a source that is not valid TypeScript; anything
 * else is serialised. A key with a `/` in it creates the directory it needs.
 */
export async function makeRoot(files) {
  const root = await mkdtemp(join(tmpdir(), 'component-prop-contract-'))
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name)
    await mkdir(dirname(target), { recursive: true })
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    await writeFile(target, body)
  }
  return root
}

/** A root holding a contract and one Button source, both valid unless overridden. */
export async function makeCase(contract = contractDocument(), source = BUTTON_SOURCE) {
  return makeRoot({ 'prop-contract.json': contract, 'src/Button.tsx': source })
}

export async function removeRoot(root) {
  await rm(root, { recursive: true, force: true })
}

/**
 * Run the real CLI as a child process and report exactly what the streams and
 * the exit code carried.
 *
 * A child process rather than an in-process call on purpose: the exit code is
 * the one part of this contract that cannot be satisfied by editing a
 * declaration, and stdout being empty is a property of the process, not of a
 * return value.
 */
export async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? PROJECT_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (error.code === undefined && error.stdout === undefined) throw error
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Run the CLI over a root and parse the report. */
export async function reportFor(root, extra = []) {
  const result = await runCli(['--root', root, '--json', ...extra])
  const report = result.stdout === '' ? null : JSON.parse(result.stdout)
  return { ...result, report }
}

/** Every rule id a report's findings used, in code-unit order. */
export function ruleIds(report) {
  return [...new Set(report.findings.map((finding) => finding.ruleId))].sort()
}
