# `@hexafield/hexevent` — Design Plan

_A standalone TypeScript package for describing events through the 12-cell 5W1H × subjective/objective ontology — twelve AD4M Subject classes (one per cell) plus a `HexEvent` class that composes all twelve into the description of a single event. AD4M is the only external reference point. This spec covers the first part of the package — the cell vocabulary and the event composer. Further parts will be added in follow-up specs._

## Metaphysical Basis

The 12 cells are not a convenience taxonomy; they're forced by the underlying immanent metaphysics:

- **Six columns** — the Six Intrinsics theorem holds that every interaction has exactly six irreducible aspects: space (where), inertia/pattern (what), time (when), force (how), possibility (why), probability (who). Drop one and you've stopped describing an event.
- **Two rows** — per Objective-and-Subjective and the Root Tautology, every interaction has both an objective face (high symmetry across perception, low continuity across expression) and a subjective face (low symmetry, high continuity). The two are conjugate, distinct, and inseparable.
- **Why exactly twelve** — the Incommensuration Theorem rules out collapsing the two rows: symmetry+continuity and asymmetry+discontinuity are mutually inadmissible, so neither objective nor subjective can be reduced to the other.
- **What each cell carries** — per Inclusion-Proximity-Similarity, every filler is a comparison of one of three pure relation types within its column's metric.

The takeaway for this package: a consumer who populates only some cells isn't using a partial ontology — they're describing an event with partial information, and the empty cells are a precise statement of what they haven't observed.

## Goal

A small, focused package that anyone can pull in to:

- Describe a single event in totality through its 12 cells (Who / What / When / Where / Why / How × Subjective / Objective).
- Query cell-specific assignments through AD4M `instanceQuery` with no client-side filtering — class identity _is_ the cell.
- Provide stable IRIs for the 12 cells, usable as Subject class flags or as plain predicates in non-AD4M consumers.
- Express the event itself as a `HexEvent` Subject class that gathers all 12 cells together — the AD4M record that _is_ the described event.

## Non-Goals (for this part)

- A semantic-frame parser. No FrameNet, no Stanza, no transformer wrappers.
- An NLP toolkit.
- Reasoning-graph subject classes (`Claim`, `Evidence`, `Connection`, `Derivation`). They live in domain consumers, not here.
- LLM extraction prompts.
- Any UI.
- Domain-specific cell semantics. Cell labels stay generic; domain projects layer their own labels on top.
- Dependencies on anything other than `@coasys/ad4m`. No semiotics package, no third-party graph or RDF libraries.

---

## Design — one Subject class per cell

Prior in-house designs of this vocabulary exposed it as a sprawl of loose exports: enums, arrays, label maps, IRI builders, parsers. For hexevent we collapse all of that into 12 AD4M Subject classes — one per cell — plus their static metadata. The class identity _is_ the cell, so `subjectFlag` carries the cell's IRI and AD4M's `instanceQuery` does cell-specific lookups natively.

### The 12 Subject classes

One concrete class per cell, named `<Interrogative><Axis>Assignment`:

```
WhoSubjectiveAssignment      WhoObjectiveAssignment
WhatSubjectiveAssignment     WhatObjectiveAssignment
WhenSubjectiveAssignment     WhenObjectiveAssignment
WhereSubjectiveAssignment    WhereObjectiveAssignment
WhySubjectiveAssignment      WhyObjectiveAssignment
HowSubjectiveAssignment      HowObjectiveAssignment
```

Each class has the same shape:

- `@Property filler: string` — the value being asserted for this cell.
- `@Property conceptIri?: string` — optional IRI of a typed concept the filler resolves to.
- `@Property source?: string` — optional provenance hint (free-form string; richer provenance lives in consumer-defined subjects).
- `subjectFlag` (AD4M-level) — the cell's canonical IRI under `CELL_NS`.
- `static readonly interrogative: Interrogative` — e.g. `'who'`.
- `static readonly axis: Axis` — e.g. `'objective'`.
- `static readonly label: string` — human-readable English label.
- `static readonly iri: string` — same as `subjectFlag`, exposed for consumers that aren't going through AD4M reflection.
- `static readonly cellId: CellId` — e.g. `'who·objective'`.

