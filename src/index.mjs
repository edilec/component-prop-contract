/**
 * component-prop-contract -- compare the public props and events a TypeScript
 * component declares against a versioned contract, and classify what changed.
 *
 * A contract goes in: a version, and for each component the source file, the
 * exported props type, and the members that type is required to carry. Each
 * component may spell its members directly (`props` and `events` with a type
 * and a required flag) or as `argTypes`, the shape a story-metadata export
 * produces. Both are read into one internal form.
 *
 * What comes out is the difference, classified:
 *
 *   - a member the contract requires and the source no longer declares, which
 *     BREAKS every caller that passes it
 *   - a member whose type changed, or that became required, which breaks
 *     callers more quietly
 *   - a member the source adds, which is compatible and reported as such
 *
 * Two things this tool is deliberately narrow about.
 *
 * **Private implementation details are excluded.** A member tagged
 * `@internal` or `@private`, or named with a leading underscore, is not part
 * of the public surface and is never reported as an addition. A props type
 * that is declared but not exported is not a public surface at all.
 *
 * **Unsupported syntax is reported, never guessed at.** There is no TypeScript
 * compiler here -- zero dependencies -- so `src/typescript.mjs` recognises one
 * written-down shape of declaration and refuses everything else BY NAME. A
 * generic declaration, an `extends` clause, a type alias that is not a plain
 * object literal, an index or method signature, a member with no terminator:
 * each makes the run `incomplete`, which is exit 2 and never a pass. A
 * component whose source could not be read completely is not compared at all,
 * because a partial surface would report a member as absent when it is merely
 * unread.
 *
 * There is no clock anywhere in this tool, and so nothing to inject and
 * nothing to drift: the report carries no timestamp and two runs over the same
 * files are byte-identical.
 */

import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  ALLOWED_ARGTYPE_FIELDS, ALLOWED_ARGTYPE_TYPE_FIELDS, ALLOWED_COMPONENT_FIELDS,
  ALLOWED_CONTRACT_FIELDS, ALLOWED_MEMBER_FIELDS, ARGTYPE_COMPARED_TYPE_NAMES, ARGTYPE_TYPE_NAMES,
  MAX_NAME_CHARS, VERSION_PATTERN,
  declaredMember, describeMatcher, exactMatcher, isUsableName, isUsableSourcePath,
  matcherFromArgType, matchesType,
} from './contract.mjs'
import {
  DEFAULT_SOURCE_LIMITS, isEventName, isPrivateMember, normaliseType, readDeclaration,
} from './typescript.mjs'
import {
  byCodeUnit, decodeUtf8, describeValue, escapePointerSegment, excerpt, hasForbiddenCharacter,
  isPlainObject, isUsableText, parseFailureDetail, renderable,
} from './text.mjs'

export {
  ALLOWED_ARGTYPE_FIELDS, ALLOWED_ARGTYPE_TYPE_FIELDS, ALLOWED_COMPONENT_FIELDS,
  ALLOWED_CONTRACT_FIELDS, ALLOWED_MEMBER_FIELDS, ARGTYPE_COMPARED_TYPE_NAMES, ARGTYPE_TYPE_NAMES,
  MAX_NAME_CHARS, VERSION_PATTERN,
  declaredMember, describeMatcher, exactMatcher, isUsableName, isUsableSourcePath,
  matcherFromArgType, matchesType,
} from './contract.mjs'
export {
  DEFAULT_SOURCE_LIMITS, findDeclarations, isEventName, isPrivateMember, maskSource, matchBrace,
  normaliseType, readDeclaration, splitUnion,
} from './typescript.mjs'
export {
  CONTROL_CLASSES, EXCERPT_LIMIT, byCodeUnit, decodeUtf8, describeValue, escapePointerSegment,
  excerpt, hasForbiddenCharacter, isPlainObject, isUsableText, parseFailureDetail, renderable,
} from './text.mjs'

export const TOOL_ID = 'component-prop-contract'
export const REPORT_SCHEMA_VERSION = '1'
export const SUPPORTED_DOCUMENT_VERSION = '1'
export const DEFAULT_CONTRACT_NAME = 'prop-contract.json'

/**
 * Parser bounds. Reaching one is an `incomplete` run with a finding naming the
 * limit -- never a silent truncation, and never a pass over the part that was
 * reached.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxComponents: 500,
  maxContractBytes: 1048576,
  maxFindings: 1000,
  maxMembers: 200,
  maxRuntimeMs: 20000,
  maxSourceBytes: 524288,
  maxTypeChars: 400,
  maxTypeDepth: 12,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxComponents: 100000,
  maxContractBytes: 67108864,
  maxFindings: 20000,
  maxMembers: 20000,
  maxRuntimeMs: 600000,
  maxSourceBytes: 67108864,
  maxTypeChars: 20000,
  maxTypeDepth: 64,
})

/**
 * The authoritative rule severity table.
 *
 * Severity decides whether a run fails, so it lives in one place and every
 * finding takes its value from here; an unknown rule id throws rather than
 * defaulting. `test/rule-catalog.test.mjs` checks this against
 * docs/prop-rules.md in both directions, which is a consistency check and NOT
 * the defence -- a table, a document and a test's expected map are three
 * declarations that one coordinated edit satisfies.
 * `test/severity-outcomes.test.mjs` is the defence: it drives real files
 * through the real CLI for every rule below and asserts the exit code.
 */
export const RULE_SEVERITY = Object.freeze({
  'component-id-duplicate': 'error',
  'component-invalid': 'error',
  'component-unknown-field': 'error',
  'contract-invalid': 'error',
  'contract-unknown-field': 'error',
  'contract-version-invalid': 'error',
  'contract-version-missing': 'error',
  'event-added': 'warning',
  'event-missing': 'error',
  'event-type-changed': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'member-duplicate': 'error',
  'member-invalid': 'error',
  'member-misclassified': 'error',
  'no-components-declared': 'error',
  'no-members-declared': 'error',
  'path-escapes-root': 'error',
  'private-member-excluded': 'info',
  'prop-added': 'warning',
  'prop-missing': 'error',
  'prop-now-optional': 'info',
  'prop-now-required': 'error',
  'prop-type-changed': 'error',
  'prop-type-unconstrained': 'info',
  'props-type-ambiguous': 'error',
  'props-type-empty': 'error',
  'props-type-missing': 'error',
  'props-type-not-exported': 'error',
  'schema-version-unsupported': 'error',
  'source-not-utf8': 'error',
  'source-path-escapes-root': 'error',
  'source-path-invalid': 'error',
  'source-too-large': 'error',
  'source-unreadable': 'error',
  'source-unsupported-syntax': 'error',
  'time-budget-exceeded': 'error',
  'too-many-components': 'error',
  'too-many-findings': 'error',
  'too-many-members': 'error',
  'type-too-complex': 'error',
})

