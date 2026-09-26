# component-prop-contract rules

One row per rule. The `ruleId` is stable across releases; renaming one is a breaking change
recorded in the changelog. The severity column is the authoritative catalog, and
`test/rule-catalog.test.mjs` asserts it against `RULE_SEVERITY` in both directions.

That assertion is a consistency check, **not** the defence. A table, a document and a test's
expected map are three declarations that one coordinated edit satisfies — one tool in this
catalog had 40 of 52 error rules survive exactly that flip. The defence is
`test/severity-outcomes.test.mjs`, which drives real files through the real CLI for every rule
below and asserts the process exit code.

`error` fails the run (exit 1). `warning` and `info` are reported and do not change the verdict.
Rules marked **incomplete** also mark the run incomplete, which is exit 2 and never a pass.

## Where a finding points

`location.file` is the file the observation is about. `location.pointer` is **always a JSON
Pointer into the contract document**, whatever `location.file` names — for a comparison finding
those are two different documents, because the source has no field path to cite and the contract
has no line a reader wants. Pointer segments are escaped per RFC 6901 (`~` becomes `~0`, `/`
becomes `~1`), so a field or `argTypes` key carrying either character still resolves.

## What changed

| ruleId | severity | fires when |
| --- | --- | --- |
| `prop-missing` | error | The contract requires a prop the source's public surface does not declare. Every caller passing it breaks, and the component's own build does not notice. |
| `event-missing` | error | The same, for a member whose name is `on` followed by an upper-case letter. |
| `prop-type-changed` | error | A prop's type is no longer the one the contract fixes. |
| `event-type-changed` | error | The same, for an event. |
| `prop-now-required` | error | The contract declares the member optional and the source now requires it. Every caller that legitimately omitted it stops compiling. |
| `prop-added` | warning | The source declares a public prop the contract does not. An addition is compatible: no caller written against the contract passes it. |
| `event-added` | warning | The same, for an event. |
| `prop-now-optional` | info | The contract requires the member and the source made it optional. Existing callers all pass it, so this is compatible. |
| `prop-type-unconstrained` | info | The contract states no type for the member, so its type was not compared. Reported so the absence of a comparison is visible rather than silent. |
| `private-member-excluded` | info | A source member is `@internal`, `@private` or underscore-prefixed, so it is excluded from the public surface in both directions. Reported so the exclusion is visible: a silent exclusion and a missed member look identical in a report. |
| `props-type-empty` | error | The named declaration has no public members at all, so the contract is compared against an empty surface. |

## The source, as a fact about it

| ruleId | severity | fires when |
| --- | --- | --- |
| `props-type-missing` | error | The source exports no interface or type alias with the name the contract gives. |
| `props-type-not-exported` | error | The declaration exists but is not exported, so it is an implementation detail. A props type callers cannot import is not a contract. |

## The source, as evidence that was never obtained

Every rule here marks the run **incomplete**: exit 2, a report on stdout naming the file, and
never a pass. The component involved is **not compared at all** — reporting a contract member as
missing from a surface this tool only half established would be reporting an unknown as an
absence.

| ruleId | severity | fires when |
| --- | --- | --- |
| `source-unreadable` | error | A source could not be opened. An unread file is not a file with no props. |
| `source-not-utf8` | error | A source is not valid UTF-8, as the strict decoder judges it. |
| `source-too-large` | error | A source is larger than `maxSourceBytes`. |
| `source-path-invalid` | error | The contract names a source path that is absolute, steps out with `..`, or carries a control character. The path comes out of an untrusted document and is checked before anything is resolved. |
| `source-path-escapes-root` | error | A source path that looks fine resolves outside the root. A symbolic link inside the root is still a way out of it. |
| `source-unsupported-syntax` | error | The declaration, or one of its members, is outside the recognised subset. See below. |
| `props-type-ambiguous` | error | The name is declared more than once. TypeScript merges those declarations, so the real surface is the union of all of them and this tool reads one. |
| `too-many-members` | error | A declaration has more members than `maxMembers`. |
| `type-too-complex` | error | A member's type text is past `maxTypeChars`, or nests past `maxTypeDepth`. |

### The recognised subset, and what falls outside it

There is no TypeScript compiler here — zero dependencies — so `src/typescript.mjs` recognises
one written-down shape and refuses the rest **by name**. Half a parser is worse than none: it
would read most of a file, quietly misread the rest, and report a clean pass over a surface it
never established.

Supported:

```ts
export interface Name { ... }
export type Name = { ... }
```

with members of the form `[readonly] name[?]: <type>;`, where `name` is an identifier or a
quoted string and `<type>` is any balanced run of text on one line.

A member name is read the same way from either document. `isUsableName` is one function, asked
about the contract's names and the source's alike, because the two are compared against each
other: a name only one side accepts is a member that can never be matched. A source member named
with bidi controls used to reach the public surface and be reported as an addition with an empty
quoted name, at exit 0, while the contract refused the identical string — an unknown reported as a
pass, arriving through the half of the comparison nobody was guarding.

Refused, each named in the finding:

| Construct | Why it cannot be read |
| --- | --- |
| a generic declaration (`interface Name<T>`) | its members mean different things for different type arguments |
| an `extends` clause | part of the surface is declared somewhere this tool never opens |
| a type alias that is not a plain object literal (a union, an intersection, `Omit<...>`, a mapped type) | same |
| an index or call or construct signature | it declares an open-ended set of members rather than named ones |
| a method signature | outside the subset |
| a member with no type annotation | there is no type to compare |
| a member whose name this tool cannot use on both sides | longer than 200 characters, carrying whitespace, or rendering as nothing once control, separator and bidi characters are removed. The contract side refuses the identical name, so the member could never be declared and never be matched — see below |
| a member whose type text spans a top-level line break | indistinguishable from a missing `;` between two members — see below |
| a declaration appearing twice | declaration merging; the surface is the union |
| an unterminated string or block comment, unbalanced brackets, a template literal with a substitution | the source cannot be masked safely |

