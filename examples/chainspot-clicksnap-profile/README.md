# ChainSpot clickSnap profile — inline-API trace corpus (2026-08-17)

Profiling of ChainSpot's click-snap path (`localFeatureSnap`) against
`chainspot-corpus dev/Annotated` ground truth, instrumented with the
**inline-API vertical slice** of Toph (DESIGN.md Q9 option 1: explicit `Trace`
param + NOOP singleton) — *not* this repo's compiler-directive runtime. It
predates `codex/toph-productization`'s Phase 1–6 work and was built directly
from DESIGN.md.

**Schema caveat:** `traces/*-trace.json` use the DESIGN.md Part 2 §10 event
schema (`check`/`decide`/`measure`/`assign` events over spawned entities), not
this repo's `src/runtime` record shapes — `toph inspect` will not read them.
They are kept as (a) a real 30k+-event trace corpus for the Phase 5 entity-
identity work, and (b) the evidence behind a shipped production fix.

## Provenance

- Base: `samuelpmahan/chainspot` main @ `894854a`.
- `chainspot-clicksnap.patch`: the full instrumentation applied there —
  `src/lib/toph/` (trace core + recorder), the instrumented `localSnap.ts`
  (including the in-radius ranking fix, see below), the profiling harness
  (`scripts/profile-click-snap.ts`), and the annotation-frame probe
  (`scripts/probe-autocrop-frames.ts`). The ChainSpot experiment branch this
  came from was deleted after this example landed; the patch is the record.
- Ground truth: `chainspot-corpus` `dev/Annotated/*` (5 courses). Three of the
  five annotations are in a post-autocrop frame relative to the shipped
  screenshots; the harness reproduces the frame with ChainSpot's own
  `proposeSingleImageCrop` (verified exact — see the analysis doc).
- 41 simulated clicks per truth object (center + 8 directions × 4–20px),
  ~6,150 clicks total, exact production calibration path.

## Contents

- `clicksnap-toph-profile.md` — the full analysis write-up.
- `traces/<course>-trace.json` — pre-fix Toph traces (one per course).
- `traces/<course>-clicks.json` — per-click outcomes (offset, snapped, error,
  rejecting gate, best score, candidate count).
- `report-before.json` / `report-after.json` — aggregate metrics before/after
  the fix, from identical harness runs.

## Headline results

- Snap **centering** was never the problem (≤3.5px when a snap fires); the
  felt "tee centers got worse" was **coverage** — and failures are per-object,
  not per-click-precision.
- First-loss attribution from the traces found the defect: `localFeatureSnap`
  ranked the whole 4×-footprint crop and then radius-tested the single winner.
  In 186/371 tee and 532/588 basket radius rejections an in-radius,
  score-passing candidate existed — within 6px of ground truth in **100%** of
  those cases.
- The fix (rank within the radius) shipped to ChainSpot and re-profiling
  measured tee snap rate 0.778 → 0.838 and basket 0.796 → 0.968, matching the
  trace-derived projection, with median accuracy unchanged.
- Side finding (kept experimental): dual putting-circle center fits and the
  basket template snap independently agree DashsTrack's annotated basket
  anchors sit ~(0,+4)px high. Anchor semantics affect the alpha-compositing
  experiments, so nothing was changed on that basis.

## What this bought Toph

This was the first run where funnel + first-loss numbers came from recorded
trace events rather than re-derived arithmetic (contrast the GEO-3 hand-ported
predicates in the retrospective). The same investigation also stress-tested
the honesty rules: the first pass produced a spectacular false "snap collapse"
on three courses that the frame audit (annotation sha256/dimensions vs shipped
image) exposed as ground-truth misregistration — evidence for recording source
provenance in traces, which this repo's `manifest.json`/`source-map.json`
design already does.
