/**
 * A deliberately narrow recogniser for one shape of TypeScript declaration.
 *
 * It is NOT a TypeScript parser and does not try to be one. Zero dependencies
 * means no compiler is available, and half a parser is worse than none: it
 * would read most of a file, quietly misread the rest, and report a clean pass
 * over a public surface it never established.
 *
 * So the subset is written down, and everything outside it is REPORTED rather
 * than guessed at. An unsupported construct makes the run incomplete, which is
 * exit 2 and never a pass. The rule throughout: if this module is not certain
 * what the public surface is, it says so.
 *
 * Supported:
 *
 *   export interface Name { ... }
 *   export type Name = { ... }
 *
 * with members of the form `[readonly] name[?]: <type>;` where `name` is an
 * identifier or a quoted string, and `<type>` is any balanced run of text.
 *
 * Not supported, and each one reported by name:
 *
 *   - a generic declaration (`interface Name<T>`) -- the members mean
 *     different things for different arguments
 *   - an `extends` clause -- part of the surface lives somewhere this module
 *     cannot see
 *   - a type alias that is not a plain object literal (a union, an
 *     intersection, a mapped type, `Omit<...>`) -- same reason
 *   - an index or call signature, a method signature, a construct signature
 *   - a member with no type annotation
 *   - a member whose name this tool could not use on both sides of the
 *     comparison: too long, carrying whitespace, or rendering as nothing once
 *     control, separator and bidi characters are removed
 *   - a member that is not terminated by `;` or `,` before the next one
 *   - an unterminated string or comment, or unbalanced brackets
 */

import { isUsableName } from './text.mjs'

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y

export const DEFAULT_SOURCE_LIMITS = Object.freeze({
  maxMembers: 200,
  maxTypeChars: 400,
  maxTypeDepth: 12,
})

/**
 * Split a source into a scannable mask, a comment-free slice source, and the
 * comments themselves.
 *
 * Two same-length views are produced because they answer different questions.
 * `structure` replaces the CONTENT of every string literal with `x`, so a
 * brace, colon or semicolon inside a string cannot be mistaken for syntax.
 * `code` keeps string literals intact, so a union of string literals can be
 * read back as the type text it is. Both blank out comments, so a `}` in a
 * comment ends nothing.
 *
 * An unterminated string or block comment is refused rather than assumed to
 * run to the end of the file.
 */
export function maskSource(source) {
  const structure = new Array(source.length)
  const code = new Array(source.length)
  const comments = []
  let index = 0

  const blank = (from, to) => {
    for (let at = from; at < to; at += 1) {
      structure[at] = ' '
      code[at] = ' '
    }
  }
  const keep = (at) => {
    structure[at] = source[at]
    code[at] = source[at]
  }

  while (index < source.length) {
    const character = source[index]

    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      comments.push({ start: index, end: stop, text: source.slice(index + 2, stop), block: false })
      blank(index, stop)
      index = stop
      continue
    }

    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) return { ok: false, reason: 'unterminated-comment', offset: index }
      const stop = end + 2
      comments.push({ start: index, end: stop, text: source.slice(index + 2, end), block: true })
      blank(index, stop)
      index = stop
      continue
    }

    if (character === "'" || character === '"' || character === '`') {
      keep(index)
      let at = index + 1
      let closed = false
      while (at < source.length) {
        if (source[at] === '\\') {
          structure[at] = 'x'
          code[at] = source[at]
          at += 1
          if (at < source.length) {
            structure[at] = 'x'
            code[at] = source[at]
            at += 1
          }
          continue
        }
        if (source[at] === character) {
          keep(at)
          at += 1
          closed = true
          break
        }
        // A template literal carrying `${` can hold arbitrary code. This
        // module does not interpret it, and pretending the text between the
        // backticks is inert would be a guess, so it is refused.
        if (character === '`' && source[at] === '$' && source[at + 1] === '{') {
          return { ok: false, reason: 'template-substitution', offset: at }
        }
        if (character !== '`' && source[at] === '\n') {
          return { ok: false, reason: 'unterminated-string', offset: index }
        }
        structure[at] = 'x'
        code[at] = source[at]
        at += 1
      }
      if (!closed) return { ok: false, reason: 'unterminated-string', offset: index }
      index = at
      continue
    }

    keep(index)
    index += 1
  }

  return { ok: true, structure: structure.join(''), code: code.join(''), comments }
}

