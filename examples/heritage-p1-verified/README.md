# Verified Heritage P1 report: geometry + appearance, 18 ground-truth tees

This extends `examples/heritage-first-loss/` (one hand-picked point, geometry
only) to the full ask: a **fixture-driven** ground truth for every tee marker
we can confidently locate in the real held-out Heritage image, run through
the **complete** P1 tee pipeline -- geometry *and* appearance -- with
production's real NCC score and threshold recorded, and component identity
preserved through final `RawMaskTee` materialization.

`toph inspect --stages p1.tee.geometry,p1.tee.appearance` (`funnel-output.txt`)
and `toph inspect --point H<n>` (`inspect-output.txt`, all 15 confident holes)
are the literal, unedited output of running `toph inspect` against the files
in this directory. Nothing in either file was hand-written or touched up.

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
its *location* is known precisely, it's just that the detector's own
connected-component labeling merges it into something else. Investigation
confirmed the glyph pixels are bright by production's own threshold, but
flood-fill absorbs them into a large 60x54px, fill=0.17 blob (component
entity 1233) alongside unrelated bright pixels, and that blob is dropped by
the geometry stage's *pre-filter* (centroid-in-badge-row / badge-overlap)
before any of the seven instrumented checks run -- zero check events for it.
`toph inspect --point H15` reports this exactly as what it is: nearest
component 30.38px away, past the 20px reliable-correspondence threshold, so
`component`/`stages` are correctly left unpopulated rather than guessed at.
Marking this "ambiguous" would misstate the actual problem -- the tee's
location isn't in question, the detector's labeling of it is.

## Instrumenting the complete P1 path

`rawObjectMask.patch` extends the Phase 4 geometry-only patch with the
appearance gate and materialization, applied to `samuelpmahan/chainspot`
(not committed there -- read-only access, nothing pushed):

1. **Geometry** (unchanged from Phase 4): `@toph filter p1.tee.geometry` on
   the seven-check filter, `@toph check` on each of `area.min`, `area.max`,
   `min-dimension`, `max-dimension`, `bbox-aspect.max`, `fill.min`,
   `fill.max`.
2. **Appearance** (new): `@toph filter p1.tee.appearance` wraps the
   real production call --
   `bestTeeTemplateScore(extractCanonicalTeePatch(raster, {...})) >=
   TEE_APPEARANCE_THRESHOLD` -- with a single `@toph check appearance.ncc`
   recording the actual computed NCC score against production's actual
   threshold (`teeAppearance.ts`'s real, untouched `TEE_APPEARANCE_THRESHOLD
   = 0.38`; no threshold in this codebase was read, tuned, or changed). This
   replaces the previous `passesTeeAppearanceCheck` wrapper call with its
   already-exported constituent pieces -- same computation, same result,
   just no longer opaque to instrumentation.
3. **Materialization identity** (new capability, not just a new directive):
   `@toph entities tee` on `sortComponents(teeComponents).map((component):
   RawMaskTee => ({...}))`. This is a `.map()`-derive site, a second entity
   host shape the compiler didn't support before this work --
   `spawnDerivedEntities` links each materialized `tee` entity back to the
   `component` entity it came from via `parentId`, looked up through the
   same identity-preserving `WeakMap` used for the plain-array shape. That
   `parentId` link is what lets the survival funnel's `materializedCount`
   answer "did this *specific* verified component survive all the way to a
   `RawMaskTee`" rather than just "how many tees came out the other end."

`compileProduction`: 0 diagnostics, byte-identical output (verified as
always -- production strips every directive and comment site back to the
original source, character for character). `compileTrace`: 0 diagnostics;
`manifest.json`/`source-map.json` are its output (2 stages, 8 checks, 1
asset, 2 entity kinds -- `component` and `tee`).

## Running it for real

The trace-compiled file was run against the real production harness (the
same `PANCAKE_STACK_ONLY` worker entry point as Phase 6) against the real
`resources/held-out/HeritagePark-Main.png`, with `startTrace()`/`finishTrace()`
wrapping the detection call and `getRasterBytes()` retrieving the snapshotted
mask while the session was still active. `course.rawMaskObjects`/`tees`/
`baskets` came back **byte-identical** to the untouched baseline.

**Label-map parity check** (DESIGN.md's "approach 2"): `collectComponents`
was re-run on an independent copy of the snapshotted pristine mask, with the
new `labels` sink populated. This re-run's 1504 components were compared
field-by-field against the real run's 1504 spawned `component` entities
(filtered out from the 1514 total, which also includes the 10 `tee` entities
materialized from this run's own `p1.tee.geometry`/`p1.tee.appearance`
survivors) -- **exact match on every field, all 1504 components.**
`labelmap.json` is this label map, run-length-encoded.

## The result

```
$ toph inspect --trace trace.json --manifest manifest.json --labelmap labelmap.json \
    --truth truth.json --stages p1.tee.geometry,p1.tee.appearance

Truth objects: 18 total (15 confident, 3 ambiguous)
Corresponded: 14 / 15 confident
  p1.tee.geometry: reached 14, kept 0
  p1.tee.appearance: reached 0, kept 0
Materialized: 0
```

Fourteen of the fifteen confident holes correspond to a real detected
component (sub-1px in all but one case; H15's is the 30.38px unreliable
case above, correctly excluded from "corresponded"). **All fourteen are
rejected at the exact same gate**: `area.min`, the first geometry check.
Every one of their areas falls in a tight 116-139px² band against this
image's actual computed threshold of 157.14px² (`basketMedianArea * 0.09`,
derived from this image's own detected basket sizes -- not a fixed
constant). None of the other six geometry checks, and none of the
appearance check, ever run for any of them -- real short-circuit means the
funnel's `p1.tee.appearance: reached 0` is not an artifact of the report,
it's what production's own control flow actually did.

This is the same failure Phase 6 found for H1 alone (`109px² < 157.14px²`),
now confirmed, without exception, across every independently-located tee
marker in the image that the detector's own component labeling kept intact
enough to reach the filter at all. `inspect-output.txt` has the full
per-hole detail -- entity id, exact attrs, the one check that ran and its
real recorded value, and the six-plus-one checks that provably never did --
for all fifteen confident holes, generated by the same command anyone can
re-run: `toph inspect --trace trace.json --manifest manifest.json --labelmap
labelmap.json --truth truth.json --point H<n>`.

No threshold in this repository or ChainSpot's was read, tuned, or changed
to produce this result. This report describes what production's *own*,
untouched threshold does to real, independently-verified tee markers -- it
does not evaluate whether that threshold is right.