/** How each unsupported construct is explained to a reader. */
export const UNSUPPORTED_REASONS = Object.freeze({
  'alias-not-object-literal': 'the type alias is not a plain object literal (a union, an intersection or a mapped type), so part of the surface is defined somewhere this tool cannot see',
  'call-signature': 'a call or construct signature',
  'extends-clause': 'an "extends" clause, so part of the surface is inherited from a declaration this tool cannot see',
  'generic-declaration': 'a generic declaration, whose members mean different things for different type arguments',
  'index-signature': 'an index signature, which declares an open-ended set of members rather than named ones',
  'member-not-terminated': 'a member whose type text spans a line break at the top level, which is indistinguishable from a missing ";" between two members',
  'member-name-unusable': 'a member name longer than 200 characters, carrying whitespace, or rendering as nothing once control, separator and bidi characters are removed',
  'member-without-type': 'a member with no type annotation',
  'method-signature': 'a method signature',
  'template-substitution': 'a template literal carrying a substitution',
  'unbalanced-body': 'a declaration whose braces do not balance',
  'unbalanced-type': 'a member whose type text has unbalanced brackets',
  'unreadable-member-name': 'a member whose name could not be read',
  'unterminated-comment': 'an unterminated block comment',
  'unterminated-string': 'an unterminated string literal',
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const EVIDENCE_LIMIT = 240
const TYPE_LIMIT = 120

const ALLOWED_OPTIONS = Object.freeze(['contract', 'limits', 'monotonic', 'root'])

export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(
        `Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`,
      )
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it. Both sides
 * must already be real paths: comparing a real root against an unresolved path
 * refuses legitimate files whenever the root is reached through a symbolic
 * link, and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_CHARS) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_CHARS} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  if (normalize(name).split(/[\\/]/).includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike. Type text and prop names come out of a
 * TypeScript source this tool did not write, and a prop name carrying a
 * newline forges whole lines in a human report exactly as an excerpt would.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/prop-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: {
      file: excerpt(row.file, LOCATION_LIMIT),
      pointer: excerpt(row.pointer ?? '', LOCATION_LIMIT),
    },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence, EVIDENCE_LIMIT)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/**
 * The documented sort key: `location.file`, `location.pointer`, `ruleId`,
 * `message`.
 *
 * The message is part of the key because several rules deliberately anchor
 * more than one finding at the same pointer -- every added prop of one
 * component hangs off that component's source file.
 */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file)
    || byCodeUnit(a.location.pointer, b.location.pointer)
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

class Run {
  constructor(contractFile) {
    this.contractFile = contractFile
    this.rows = []
    this.incomplete = false
  }

  add(row) {
    this.rows.push({ pointer: '', file: this.contractFile, ...row })
  }

  /**
   * Record a finding AND mark the run incomplete, in one call.
   *
   * The two belong together: every caller is a place where the tool wanted a
   * fact about a source and did not get one. Splitting them into two
   * statements is how a deleted line leaves an unread source reporting a pass.
   */
  addUnknown(row) {
    this.incomplete = true
    this.add(row)
  }
}

async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

function checkUnknownFields(run, file, container, allowed, ruleId, pointerPrefix) {
  for (const key of Object.keys(container).sort(byCodeUnit)) {
    if (allowed.includes(key)) continue
    run.add({
      file,
      pointer: `${pointerPrefix}/${escapePointerSegment(key)}`,
      ruleId,
      message: `Unknown field "${excerpt(key, 60)}"; known fields are ${allowed.join(', ')}. An accepted-and-ignored key is how a typo turns a real requirement into a green run.`,
      suggestion: 'Remove the field, or correct the spelling of the one you meant.',
    })
  }
}