Implementation pattern: a single shared internal factory builds the 12 classes from the 12 metadata rows, so the per-cell code stays identical and any future change to the shape lands once.

### The `HexEvent` class — the event composer

A single Subject class whose record gathers the 12 cells into one described event.

- `subjectFlag` → `${VOCAB_NS}HexEvent`.
- Twelve `@HasMany` relationships, one per cell — each typed to the corresponding assignment class, named after the cell in camelCase:

  ```
  @HasMany whoSubjective:    WhoSubjectiveAssignment[]
  @HasMany whoObjective:     WhoObjectiveAssignment[]
  @HasMany whatSubjective:   WhatSubjectiveAssignment[]
  @HasMany whatObjective:    WhatObjectiveAssignment[]
  @HasMany whenSubjective:   WhenSubjectiveAssignment[]
  @HasMany whenObjective:    WhenObjectiveAssignment[]
  @HasMany whereSubjective:  WhereSubjectiveAssignment[]
  @HasMany whereObjective:   WhereObjectiveAssignment[]
  @HasMany whySubjective:    WhySubjectiveAssignment[]
  @HasMany whyObjective:     WhyObjectiveAssignment[]
  @HasMany howSubjective:    HowSubjectiveAssignment[]
  @HasMany howObjective:     HowObjectiveAssignment[]
  ```

- Each `@HasMany` predicate is the corresponding cell's IRI (i.e. the same IRI used as `subjectFlag` on the assignment class). Same IRI, two roles: as object of a type triple it classifies the assignment, as predicate of a HexEvent triple it links the event to that assignment. Standard RDF; halves the vocabulary surface.
- No other required properties. Per the metaphysics, the event _is_ its 12 cells; adding parallel scalar fields would duplicate what the cells already carry. Consumers who need additional scaffolding (e.g. an event-level timestamp distinct from `whenObjective`) layer their own subclass or sibling subject.
- Static `HexEvent.CELL_SLOTS` — ordered tuple of the 12 property names, matching `ALL_CELL_CLASSES` order. Lets generic processors walk the event without hard-coding 12 reads.

The class is intentionally minimal: it provides the structural composition required by the metaphysics and nothing more. Missing cells are an explicit, queryable statement of unobserved aspects.

### Aggregate exports

For generic iteration, the package also exports:

- `ALL_CELL_CLASSES` — readonly tuple of the 12 cell classes in deterministic order (interrogatives × axes).
- `CELL_CLASS_BY_ID` — `Record<CellId, CellClass>` for `O(1)` lookup from a cell id string to its class.
- `CELL_CLASS_BY_IRI` — `Record<string, CellClass>` for `O(1)` lookup from an IRI back to its class.

These let consumers iterate the taxonomy without hard-coding 12 imports.

### IRI constants

In addition to `<Class>.iri`, the 12 IRIs are also exported as plain string constants for consumers who want the IRI without touching the class:

```
CELL_IRI_WHO_SUBJECTIVE       CELL_IRI_WHO_OBJECTIVE
CELL_IRI_WHAT_SUBJECTIVE      CELL_IRI_WHAT_OBJECTIVE
CELL_IRI_WHEN_SUBJECTIVE      CELL_IRI_WHEN_OBJECTIVE
CELL_IRI_WHERE_SUBJECTIVE     CELL_IRI_WHERE_OBJECTIVE
CELL_IRI_WHY_SUBJECTIVE       CELL_IRI_WHY_OBJECTIVE
CELL_IRI_HOW_SUBJECTIVE       CELL_IRI_HOW_OBJECTIVE
```

Each equals the corresponding `<Class>.iri` / `subjectFlag`.

### Top-level exports that stay

These don't fold into a class:

- Namespace constants: `VOCAB_NS`, `CELL_NS`, `OA_NS`.
- Type aliases: `Interrogative`, `Axis`, `CellId` (template literal `${Interrogative}·${Axis}`).
- `parseCellId(id)` helper — pure string operation, useful when an id arrives from outside the type system (e.g. parsed from JSON).

