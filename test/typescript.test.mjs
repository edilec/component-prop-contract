/**
 * The recogniser, on its own.
 *
 * It is a written-down subset rather than a parser, so what has to be pinned
 * is both halves of that promise: everything inside the subset is read
 * exactly, and everything outside it is refused BY NAME. A guard that refuses
 * every source would pass every refusal test while making the tool useless, so
 * the supported cases are asserted just as hard as the unsupported ones.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DEFAULT_SOURCE_LIMITS, findDeclarations, isEventName, isPrivateMember, maskSource, matchBrace,
  normaliseType, readDeclaration, splitUnion,
} from '../src/index.mjs'

function read(source, name = 'P') {
  return readDeclaration(source, name, DEFAULT_SOURCE_LIMITS)
}

describe('what the subset reads', () => {
  test('an interface, with every supported member form', () => {
    const result = read(`export interface P {
  /** a doc comment */
  label: string;
  readonly id: string;
  optional?: number;
  'quoted-name'?: boolean,
  nested?: { a: string; b: number };
  callback?: (event: MouseEvent) => void;
  union?: 'a' | 'b';
  generic?: Record<string, unknown>;
}
`)
    assert.equal(result.ok, true)
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(result.members.map((member) => member.name), [
      'label', 'id', 'optional', 'quoted-name', 'nested', 'callback', 'union', 'generic',
    ])
    assert.deepEqual(result.members.map((member) => member.optional), [
      false, false, true, true, true, true, true, true,
    ])
    assert.equal(result.members[1].readonly, true)
    assert.equal(result.members[0].doc.includes('a doc comment'), true)
    assert.equal(result.members[5].type, '(event: MouseEvent) => void')
  })

  test('a type alias that is a plain object literal', () => {
    const result = read('export type P = { a: string; b?: number };')
    assert.equal(result.ok, true)
    assert.deepEqual(result.members.map((member) => member.name), ['a', 'b'])
  })

  test('a single member with no terminator, closed by the brace', () => {
    const result = read('export interface P { label: string }')
    assert.equal(result.ok, true)
    assert.deepEqual(result.members.map((member) => member.name), ['label'])
  })

  test('a member named readonly is a member, not a modifier', () => {
    const result = read('export interface P { readonly: boolean; readonly other: string; }')
    assert.equal(result.ok, true)
    assert.deepEqual(result.members.map((member) => [member.name, member.readonly]), [
      ['readonly', false], ['other', true],
    ])
  })

  test('braces, colons and semicolons inside a string literal are not syntax', () => {
    const result = read(`export interface P {
  pattern?: '{;:}';
  label: string;
}
`)
    assert.equal(result.ok, true)
    assert.deepEqual(result.members.map((member) => member.name), ['pattern', 'label'])
    assert.equal(result.members[0].type, "'{;:}'")
  })

  test('a comment cannot close a declaration', () => {
    const result = read(`export interface P {
  // } not the end
  label: string;
}
`)
    assert.equal(result.ok, true)
    assert.deepEqual(result.members.map((member) => member.name), ['label'])
  })

  test('the line each member is on is recorded, so a finding can point at it', () => {
    const result = read('export interface P {\n\n  a: string;\n  b: string;\n}')
    assert.deepEqual(result.members.map((member) => member.line), [3, 4])
  })
})

describe('what the subset refuses, by name', () => {
  const REFUSED = [
    ['generic-declaration', 'export interface P<T> { a: T; }'],
    ['extends-clause', 'export interface P extends Base { a: string; }'],
    ['alias-not-object-literal', "export type P = 'a' | 'b';"],
    ['alias-not-object-literal', 'export type P = { a: string } & Base;'],
    ['alias-not-object-literal', 'export type P = { a: string } | Other;'],
    ['alias-not-object-literal', "export type P = Omit<Base, 'x'>;"],
    ['declared-more-than-once', 'export interface P { a: string; }\nexport interface P { b: string; }'],
    ['not-exported', 'interface P { a: string; }'],
    ['not-declared', 'export interface Q { a: string; }'],
    ['unterminated-comment', 'export interface P { a: string; }\n/* open'],
    ['unterminated-string', "export interface P { a: 'open\n; }"],
    ['template-substitution', 'export interface P { a: `x${1}`; }'],
    ['unbalanced-body', 'export interface P { a: string;'],
  ]

  for (const [reason, source] of REFUSED) {
    test(`${reason}: ${source.slice(0, 44).replace(/\n/g, ' ')}`, () => {
      const result = read(source)
      assert.equal(result.ok, false)
      assert.equal(result.reason, reason)
    })
  }

  const PARTIAL = [
    ['index-signature', 'export interface P { [key: string]: unknown; a: string; }'],
    ['call-signature', 'export interface P { (x: number): void; a: string; }'],
    ['method-signature', 'export interface P { render(): void; a: string; }'],
    ['member-without-type', 'export interface P { a; b: string; }'],
    ['member-not-terminated', 'export interface P {\n  a: string\n  b: string;\n}'],
    ['unbalanced-type', 'export interface P { a: Array<string; }'],
  ]

  for (const [reason, source] of PARTIAL) {
    test(`${reason} is reported as an unsupported member`, () => {
      const result = read(source)
      assert.equal(result.ok, true, 'the declaration itself was found')
      assert.ok(
        result.unsupported.some((item) => item.reason === reason),
        `expected ${reason}, got ${result.unsupported.map((item) => item.reason).join(', ')}`,
      )
    })
  }

  test('a member with no terminator never absorbs the next one', () => {
    // This is the bug the first draft of this module shipped: scanning on to
    // the next `;` merged two members and reported a type of
    // `string b: string`, with `b` then reported MISSING from a source that
    // declares it. A wrong answer delivered confidently.
    const result = read('export interface P {\n  a: string\n  b: string;\n}')
    for (const member of result.members) {
      assert.equal(member.type.includes('b:'), false, 'a member absorbed the one after it')
      assert.equal(member.type.includes('\n'), false, 'a type spans no line break at top level')
    }
    assert.ok(result.unsupported.length > 0, 'and the run is not allowed to look clean')
  })

  test('a multi-line union is refused rather than misread', () => {
    const result = read("export interface P {\n  a:\n    | 'x'\n    | 'y';\n}")
    assert.deepEqual(result.unsupported.map((item) => item.reason), ['member-not-terminated'])
    assert.deepEqual(result.members, [])
  })
})

describe('limits inside a declaration', () => {
  test('too many members', () => {
    const body = Array.from({ length: 10 }, (item, index) => `  m${index}: string;`).join('\n')
    const result = readDeclaration(`export interface P {\n${body}\n}`, 'P', { ...DEFAULT_SOURCE_LIMITS, maxMembers: 3 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'too-many-members')
  })

  test('a type longer than the limit', () => {
    const result = readDeclaration(`export interface P { a: ${'x'.repeat(50)}; }`, 'P', { ...DEFAULT_SOURCE_LIMITS, maxTypeChars: 10 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'type-too-long')
  })

  test('a type nested past the limit', () => {
    const result = readDeclaration('export interface P { a: { b: { c: { d: string } } }; }', 'P', { ...DEFAULT_SOURCE_LIMITS, maxTypeDepth: 2 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'type-too-deep')

    const within = readDeclaration('export interface P { a: { b: { c: { d: string } } }; }', 'P', DEFAULT_SOURCE_LIMITS)
    assert.equal(within.ok, true, 'and the same type inside the limit is read')
  })
})

describe('the supporting primitives', () => {
  test('maskSource blanks comments and string contents but keeps lengths', () => {
    const source = "const a = 'x}'; // }\n"
    const masked = maskSource(source)
    assert.equal(masked.ok, true)
    assert.equal(masked.structure.length, source.length)
    assert.equal(masked.code.length, source.length)
    assert.equal(masked.structure.includes('}'), false, 'no brace survives inside a string or a comment')
    assert.equal(masked.code.includes("'x}'"), true, 'the code view keeps the literal for type text')
  })

  test('matchBrace finds the matching close, and null when there is none', () => {
    assert.equal(matchBrace('{ { } }', 0), 6)
    assert.equal(matchBrace('{ { }', 0), null)
  })

  test('findDeclarations records exported and non-exported alike', () => {
    const source = 'interface A { }\nexport type B = { }\n'
    const found = findDeclarations(source, maskSource(source).structure)
    assert.deepEqual(found.map((entry) => [entry.name, entry.exported, entry.kind]), [
      ['A', false, 'interface'],
      ['B', true, 'type'],
    ])
  })

  test('normaliseType tightens whitespace and treats a union as a set', () => {
    assert.equal(normaliseType("'b'  |  'a'"), normaliseType("'a' | 'b'"))
    assert.equal(normaliseType('( e : MouseEvent ) => void'), '(e:MouseEvent)=>void')
    assert.equal(normaliseType('Record< string , unknown >'), 'Record<string,unknown>')
    assert.equal(normaliseType('string;'), 'string')
    assert.notEqual(normaliseType('string[]'), normaliseType('Array<string>'))
  })

  test('splitUnion splits only at depth zero', () => {
    assert.deepEqual(splitUnion("'a'|(x|y)|'b'"), ["'a'", '(x|y)', "'b'"])
    assert.deepEqual(splitUnion('Record<a|b,c>'), ['Record<a|b,c>'])
  })

  test('isPrivateMember sees all three markings, and nothing else', () => {
    assert.equal(isPrivateMember({ name: '_x', doc: '' }).private, true)
    assert.equal(isPrivateMember({ name: 'x', doc: '* @internal ' }).private, true)
    assert.equal(isPrivateMember({ name: 'x', doc: '* @private ' }).private, true)
    assert.equal(isPrivateMember({ name: 'x', doc: '* internal note ' }).private, false)
    assert.equal(isPrivateMember({ name: 'internal', doc: '' }).private, false)
  })

  test('isEventName is on followed by an upper-case letter, and nothing else', () => {
    assert.equal(isEventName('onClick'), true)
    assert.equal(isEventName('onBlur'), true)
    assert.equal(isEventName('onclick'), false)
    assert.equal(isEventName('once'), false)
    assert.equal(isEventName('only'), false)
    assert.equal(isEventName('on'), false)
  })
})