/** Read one component's declared members from the direct `props`/`events` spelling. */
function readDirectMembers(run, entry, pointer, seen) {
  const members = []
  let usable = true

  for (const field of ['events', 'props']) {
    if (!Object.hasOwn(entry, field)) continue
    const list = entry[field]
    if (!Array.isArray(list)) {
      usable = false
      run.add({
        pointer: `${pointer}/${field}`,
        ruleId: 'component-invalid',
        message: `"${field}" is not an array of declared members.`,
        suggestion: `Write "${field}" as an array of { "name": "...", "type": "...", "required": true }.`,
      })
      continue
    }

    for (const [index, declared] of list.entries()) {
      const memberPointer = `${pointer}/${field}/${index}`
      if (!isPlainObject(declared)) {
        usable = false
        run.add({
          pointer: memberPointer,
          ruleId: 'member-invalid',
          message: 'This declared member is not an object with a name and a required flag.',
          suggestion: 'Write each member as { "name": "label", "type": "string", "required": true }.',
        })
        continue
      }
      checkUnknownFields(run, run.contractFile, declared, ALLOWED_MEMBER_FIELDS, 'member-invalid', memberPointer)

      if (!isUsableName(declared.name)) {
        usable = false
        run.add({
          pointer: `${memberPointer}/name`,
          ruleId: 'member-invalid',
          message: `This declared member has no usable "name": it must be a string of 1-${MAX_NAME_CHARS} characters with no whitespace, that is still there once control, separator and bidi characters are removed.`,
          suggestion: 'Name the member exactly as the source declares it.',
        })
        continue
      }
      if (seen.has(declared.name)) {
        usable = false
        run.add({
          pointer: `${memberPointer}/name`,
          ruleId: 'member-duplicate',
          message: `The member "${excerpt(declared.name, 80)}" is declared more than once, so the contract states two requirements for one member and neither is authoritative.`,
          evidence: `also declared at ${seen.get(declared.name)}`,
          suggestion: 'Keep one entry per member name.',
        })
        continue
      }
      seen.set(declared.name, memberPointer)

      /**
       * One rule decides what an event is, and it is applied to the contract
       * and to the source alike. A contract that files `onClick` under
       * `props` is disagreeing with itself, and silently reclassifying it
       * would hide the disagreement.
       */
      const expectEvent = isEventName(declared.name)
      if ((field === 'events') !== expectEvent) {
        usable = false
        run.add({
          pointer: `${memberPointer}/name`,
          ruleId: 'member-misclassified',
          message: `The member "${excerpt(declared.name, 80)}" is declared under "${field}", but a member is an event when its name is "on" followed by an upper-case letter and a prop otherwise. One rule decides this for the contract and the source alike.`,
          suggestion: `Move it to "${expectEvent ? 'events' : 'props'}".`,
        })
        continue
      }

      /**
       * `required` is required. Defaulting it either way would make the
       * tool's most consequential verdict -- whether an optional member
       * became mandatory -- depend on a guess.
       */
      if (typeof declared.required !== 'boolean') {
        usable = false
        run.add({
          pointer: `${memberPointer}/required`,
          ruleId: 'member-invalid',
          message: `The member "${excerpt(declared.name, 80)}" does not say whether it is required, as a boolean. Whether a caller must pass it is exactly what this tool compares, so an absent flag is not "optional".`,
          suggestion: 'Declare "required": true or false.',
        })
        continue
      }

      let matcher = { kind: 'none' }
      if (Object.hasOwn(declared, 'type')) {
        if (!isUsableText(declared.type, 400)) {
          usable = false
          run.add({
            pointer: `${memberPointer}/type`,
            ruleId: 'member-invalid',
            message: `The member "${excerpt(declared.name, 80)}" declares "type", but not as usable text. An optional field that is present must say something.`,
            suggestion: 'Write the type as it appears in the source, or omit it to place no requirement on it.',
          })
          continue
        }
        matcher = exactMatcher(declared.type)
      }
      if (Object.hasOwn(declared, 'note') && !isUsableText(declared.note, 400)) {
        usable = false
        run.add({
          pointer: `${memberPointer}/note`,
          ruleId: 'member-invalid',
          message: `The member "${excerpt(declared.name, 80)}" declares "note", but not as usable text.`,
          suggestion: 'Write the note as a plain string, or omit it.',
        })
        continue
      }

      members.push(declaredMember({
        name: declared.name,
        required: declared.required,
        matcher,
        pointer: memberPointer,
      }))
    }
  }

  return { usable, members }
}

/**
 * Read one component's declared members from the `argTypes` spelling.
 *
 * This is the shape a story-metadata export produces. It carries less than the
 * direct spelling -- a kind rather than type text -- and the comparison is
 * narrowed to match rather than widened to pretend.
 */
function readArgTypeMembers(run, entry, pointer, seen) {
  const members = []
  let usable = true
  const argTypes = entry.argTypes

  if (!isPlainObject(argTypes)) {
    run.add({
      pointer: `${pointer}/argTypes`,
      ruleId: 'component-invalid',
      message: '"argTypes" is not an object keyed by member name.',
      suggestion: 'Write "argTypes" as { "label": { "type": { "name": "string", "required": true } } }.',
    })
    return { usable: false, members }
  }

  for (const name of Object.keys(argTypes).sort(byCodeUnit)) {
    const memberPointer = `${pointer}/argTypes/${escapePointerSegment(name)}`
    if (!isUsableName(name)) {
      usable = false
      run.add({
        pointer: memberPointer,
        ruleId: 'member-invalid',
        message: `This "argTypes" key is not a usable member name: it must be 1-${MAX_NAME_CHARS} characters with no whitespace, that is still there once control, separator and bidi characters are removed.`,
        suggestion: 'Key each entry by the member name the source declares.',
      })
      continue
    }
    if (seen.has(name)) {
      usable = false
      run.add({
        pointer: memberPointer,
        ruleId: 'member-duplicate',
        message: `The member "${excerpt(name, 80)}" is declared more than once across "props", "events" and "argTypes".`,
        evidence: `also declared at ${seen.get(name)}`,
        suggestion: 'Declare each member in one place only.',
      })
      continue
    }
    seen.set(name, memberPointer)

    const declared = argTypes[name]
    if (!isPlainObject(declared)) {
      usable = false
      run.add({
        pointer: memberPointer,
        ruleId: 'member-invalid',
        message: `The "argTypes" entry for "${excerpt(name, 80)}" is not an object.`,
        suggestion: 'Write each entry as { "type": { "name": "string", "required": true } }.',
      })
      continue
    }
    checkUnknownFields(run, run.contractFile, declared, ALLOWED_ARGTYPE_FIELDS, 'member-invalid', memberPointer)

    /**
     * The two free-text fields of an `argTypes` entry are checked like every
     * other optional field in this document. They were the only two that were
     * not, and "optional" means the contract may omit the field -- not that
     * anything at all may be written in it.
     */
    let usableFields = true
    for (const field of ['description', 'name']) {
      if (!Object.hasOwn(declared, field) || isUsableText(declared[field], 400)) continue
      usableFields = false
      usable = false
      run.add({
        pointer: `${memberPointer}/${field}`,
        ruleId: 'member-invalid',
        message: `The "argTypes" entry for "${excerpt(name, 80)}" declares "${field}" as ${describeValue(declared[field], 60)}, which is not usable text. An optional field that is present must say something.`,
        suggestion: `Write "${field}" as a plain string, or omit it.`,
      })
    }
    if (!usableFields) continue

    let required = false
    let matcher = { kind: 'none' }
    if (Object.hasOwn(declared, 'type')) {
      const type = declared.type
      if (!isPlainObject(type)) {
        usable = false
        run.add({
          pointer: `${memberPointer}/type`,
          ruleId: 'member-invalid',
          message: `The "argTypes" entry for "${excerpt(name, 80)}" declares "type", but not as an object with a "name".`,
          suggestion: 'Write the type as { "name": "string", "required": true }, or omit it.',
        })
        continue
      }
      checkUnknownFields(run, run.contractFile, type, ALLOWED_ARGTYPE_TYPE_FIELDS, 'member-invalid', `${memberPointer}/type`)
      if (Object.hasOwn(type, 'required') && typeof type.required !== 'boolean') {
        usable = false
        run.add({
          pointer: `${memberPointer}/type/required`,
          ruleId: 'member-invalid',
          message: `The "argTypes" entry for "${excerpt(name, 80)}" declares "required", but not as a boolean. Whether a caller must pass it is exactly what this tool compares, so a value that is neither true nor false is refused rather than read as "no".`,
          suggestion: 'Declare "required": true or false, or omit it.',
        })
        continue
      }

      /**
       * The type NAME is a closed vocabulary, not "anything else places no
       * requirement".
       *
       * `{"name": "strnig"}` used to fall through to no requirement at all and
       * the run went green, while the identical typo in the KEY of this same
       * object was refused at exit 1. That is defect class 6 of the house
       * contract -- a one-character typo turning a real failure into a green
       * run -- so the names that carry no comparable requirement are listed
       * too, and a name outside the list is refused rather than ignored.
       */
      if (Object.hasOwn(type, 'name') && !ARGTYPE_TYPE_NAMES.includes(type.name)) {
        usable = false
        run.add({
          pointer: `${memberPointer}/type/name`,
          ruleId: 'member-invalid',
          message: `The "argTypes" entry for "${excerpt(name, 80)}" declares the type name ${describeValue(type.name, 60)}, which this build does not know. A name it does not know would place no requirement at all, so a typo would take the run green.`,
          evidence: `known type names: ${ARGTYPE_TYPE_NAMES.join(', ')}`,
          suggestion: `Use one of the known type names, or omit "type" to place no requirement on the type.`,
        })
        continue
      }

      /**
       * An enum's values are the requirement. A list carrying a non-string
       * used to degrade the WHOLE requirement to none and pass; a value made
       * only of stripped characters was accepted into the expected set and
       * rendered as a blank quoted literal in the evidence.
       */
      if (type.name === 'enum') {
        const values = Array.isArray(type.value) ? type.value : null
        if (values === null || values.length === 0) {
          usable = false
          run.add({
            pointer: `${memberPointer}/type/value`,
            ruleId: 'member-invalid',
            message: `The "argTypes" entry for "${excerpt(name, 80)}" declares the type name "enum" but "value" is ${values === null ? describeValue(type.value, 60) : 'an empty array'}. The values ARE the requirement, so an enum without them states nothing.`,
            suggestion: 'List the allowed string literals in "value".',
          })
          continue
        }
        let usableValues = true
        for (const [valueIndex, entry] of values.entries()) {
          if (isUsableText(entry, 200)) continue
          usableValues = false
          usable = false
          run.add({
            pointer: `${memberPointer}/type/value/${valueIndex}`,
            ruleId: 'member-invalid',
            message: `The "argTypes" entry for "${excerpt(name, 80)}" lists ${describeValue(entry, 60)} among its enum values. Every value has to be text this report can name, or the requirement is compared against something a reader cannot see.`,
            suggestion: 'Write each enum value as a plain string literal.',
          })
        }
        if (!usableValues) continue
      }

      required = type.required === true
      matcher = matcherFromArgType(type)
    }

    members.push(declaredMember({ name, required, matcher, pointer: memberPointer }))
  }

  return { usable, members }
}

