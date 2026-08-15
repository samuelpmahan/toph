# Toph — implementation decisions (Phase 0)

This note records the decisions made before writing any compiler/runtime code,
per the orchestration brief's Phase 0 ("repository reality check"). It exists
so later phases don't silently re-litigate settled questions.

## 1. DESIGN.md vs. the orchestration brief: API shape conflict, resolved

`DESIGN.md` (branch `claude/toph-architecture-design-f0h9nb`, commit `7a4143b`)
traced the real ChainSpot tee path and reached a specific, well-argued
conclusion in Part 2 Q3/Q9: an explicit `Trace` interface threaded like the
existing `cv` handle (`t.range(e, 'area', ...)`), compiled out via a `NOOP`
singleton object whose methods are bare comparisons, relying on JIT inlining.
It explicitly considered and **rejected** source transforms: *"Source
transforms / babel strip plugins — magical, breaks sourcemaps and editor
navigation, another build dependency. Rejected."*

The orchestration brief for this task overrides exactly that decision, under
a section literally titled "Important API correction": humans author plain
TypeScript plus `@toph filter` / `@toph check` JSDoc directives; a compiler
generates trace instrumentation and erases to zero-residue production code.
This is treated as the user's deliberate, informed course-correction on top
of DESIGN.md — not an oversight to reconcile by picking DESIGN.md's answer.
Concretely:

- **Superseded**: DESIGN.md Q3 ("what should the API look like") and Q9
  ("how should tracing compile out") — the `Trace`-handle-threading /
  `NOOP`-singleton mechanism is replaced by compiler directives + real
  source-to-source erasure.
- **Still authoritative**: everything else — the entity/event data model
  (Q1–Q2, Q10), the raster/entity bridge via label maps (Q6), the rejection
  of collection-wrapper and generic-spying approaches (Q5, Q7), the adapter
  boundary (Q8), and the scope exclusions (Q11). The runtime schema in
  Phase 2 is DESIGN.md's schema, subsetted to what the Phase 1 fixture
  actually emits — not redesigned from scratch.
- The brief's own zero-cost bar is stricter than DESIGN.md's: *"Do not
  describe a no-op facade as 'compiled out.'"* is a direct, correct critique
  of the NOOP-singleton mechanism (a NOOP call is still a real call at every
  site; its elimination depends on JIT inlining, which is not a guarantee).
  Compiler erasure is held to a higher bar: production code must not
  *contain* Toph machinery, not merely execute cheap Toph machinery.

## 2. Compiler technology: raw TypeScript Compiler API, no new runtime dependency

Options considered:

- **Raw `typescript` package (compiler API)** — chosen. ChainSpot already
  depends on `typescript@6.0.3` (`moduleResolution: "bundler"`,
  `sourceMap: true`). Toph's compiler declares `typescript` as a
  `peerDependency` (consumer supplies its own installed version) plus a
  matching `devDependency` for its own tests. No new package is introduced
  into the dependency graph of any consumer.
- **ts-morph** — rejected for the spike. Nicer traversal ergonomics, but it
  is a wrapper *around* the compiler API that pulls in its own version
  pinning and abstraction layer. The compiler's job here is deliberately
  narrow (two directive kinds, a handful of AST shapes) — raw
  `ts.visitEachChild`/`ts.factory` is not meaningfully more code than
  ts-morph would be, and it avoids a dependency whose abstractions we'd
  otherwise have to route around.
- **Babel + plugin** — rejected, for the same reason DESIGN.md rejected it:
  a second parser disagreeing with the TypeScript type-checker/IDE tooling
  about syntax, plus it cannot see TS-only constructs without
  `@babel/preset-typescript` maintaining its own approximation of TS syntax.
  Not justified when `typescript` is already the shared parser across every
  consumer.

Directive comments are read via `ts.getLeadingCommentRanges` against the raw
source text at each candidate node's leading trivia, then matched against
`/^\s*@toph\s+(filter|check)\b(.*)$/m` — not via `ts.getJSDocTags`, because
`@toph` is not a tag TypeScript's own JSDoc parser recognizes or associates
with arbitrary statements (JSDoc tag binding in the compiler API is aimed at
type annotations on declarations, not statement-level pragmas). Plain
comment-range text matching is simpler, more predictable, and keeps the
directive grammar entirely Toph's to define.

## 3. Package layout

Single package (`toph`, `type: module`), two subpath exports rather than a
multi-package workspace — there is one consumer and the compiler/runtime
split is an internal-module boundary, not a versioning boundary yet
(DESIGN.md Q11: "nothing is versioned except the trace format itself"):

