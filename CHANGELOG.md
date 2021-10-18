# Changelog

All notable changes to this project are recorded here. Rule ids are part of the public
interface: renaming one is a breaking change and gets its own entry.

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
