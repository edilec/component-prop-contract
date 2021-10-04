/**
 * The contract document, and the two spellings it accepts for a component's
 * public surface.
 *
 * A component entry declares either `props`/`events` directly, or `argTypes`
 * in the shape a story-metadata export produces. Both are normalised to one
 * internal member shape here, so the comparison downstream has a single form
 * to work with and cannot drift between the two.
 */

import { isEventName, normaliseType, splitUnion } from './typescript.mjs'
import { excerpt, isUsableText } from './text.mjs'

/** Top-level fields the contract may declare. */
export const ALLOWED_CONTRACT_FIELDS = Object.freeze([
  'components', 'description', 'schemaVersion', 'version',
])

/** Fields one component entry may declare. */
export const ALLOWED_COMPONENT_FIELDS = Object.freeze([
  'argTypes', 'events', 'id', 'note', 'props', 'propsType', 'source',
])

/** Fields one declared member may carry in the direct spelling. */
export const ALLOWED_MEMBER_FIELDS = Object.freeze(['name', 'note', 'required', 'type'])

/** Fields one `argTypes` entry may carry. */
export const ALLOWED_ARGTYPE_FIELDS = Object.freeze(['description', 'name', 'type'])

/** Fields one `argTypes` entry's `type` may carry. */
export const ALLOWED_ARGTYPE_TYPE_FIELDS = Object.freeze(['name', 'required', 'value'])

export const MAX_NAME_CHARS = 200

/** A `major.minor.patch` contract version. Anything looser is refused. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** A member name, as this tool will accept it from either document. */
export function isUsableName(value) {
  return isUsableText(value, MAX_NAME_CHARS) && !/\s/.test(value)
}

/**
 * How a declared type is compared against the type the source declares.
 *
 * The direct spelling gives type TEXT, compared after normalisation. The
 * `argTypes` spelling gives a KIND, which carries less information, and
 * pretending otherwise would manufacture mismatches: `function` in an argTypes
 * export cannot be compared against `(event: MouseEvent) => void` as text, so
 * it is compared as "is this callable at all".
 *
 * `none` is a real answer and not a failure: a contract that states no type
 * places no requirement on it. That is reported at `info` so the absence of a
 * comparison is visible rather than silent.
 */
export function exactMatcher(text) {
  return Object.freeze({ kind: 'exact', text: normaliseType(text), source: text })
}

export function matcherFromArgType(type) {
  if (type === null || typeof type !== 'object' || Array.isArray(type)) return Object.freeze({ kind: 'none' })
  const name = type.name
  if (name === 'string' || name === 'number' || name === 'boolean' || name === 'symbol') {
    return Object.freeze({ kind: 'exact', text: name, source: name })
  }
  if (name === 'function') return Object.freeze({ kind: 'callable' })
  if (name === 'enum' && Array.isArray(type.value)) {
    const values = type.value.filter((entry) => typeof entry === 'string')
    if (values.length !== type.value.length || values.length === 0) return Object.freeze({ kind: 'none' })
    return Object.freeze({ kind: 'union', values: Object.freeze([...values]) })
  }
  return Object.freeze({ kind: 'none' })
}

/**
 * Compare a declared type against the one the source carries.
 *
 * Returns `{ compared, ok, expected }`. `compared: false` means the contract
 * stated no requirement, which is neither a pass nor a failure -- it is
 * reported so that a reader knows nothing was checked there.
 */
export function matchesType(matcher, sourceType) {
  const actual = normaliseType(sourceType)
  if (matcher.kind === 'none') return { compared: false, ok: true, expected: '' }
  if (matcher.kind === 'exact') return { compared: true, ok: actual === matcher.text, expected: matcher.text }
  if (matcher.kind === 'callable') {
    return {
      compared: true,
      ok: actual.includes('=>'),
      expected: 'a callable type, because the contract records this member as a function',
    }
  }
  const parts = splitUnion(actual)
  const expected = [...matcher.values].map((value) => `'${value}'`).sort(byUnit)
  const got = [...new Set(parts)].sort(byUnit)
  return {
    compared: true,
    ok: expected.length === got.length && expected.every((value, index) => value === got[index]),
    expected: expected.join('|'),
  }
}

function byUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** One member of a declared surface, in the single internal shape. */
export function declaredMember({ name, required, matcher, pointer }) {
  return Object.freeze({
    name,
    required,
    matcher,
    pointer,
    isEvent: isEventName(name),
  })
}

/**
 * Describe a matcher for a message, without reproducing more of the contract
 * than the reader needs.
 */
export function describeMatcher(matcher) {
  if (matcher.kind === 'none') return 'no type'
  if (matcher.kind === 'callable') return 'a function'
  if (matcher.kind === 'union') return excerpt(matcher.values.map((value) => `'${value}'`).join(' | '), 120)
  return excerpt(matcher.source, 120)
}

/**
 * A relative source path this tool is willing to resolve.
 *
 * The path comes out of the contract, which is untrusted input like any other
 * document: it names a file this tool will open, so it is checked before
 * anything is resolved. An absolute path, a `..` segment, a leading separator
 * or a control character is refused here; a path that looks fine and resolves
 * outside the root through a link is refused after resolution, because
 * lexical checking is not confinement.
 */
export function isUsableSourcePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400) return false
  if (excerpt(value, 400) !== value) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('\\')) return false
  return !value.split(/[\\/]/).includes('..')
}
