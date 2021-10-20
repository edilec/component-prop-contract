# Component Prop Contract

Compare the public props and events a TypeScript component declares against a versioned
contract, and classify what changed — compatible addition, or incompatible break.

- **Repository:** [edilec/component-prop-contract](https://github.com/edilec/component-prop-contract)
- **Area:** Design Systems
- **License:** MIT
- **Dependencies:** none, at runtime or in development. Node 22+, `node:test`, `node:assert/strict`.

## What it does

A contract goes in: a version, and for each component the source file, the exported props type,
and the members that type is required to carry. The TypeScript sources it names go in with it.

What comes out is the difference, classified:

| | |
| --- | --- |
| **incompatible** | a member the contract requires and the source no longer declares; a member whose type changed; an optional member the source now requires |
| **compatible** | a member the source adds; a required member the source made optional |
| **not compared** | a member the contract states no type for; a member the source marks private |

## Why it exists

A component's own build is perfectly happy when you delete a prop. Nothing in the component's
type check knows that forty call sites pass it. The break surfaces in whichever application
upgrades first, usually as a wall of errors in code nobody on the component team wrote.

The quieter version is worse: an optional prop becomes required, or a union member gets renamed.
Both compile inside the library, both break callers, and neither shows up in a diff review that
is looking at behaviour rather than at signatures.

A contract file makes the surface explicit, and this compares it to what the source actually
declares.

## What it does not do

**It runs no compiler.** Zero dependencies means no TypeScript is available, so this is not type
checking and never claims to be. Type comparison is text comparison after normalisation:
`string[]` and `Array<string>` are different text and are reported as a change. The README says
so because a tool that implied otherwise would be worse than one that says what it is.

**It guesses at nothing it cannot read.** One shape of declaration is recognised; everything else
is refused **by name**, the run is `incomplete`, and the component involved is not compared at
all. The recognised subset and every refused construct are listed in
[`docs/prop-rules.md`](./docs/prop-rules.md).

**It writes nothing.** There is no `--out`, it creates no directory and it modifies no file, so
no output-destination guard applies and none is claimed.

**It opens no socket and resolves no host.**

**It reads no clock.** The report carries no timestamp, so there is nothing to inject and nothing
to drift. Two runs over the same files are byte-identical.

## Quick start

```sh
node bin/component-prop-contract.mjs --root examples/honoured
# exit 0 -- the surface matches the contract; two private members excluded

node bin/component-prop-contract.mjs --root examples/broken
# exit 1 -- a renamed union member, an optional prop made required,
#           a prop dropped, and one compatible addition

node bin/component-prop-contract.mjs --root examples/unsupported
# exit 2 -- an "extends" clause, so the surface was never established
#           and NOTHING is reported as missing from it
```

The break, as it reaches stdout:

```json
{
  "ruleId": "prop-missing",
  "severity": "error",
  "message": "The contract requires \"Chip\" to accept the prop \"tone\", and \"ChipProps\" in src/Chip.tsx does not declare it. Every caller passing it breaks, and the component's own build does not notice.",
  "location": { "file": "src/Chip.tsx", "pointer": "/components/1/argTypes/tone" },
  "evidence": "public members of ChipProps: label, onDismiss",
  "suggestion": "Restore the prop, or raise the contract's major version and remove it there too."
}
```

## The contract

```json
{
  "schemaVersion": "1",
  "version": "2.3.0",
  "components": [
    {
      "id": "Button",
      "source": "src/Button.tsx",
      "propsType": "ButtonProps",
      "props": [
        { "name": "label", "type": "string", "required": true },
        { "name": "icon", "required": false }
      ],
      "events": [
        { "name": "onClick", "type": "(event: MouseEvent) => void", "required": false }
      ]
    },
    {
      "id": "Chip",
      "source": "src/Chip.tsx",
      "propsType": "ChipProps",
      "argTypes": {
        "label": { "type": { "name": "string", "required": true } },
        "tone": { "type": { "name": "enum", "value": ["neutral", "danger"] } }
      }
    }
  ]
}
```

Two spellings, one internal form. `props`/`events` carries type text; `argTypes` is the shape a
story-metadata export produces and carries a kind instead. The comparison is narrowed to match
what each spelling actually says rather than widened to pretend — the details are in the rule
document.

A member is an **event** when its name is `on` followed by an upper-case letter, and a prop
otherwise. One rule, applied to the contract and the source alike, so a contract that files
`onClick` under `props` is told rather than silently reclassified.

`required` is mandatory in the direct spelling. Whether a caller must pass a member is exactly
what this tool compares, so an absent flag is not "optional". In `argTypes` it defaults to
`false`, which is what a story export means by omitting it.

Omitting `type` is a real answer: the contract places no requirement on the type, nothing is
compared, and `prop-type-unconstrained` says so at `info` — so the gap is visible rather than
silent.

## Private implementation details

Three ways to say a member is not public, and all three are honoured:

- a `@internal` tag in the member's own doc comment
- a `@private` tag
- a leading underscore in the name

An excluded member is never reported as an addition, and never compared in either direction. The
exclusion is reported at `info` rather than performed in silence, because a silent exclusion and
a missed member look identical in a report.

A props type that is **declared but not exported** is not a public surface at all: callers cannot
import it. That is reported as `props-type-not-exported` and the component is not compared.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | everything was read and no error-severity rule fired |
| `1` | everything was read and at least one error-severity rule fired |
| `2` | invalid configuration, or evidence that could not be obtained |

Exit 2 has two shapes, and a consumer piping stdout must handle both:

| Situation | stdout | status |
| --- | --- | --- |
| Invalid configuration, unknown option, bad usage | **empty** | no report — the run never had a subject |
| A file that could not be read, decoded or fully recognised | a report | `incomplete` |

## Guarantees

Each is pinned by a test that fails when the behaviour is removed — not by a test that reads a
declaration.

- **Removing a required member fails.** `prop-missing` and `event-missing` are `error`, and the
  exit code is asserted through the real CLI.
- **Unknown is never a pass.** A source that could not be read, decoded or fully recognised
  makes the run `incomplete`, and the component is **not compared**: no member of it is reported
  as missing, added, retyped or matched.
- **No vacuous pass.** A contract with no components, a component with no declared members, and
  a props type with no public members each fail rather than reporting green on no evidence.
- **Private members are excluded in both directions** — never reported as additions, never
  compared — and the exclusion is visible in the report.
- **Ordering is by UTF-16 code unit.** Never `localeCompare` or `Intl.Collator`, whose ICU data
  differs between Node builds. Pinned with inputs whose order genuinely differs between the two
  (`Z.tsx` before `a.tsx`; `onBlur` before `onblur`; `aria-label` before `ariaLabel`).
- **Every untrusted string is sanitised** — component ids, member names, type text, file names,
  pointer segments and excerpts alike. C0, DEL, C1, U+2028/U+2029 and the bidi controls are all
  removed, and a name that would render as nothing is refused rather than rendered blank —
  **on both sides of the comparison.** One predicate decides what a name is, for the contract and
  for a name read out of a TypeScript source, because a name only one side accepts is a member
  that can never be matched. A source member this tool cannot name makes the run `incomplete`.
- **A value that cannot be stringified does not cost the report.** `{"toString": {}}` in any
  field, including one read before any schema check, still produces a report on stdout.
- **A parse failure never reproduces the document.** The helper recognises V8's quoting shape
  *before* looking for an offset, and ends with a backstop refusing any message still carrying a
  double quote.
- **Path confinement is resolved, not lexical**, for the contract and for every source path the
  contract names — and source paths are untrusted input. A root reached *through* a link still
  works, because a false refusal is a defect too.
- **Determinism.** Two runs over the same files produce byte-identical stdout, and the report
  carries no timestamp.

## Limits

| Limit | Default | Reaching it |
| --- | ---: | --- |
| `--max-contract-bytes` | 1048576 | `incomplete` |
| `--max-source-bytes` | 524288 | `incomplete` |
| `--max-components` | 500 | `incomplete` |
| `--max-members` | 200 | `incomplete` |
| `--max-type-chars` | 400 | `incomplete` |
| `--max-type-depth` | 12 | `incomplete` |
| `--max-findings` | 1000 | `incomplete`, report partial |
| `--max-runtime-ms` | 20000 | `incomplete` |

Every limit is enforced and tested. An unknown limit key throws rather than being ignored, and a
flag that carries a value may be given once: a repeated flag is a configuration error, not a
silent last-wins.

## Non-goals

- **It is not a type checker.** It compares text, after normalisation. Two types that are
  structurally identical but spelled differently are reported as a change.
- **It does not resolve imports.** A type imported from another module is text in the comparison,
  not a thing that gets looked up — and a props type that `extends` an imported one is refused
  rather than half-read.
- **It does not read `.d.ts` output, JSDoc `@param` tags, PropTypes, or a framework's runtime
  prop declarations.** One source of truth, named in the contract.
- **It does not infer the contract from the source.** The contract is written by a person and is
  the thing being checked against; generating it from the code it governs would check nothing.
- **It does not know what a component renders**, only what its props type declares.
- **It does not write, move or delete files**, and it has no auto-fix.
- **It does not enforce a versioning policy.** It classifies changes and records the contract
  version in the report; deciding what that means for a release is a separate judgement.

## Verification

```sh
npm run check        # lint + test + all three examples + npm pack --dry-run
```

## License

MIT. See [LICENSE](./LICENSE).