### What's removed compared to prior in-house surfaces

All of these are gone — absorbed into class statics, the `ALL_CELL_CLASSES` tuple, or simply unnecessary in a class-based API:

- `INTERROGATIVES` / `AXES` arrays
- `CELLS` array
- `cellId(interrogative, axis)` constructor
- `CELL_LABELS` map
- `cellLabel(id)` helper
- `cellIri(id)` builder
- `CellAssignment` interface and `CellMap` type
- `emptyCellMap()` / `addToCellMap()` helpers
- FrameNet FE → cell mapping (entire group)
- `LG_NS` / `lgIri` (linguistic, out of scope)

---

## Package Shape

|  |  |
| --- | --- |
| **Name** | `@hexafield/hexevent` |
| **Repo** | https://github.com/HexaField/hexevent (new public repo) |
| **License** | MIT — pure schema, no user-data or service surface |
| **Runtime deps** | `@coasys/ad4m` (peer dep) — used directly for the Subject class decorators |
| **Dev deps** | `typescript`, `vitest`, `@coasys/ad4m` |
| **Engine** | Node ≥ 20, pure ES2022 |
| **Module style** | ESM, single entry point `./dist/index.js` |
| **Bundle size budget** | < 15 kB gzipped |
| **Public exports** | `HexEvent`, 12 cell classes, `ALL_CELL_CLASSES`, `CELL_CLASS_BY_ID`, `CELL_CLASS_BY_IRI`, 12 `CELL_IRI_*` strings, `HEXEVENT_IRI`, `VOCAB_NS`, `CELL_NS`, `OA_NS`, `Interrogative`, `Axis`, `CellId`, `parseCellId` |

### Why MIT

`hexevent` is a vocabulary. No User Data, no Cryptographic Keys, no service surface — the CAL's reason for existing doesn't apply. MIT keeps it easy for any project to adopt the vocabulary.

### Why depend on `@coasys/ad4m`

The 12 Subject classes use AD4M's `@Model` / `@Property` decorators and rely on `subjectFlag` for class-as-cell-IRI dispatch. `@coasys/ad4m` is a real (peer) dependency in this part. Anyone using hexevent is already in the AD4M ecosystem; the peer-dep model means hexevent shares the consumer's single AD4M version rather than carrying its own.

---

## Repo Layout

Mirror of `@hexafield/ad4m-rag` for consistency:

```
hexevent/
  src/
    index.ts            # all exports
    index.test.ts       # tests
  dist/                 # built artefacts (gitignored, published)
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
  LICENSE               # MIT
  PLAN.md               # this file, moved into the repo
```

---

## Requirements

The whole part ships in one cohesive commit — no phased rollout within this spec.

### R1. New repo

- `HexaField/hexevent` on GitHub, public, MIT-licensed.
- Single-package TypeScript layout (see Repo Layout).
- Initial commit: scaffold + code + tests, all in one go.

### R2. 12 cell Subject classes

- One concrete class per cell, named per the Design section.
- Each carries `@Property filler`, `conceptIri?`, `source?`.
- Each carries `subjectFlag` set to the cell's IRI under `CELL_NS`.
- Each exposes static `interrogative`, `axis`, `label`, `iri`, `cellId`.
- Generated by a shared internal factory from the 12 metadata rows.

### R3. `HexEvent` Subject class

- One concrete class `HexEvent`, `subjectFlag` set to `HEXEVENT_IRI` (`${VOCAB_NS}HexEvent`).
- Twelve `@HasMany` properties, named per the Design section, each typed to the corresponding assignment class.
- Each `@HasMany` predicate equals the corresponding cell's IRI (shared with the assignment class's `subjectFlag`).
- Static `HexEvent.CELL_SLOTS` — readonly tuple of the 12 property names in the same order as `ALL_CELL_CLASSES`.
- No additional `@Property` fields.

### R4. Aggregate exports

