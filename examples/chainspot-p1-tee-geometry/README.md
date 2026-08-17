# Phase 4 artifact: `p1.tee.geometry` traced against real Heritage data

This directory is evidence, not code — the output of actually annotating
ChainSpot's real `detectRawObjectMask` (rawObjectMask.ts) and running it
against the real production harness on the real Heritage held-out image.
Nothing here is committed to ChainSpot (this session only has read access to
that repo, and nothing was pushed) — this is the reproducible record of what
running the patch below produces.

## How this was produced

1. `rawObjectMask.patch` applied cleanly to `src/lib/autoAnnotation/rawObjectMask.ts`
   at `samuelpmahan/chainspot` commit `2e327e7`. It does two things, both
   confined to the tee family geometry gate (`rawObjectMask.ts:324-341`
   before the patch):
   - Splits the single seven-and-two-condition `.filter()` into an
     un-instrumented pool prefilter (`geometryPool` — the vertical-band and
     inside-badge membership tests, which are pool membership, not geometry
     gates) and a `@toph filter p1.tee.geometry` block over the seven
     geometry conditions. This split is required because the compiler's
     supported filter-body shape is strictly "check groups, then
     `return true`" — no unannotated statements interleaved (see
     `IMPLEMENTATION-DECISIONS.md` section 4) — and produces *exactly* the
     same result set as the original single-pass filter (filtering is
     associative when neither predicate has side effects, which neither
     does here).
   - Rewrites the compound `return (a && b && c && ...)` into seven
     `@toph check`-annotated check groups, in the *same order* as the
     original `&&` chain, so short-circuit behavior is unchanged.
2. `compileProduction` on the patched file: 0 diagnostics, output
   byte-identical to the patched source (as designed — nothing is ever
   inserted in production mode).
3. `compileTrace` on the patched file: 0 diagnostics. `manifest.json` /
   `source-map.json` are its output, merged via `writeManifest`.
4. Three harness runs of `scripts/pancake-harness.ts` (ChainSpot's own real
   production-pipeline-in-Node harness — `PANCAKE_STACK_ONLY` branch,
   `basketDetection.worker.ts`) against
   `resources/held-out/HeritagePark-Main.png`:
   - **baseline** — the true, unmodified original file.
   - **annotated** — the patched-but-uncompiled file in place (i.e. exactly
     what `compileProduction` emits — proves the annotation + restructuring
     alone don't change behavior).
   - **trace** — the `compileTrace`-generated file swapped in for
     `rawObjectMask.ts`, run via a thin harness variant that wraps the same
     detection call in `startTrace()`/`finishTrace()` (`toph`'s runtime
     resolved via a transpiled `node_modules/toph` shim — same technique the
     project's own test harnesses use). `heritage-trace.json` and
     `heritage-detector-output.json` are this run's output.
   - The original file was restored immediately after each swap; `git diff`
     against the ChainSpot clone is empty.

## Acceptance check: identical final output

`course.rawMaskObjects`, `course.tees`, `course.baskets`,
`course.numberDetection`, and `course.grammar` are **byte-identical** (after
stripping pure wall-clock timing fields) across all three runs. Trace
instrumentation changed nothing about what the detector actually decided —
only what evidence survived about *why*.

## The finding

Baseline `rawMaskObjects`: **1697 bright components** → 313 survive the
vertical-band/inside-badge pool prefilter → **0 tees**, matching
`scripts/cv-probes/grayt-tuning-report.md`'s existing "0 gate-passed tees on
all 18 holes" finding for this image.

`heritage-trace.json` shows *why*, per component, for the first time without
reading `rawObjectMask.ts` or rerunning the detector:

| First failing check | Elements |
|---|---|
| `area.min` (`areaPx >= basketMedianArea * 0.09`) | 292 |
| `area.max` (`areaPx <= basketMedianArea * 0.35`) | 20 |
| `max-dimension` (`max(w,h) <= basketMedianWidth * 2`) | 1 |
| passed all 7 checks | 0 |

This run's actual computed threshold was `basketMedianArea * 0.09 =
157.14px²` — **the great majority of Heritage's bright components (292 of
313) are rejected at the very first geometry gate for being far too small**,
not a near-miss on shape. Several real components in this run have
`areaPx` of 107–111px² against that 157.14px² threshold — i.e. this is very
likely where the product brief's own illustrative example
(`area.min: 109 < 157.14`) came from; the number match is not a
coincidence, it's this exact run.

One component (of 313) makes it further than any other: area 600px² (passes
both area bounds), min-dimension 25px (passes), but `max-dimension: 103 <=
84` fails — width/height 103px is far more elongated than the tee-pad-glyph
aspect these bounds assume. No component in this Heritage image passes all
seven geometry checks; none reaches the untouched appearance filter at all.

This is consistent with (and sharpens) the visual read recorded in
`IMPLEMENTATION-DECISIONS.md` section 9: Heritage is a UDisc screenshot with
its own white flag/tee glyph, not ChainSpot's rendered oval tee-pad — bright
components exist and clear the mask threshold, but as a *population* they
are the wrong size for the oval-tee-pad-tuned geometry gates, overwhelmingly
too small.

## Files

- `rawObjectMask.patch` — the exact diff, ready to `git apply` against
  `samuelpmahan/chainspot`.
- `manifest.json` / `source-map.json` — this compile's Toph manifest (1
  stage, 7 checks) and generated-line source map.
- `heritage-trace.json` — the full `TraceRun` from the trace-mode run: 1
  stage invocation, 313 elements, 336 check events.
- `heritage-detector-output.json` — `course.rawMaskObjects` from that same
  run (tees/badges/baskets/diagnostics), for reference — identical across
  all three runs described above.
