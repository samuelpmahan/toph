# Verified Heritage P1 report: prefilter + geometry + appearance, 18 ground-truth tees

This is the complete P1 tee-family survival story for every confidently-locatable
tee marker in the real held-out Heritage image: mask presence, matched component,
the real prefilter, real geometry, real appearance, and materialization -- with
production's real thresholds, real short-circuit, and one command that explains
every verified hole's first loss.

It extends `examples/heritage-first-loss/` (one hand-picked point, geometry only)
in two rounds. Round 1 (still true, unchanged below) added the appearance gate and
materialization identity. Round 2 -- this update -- closed the two gaps that round
1 left: one truth (H15) that Toph could not reliably locate at all, and one real
ChainSpot boundary (the geometry stage's own prefilter) that ran but was invisible.

`toph inspect --stages p1.tee.prefilter,p1.tee.geometry,p1.tee.appearance`
(`funnel-output.txt`) and `toph inspect --point H<n>` (`inspect-output.txt`, all 15
confident holes) are the literal, unedited output of running `toph inspect` against
the files in this directory. Nothing in either file was hand-written or touched up.

## How the ground truth was built

`Annotated/Heritage/` (a real annotation bundle, not synthesized) contains
`HeritagePark-full.png` plus a hand-authored `annotation.json` marking each
hole's basket and tee-marker screen position. Its `sourceImage.heightPx`
(2115) did **not** match the actual PNG or ChainSpot's held-out
`HeritagePark-Main.png` (both 2796px tall) -- a 681px gap.

The fix was not to curve-fit an offset. ChainSpot's own upload pipeline
autocrops every screenshot before detection ever runs
(`src/lib/singleImageAutoCrop.ts`, `src/lib/stitch/autoCrop.ts` --
`proposeSingleImageCrop`, entropy-based chrome-boundary detection), and it's
deterministic. Running the real function against the real image gave exact
insets: **429px top, 252px bottom** (`2796 - 429 - 252 = 2115`, matching the
annotation's declared height exactly). This was independently confirmed by
ChainSpot's own upload-crop UI reporting the identical 429/252 split. Every
annotated coordinate in `truth.json` is `(x, yAnnotated - 429)` -- no fitting,
no tuning, just replaying the same deterministic crop the annotation was
already expressed against.

## Classifying the 18 holes

Every hole's tee-marker glyph was checked against the correctly-cropped
image. Two outcomes:

- **15 confident** -- H1-H4, H7-H9, H11-H18: a small, visually distinct
  bright glyph, separate from the basket icon and the number badge,
  identified to sub-3px precision (most sub-1px) against the annotation.
  Includes H15 (see below).
- **3 ambiguous** -- H5, H6, H10: at this map's zoom level the tee glyph
  visually merges into the basket icon and is not separable as a distinct
  bright shape. `truth.json` marks these `"status": "ambiguous"` with a
  `reason`; `toph inspect --point H5` (etc.) short-circuits to that reason
  without touching the labelmap or entities at all -- an honest "don't know,"
  not a guess forced into a number.

**H15** is deliberately kept `"status": "confident"` rather than ambiguous:
its *location* is known precisely (round 2 resolves it to 1.62px, see below)
-- it's just that the detector's own connected-component labeling merges it
into something else.

## Round 2: closing the two gaps round 1 left open

Round 1 shipped with two known, stated gaps. Both are closed here, as two
independent, narrowly-scoped Toph capabilities -- neither touches the other,
each proven and tested on its own before the next was attempted:

### Gap 1: H15 had no reliable correspondence at all

Round 1's correspondence used direct-pixel-hit, then nearest-*centroid*
across every spawned component. For H15 that reported the nearest component
as 30.38px away (unreliable, effectively "no match") -- correct as far as it
went, but not the real story. Manually decoding the labelmap and searching
outward from H15's truth point found an actual labeled (bright) pixel only
**1.62px** away, belonging to that exact same component (entity 1233): a
large (60x54px), sparse (fill 0.17) blob that H15's tee glyph got
flood-fill-merged into during detection, alongside unrelated bright pixels.
The component's *centroid* is dragged 30px away by those unrelated pixels
even though the truth point sits right on the component's own member pixels.
Centroid distance is a bad proxy for "does this point belong to this
component" once a component is large and irregular.

`src/cli/inspect.ts`'s `resolveCorrespondence` gained a bounded
expanding-ring search directly against the labelmap, tried between
direct-pixel-hit and nearest-centroid: real, non-aggregate pixel evidence
beats an aggregate guess. Verified against all 18 holes: the 14 that already
worked map to the *identical* entities as before (this fix is additive, not
a regression), and H15 now resolves reliably to entity 1233 at 1.62px.
Toph commit: `feat: resolve correspondence via nearest labeled pixel, not
just centroid`.

### Gap 2: the geometry stage's own prefilter ran, but was invisible

Once H15 could be located, its component (entity 1233) turned out to have
**zero check events at any instrumented stage** -- it never even reached
`p1.tee.geometry`'s seven checks. The real code was already why: before the
seven-check filter, `brightComponents` passes through an un-instrumented
prefilter (a y-range gate derived from badge positions, and a
badge-overlap-exclusion gate) that silently drops candidates before the
checked filter ever sees them. This is exactly the "component disappears
before p1.tee.geometry" case -- Toph's trace stopped answering right there.

Instrumenting it needed one small, real, additional Toph capability first:
one of the prefilter's two conditions, `centerFallsInsideBadge(...)`, is a
plain boolean function call, not a numeric comparison -- the existing
`@toph check` shape (a `value <op> threshold` comparison) had no boolean
case. Rather than adding a new directive or check shape, it's expressed as
an explicit equality against a boolean literal
(`centerFallsInsideBadge(...) === false`), which the compiler already
accepted syntactically with zero changes; the only real gap was
`src/runtime/index.ts` typing `CheckRecord.value`/`threshold` as strictly
`number`. `eq`/`neq` (only those two -- `gte`/`lte`/`gt`/`lt` stay
number-only, locked in by a `@ts-expect-error` test) were widened to
`number | boolean`, since `===`/`!==` are sound on booleans. Toph commit:
`feat: allow eq/neq checks to compare booleans`.

With that capability available, the prefilter became a real, checked
`@toph filter p1.tee.prefilter` stage -- `centroid-y.min`, `centroid-y.max`,
`badge-overlap` -- structurally identical to how `area.min`/`area.max`
already decompose a compound range condition into two checks. Running it
for real: **H15's component fails `badge-overlap`** -- its centroid sits
inside hole 15's own number badge's bounding box (plus margin). It never
reaches `p1.tee.geometry` at all. The other 14 confident holes all pass the
prefilter cleanly (verified below) before failing at `area.min`, exactly as
round 1 already found -- this instrumentation adds evidence, it changes
nothing about their outcome.

## Instrumenting the complete P1 path

`rawObjectMask.patch` is the full patch (prefilter + geometry + appearance +
materialization) applied to `samuelpmahan/chainspot`, always in a **temporary
git worktree**, never the tracked checkout (read-only access, nothing pushed
or committed there):

1. **Prefilter** (new, round 2): `@toph filter p1.tee.prefilter` on the
   y-range + badge-overlap gate that runs before the seven-check filter --
   `@toph check centroid-y.min`, `centroid-y.max`, `badge-overlap`. This is
   the same kind of compound-condition-into-named-checks decomposition
   already used for the geometry stage, just applied one filter earlier;
   `geometryPool` (the prefilter's output) already existed as its own
   variable from round 1's structural split, only its instrumentation was
   missing.
2. **Geometry** (unchanged since round 1): `@toph filter p1.tee.geometry` on
   the seven-check filter, `@toph check` on each of `area.min`, `area.max`,
   `min-dimension`, `max-dimension`, `bbox-aspect.max`, `fill.min`,
   `fill.max`.
3. **Appearance** (unchanged since round 1): `@toph filter p1.tee.appearance`
   wraps the real production call -- `bestTeeTemplateScore(extractCanonicalTeePatch(raster,
   {...})) >= TEE_APPEARANCE_THRESHOLD` -- with `@toph check appearance.ncc`
   recording the actual computed NCC score against production's actual,
   untouched threshold (`teeAppearance.ts`'s `TEE_APPEARANCE_THRESHOLD = 0.38`).
4. **Materialization identity** (unchanged since round 1): `@toph entities tee`
   on `sortComponents(teeComponents).map((component): RawMaskTee => ({...}))`,
   linking each materialized `tee` entity back to its source `component` entity
   via `parentId` (`spawnDerivedEntities`).

`compileProduction`: 0 diagnostics. Per this task's own rule, production
mode is a pure source-identity pass (it validates and returns the input
unchanged) -- the real "zero residue" guarantee is that the *committed*
ChainSpot file never carries `@toph` markup at all. Verified directly: the
annotated source with only its `@toph`-comment lines mechanically stripped
(i.e. exactly what would actually ship) contains zero occurrences of the
string "toph", case-insensitive. `compileTrace`: 0 diagnostics;
`manifest.json`/`source-map.json` are its output -- **3 stages, 11 checks,
1 asset, 2 entity kinds** (`component` and `tee`).

## Running it for real, and proving parity three ways

The trace-compiled file was run, in the temporary worktree, against the real
production harness (the same `PANCAKE_STACK_ONLY` worker entry point as
round 1) against the real, correctly-autocropped Heritage image, with
`startTrace()`/`finishTrace()` wrapping the detection call and
`getRasterBytes()` retrieving the snapshotted mask while the session was
still active.

Three independent runs of the same detection call were compared field for
field on `course.rawMaskObjects.{tees,badges,baskets,diagnostics}`:

1. **baseline** -- the true, unmodified, un-annotated ChainSpot source.
2. **trace** -- the full 3-stage instrumented source, compiled by
   `compileTrace`.
3. **production** -- the annotated source with only its `@toph` comment
   lines removed (i.e. what would actually be committed/shipped).

**All three are byte-identical** -- `tees` (10), `badges` (18), `baskets`
(15), and `diagnostics` (`brightComponentCount: 1504`, etc.) match exactly
across all three runs. This proves the structural refactor (splitting the
prefilter into its own named variable, restructuring the appearance call)
and every layer of instrumentation are behavior-preserving, not just at the
source level but at the real detection-output level.

**Label-map parity check** (DESIGN.md's "approach 2"): `collectComponents`
was re-run on an independent copy of the snapshotted pristine mask, with a
`labels` sink populated. This re-run's 1504 components were compared
field-by-field against the real run's 1504 spawned `component` entities
(filtered out from the 1514 total, which also includes the 10 `tee`
entities materialized from this run's own survivors) -- **exact match on
every field, all 1504 components.** `labelmap.json` is this label map,
run-length-encoded, byte-identical to round 1's (the prefilter split never
touches mask labeling, only downstream filtering).

## The result

```
$ toph inspect --trace trace.json --manifest manifest.json --labelmap labelmap.json \
    --truth truth.json --stages p1.tee.prefilter,p1.tee.geometry,p1.tee.appearance

Truth objects: 18 total (15 confident, 3 ambiguous)
Corresponded: 15 / 15 confident
  p1.tee.prefilter: reached 15, kept 14
  p1.tee.geometry: reached 14, kept 0
  p1.tee.appearance: reached 0, kept 0
Materialized: 0
```

All 15 confident holes now correspond to a real detected component (H1-H14,
H16-H18 sub-4px via nearest-pixel; H15 at 1.62px, the same fix). **Exactly
one -- H15 -- is rejected at the prefilter** (`badge-overlap`: its merged
component's centroid falls inside hole 15's own number badge). **The other
fourteen all pass the prefilter cleanly**, then are **rejected at the exact
same geometry gate**: `area.min`, the first geometry check, areas in a tight
116-139px² band against this image's actual computed threshold of
157.14px². None of them, and H15, ever reach the appearance check --
`p1.tee.appearance: reached 0` is real short-circuit, not a report artifact.

This is the same failure Phase 6 originally found for H1 alone
(`109px² < 157.14px²`), now confirmed across all 14 geometrically-evaluated
holes, plus a complete, independent explanation for the 15th. Every
confident annotation in this fixture now has an exact first-loss
explanation, reachable from a single command -- `inspect-output.txt` has
the full per-hole detail (entity id, exact attrs, every check that ran and
its real recorded value, every check that provably never did) for all
fifteen, generated by the same command anyone can re-run: `toph inspect
--trace trace.json --manifest manifest.json --labelmap labelmap.json
--truth truth.json --point H<n>`.

No threshold in this repository or ChainSpot's was read, tuned, or changed
to produce this result. This report describes what production's *own*,
untouched thresholds and gates do to real, independently-verified tee
markers -- it does not evaluate whether they're right.

## What's still unexplained, and why that's a stopping point, not a gap

Every one of the 15 confident holes now has a complete first-loss
explanation (14 at `p1.tee.geometry`'s `area.min`, 1 at
`p1.tee.prefilter`'s `badge-overlap`), or is honestly `ambiguous` (H5, H6,
H10 -- the ground truth itself, not the detector, is what's uncertain
there). None of the 18 truths ever reach `p1.tee.appearance` or
materialization, so there is nothing further to instrument *for this
fixture* -- extending appearance/materialization/later-pipeline
instrumentation now would be instrumenting a phase merely because it
exists, not because a real, currently-blocked truth needs it. That is this
round's stopping point per this task's own rule.