- `ALL_CELL_CLASSES` readonly tuple, deterministic order.
- `CELL_CLASS_BY_ID` and `CELL_CLASS_BY_IRI` lookup records.

### R5. IRI string exports

- 12 `CELL_IRI_*` string constants, each equal to its class's `iri`.
- `HEXEVENT_IRI` string constant equal to `HexEvent`'s `subjectFlag`.

### R6. Top-level helpers

- Namespace constants `VOCAB_NS`, `CELL_NS`, `OA_NS`.
- Type aliases `Interrogative`, `Axis`, `CellId`.
- `parseCellId(id)` helper.
- No other exports.

### R7. Dependency discipline

- `dependencies` block in `package.json` is empty.
- `peerDependencies` contains `@coasys/ad4m`.
- `devDependencies` contains `typescript`, `vitest`, `@coasys/ad4m`.
- The package imports from `@coasys/ad4m` only.

### R8. TypeScript-first published artefacts

- `npm publish` ships `dist/` (compiled JS + `.d.ts`), `src/`, README, PLAN, LICENSE.
- `tsconfig.json` emits declarations + sourcemaps. ES2022 target, Bundler resolution. Decorator emit enabled to match `@coasys/ad4m`'s requirements.

### R9. Namespace URLs

- `VOCAB_NS` → `https://hexafield.github.io/hexevent/vocab#`
- `CELL_NS` → `https://hexafield.github.io/hexevent/cells#`
- `OA_NS` → `http://www.w3.org/ns/oa#` (unchanged W3C)

### R10. Tests

- All 12 cell classes exist, are concrete, and carry the expected static metadata (`interrogative`, `axis`, `label`, `iri`, `cellId`).
- `subjectFlag` on each cell class equals the corresponding `CELL_IRI_*` string constant.
- `ALL_CELL_CLASSES` contains all 12 in deterministic order with no duplicates.
- `CELL_CLASS_BY_ID` and `CELL_CLASS_BY_IRI` round-trip every class through its id and IRI.
- `parseCellId` round-trips every `CellId`; rejects malformed inputs.
- An end-to-end Subject-class round-trip mirroring the pattern `@hexafield/ad4m-rag` uses: construct an instance of one cell class, serialise its `@Property` decorators, re-hydrate, confirm equality.
- `HexEvent.subjectFlag` equals `HEXEVENT_IRI`.
- `HexEvent.CELL_SLOTS` matches `ALL_CELL_CLASSES` in order and length.
- Each of the 12 `@HasMany` predicates on `HexEvent` equals the corresponding cell IRI.
- End-to-end `HexEvent` round-trip: construct a `HexEvent` with assignments populated in at least three different cells, serialise via decorators, re-hydrate, and confirm each cell slot contains the expected assignment instances.

### R11. README

- Short — what the 12-cell schema is, why it's useful, install, a brief excerpt of the metaphysical basis, and a worked example showing import of e.g. `WhoObjectiveAssignment`, constructing one, composing a `HexEvent` from a handful of assignments, and looking up a class via `CELL_CLASS_BY_ID`.

### R12. PLAN.md

- This file moves into the new repo as `PLAN.md` once the repo exists.

### R13. Verification before publish

- `npm pack` produces a tarball.
- Verify the tarball's `package.json` has empty `dependencies` and `@coasys/ad4m` in `peerDependencies`.
- `npm install --omit=dev` of the tarball installs nothing transitively.

---

## Future Parts (named for context, specced separately)

The name `hexevent` is broader than the cell vocabulary alone. Later parts of the package will build on the cell schema; each gets its own PLAN section once the design is settled. None of them are in scope here, and none of them change what ships in this first part.

---

## Out of Scope

- A general semantic-web ontology library.
- A semantic-frame parser.
- Integration code with any particular RAG, reasoning system, or graph database. Consumers compose `hexevent` into their own stack.
- Domain-specific claim / evidence / connection subject classes — they belong with their consumers, not here.
- Internationalised cell labels.
- A formal versioning policy — set when the package stabilises.
- Anything that would require a dependency other than `@coasys/ad4m`.