const OPENERS = { '(': ')', '[': ']', '{': '}' }
const CLOSERS = { ')': '(', ']': '[', '}': '{' }

/**
 * Find the `}` matching the `{` at `open`, over the masked structure.
 *
 * Returns null when the braces do not balance, which is refused upstream
 * rather than read as "the declaration runs to the end of the file".
 */
export function matchBrace(structure, open) {
  let depth = 0
  for (let index = open; index < structure.length; index += 1) {
    const character = structure[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return null
}

function skipSpace(text, from) {
  let index = from
  while (index < text.length && /\s/.test(text[index])) index += 1
  return index
}

function lineOf(source, offset) {
  let line = 1
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

/**
 * Locate every `export interface Name` / `export type Name` in the source.
 *
 * Returns one entry per occurrence, including repeats: two declarations of the
 * same name are TypeScript declaration merging, and the real surface is the
 * union of both. This module reads one declaration, so the caller refuses the
 * ambiguity rather than reading half of it.
 *
 * Declarations without `export` are recorded too, with `exported: false`. They
 * are not a public surface -- a props type nobody can import is an
 * implementation detail -- but the caller needs to tell "not exported" apart
 * from "not there at all", because they call for different fixes.
 */
export function findDeclarations(source, structure) {
  const found = []
  const pattern = /(^|[\s;}(,<])(export[ \t]+)?(?:declare[ \t]+)?(interface|type)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/g
  let match
  while ((match = pattern.exec(structure)) !== null) {
    found.push({
      exported: match[2] !== undefined,
      kind: match[3],
      name: match[4],
      start: match.index + match[1].length,
      nameEnd: match.index + match[0].length,
      line: lineOf(source, match.index + match[1].length),
    })
    pattern.lastIndex = match.index + match[0].length
  }
  return found
}

/** A JSDoc-style comment ending immediately before `offset`, if there is one. */
function attachedComment(comments, offset, source) {
  let best = null
  for (const comment of comments) {
    if (comment.end > offset) break
    if (/\S/.test(source.slice(comment.end, offset))) continue
    best = comment
  }
  return best
}

/**
 * Read the member list of one declaration's object body.
 *
 * Every member is either read exactly or reported as unsupported. There is no
 * third outcome: a member this function cannot classify never silently drops
 * out of the surface, because a dropped member is a prop the report would call
 * absent when it is merely unread.
 */
function readMembers(source, structure, code, comments, open, close, limits) {
  const members = []
  const unsupported = []
  let index = open + 1

  while (index < close) {
    index = skipSpace(structure, index)
    if (index >= close) break
    if (structure[index] === ';' || structure[index] === ',') {
      index += 1
      continue
    }

    const memberStart = index
    if (members.length + unsupported.length >= limits.maxMembers) {
      return { ok: false, reason: 'too-many-members', line: lineOf(source, memberStart) }
    }

    if (structure[index] === '[') {
      unsupported.push({ reason: 'index-signature', line: lineOf(source, index) })
      index = skipToTerminator(structure, index, close) ?? close
      continue
    }
    if (structure[index] === '(' || structure[index] === '<') {
      unsupported.push({ reason: 'call-signature', line: lineOf(source, index) })
      index = skipToTerminator(structure, index, close) ?? close
      continue
    }

    let readonly = false
    IDENTIFIER.lastIndex = index
    const leading = IDENTIFIER.exec(structure)
    if (leading !== null && leading[0] === 'readonly') {
      const after = skipSpace(structure, index + leading[0].length)
      // `readonly` is only a modifier when something else follows it on the
      // same member; `readonly: boolean` is an ordinary prop called readonly.
      if (structure[after] !== ':' && structure[after] !== '?') {
        readonly = true
        index = after
      }
    }

    let name = null
    if (structure[index] === "'" || structure[index] === '"') {
      const quote = structure[index]
      const end = structure.indexOf(quote, index + 1)
      if (end === -1 || end >= close) {
        unsupported.push({ reason: 'unreadable-member-name', line: lineOf(source, index) })
        break
      }
      name = code.slice(index + 1, end)
      index = end + 1
    } else {
      IDENTIFIER.lastIndex = index
      const identifier = IDENTIFIER.exec(structure)
      if (identifier === null) {
        unsupported.push({ reason: 'unreadable-member-name', line: lineOf(source, index) })
        index = skipToTerminator(structure, index, close) ?? close
        continue
      }
      name = identifier[0]
      index += identifier[0].length
    }

    /**
     * The name was READ. Whether it can be USED is a separate question, and
     * the answer has to be the same one the contract side gives -- the two are
     * compared against each other, so a name only one side accepts can never
     * be matched. `isUsableName` is the single predicate both sides ask.
     *
     * A name made of bidi controls used to reach the public surface here and
     * render as `""` in the report, while the contract refused the identical
     * string: an addition nobody could ever declare, at exit 0.
     */
    if (!isUsableName(name)) {
      // `name` is deliberately not carried: it is the thing that cannot be
      // rendered, so the finding describes it by line rather than repeating it.
      unsupported.push({ reason: 'member-name-unusable', line: lineOf(source, memberStart) })
      index = skipToTerminator(structure, index, close) ?? close
      continue
    }

    index = skipSpace(structure, index)
    let optional = false
    if (structure[index] === '?') {
      optional = true
      index = skipSpace(structure, index + 1)
    }

    if (structure[index] === '(' || structure[index] === '<') {
      unsupported.push({ reason: 'method-signature', line: lineOf(source, memberStart), name })
      index = skipToTerminator(structure, index, close) ?? close
      continue
    }
    if (structure[index] !== ':') {
      unsupported.push({ reason: 'member-without-type', line: lineOf(source, memberStart), name })
      index = skipToTerminator(structure, index, close) ?? close
      continue
    }

    const typeStart = index + 1
    const terminator = findTerminator(structure, typeStart, close, limits)
    if (terminator === null) {
      unsupported.push({ reason: 'unbalanced-type', line: lineOf(source, memberStart), name })
      break
    }
    if (terminator.reason === 'type-too-deep') {
      // A limit, not a syntax this module declines to read: like
      // `too-many-members` it ends the whole declaration, because resuming in
      // the middle of a type it already refused produces a second, spurious
      // complaint about a member name that was never there.
      return { ok: false, reason: 'type-too-deep', line: lineOf(source, memberStart) }
    }
    if (terminator.reason !== undefined) {
      unsupported.push({ reason: terminator.reason, line: lineOf(source, memberStart), name })
      index = skipToTerminator(structure, terminator.at, close) ?? close
      continue
    }

    const raw = code.slice(typeStart, terminator.at).trim()
    if (raw.length === 0) {
      unsupported.push({ reason: 'member-without-type', line: lineOf(source, memberStart), name })
      index = terminator.at + 1
      continue
    }
    if (raw.length > limits.maxTypeChars) {
      return { ok: false, reason: 'type-too-long', line: lineOf(source, memberStart) }
    }

    const doc = attachedComment(comments, memberStart, source)
    members.push({
      name,
      optional,
      readonly,
      type: raw,
      line: lineOf(source, memberStart),
      doc: doc === null ? '' : doc.text,
    })
    index = terminator.at + (structure[terminator.at] === '}' ? 0 : 1)
  }

  return { ok: true, members, unsupported }
}

/** Advance past a member this module could not read, so the next one is still seen. */
function skipToTerminator(structure, from, close) {
  let depth = 0
  for (let index = from; index < close; index += 1) {
    const character = structure[index]
    if (OPENERS[character] !== undefined) depth += 1
    else if (CLOSERS[character] !== undefined) depth -= 1
    else if (depth === 0 && (character === ';' || character === ',')) return index + 1
  }
  return null
}

/**
 * Find where a member's type text ends.
 *
 * A `;` or `,` at bracket depth zero ends it, and so does the body's closing
 * brace for the last member.
 *
 * A LINE BREAK at top level ends nothing, and that is the dangerous case.
 * TypeScript lets members be separated by line breaks alone:
 *
 *     label: string
 *     variant?: 'primary'
 *
 * but a union written across several lines looks identical to this module:
 *
 *     variant:
 *       | 'primary'
 *       | 'secondary';
 *
 * Without a real parser the two cannot be told apart, and the first draft of
 * this function proved why it matters -- scanning on to the next `;` merged
 * two members into one and reported a type of `string variant?: 'primary'`,
 * with `variant` then reported as MISSING from a source that declares it.
 * That is a wrong answer delivered confidently, which is the one outcome this
 * module exists to avoid.
 *
 * So a type whose text spans a top-level line break is reported as
 * `member-not-terminated` and the run is incomplete. The subset is narrower
 * for it, and the README says so.
 */
function findTerminator(structure, from, close, limits) {
  let depth = 0
  let angle = 0
  let seenContent = false
  let pendingBreak = false
  let brokeLine = false

  for (let index = from; index < close; index += 1) {
    const character = structure[index]

    if (character === '\n') {
      if (seenContent && depth === 0 && angle === 0) pendingBreak = true
      continue
    }
    if (/\s/.test(character)) continue

    if (OPENERS[character] !== undefined) {
      depth += 1
      if (depth > limits.maxTypeDepth) return { at: index, reason: 'type-too-deep' }
    } else if (CLOSERS[character] !== undefined) {
      depth -= 1
      if (depth < 0) return null
    } else if (character === '<') angle += 1
    else if (character === '>' && structure[index - 1] !== '=') angle = Math.max(0, angle - 1)

    if (depth === 0 && angle === 0 && (character === ';' || character === ',')) {
      return brokeLine ? { at: index, reason: 'member-not-terminated' } : { at: index }
    }

    // Any content after a top-level line break means the break sat between two
    // things, and this module cannot say whether they were one member or two.
    if (pendingBreak) brokeLine = true
    seenContent = true
  }

  if (depth !== 0 || angle !== 0) return null
  // The last member may be closed by the body's own brace. A trailing line
  // break with nothing after it is just whitespace, not a missing terminator.
  return brokeLine ? { at: close, reason: 'member-not-terminated' } : { at: close }
}

/**
 * Read the members of `typeName` out of a TypeScript source.
 *
 * Returns one of:
 *   { ok: true, members, unsupported }  -- the declaration was read
 *   { ok: false, reason, ... }          -- it was not, and why
 *
 * `unsupported` is non-empty when the declaration was read but some of its
 * members were not. That is still incomplete evidence about the surface, and
 * the caller treats it as such.
 */
export function readDeclaration(source, typeName, limits = DEFAULT_SOURCE_LIMITS) {
  const masked = maskSource(source)
  if (!masked.ok) return { ok: false, reason: masked.reason, line: lineOf(source, masked.offset ?? 0) }

  const declarations = findDeclarations(source, masked.structure)
  const named = declarations.filter((declaration) => declaration.name === typeName)
  if (named.length === 0) return { ok: false, reason: 'not-declared' }
  if (named.length > 1) {
    return { ok: false, reason: 'declared-more-than-once', lines: named.map((entry) => entry.line) }
  }

  const [declaration] = named
  if (!declaration.exported) return { ok: false, reason: 'not-exported', line: declaration.line }

  let cursor = skipSpace(masked.structure, declaration.nameEnd)
  if (masked.structure[cursor] === '<') {
    return { ok: false, reason: 'generic-declaration', line: declaration.line }
  }

  if (declaration.kind === 'interface') {
    const brace = masked.structure.indexOf('{', cursor)
    if (brace === -1) return { ok: false, reason: 'unbalanced-body', line: declaration.line }
    if (/\bextends\b/.test(masked.structure.slice(cursor, brace))) {
      return { ok: false, reason: 'extends-clause', line: declaration.line }
    }
    cursor = brace
  } else {
    if (masked.structure[cursor] !== '=') return { ok: false, reason: 'unbalanced-body', line: declaration.line }
    cursor = skipSpace(masked.structure, cursor + 1)
    if (masked.structure[cursor] !== '{') {
      return { ok: false, reason: 'alias-not-object-literal', line: declaration.line }
    }
  }

  const close = matchBrace(masked.structure, cursor)
  if (close === null) return { ok: false, reason: 'unbalanced-body', line: declaration.line }

  if (declaration.kind === 'type') {
    const after = skipSpace(masked.structure, close + 1)
    if (masked.structure[after] === '&' || masked.structure[after] === '|') {
      return { ok: false, reason: 'alias-not-object-literal', line: declaration.line }
    }
  }

  const read = readMembers(source, masked.structure, masked.code, masked.comments, cursor, close, limits)
  if (!read.ok) return { ok: false, reason: read.reason, line: read.line }
  return { ok: true, members: read.members, unsupported: read.unsupported, line: declaration.line }
}

/**
 * Normalise type text so two spellings of the same type compare equal.
 *
 * Whitespace around punctuation is removed, and a top-level union is compared
 * as a SET: `'a' | 'b'` and `'b' | 'a'` are the same type, and a contract that
 * had to list them in one order would fail on a formatting change. Nothing
 * else is interpreted -- this is a text comparison and the README says so.
 */
export function normaliseType(text) {
  const flattened = String(text).replace(/\s+/g, ' ').trim().replace(/;$/, '')
  const tightened = flattened
    .replace(/\s*([|&<>,(){}[\]:;?])\s*/g, '$1')
    .replace(/\s*=>\s*/g, '=>')
  const parts = splitUnion(tightened)
  if (parts.length < 2) return tightened
  return [...new Set(parts)].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1)).join('|')
}

/** Split on `|` at bracket depth zero; anything nested stays where it is. */
export function splitUnion(text) {
  const parts = []
  let depth = 0
  let angle = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (OPENERS[character] !== undefined) depth += 1
    else if (CLOSERS[character] !== undefined) depth -= 1
    else if (character === '<') angle += 1
    else if (character === '>' && text[index - 1] !== '=') angle = Math.max(0, angle - 1)
    else if (character === '|' && depth === 0 && angle === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/**
 * Whether a member is part of the public surface.
 *
 * Three ways to say "this is an implementation detail", and all three are
 * honoured: a `@internal` or `@private` tag in the member's own doc comment,
 * and a leading underscore. The declaration not being exported is handled one
 * level up, because it excludes the whole type rather than one member.
 */
export function isPrivateMember(member) {
  if (member.name.startsWith('_')) return { private: true, why: 'a leading underscore' }
  if (/@internal\b/.test(member.doc)) return { private: true, why: 'an @internal tag' }
  if (/@private\b/.test(member.doc)) return { private: true, why: 'a @private tag' }
  return { private: false, why: '' }
}

/**
 * Whether a member name is an event.
 *
 * One rule, applied to the source and to the contract alike: a member whose
 * name is `on` followed by an upper-case letter is an event, everything else
 * is a prop. Stating it once and applying it everywhere is what keeps a
 * contract from disagreeing with itself about which list `onClick` belongs in.
 */
export function isEventName(name) {
  return /^on[A-Z]/.test(name)
}