/** Read the contract into a list of components, or report why it could not be. */
function readContract(run, document, limits, state) {
  const file = run.contractFile
  checkUnknownFields(run, file, document, ALLOWED_CONTRACT_FIELDS, 'contract-unknown-field', '')

  if (!Object.hasOwn(document, 'version')) {
    run.add({
      pointer: '/version',
      ruleId: 'contract-version-missing',
      message: 'The contract declares no "version". Every verdict in this report is about a particular version of a public interface, and a report that cannot name it cannot be filed against a release.',
      suggestion: 'Declare "version" as major.minor.patch.',
    })
  } else if (typeof document.version !== 'string' || !VERSION_PATTERN.test(document.version)) {
    run.add({
      pointer: '/version',
      ruleId: 'contract-version-invalid',
      message: `The contract "version" is not a major.minor.patch string. A loose version cannot be compared or ordered, and an incompatible change has to be filed against a version somebody can name.`,
      suggestion: 'Write the version as 2.3.0.',
    })
  } else state.contractVersion = document.version

  if (Object.hasOwn(document, 'description') && !isUsableText(document.description, 1000)) {
    run.add({
      pointer: '/description',
      ruleId: 'contract-invalid',
      message: 'The contract declares "description", but not as usable text. An optional field that is present must say something.',
      suggestion: 'Write "description" as a plain string, or omit it.',
    })
  }

  if (!Array.isArray(document.components)) {
    run.add({
      pointer: '/components',
      ruleId: 'contract-invalid',
      message: 'The contract declares "components" as something other than an array. An absent list is not an empty one: "no component is governed" and "nobody wrote the list" are different contracts.',
      suggestion: 'Declare "components" as an array of component entries.',
    })
    return null
  }
  if (document.components.length > limits.maxComponents) {
    run.addUnknown({
      pointer: '/components',
      ruleId: 'too-many-components',
      message: `The contract declares ${document.components.length} components, past the maxComponents limit of ${limits.maxComponents}. None were examined.`,
      suggestion: 'Raise --max-components, or split the contract.',
    })
    return null
  }
  if (document.components.length === 0) {
    /**
     * The vacuous pass. A contract governing nothing would otherwise report
     * `pass` with `checked: 0`, which is green on no evidence.
     */
    run.add({
      pointer: '/components',
      ruleId: 'no-components-declared',
      message: 'The contract governs no components at all, so this run would check nothing and report a pass on no evidence.',
      suggestion: 'Declare the components whose public surface is fixed, or stop running this check.',
    })
    return []
  }

  const components = []
  const seenIds = new Map()
  for (const [index, entry] of document.components.entries()) {
    const pointer = `/components/${index}`
    if (!isPlainObject(entry)) {
      run.add({
        pointer,
        ruleId: 'component-invalid',
        message: 'This component entry is not an object with an id, a source and a props type.',
        suggestion: 'Write each component as { "id": "Button", "source": "src/Button.tsx", "propsType": "ButtonProps", "props": [] }.',
      })
      continue
    }
    checkUnknownFields(run, file, entry, ALLOWED_COMPONENT_FIELDS, 'component-unknown-field', pointer)

    if (!isUsableName(entry.id)) {
      run.add({
        pointer: `${pointer}/id`,
        ruleId: 'component-invalid',
        message: `This component has no usable "id": it must be a string of 1-${MAX_NAME_CHARS} characters with no whitespace, that is still there once control, separator and bidi characters are removed.`,
        suggestion: 'Give the component the name the design system uses for it.',
      })
      continue
    }
    if (seenIds.has(entry.id)) {
      run.add({
        pointer: `${pointer}/id`,
        ruleId: 'component-id-duplicate',
        message: `The component id "${excerpt(entry.id, 80)}" is declared more than once, so the contract states two different public surfaces for one component and neither is authoritative.`,
        evidence: `also declared at /components/${seenIds.get(entry.id)}`,
        suggestion: 'Merge the entries into one.',
      })
      continue
    }
    seenIds.set(entry.id, index)

    if (!isUsableSourcePath(entry.source)) {
      /**
       * The source path comes out of the contract, which is untrusted input.
       * It names a file this tool will open, so it is checked before anything
       * is resolved -- and the run is incomplete either way, because a source
       * that was not read is not a source with no members.
       */
      run.addUnknown({
        pointer: `${pointer}/source`,
        ruleId: 'source-path-invalid',
        message: `The component "${excerpt(entry.id, 80)}" names no usable "source": it must be a relative path inside the root, of 1-400 characters, with no "..", no leading separator and no control character. It was not read, so nothing is claimed about its surface.`,
        suggestion: 'Name the source file as a path relative to --root.',
      })
      continue
    }
    if (!isUsableName(entry.propsType)) {
      run.add({
        pointer: `${pointer}/propsType`,
        ruleId: 'component-invalid',
        message: `The component "${excerpt(entry.id, 80)}" names no usable "propsType", so there is no declaration in the source to compare against.`,
        suggestion: 'Name the exported interface or type alias that declares the public props.',
      })
      continue
    }
    if (Object.hasOwn(entry, 'note') && !isUsableText(entry.note, 400)) {
      run.add({
        pointer: `${pointer}/note`,
        ruleId: 'component-invalid',
        message: `The component "${excerpt(entry.id, 80)}" declares "note", but not as usable text.`,
        suggestion: 'Write "note" as a plain string, or omit it.',
      })
      continue
    }

    const seenMembers = new Map()
    const direct = readDirectMembers(run, entry, pointer, seenMembers)
    const fromArgTypes = Object.hasOwn(entry, 'argTypes')
      ? readArgTypeMembers(run, entry, pointer, seenMembers)
      : { usable: true, members: [] }
    if (!direct.usable || !fromArgTypes.usable) continue

    const members = [...direct.members, ...fromArgTypes.members]
    if (members.length === 0) {
      run.add({
        pointer,
        ruleId: 'no-members-declared',
        message: `The component "${excerpt(entry.id, 80)}" declares no props, events or argTypes, so nothing about it is required and its entry in this report would be a pass on no evidence.`,
        suggestion: 'Declare the members the public surface must keep, or remove the entry.',
      })
      continue
    }

    state.componentsRead += 1
    components.push({
      id: entry.id,
      index,
      pointer,
      source: entry.source,
      propsType: entry.propsType,
      members,
    })
  }
  return components
}

