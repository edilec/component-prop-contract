#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_CONTRACT_NAME,
  checkPropContract, excerpt, exitCodeFor, formatReport, serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `component-prop-contract

Compare the public props and events a TypeScript component declares against a
versioned contract, and classify what changed.

Reads one JSON contract and the TypeScript sources it names. It runs no
compiler, starts no build, evaluates nothing, opens no socket and resolves no
host, and it writes no file: there is no --out, no directory is created and
nothing is modified, so no destination check applies.

What it classifies:
  compatible     a member the source adds that the contract does not have
  incompatible   a member the contract requires and the source no longer
                 declares, a member whose type changed, or an optional member
                 the source now requires

Private implementation details are excluded:
  A member tagged @internal or @private in its own doc comment, or named with a
  leading underscore, is not part of the public surface and is never reported
  as an addition. A props type that is declared but NOT exported is not a
  public surface at all, and is reported as such.

Unsupported syntax is reported, never guessed at:
  There is no TypeScript compiler here. One shape of declaration is
  recognised --

    export interface Name { ... }        export type Name = { ... }

  with members of the form [readonly] name[?]: <type>; -- and everything else
  is refused BY NAME: a generic declaration, an extends clause, a type alias
  that is not a plain object literal, an index or call or method signature, a
  member with no type, a member whose type text spans a line break at the top
  level, and a declaration that appears twice. Each makes the run incomplete
  (exit 2), and the component involved is NOT compared, because a half-read
  surface would report a member as absent when it is merely unread.

There is no clock in this tool. The report carries no timestamp, so there is
nothing to inject and nothing to drift.

Usage:
  component-prop-contract --root DIR [--contract FILE] [--json] [limits]

Options:
  --root DIR                 Directory holding the contract and the sources it
                             names (required)
  --contract FILE            Contract to read, relative to --root
                             (default ${DEFAULT_CONTRACT_NAME})
  --json                     Suppress the human summary on stderr

Limits (evidence that could not be read completely, reported):
  --max-components N         Maximum components in one contract (default 500)
  --max-contract-bytes N     Maximum contract size (default 1048576)
  --max-findings N           Maximum findings in one report (default 1000)
  --max-members N            Maximum members in one declaration (default 200)
  --max-runtime-ms N         Time budget, checked between components. Not a
                             hard deadline: a run overshoots by the cost of the
                             component in hand (default 20000)
  --max-source-bytes N       Maximum size of one TypeScript source
                             (default 524288)
  --max-type-chars N         Maximum length of one member's type text
                             (default 400)
  --max-type-depth N         Maximum bracket nesting in one type (default 12)
  -h, --help                 Show this help
  -v, --version              Show the version

Every option that carries a value may be given once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused.

Source paths come out of the contract, which is untrusted input. Each is
required to be relative, free of ".." and of control characters, and to resolve
to a real path inside --root; a symbolic link inside the root that points
outside it is refused.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

Where the line falls between exit 1 and exit 2:
  A difference between a contract and a source that were both read completely
  is a fact ABOUT them, and it fails (exit 1). A source this tool could not
  read, decode or fully recognise is evidence it did not obtain -- that is
  incomplete (exit 2), never a pass, and never reported as a member's absence.

Exit codes:
  0  everything was read and no error-severity rule fired
  1  everything was read and at least one error-severity rule fired
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-components', 'maxComponents'],
  ['--max-contract-bytes', 'maxContractBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-members', 'maxMembers'],
  ['--max-runtime-ms', 'maxRuntimeMs'],
  ['--max-source-bytes', 'maxSourceBytes'],
  ['--max-type-chars', 'maxTypeChars'],
  ['--max-type-depth', 'maxTypeDepth'],
])

const VALUE_FLAGS = new Map([
  ['--contract', 'contract'],
  ['--root', 'root'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, contract: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag carrying a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--max-members 10 --max-members 9000` reads a surface nobody asked for.
   * That is the same defect as an ignored typo, which this tool also refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once(argument)
      options.json = true
    } else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await checkPropContract({
      root: options.root,
      limits: options.limits,
      ...(options.contract === null ? {} : { contract: options.contract }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty rather
    // than carrying a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  if (report.status === 'incomplete') {
    process.stderr.write('incomplete: this run is not a pass. Part of the surface was never read.\n')
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
