# Toph vertical-slice feedback — from the first real execution

For: `samuelpmahan/toph` (DESIGN.md is currently the repo's only file; this doc
is field feedback from the first working implementation of the Part 3 vertical
slice, run 2026-08-17 inside ChainSpot against the 4-course annotated corpus —
full experiment write-up in ChainSpot's
`scripts/cv-probes/toph-p1-corpus-tuning-findings.md`).

**Bottom line: the architecture survived contact.** The slice was implemented
as designed (~420 lines core + recorder), instrumented `detectRawObjectMask` at
~15 call sites with one hoist, and every conclusion of a real tuning experiment
came off the trace instead of archaeology. Spike verdicts: friction PASS,
identity PASS, labelmap join PASS, vocabulary PASS, payoff PASS, zero-cost
**FAIL** (details below). The retrospective's acceptance bar — reproduce a
GEO-3-style per-truth attribution with no custom enumeration script — is met on
this corpus: per-truth first-loss tables for 144 truths across 4 courses, each
naming the gate, measured value, and threshold.

## What the design got right (keep these load-bearing)

- **Entity IDs + append-only events.** WeakMap identity with explicit
  `transform` at spread sites was enough; P1 has exactly 3 derivation sites,
  matching the design's "few enough" bet.
- **Gates that return the comparison.** Control flow untouched; course-derived
  thresholds (`basketMedianArea * 0.09`…) came out as concrete per-run numbers
  for free — this single property carried the whole tuning experiment.
- **Labelmap as the raster↔entity join.** Every ground-truth query resolved
  with zero per-pixel events; traces ≈2MB/course as PNGs.
- **`select` for population-relative decisions.** The most valuable single
  attribution of the experiment (a 17-member badge-digit cluster outvoting the
  16 real baskets in size consensus) was only expressible because consensus is
  a `select` event with basis, not a per-element threshold.

## Changes to make before calling the API real

1. **First-loss must be family/verdict-scoped.** The naive query ("first
   rejection in any stage") misattributed nearly every truth: a tee dying at
   the basket pool is *expected*, not a loss. GroundTruth already has
   `expect?: string` — the query must filter attributable stages by the
   expected entity role. This was the largest correctness bug in the slice and
   it will bite every integration.
2. **Promote `selectFateOf(entity)` to a core query.** "Which select
   kept/rejected this entity, and what was the basis" was needed by every
   basket-truth query. It is currently an integration-side helper; it belongs
   next to first-loss.
3. **The labelmap write needs the compile-out mechanism in core.** Measured
   NOOP overhead on the DashsTrack fixture: ~4.3% median (149.3ms vs 143.2ms)
   — the design's own <1% falsification clause triggered. The cost is the
   per-pixel `labels` branch inside the flood-fill hot loop, not the gate
   calls. The design anticipated exactly this escalation (Q9 option 3 /
   second loop variant); ship it as part of the core contract rather than
   leaving each host to discover the regression.
4. **Make the coordinate-frame contract enforceable.** The biggest source of
   wrong conclusions in the experiment was not gates at all: ground truth
   lived in the post-autocrop frame while images arrive pre-crop, and every
   truth silently missed until the frames were reconciled. The schema already
   models `spaces`; add the rule that a GroundTruth block must name its space
   and the recorder/query must refuse a GT whose space cannot be reconciled
   with a recorded transform (ChainSpot's runner now validates against the
   annotation's recorded source dimensions — that check saved the experiment).
5. **Ship the radius-fallback GT match, with the no-forcing rule.** Human
   truth clicks are pad-center approximations; exact-pixel labelmap hits
   missed roughly half of real correspondences. The standard query should
   scan a bounded radius, record the distance, and preserve the
   refuse-unreliable-correspondence semantics (H15 precedent) rather than
   snapping to whatever is nearest.
6. **Keep stage-scoped `measure` events.** Recording derived scale references
   (`basketMedianArea`, `badgeMedianHeight`) as stage measures is what made
   "the tee window collapsed because the basket median was digit-sized"
   readable directly off the trace. Trivial to record, disproportionate
   explanatory value.

## Smaller notes

- 16-bit labelmaps encoded as R/G low/high bytes in ordinary PNGs worked fine
  and stayed jq-adjacent (manifest carries no pixel data); no need for real
  16-bit PNG in the slice.
- `keep(e, obj)` re-binding the surviving object to the entity id made the
  emitted-object → entity join free at the API boundary; worth documenting as
  the intended pattern.
- The recorder held rasters in memory for in-process queries and wrote PNGs
  only at `finish()`; for harness-style use this dual mode (query surface +
  persisted artifact) is the shape consumers actually want — consider making
  it explicit in the design rather than implying write-then-reload.