/** Read one component's source and hand back its public surface, or report why not. */
async function readSurface(run, realRoot, component, limits) {
  const file = component.source
  const located = await resolveInput(realRoot, component.source)
  if (!located.ok) {
    run.addUnknown(located.reason === 'escapes'
      ? {
        file,
        pointer: `${component.pointer}/source`,
        ruleId: 'source-path-escapes-root',
        message: `The source for "${excerpt(component.id, 80)}" resolves outside the declared root, so it was not read and nothing is claimed about its surface. A symbolic link inside the root is still a way out of it.`,
        suggestion: 'Point --root at the tree that really holds the sources.',
      }
      : {
        file,
        pointer: `${component.pointer}/source`,
        ruleId: 'source-unreadable',
        message: `The source for "${excerpt(component.id, 80)}" could not be read (${excerpt(located.code ?? 'unreadable', 40)}), so nothing is claimed about its surface. An unread file is not a file with no props.`,
        suggestion: 'Check the path and the file permissions.',
      })
    return null
  }

  let bytes
  try {
    bytes = await readFile(located.real)
  } catch (error) {
    run.addUnknown({
      file,
      pointer: `${component.pointer}/source`,
      ruleId: 'source-unreadable',
      message: `The source for "${excerpt(component.id, 80)}" could not be read (${excerpt(error.code ?? 'unreadable', 40)}).`,
      suggestion: 'Check the path and the file permissions.',
    })
    return null
  }

  if (bytes.byteLength > limits.maxSourceBytes) {
    run.addUnknown({
      file,
      pointer: `${component.pointer}/source`,
      ruleId: 'source-too-large',
      message: `The source for "${excerpt(component.id, 80)}" is ${bytes.byteLength} bytes, past the maxSourceBytes limit of ${limits.maxSourceBytes}. It was not read.`,
      suggestion: 'Raise --max-source-bytes, or move the props type into a smaller file.',
    })
    return null
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    run.addUnknown({
      file,
      pointer: `${component.pointer}/source`,
      ruleId: 'source-not-utf8',
      message: `The source for "${excerpt(component.id, 80)}" is not valid UTF-8, so it was not read. The decoder decides that, not a search of decoded text for a replacement character.`,
      suggestion: 'Re-encode the source as UTF-8.',
    })
    return null
  }

  const read = readDeclaration(decoded.text, component.propsType, {
    maxMembers: limits.maxMembers,
    maxTypeChars: limits.maxTypeChars,
    maxTypeDepth: limits.maxTypeDepth,
  })

  if (!read.ok) return handleUnreadDeclaration(run, component, file, read, limits)

  if (read.unsupported.length > 0) {
    /**
     * A declaration that was read but not completely. Every one of these is a
     * member whose name, type or very existence is unknown, so the comparison
     * is not run at all: reporting a contract member as missing from a surface
     * this tool only half established would be reporting an unknown as an
     * absence.
     */
    for (const item of read.unsupported.slice(0, 20)) {
      run.addUnknown({
        file,
        pointer: `${component.pointer}/propsType`,
        ruleId: 'source-unsupported-syntax',
        message: `"${excerpt(component.propsType, 60)}" in ${excerpt(file, 80)} uses ${UNSUPPORTED_REASONS[item.reason] ?? excerpt(item.reason, 80)}, at line ${item.line}. This tool recognises one written-down shape of declaration and refuses the rest by name rather than guessing, so ${excerpt(component.id, 60)} was not compared at all.`,
        evidence: item.name === undefined ? `line ${item.line}` : `line ${item.line}, member "${excerpt(item.name, 60)}"`,
        suggestion: 'Rewrite the member in the supported form, or declare the surface somewhere this tool can read it. docs/prop-rules.md lists the subset.',
      })
    }
    return null
  }

  return read
}