```
toph/
  src/
    compiler/   # Subagent A. Node-only. Never imported by generated trace/production code's *runtime* — it produces code, it doesn't run alongside it.
    runtime/    # Subagent B. Imported only by trace-mode generated code and the recording harness.
  test/
    compiler/
    runtime/
```

`exports`: `"."` → `src/runtime/index.ts`, `"./compiler"` → `src/compiler/index.ts`.
Test runner: `vitest`, matching ChainSpot's own stack.

## 4. Directive grammar and supported AST shapes (Phase 1 vocabulary only)

Exactly two directives, as specified: `@toph filter <stage-name>` and
`@toph check <code> [unit=<unit>]`. No inference beyond these two fixed
shapes; anything else is a compiler error, not a best-effort guess.

**`@toph filter <name>`** must be the leading comment of a statement matching
exactly:

```ts
const <ident> = <expr>.filter((<param>) => { <body> });
```

`<body>` must be a sequence of zero or more *check groups* followed by a
single final `return true;` statement. A check group is exactly:

```ts
const <boolIdent> = <expr> <op> <expr>;   // op ∈ >= <= > < === !==
if (!<boolIdent>) return false;
```

(the `if` may or may not use braces). This is the same shape the brief's own
examples use. Anything else attached to `@toph filter` — a non-block arrow
body, a non-`.filter` callee, extra parameters, a body that doesn't end in
`return true;` — is `TOPH101`.

