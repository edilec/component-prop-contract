# Changelog

All notable changes to this project are recorded here. Rule ids are part of the public
interface: renaming one is a breaking change and gets its own entry.

## Unreleased

### Fixed

- A source member name the contract side could never declare is refused instead of admitted to
  the public surface. A member named with control, separator or bidi characters was reported as
  an addition with an empty quoted name at exit 0, while the contract refused the identical
  string — so the member could never be declared and never be satisfied. `isUsableName` is now
  one predicate, asked on both sides of the comparison, and a source member it refuses is
  `source-unsupported-syntax`: `incomplete`, exit 2, component not compared.
- An `argTypes` `type.name` is a closed vocabulary. A one-character typo in `string` used to
  place no requirement at all and take the run green, while the identical typo in the KEY of the
  same object was refused at exit 1. The names that carry no comparable requirement — `array`,
  `intersection`, `object`, `other`, `union` — are in the vocabulary, so a real story export is
  still accepted.
- An `argTypes` `enum` whose `value` list is absent, empty, or carries something that is not
  usable text is `member-invalid`. A non-string used to degrade the whole requirement to none;
  a value made only of stripped characters was compared and rendered as a blank quoted literal.
- `argTypes.<key>.description` and `argTypes.<key>.name` are validated like every other optional
  field. They were the only two that were not.
- A value that renders as nothing is described by its shape rather than printed as an empty pair
  of quotes. The `schemaVersion` diagnostic said `declares ""`.
- The human summary on stderr separates `location.file` from `location.pointer`. Concatenated,
  they read as a filesystem path and are not one: the file is the TypeScript source, the pointer
  is a JSON Pointer into the contract. That convention was true from the first release and
  documented nowhere; the README and the rule document now state it and a test resolves every
  emitted pointer against the contract.

- Ordering is pinned where it decides a VERDICT, not only a report's shape. A union is compared as
  a set -- both sides sorted, then compared element by element -- so the comparator inside
  `matchesType` decides whether a type matches. Substituting `Intl.Collator` at either sort site
  turned a contract stating `'Z' | 'a'` against a source declaring the same two values from exit 0
  into `prop-type-changed` at exit 1, with the whole suite green. Three cases hold it now,
  including the pair a collator calls EQUAL rather than merely orders differently.
- The `location.pointer` sort key is pinned against a collator as well as against deletion. Every
  fixture had used pointers the two orders agree about; an `argTypes` key of `Z` against `a` is
  the pair collation reverses.
- Every refusal in the contract reader has a case of its own, asserting the consequence. Seven
  guards could be removed with the suite green while the CLI reported something else: an
  `argTypes` key that renders as nothing reached the compared surface and was reported as an
  addition -- the README's "refused rather than rendered blank" guarantee failing on the one side
  of the document nothing was watching -- and an unusable `propsType` was reported as a type the
  source does not export.
- The evidence on a type change names what the contract required. The `callable` and `union`
  branches of `describeMatcher` could each be deleted with the suite green, leaving `contract: `
  with nothing after it.
- The library entry point's refusals each have a case: options that are not an object, an unknown
  option, limits that are not an object, a `monotonic` that is not callable, an absent root, and a
  `contract` name that is unusable, carries a control character, is absolute, or steps outside the
  root.
- A source path that resolves outside the root through a link is refused as an escape even when no
  file is there. Removing the branch that resolves the parent left the suite green while the
  report called it `source-unreadable` -- a fact about a file -- instead of
  `source-path-escapes-root`, a fact about where the contract pointed.
- The masker's own guards have cases of their own. Four could be removed with the suite green,
  because every fixture that reached them was decided by a guard further up. The escape pair
  matters most: without it an ordinary literal type containing an escaped quote -- `'it\'s'` --
  is refused as an unterminated string, so a source this tool should read becomes `incomplete`
  and exit 2.
- The `incomplete` flag on an unreadable **contract** is pinned. The contract and the sources have
  separate reads, separate catches and separate flags, and only the source one had a test: with
  that one `incomplete = true` deleted, a contract this tool never opened was reported as `fail`
  at exit 1 -- a verdict about a document it had not read -- with the whole suite green. A
  contract the process may not read now has its own case.

### Notes on this round

The 0.1.0 test-suite commit said that every guarantee had been broken, the test watched to fail,
and the code restored. An independent mutation sweep falsified that for six guarantees in this
tool: `unreadable-member-name`, `member-without-type` for an empty annotation, the doc-comment
attachment boundary, the `message` sort key, the no-whitespace half of `isUsableName`, and RFC
6901 pointer escaping could each be deleted with the whole suite green. All six now have a test
that fails when the behaviour is removed. That claim is recorded here rather than left in a
commit message nobody re-reads.

Six was an undercount, and the correction belongs here too. A second sweep, enumerated
independently from the source rather than from a list -- every severity flipped, every
`incomplete = true` deleted, every `if` condition in `src/` and `bin/` forced to `false`, every
ordering site given a collator -- ran 285 mutations and found **50** that left the suite green.
Most are now pinned by the entries above. The ones that remain are recorded as what they are:
`if (left === right)` inside the comparator and `if (expired)` inside the budget memo are
equivalent mutants -- the first orders identical strings, whose relative order nothing can
observe; the second guards a branch with one call site that breaks on the value it returns.

## 0.1.0

First release.

### Added

- `component-prop-contract` CLI and the `checkPropContract` library entry point, comparing a
  versioned contract against the TypeScript sources it names.
- Classification of every difference: a required member the source dropped, a type that
  changed, an optional member the source now requires, a compatible addition, a compatible
  relaxation, and a member the contract places no type requirement on.
- Two contract spellings for one surface: `props`/`events` with type text, and `argTypes` in
  the shape a story-metadata export produces. The `argTypes` comparison is narrowed to the
  information that spelling actually carries.
- Exclusion of private implementation details -- `@internal`, `@private`, a leading
  underscore, and a props type that is declared but not exported -- reported at `info` rather
  than performed in silence.
- A deliberately narrow TypeScript recogniser that refuses everything outside its documented
  subset BY NAME, marks the run incomplete, and does not compare the component at all.
- Enforced limits: `--max-contract-bytes`, `--max-source-bytes`, `--max-components`,
  `--max-members`, `--max-type-chars`, `--max-type-depth`, `--max-findings`,
  `--max-runtime-ms`.
- Three examples -- a contract that is honoured, one that is broken, and one whose source uses
  syntax outside the subset -- all run by `npm run check`.

### Notes on the shape of the checks

- Source paths come out of the contract, which is untrusted input. Each is checked lexically
  before anything is resolved, and its real path is asserted to be inside the real root.
- There is no clock. The report carries no timestamp, so there is nothing to inject and
  nothing to drift.