/** The ways a declaration can fail to be read, each named rather than guessed at. */
function handleUnreadDeclaration(run, component, file, read, limits) {
  const at = read.line === undefined ? '' : ` at line ${read.line}`

  if (read.reason === 'not-declared') {
    run.add({
      file,
      pointer: `${component.pointer}/propsType`,
      ruleId: 'props-type-missing',
      message: `${excerpt(file, 80)} exports no interface or type alias called "${excerpt(component.propsType, 60)}", so the contract for "${excerpt(component.id, 60)}" describes a surface that is not there.`,
      suggestion: 'Correct "propsType", or restore the declaration the contract names.',
    })
    return null
  }

  if (read.reason === 'not-exported') {
    run.add({
      file,
      pointer: `${component.pointer}/propsType`,
      ruleId: 'props-type-not-exported',
      message: `"${excerpt(component.propsType, 60)}" is declared in ${excerpt(file, 80)}${at} but not exported, so it is an implementation detail rather than a public surface. A props type callers cannot import is not a contract.`,
      suggestion: 'Export the declaration, or point the contract at the type that is exported.',
    })
    return null
  }

  if (read.reason === 'declared-more-than-once') {
    run.addUnknown({
      file,
      pointer: `${component.pointer}/propsType`,
      ruleId: 'props-type-ambiguous',
      message: `"${excerpt(component.propsType, 60)}" is declared more than once in ${excerpt(file, 80)}. TypeScript merges those declarations, so the real surface is the union of all of them, and this tool reads one. Nothing is claimed about "${excerpt(component.id, 60)}".`,
      evidence: `lines ${(read.lines ?? []).join(', ')}`,
      suggestion: 'Merge the declarations into one, or point the contract at a type declared once.',
    })
    return null
  }

  if (read.reason === 'too-many-members') {
    run.addUnknown({
      file,
      pointer: `${component.pointer}/propsType`,
      ruleId: 'too-many-members',
      message: `"${excerpt(component.propsType, 60)}" declares more members than the maxMembers limit of ${limits.maxMembers}${at}. It was not read.`,
      suggestion: 'Raise --max-members, or split the props type.',
    })
    return null
  }

  if (read.reason === 'type-too-long' || read.reason === 'type-too-deep') {
    run.addUnknown({
      file,
      pointer: `${component.pointer}/propsType`,
      ruleId: 'type-too-complex',
      message: `A member of "${excerpt(component.propsType, 60)}"${at} has a type past the maxTypeChars limit of ${limits.maxTypeChars} or the maxTypeDepth limit of ${limits.maxTypeDepth}. It was not read, so nothing is claimed about "${excerpt(component.id, 60)}".`,
      suggestion: 'Raise the limit, or give the type a name and use it.',
    })
    return null
  }

  run.addUnknown({
    file,
    pointer: `${component.pointer}/propsType`,
    ruleId: 'source-unsupported-syntax',
    message: `"${excerpt(component.propsType, 60)}" in ${excerpt(file, 80)} uses ${UNSUPPORTED_REASONS[read.reason] ?? excerpt(read.reason, 80)}${at}. This tool recognises one written-down shape of declaration and refuses the rest by name rather than guessing, so "${excerpt(component.id, 60)}" was not compared at all.`,
    suggestion: 'Rewrite the declaration in the supported form. docs/prop-rules.md lists the subset.',
  })
  return null
}

/**
 * Compare one component's declared surface with the one its source carries.
 *
 * Runs only over a surface that was read COMPLETELY. Everything below assumes
 * that the member list is the whole public surface, and that assumption is
 * what makes "the contract requires it and the source does not declare it" a
 * fact rather than a guess.
 */