**`@toph check <code>`** must be the leading comment of a `const` declaration
whose initializer is a supported binary comparison, and the *very next*
statement in the same block must be the `if (!<boolIdent>) return false;`
guard referencing that same identifier. Any other shape at the annotated
site — a call expression, a logical/ternary expression, a comparison against
a non-comparison operator, a missing/mismatched guard — is `TOPH102`
(matching the brief's own example diagnostic text verbatim).

Additional narrow diagnostics: `TOPH103` (check not immediately followed by
its guard), `TOPH104` (duplicate check code within one filter stage — every
check needs a unique code so manifest/query lookups aren't ambiguous),
`TOPH105` (directive text doesn't parse as `@toph <verb> <args>` at all).

This is intentionally not extensible-by-guessing: a predicate shaped
slightly differently (e.g. `if (!a || !b) return false;` combining two
checks in one guard) is a compiler error telling the author to split it, not
a shape the compiler tries to handle cleverly.

## 5. Entity identity scope for Phase 1–3: deferred, not designed away

The Phase 1 fixture only needs to answer "which checks ran, in what order,
with what values, and did this element survive" *within one filter
invocation*. It does not need cross-statement entity identity (DESIGN.md's
`WeakMap`/`spawn`/`keep` lineage) because there is exactly one derivation
site and no downstream stage consuming the survivors in the fixture. So:

- Phase 1–3 runtime identifies each filter-callback invocation by an
  **ordinal index within its stage invocation** (first element evaluated,
  second, …) — not a stable cross-call entity ID.
- Real entity identity (stable IDs surviving into a component → candidate →
  `RawMaskTee` derivation chain) is introduced in Phase 5, when the raster/
  component bridge and multi-stage ChainSpot pipeline actually require it.
  This is consistent with the brief's own sequencing ("Add directives or
  explicit generated hooks only as needed") and avoids building identity
  machinery the first two phases can't exercise or falsify.

## 6. Generated code shape (trace mode)

```ts
import * as __toph from "toph";

const __toph_s17 = __toph.enterStage(17);
const survivors = components.filter((component) => {
  const __toph_e = __toph.enterElement(__toph_s17);
  const areaOk = __toph.gte(__toph_e, 31, component.area, minArea);
  if (!areaOk) return false;
  const aspectOk = __toph.lte(__toph_e, 32, component.aspect, maxAspect);
  if (!aspectOk) return false;
  __toph.keep(__toph_e);
  return true;
});
```

Notes:

- Stage IDs (17) and check IDs (31, 32) are compiler-allocated integers
  baked into the call sites; no strings survive into generated code except
  as manifest content.
- Rejection is *not* a separate call — a `check` event with `pass: false` at
  a given element already implies "rejected at this check," per DESIGN.md
  §10's "deliberately absent, viewer-computed" principle. Only the survivor
  path (`keep`) is explicit, because the compiler cannot infer "the callback
  returned true" without adding a call at that exact point anyway, and an
  explicit marker is unambiguous where inference would require re-deriving
  "did every check run and pass."
- `component.area`, `minArea`, etc. are passed as already-evaluated
  arguments — each original sub-expression is evaluated exactly once, at its
  original position, by ordinary JS evaluation order. The check functions
  (`gte`/`lte`/`gt`/`lt`/`eq`/`neq`) perform the literal native comparison
  internally, so trace-mode behavior is semantically identical to the
  original `>=`/`<=`/etc.
- No ambient/global "current entity." `__toph_e`/`__toph_s17` are ordinary
  local variables threaded through generated code only — this is immune to
  the re-entrancy bugs a mutable "current entity" global would have under
  nested `@toph filter` sites (adversarially tested in Phase 3).
- A single process-global "active trace session," set by the recording
  harness before running the pipeline, is what `enterStage`/`gte`/etc.
  resolve against internally — consistent with DESIGN.md Q11's declared
  scope ("one image, one trace, written at end of run"; no concurrent-trace
  support is being built).

## 7. Production-mode erasure: validate, then pass through unchanged

Production mode does not rewrite the AST at all. It parses the source,
applies the exact same directive-shape validation used in trace mode (so
authors get `TOPH1xx` errors regardless of build mode — a bad annotation is
a bug worth catching even in a production build), and if valid, returns the
**original source text, byte-identical**. No node is added, replaced, or
removed.

This is a deliberate stronger claim than "compiles to a no-op": there is
nothing to strip because nothing was ever inserted. A production build
literally never imports anything Toph exports. Subagent D's erasure audit
(Phase 3) is a regression guard against this invariant — grep for `toph`
tokens in production output, diff production output against a hand-written
unannotated control, and benchmark both (expected to be indistinguishable,
since they're the same code).

## 8. Manifest and source-map artifacts

`.toph/manifest.json` — exactly the `{ stages: [...], checks: [...] }` shape
given in the brief, with two independent monotonic ID counters (stage IDs,
check IDs) assigned during one deterministic compile pass (files in sorted
path order, nodes in document order).

`.toph/source-map.json` — scoped down from "a real bidirectional source
map" to a flat array of `{ generatedFile, generatedLine, file, line }`
records, one per stage/check. A full V3-style source map (arbitrary
column-level mapping for step-through debugging in an editor/devtools) is
explicitly deferred: nothing in Phases 1–6 needs to single-step generated
code in a debugger, and `manifest.json` already carries per-item
`source: {file, line}`, which is sufficient for every query this project
needs (CLI inspection, not IDE breakpoint mapping). If that need arises
later, this is the first thing to revisit — noted here so it isn't silently
forgotten.

## 9. ChainSpot P1 reality check — corrections to DESIGN.md and the patch plan

Verified against the current `samuelpmahan/chainspot` working tree (all line
numbers current as of this inspection):

### Confirmed accurate

`rawObjectMask.ts`'s structure matches DESIGN.md almost exactly: the HSV
threshold loop (268–283), `collectComponents` (121–206), the basket/badge
shape-pool filters (289–293, 300–304), `dominantSizeCluster` (208–227), the
tee family filter (324–341), the appearance filter call (343–351), final
`RawMaskTee` mapping (354–364), and the `diagnostics` block (389–404) are
all present essentially as described, with the corrected line numbers below.

### Corrected

1. **The real production call site is `basketDetection.worker.ts:517`, not
   ~800.** `PANCAKE_STACK_ONLY` (line 58) is a hardcoded `const true`, and
   its `if` block returns unconditionally at line 699 — everything from 714
   onward, including the call at line 805, is dead code today. The live
   path is: `AnnotationWorkspace.svelte:2302` →
   `basketDetection.ts:detectCourseCandidates` → Worker message
   `detect-course` → `basketDetection.worker.ts:detectCourse` (line 495) →
   `PANCAKE_STACK_ONLY` branch → `detectRawObjectMask` at **line 517**.
   Phase 4/5 instrumentation and parity checks must anchor to line 517.

2. **`scripts/detect-tees.ts` does not exercise `detectRawObjectMask` at
   all** — it drives an entirely different legacy detector
   (`cvCalibratedDetectors.ts`'s template-matching pipeline). It is not a
   usable P1 harness or parity oracle.

3. **The real parity-oracle candidate is `scripts/pancake-harness.ts`** — it
   runs the actual `basketDetection.worker.ts` module in Node (via
   `OffscreenCanvas`/`createImageBitmap`/`postMessage` shims scoped safe
   under `PANCAKE_STACK_ONLY`), sends a real `detect-course` message, and
   dumps the full result including `rawMaskObjects` as JSON. It is not
   wired into `package.json` scripts (manual `npx tsx pancake-harness.ts
   <zip> <projectRoot>` invocation). This is the harness Phase 4 should
   extend/wrap, not `detect-tees.ts`.

4. **No component label-map output exists in `collectComponents` today** —
   confirmed no output parameter of any kind. `collectComponents` mutates
   its `mask` argument in place as its own BFS visited-set (`mask[seed] =
   2`, `mask[neighbor] = 2`), which means **the pristine binary mask is
   destroyed by the time it returns** — a label sink or raster snapshot
   must be taken *before* the `collectComponents(bright, ...)` /
   `collectComponents(dark, ...)` calls (lines 286–287), not after. This
   confirms DESIGN.md §6's plan (add a label-sink output param, "one extra
   write per visited pixel, done only when tracing") is the necessary
   approach, not an option — relabeling from a captured post-hoc mask is
   not viable here since nothing captures the pre-flood-fill mask today,
   and the flood order itself (which determines label assignment) lives
   only inside `collectComponents`.

5. **No ground truth exists for Heritage anywhere in the repo.** Visual
   inspection of `HeritagePark-Main.png` (1290×2796) confirms it's a UDisc
   app screenshot ("Towne Lake, Red Tees", satellite basemap) with 18
   numbered holes, each marked by a small white flag/tee glyph and a black
   numbered badge — **not** ChainSpot's own rendered course-annotation
   style. This refines rather than confirms the earlier "domain mismatch"
   read: `grayt-tuning-report.md`'s claim ("no rendered 'hollow oval
   tee-pad' symbol") is specifically about ChainSpot's own oval tee-pad
   glyph, and that's accurate — but the image is not glyph-free. UDisc's
   white flag icons are bright, plausibly HSV-threshold-bright-mask
   positive, and the black number badges are plausibly dark-mask badge-pool
   positive. **The more likely failure mode is therefore that bright/dark
   components exist and clear the mask threshold, but the flag-icon shape
   doesn't match the geometry gates tuned for ChainSpot's own oval tee-pad
   (`bboxAspect`, min/max dimension ratios relative to basket/badge size)**
   — i.e. closer to the brief's illustrative near-miss-geometry-rejection
   format than a total absence-of-bright-pixels loss, though this is a
   plausibility read from a screenshot, not a claim to treat as
   established — Phase 6 must report whatever the real trace shows, at
   whichever stage it actually shows a loss. Ground truth (approximate
   tee-pad pixel coordinates per hole) does not exist and must be
   hand-produced for Phase 6 — by visual inspection of the PNG, recorded as
   a small JSON sidecar consumed only by the diagnostic harness (never by
   production code).

6. **Mutation/aliasing**: `raster.rgba` is read-only everywhere (safe to
   snapshot/reuse). `bright`/`dark`/`queue` are freshly allocated per call
   (no cross-call buffer pooling) — safe to hold references to a specific
   call's rasters. The one hazard is `collectComponents`'s in-place mask
   mutation noted above.

### Exact proposed patch sites for Phase 4 (`p1.tee.geometry` only)

Scoped to the brief's Phase 4 instruction — **only** the tee family filter,
nothing else in the P1 stack yet:

- `rawObjectMask.ts:324-341` — the tee family filter becomes a `@toph
  filter p1.tee.geometry` over a rewritten check-group body (six conditions
  → six `@toph check` sites: `verticalBand`/`insideBadge` stay plain guards
  — they're pool-membership prefilters, not geometry gates the brief asks
  for — the geometry-gate rewrite covers `areaVsBasket`, `minDim`,
  `maxDim`, `bboxAspect`, `fill`; appearance (line 343–351) is intentionally
  **not** touched in Phase 4 per the brief's "instrument only
  `p1.tee.geometry`" scope — Phase 4's acceptance query needs `appearance:
  not evaluated` to be *true*, i.e. the appearance filter must stay
  un-instrumented and simply not run for rejected components, which it
  already doesn't).
- No signature change to `detectRawObjectMask` is needed for Phase 4 — the
  directive lives entirely inside the function body; the trace session is
  process-global per §6 above, not threaded through the signature.
- `scripts/pancake-harness.ts` (or a small sibling script) is the
  integration point for "run Heritage through the exact real production
  harness" — it already loads a real image and drives the real worker
  entry; Phase 4 needs it to run against the trace-mode-compiled module
  instead of the original, and call `.finish()` on the trace session
  afterward.
- Phase 5 (label bridge) is the only phase that touches `collectComponents`
  (121–206) and the mask-build loop (268–283), per finding 4 above.

## 10. Task tracking

Phase 0 recon was split between this note (synthesis, decisions, patch plan)
and an inspection pass over ChainSpot (verification of DESIGN.md's claims,
call-path tracing, mutation-hazard analysis, ground-truth search) — together
these satisfy the brief's "Subagent C — inspect only" charter for this
stage; Subagent C is not separately re-run before Phase 4, to avoid
re-deriving facts already established here.