The line-break rule is the narrowest one and it is deliberate. TypeScript allows members to be
separated by line breaks alone:

```ts
label: string
variant?: 'primary'
```

and a union written across several lines looks identical to a text scanner:

```ts
variant:
  | 'primary'
  | 'secondary';
```

The first draft of this tool scanned on to the next `;` and merged the two members, reporting a
type of `string variant?: 'primary'` — and then reporting `variant` as **missing** from a source
that declares it. A wrong answer delivered confidently is the one outcome this module exists to
avoid, so both forms are now refused and reported.

## The contract document

| ruleId | severity | fires when |
| --- | --- | --- |
| `contract-invalid` | error | A top-level field is present but not of the shape the contract needs. |
| `contract-unknown-field` | error | A top-level field this build does not know. Accepted-and-ignored is how a typo turns a real requirement into a green run. |
| `contract-version-missing` | error | No `version`. Every verdict is about a particular version of a public interface. |
| `contract-version-invalid` | error | `version` is not `major.minor.patch`. |
| `component-invalid` | error | A component entry is not an object, or its `id`, `propsType` or `note` is unusable. |
| `component-unknown-field` | error | A component declares a field this build does not know. |
| `component-id-duplicate` | error | Two entries share an id, so neither surface is authoritative. |
| `member-invalid` | error | A declared member is malformed: no usable name, no boolean `required`, an unusable `type`, `note`, `description` or `name`, an `argTypes` entry that is not an object, a `type.name` outside the vocabulary below, or an `enum` whose `value` list is absent, empty or carries something that is not usable text. |
| `member-duplicate` | error | A member name appears more than once across `props`, `events` and `argTypes`. |
| `member-misclassified` | error | A member is declared under `props` whose name is an event, or the reverse. One rule decides this for the contract and the source alike. |
| `no-components-declared` | error | The contract governs no components, so the run would report a pass having checked nothing. |
| `no-members-declared` | error | A component declares no props, events or argTypes, so nothing about it is required. |

### The two spellings of a surface

A component declares its members either directly:

```json
{ "props": [{ "name": "label", "type": "string", "required": true }] }
```

or as `argTypes`, the shape a story-metadata export produces:

```json
{ "argTypes": { "label": { "type": { "name": "string", "required": true } } } }
```

The `argTypes` spelling carries less: a kind rather than type text. The comparison is narrowed
to match rather than widened to pretend.

`type.name` is a **closed vocabulary**, and both halves of it are written down:

| `type.name` | compared as |
| --- | --- |
| `string`, `number`, `boolean`, `symbol` | that exact type name |
| `function` | "is this callable at all" — `function` cannot be compared against `(event: MouseEvent) => void` as text |
| `enum` | a set of string literals, taken from `value` |
| `array`, `intersection`, `object`, `other`, `union` | nothing. The kind carries no requirement this tool can check, and `prop-type-unconstrained` says so at `info` |

A `type.name` outside that list is `member-invalid`, not "no requirement". The two are
indistinguishable in a document and one of them is a typo: `{"type": {"nmae": "string"}}` was
refused at exit 1 from the first release, while `{"type": {"name": "strnig"}}` silently placed no
requirement at all and the run went green — the same mistake one character to the right. The
names that legitimately carry no requirement are therefore *in* the vocabulary, so an export that
really says `object` is accepted and only a name nobody meant is refused.

An `enum` states its values or states nothing usable: `value` must be an array of at least one
usable string. A non-string in that list used to degrade the entire requirement to none, and a
value made only of stripped characters used to be compared and then rendered as a blank quoted
literal in the evidence. Both are `member-invalid`.

`description` and `name` on an `argTypes` entry are checked like every other optional field: if
present, they must be text that is still there after sanitising.

`required` defaults to `false` when absent, which is what a story export means by omitting it; in
the direct spelling `required` is mandatory, because whether a caller must pass a member is
exactly what this tool compares.

Type text is compared after normalisation: whitespace around punctuation is removed, and a
top-level union is compared as a **set**, so `'a' | 'b'` and `'b' | 'a'` are the same type.
Nothing else is interpreted — this is a text comparison, not type checking. `string[]` and
`Array<string>` are different text and are reported as a change.

## The contract, as evidence that was never obtained

| ruleId | severity | fires when |
| --- | --- | --- |
| `input-unreadable` | error | The contract could not be opened. |
| `input-not-utf8` | error | The contract is not valid UTF-8. |
| `input-not-json` | error | The contract did not parse as JSON, or parsed as something other than an object. |
| `input-too-large` | error | The contract is larger than `maxContractBytes`. |
| `path-escapes-root` | error | The contract resolves outside the declared root. |
| `schema-version-unsupported` | error | The contract declares a `schemaVersion` this build does not understand. |
| `too-many-components` | error | The contract lists more components than `maxComponents`. None were examined. |
| `too-many-findings` | error | The run produced more findings than `maxFindings`, so the report is partial. |
| `time-budget-exceeded` | error | The `maxRuntimeMs` budget expired. The remaining components are neither matching nor broken, because nothing looked at them. |