function compareSurface(run, component, surface, state) {
  const file = component.source
  const publicMembers = new Map()

  for (const member of surface.members) {
    const privacy = isPrivateMember(member)
    if (privacy.private) {
      /**
       * Acceptance: private implementation details are excluded. Reported at
       * `info` rather than dropped in silence, so the exclusion is visible to
       * a reader and provable by a test -- a silent exclusion and a missed
       * member look identical in a report.
       */
      state.excluded += 1
      run.add({
        file,
        pointer: `${component.pointer}/propsType`,
        ruleId: 'private-member-excluded',
        message: `"${excerpt(member.name, 60)}" in "${excerpt(component.propsType, 60)}" is marked private by ${privacy.why}, so it is not part of the public surface and is not compared in either direction.`,
        evidence: `line ${member.line}`,
      })
      continue
    }
    publicMembers.set(member.name, member)
  }

  state.publicMembers += publicMembers.size

  if (publicMembers.size === 0) {
    run.add({
      file,
      pointer: `${component.pointer}/propsType`,
      ruleId: 'props-type-empty',
      message: `"${excerpt(component.propsType, 60)}" declares no public members at all, so the contract for "${excerpt(component.id, 60)}" is compared against an empty surface.`,
      suggestion: 'Check that the props type is the one the component really uses.',
    })
  }

  const declaredNames = new Set()
  for (const declared of component.members) {
    state.checked += 1
    declaredNames.add(declared.name)
    const noun = declared.isEvent ? 'event' : 'prop'
    const actual = publicMembers.get(declared.name)

    if (actual === undefined) {
      /**
       * Acceptance: removing a required prop contract fails. This is the
       * whole point of the tool -- every caller passing this member breaks,
       * and nothing in a type-checked build of the COMPONENT notices.
       */
      state.missing += 1
      run.add({
        file,
        pointer: declared.pointer,
        ruleId: declared.isEvent ? 'event-missing' : 'prop-missing',
        message: `The contract requires "${excerpt(component.id, 60)}" to accept the ${noun} "${excerpt(declared.name, 60)}", and "${excerpt(component.propsType, 60)}" in ${excerpt(file, 60)} does not declare it. Every caller passing it breaks, and the component's own build does not notice.`,
        evidence: `public members of ${excerpt(component.propsType, 40)}: ${listNames([...publicMembers.keys()])}`,
        suggestion: `Restore the ${noun}, or raise the contract's major version and remove it there too.`,
      })
      continue
    }

    state.matched += 1

    if (declared.required && actual.optional) {
      state.relaxed += 1
      run.add({
        file,
        pointer: declared.pointer,
        ruleId: 'prop-now-optional',
        message: `The contract requires the ${noun} "${excerpt(declared.name, 60)}" and the source now declares it optional. Existing callers all pass it, so this is compatible; it is reported so the contract can catch up.`,
        evidence: `line ${actual.line}`,
        suggestion: 'Mark the member optional in the contract too.',
      })
    } else if (!declared.required && !actual.optional) {
      /**
       * The incompatible direction, and the quieter of the two. Every caller
       * that legitimately omitted this member now fails to compile, and the
       * contract said they did not have to pass it.
       */
      state.tightened += 1
      run.add({
        file,
        pointer: declared.pointer,
        ruleId: 'prop-now-required',
        message: `The contract declares the ${noun} "${excerpt(declared.name, 60)}" optional and the source now requires it. Every caller that legitimately omitted it stops compiling, which is an incompatible change.`,
        evidence: `line ${actual.line}`,
        suggestion: 'Make the member optional again, or raise the contract\'s major version.',
      })
    }

    const comparison = matchesType(declared.matcher, actual.type)
    if (!comparison.compared) {
      state.unconstrained += 1
      run.add({
        file,
        pointer: declared.pointer,
        ruleId: 'prop-type-unconstrained',
        message: `The contract states no type for the ${noun} "${excerpt(declared.name, 60)}", so its type was not compared. The source declares it as ${excerpt(normaliseType(actual.type), TYPE_LIMIT)}.`,
        evidence: `line ${actual.line}`,
        suggestion: 'Record the type in the contract if it should be fixed.',
      })
      continue
    }
    if (comparison.ok) {
      state.typesMatched += 1
      continue
    }
    state.typeChanged += 1
    run.add({
      file,
      pointer: declared.pointer,
      ruleId: declared.isEvent ? 'event-type-changed' : 'prop-type-changed',
      message: `The ${noun} "${excerpt(declared.name, 60)}" of "${excerpt(component.id, 60)}" no longer has the type the contract fixes. A caller written against the contract now passes the wrong thing.`,
      evidence: `contract: ${excerpt(describeMatcher(declared.matcher), 100)}; source line ${actual.line}: ${excerpt(normaliseType(actual.type), 100)}`,
      suggestion: 'Restore the type, or raise the contract\'s major version and record the new one.',
    })
  }

  for (const [name, member] of [...publicMembers.entries()].sort((a, b) => byCodeUnit(a[0], b[0]))) {
    if (declaredNames.has(name)) continue
    /**
     * An addition is compatible: no caller written against the contract passes
     * it, so nothing breaks. It is reported as a warning so the contract can
     * be brought up to date, and it never fails the run.
     */
    state.added += 1
    const noun = isEventName(name) ? 'event' : 'prop'
    run.add({
      file,
      pointer: `${component.pointer}/propsType`,
      ruleId: isEventName(name) ? 'event-added' : 'prop-added',
      message: `"${excerpt(component.propsType, 60)}" declares the public ${noun} "${excerpt(name, 60)}", which the contract does not. An addition is compatible -- no caller written against the contract passes it -- so this is reported, not failed.`,
      evidence: `line ${member.line}: ${excerpt(normaliseType(member.type), 100)}`,
      suggestion: 'Add the member to the contract and raise its minor version.',
    })
  }
}

/** A bounded, code-unit-ordered listing of names for an evidence field. */
export function listNames(names, limit = 12) {
  const sorted = [...new Set(names.map((name) => excerpt(name, 60)))].sort(byCodeUnit)
  if (sorted.length === 0) return 'none'
  if (sorted.length <= limit) return sorted.join(', ')
  return `${sorted.slice(0, limit).join(', ')} and ${sorted.length - limit} more`
}

/**
 * Read one JSON document, recording every way it could fail to arrive.
 */
async function readContractDocument(run, realRoot, name, file, limits) {
  const located = await resolveInput(realRoot, name)
  if (!located.ok) {
    run.addUnknown(located.reason === 'escapes'
      ? {
        file,
        ruleId: 'path-escapes-root',
        message: 'The contract resolves outside the declared root, so it was not read. A symbolic link inside the root is still a way out of it.',
        suggestion: 'Point --root at the directory that really holds the contract.',
      }
      : {
        file,
        ruleId: 'input-unreadable',
        message: `The contract could not be read (${excerpt(located.code ?? 'unreadable', 40)}).`,
        suggestion: 'Check the path and the file permissions.',
      })
    return null
  }

  let bytes
  try {
    bytes = await readFile(located.real)
  } catch (error) {
    run.addUnknown({
      file,
      ruleId: 'input-unreadable',
      message: `The contract could not be read (${excerpt(error.code ?? 'unreadable', 40)}).`,
      suggestion: 'Check the path and the file permissions.',
    })
    return null
  }

  if (bytes.byteLength > limits.maxContractBytes) {
    run.addUnknown({
      file,
      ruleId: 'input-too-large',
      message: `The contract is ${bytes.byteLength} bytes, past the maxContractBytes limit of ${limits.maxContractBytes}. It was not parsed.`,
      suggestion: 'Raise --max-contract-bytes, or split the contract.',
    })
    return null
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    run.addUnknown({
      file,
      ruleId: 'input-not-utf8',
      message: 'The contract is not valid UTF-8, so it was not parsed. The decoder decides that, not a search of the decoded text for a replacement character.',
      suggestion: 'Re-encode the contract as UTF-8.',
    })
    return null
  }

  let document
  try {
    document = JSON.parse(decoded.text)
  } catch (error) {
    run.addUnknown({
      file,
      ruleId: 'input-not-json',
      // The detail describes where the parse failed and never reproduces the
      // document. V8's own message quotes the input back, so the raw message
      // may never reach a stream.
      message: `The contract is not valid JSON: ${excerpt(parseFailureDetail(error), 200)}.`,
      suggestion: 'Validate the contract with a JSON parser before comparing against it.',
    })
    return null
  }

  if (!isPlainObject(document)) {
    run.addUnknown({
      file,
      ruleId: 'input-not-json',
      message: 'The contract parsed, but as something other than a JSON object, so none of its fields could be read.',
      suggestion: 'Write the contract as an object with a "version" and a "components" array.',
    })
    return null
  }

  if (Object.hasOwn(document, 'schemaVersion') && document.schemaVersion !== SUPPORTED_DOCUMENT_VERSION) {
    run.addUnknown({
      file,
      pointer: '/schemaVersion',
      // Not `String(document.schemaVersion)`: a value carrying a non-callable
      // `toString` throws there, and this site is reached before any schema
      // check, so it would cost the whole report on any contract at all.
      ruleId: 'schema-version-unsupported',
      message: `This build understands schemaVersion "${SUPPORTED_DOCUMENT_VERSION}"; the contract declares ${describeValue(document.schemaVersion, 40)}. It was not interpreted.`,
      suggestion: 'Read the contract with a build that understands its schema version.',
    })
    return null
  }

  return document
}

