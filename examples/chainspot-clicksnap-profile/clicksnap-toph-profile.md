# clickSnap (localFeatureSnap) Toph profile — 2026-08-17

Side quest: profile the click-snap/AutoSnap path with Toph against corpus ground
truth, because tee centers felt like they had gotten worse. This run is also
Toph's first executable vertical slice (`src/lib/toph/`): every number below
comes from recorded `check`/`decide` events, not from re-derived arithmetic.

## Method

- Ground truth: `chainspot-corpus` `dev/Annotated/*` (AlexClark, DashsTrack,
  Heritage, Lenard, TowneLake) — per-hole tee/basket centers.
- **Frame audit (machine-checked):** the schemaV1 annotations record the source
  image's sha256 + dimensions. DashsTrack matches its shipped image exactly;
  Lenard/TowneLake/Heritage annotations were made in a **post-autocrop frame**
  while the corpus ships the raw 1290×2796 phone screenshots. The production
  single-image autocrop (`proposeSingleImageCrop`) regenerates each annotated
  frame *exactly* (Lenard top 429 / bottom 278 → 2089; TowneLake 532/252 →
  2012; Heritage 429/252 → 2115), so the harness autocrops before profiling.
  First-pass results without this correction showed near-total snap collapse on
  those three courses — that collapse was a ground-truth registration artifact,
  not a snap regression.
- Clicks: for every truth object, the GT center plus 8 directions × radii
  {4, 8, 12, 16, 20}px (41 clicks/object; 3,075 clicks per kind corpus-wide).
- Snap path: exact production calibration (number-badge anchor →
  `deriveUDiscCalibration`, basket template scale), exact production
  `localFeatureSnap`, instrumented with a Toph trace.
- Harness: `npx tsx scripts/profile-click-snap.ts --corpus <dev/Annotated> --out <dir>`
  (writes per-course `*-trace.json`, `*-clicks.json`, and `report.json`).

## Results (post frame correction)

| Course | tee snapRate | tee err med/p90 | basket snapRate | basket err med/p90 |
|---|---|---|---|---|
| AlexClark | 0.667 | 3.46 / 3.46 | 0.992 | 3.5 / 4.0 |
| DashsTrack | 0.896 | 0.31 / 0.84 | 0.930 | 4.03 / 4.03 |
| Heritage | 0.625 | 0 / 0 | 0.707 | 0 / 4.03 |
| Lenard | 0.760 | 0 / 0 | 0.701 | 0 / 0 |
| TowneLake | 0.848 | 0 / 1.8 | 0.812 | 0 / 1.15 |

- **Centering is not the problem.** When a tee snap fires it lands ≤3.5px from
  GT (frequently sub-pixel). The "worse tee centers" feeling is a **coverage**
  problem: on ~22% of tee clicks no snap fires, so the marker stays wherever
  the finger landed.
- **Failures are per-object, not per-click-precision.** Snap rate is flat from
  0px to 20px click offset (tee ~0.78 at every radius). A snappable hole snaps
  even from a 20px-sloppy click; an unsnappable hole never snaps.

## First-loss attribution (from the Toph funnel)

Rejections split between `candidatesFound` (detector saw nothing in the crop)
and `snapDistancePx` (the crop's best-scoring candidate sat outside the accept
radius). Counterfactual check on the radius-rejected best candidates: they land
50–105px from GT — the radius gate is correctly refusing wrong features (the
crop is 4× the footprint, so neighbouring pads/glyphs are visible and often
outscore the true one).

**The actionable defect:** `localFeatureSnap` selects the single best-scoring
candidate in the *whole crop*, then radius-tests it. The Toph traces show that
when that global best is rejected for distance, another candidate that (a)
clears `LOCAL_SNAP_MIN_SCORE` and (b) is inside the snap radius existed in the
same crop in **186/371 tee** and **532/588 basket** rejections — and in **100%
of those cases** that in-radius candidate lands within 6px of ground truth.

> Recommendation: rank only candidates within `snapRadiusPx` of the click
> (fall back to none). Projected corpus-wide snap rates: tee 0.78 → ~0.84,
> basket 0.80 → ~0.97, with no observed accuracy cost.

**Shipped and validated** (`localSnap: rank candidates within the snap radius`):
re-running the identical harness after the change measured tee 0.778 → 0.838
and basket 0.796 → 0.968 corpus-wide — matching the trace-derived projection —
with per-course median snap error unchanged everywhere (largest p90 movement:
Lenard basket 0 → 2.02px, from holes that previously never snapped at all).

## Euclid check (putting-circle centers, from `claude/teepad-putting-circle-recovery`)

`fitPuttingCircleRadiusPx` (dashed-ring radial sweep with run-count gating) was
extended in a probe to optimize the circle *center*. On DashsTrack, with a
relaxed bright threshold (V≥175, S≤60 — the branch's V≥210 finds circles on
only 4/18 holes at overview zoom, consistent with the rendering doc's
zoom-prominence observation), **both** circles fit on 18/18 holes.

Two independent measurements agree with each other and disagree with the human
anchor by the same vector:

- fitted circle centers sit at median **(+0, +4)px** from the GT basket anchor;
- the production basket template snap lands at **(−0.5, +4)px** from GT on
  essentially every DashsTrack hole (which is why basket snap error is a
  suspiciously constant ~4.03px).

Euclid wins: the annotated anchors are ~4px high, and basket snap centering is
actually sub-pixel consistent with the rendered geometry. The circle-center fit
is a viable *verifier/refiner* for basket snaps (two concentric fits agreeing
within a couple px is very strong evidence for the true anchor), but at
overview zoom it needs the relaxed threshold, and per the rendering working
model any threshold must be re-measured per zoom level.

## Artifacts

- Toph core: `src/lib/toph/trace.ts` (Trace + NOOP), `src/lib/toph/record.ts`.
- Instrumented: `src/lib/cv/localSnap.ts` (optional trailing `trace` param;
  production callers unchanged, NOOP by default; existing unit tests pass).
- Harness: `scripts/profile-click-snap.ts`; frame probe:
  `scripts/probe-autocrop-frames.ts`.
- Raw traces/reports were written to the session scratchpad (not committed):
  per-course `*-trace.json` (full Toph event logs), `*-clicks.json`,
  `report.json`.