/**
 * Compare a versioned prop contract with the TypeScript sources it governs.
 *
 * Returns a report. It throws only for configuration that never gave the run a
 * subject: an unusable root, an unknown option or an invalid limit. Everything
 * about the contract and the sources, including ones that could not be read,
 * comes back as a report.
 */
export async function checkPropContract(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }

  const limits = validateLimits(options.limits)
  const monotonic = options.monotonic ?? (() => performance.now())
  if (typeof monotonic !== 'function') throw new TypeError('monotonic must be a function returning milliseconds')
  const startedAt = monotonic()

  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root is required')
  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new TypeError(`root is not a readable directory (${error.code ?? 'unreadable'})`)
  }

  const contractName = validateName(options.contract ?? DEFAULT_CONTRACT_NAME, 'contract')
  const contractFile = relative(realRoot, resolve(realRoot, contractName)).split(sep).join('/')
  const run = new Run(contractFile)
  const state = {
    checked: 0,
    componentsRead: 0,
    componentsCompared: 0,
    publicMembers: 0,
    excluded: 0,
    matched: 0,
    missing: 0,
    added: 0,
    typesMatched: 0,
    typeChanged: 0,
    tightened: 0,
    relaxed: 0,
    unconstrained: 0,
    contractVersion: null,
  }

  let expired = false
  const deadline = () => {
    if (expired) return true
    if (monotonic() - startedAt <= limits.maxRuntimeMs) return false
    expired = true
    /**
     * A budget that expires mid-run must not leave a component looking
     * compared. The flag stops the loop AND marks the run incomplete in one
     * call, so no path exists where part of the contract was checked and the
     * report still says `pass`.
     */
    run.addUnknown({
      ruleId: 'time-budget-exceeded',
      message: `The maxRuntimeMs budget of ${limits.maxRuntimeMs} ms expired, so the remaining components were not read or compared. They are neither matching nor broken, because nothing looked at them.`,
      suggestion: 'Raise --max-runtime-ms, or split the contract.',
    })
    return true
  }

  const document = await readContractDocument(run, realRoot, contractName, contractFile, limits)
  if (document === null) return buildReport(run, state, limits)

  const components = readContract(run, document, limits, state)
  if (components === null) return buildReport(run, state, limits)

  for (const component of components) {
    if (deadline()) break
    const surface = await readSurface(run, realRoot, component, limits)
    if (surface === null) continue
    state.componentsCompared += 1
    compareSurface(run, component, surface, state)
  }

  return buildReport(run, state, limits)
}

function buildReport(run, state, limits) {
  let findings = run.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: run.contractFile,
      pointer: '',
      ruleId: 'too-many-findings',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or fix what is already reported and run again.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const incomplete = run.incomplete || truncated
  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      contractVersion: state.contractVersion,
      components: state.componentsRead,
      componentsCompared: state.componentsCompared,
      publicMembers: state.publicMembers,
      privateMembersExcluded: state.excluded,
      membersMatched: state.matched,
      membersMissing: state.missing,
      membersAdded: state.added,
      typesMatched: state.typesMatched,
      typesChanged: state.typeChanged,
      madeRequired: state.tightened,
      madeOptional: state.relaxed,
      typesUnconstrained: state.unconstrained,
    },
    findings,
  }
}

/** The JSON report, exactly as it reaches stdout. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 pass, 1 fail, 2 incomplete. An incomplete run is never a pass. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_MARK = Object.freeze({ error: 'ERROR  ', warning: 'WARN   ', info: 'INFO   ' })

/**
 * The human summary. It goes to stderr; stdout carries the JSON and nothing
 * else.
 *
 * `file` and `pointer` are printed with a separator between them because they
 * name DIFFERENT documents: the file is the TypeScript source the observation
 * is about, and the pointer is the place in the contract that states the
 * requirement. Concatenating them produced `src/Chip.tsx/components/1/argTypes/tone`,
 * which reads as a filesystem path and is not one.
 */
export function formatReport(report) {
  const summary = report.summary
  const lines = []
  lines.push(`${TOOL_ID}: ${report.status} (contract version ${summary.contractVersion ?? 'not declared'})`)
  lines.push(`  ${summary.checked} declared member(s) checked, ${summary.errors} error(s), ${summary.warnings} warning(s)`)
  lines.push(
    `  ${summary.componentsCompared}/${summary.components} component(s) compared, `
    + `${summary.membersMissing} missing, ${summary.typesChanged} type change(s), `
    + `${summary.madeRequired} made required, ${summary.membersAdded} added`,
  )
  lines.push(
    `  ${summary.publicMembers} public member(s) read, `
    + `${summary.privateMembersExcluded} private member(s) excluded`,
  )
  for (const finding of report.findings) {
    const where = finding.location.pointer === ''
      ? finding.location.file
      : `${finding.location.file}  <- contract ${finding.location.pointer}`
    lines.push(`  ${SEVERITY_MARK[finding.severity]}${finding.ruleId}  ${where}`)
    lines.push(`         ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}
