# Phase 6 artifact: the Heritage H1 first-loss query

This is the primary pass/fail deliverable for the whole spike: *"After
annotating the narrow ChainSpot P1 path, selecting Heritage H1 must reveal
its actual white-mask support, exact connected component, checks that truly
executed, first failed threshold, and downstream non-execution — without
rerunning the detector or opening rawObjectMask.ts."*

`inspect-output.txt` is the literal output of running `toph inspect`
against the files in this directory. Nothing in it was hand-written or
touched up — it's the query tool's real output against a real trace.

## How this was produced

1. `rawObjectMask.patch` extends Phase 4's `p1.tee.geometry` patch (same
   geometry-filter rewrite) with two additions, applied to
   `samuelpmahan/chainspot` commit `2e327e7` (not committed there — read-only
   access, nothing pushed):
   - `collectComponents` (`rawObjectMask.ts`) is exported and gains an
     optional trailing `labels?: Uint16Array` parameter — a plain,
     Toph-agnostic optional parameter, `undefined` for every real caller,
     that fills in a component-label sink one write per visited pixel when
     present. Zero behavior/cost change for the real call sites, which never
     pass it.
   - `@toph snapshot bright.mask kind=mask ref=bright width=width
     height=height` and `@toph entities component`, both attached to
     `const brightComponents = collectComponents(bright, width, height,
     queue);` — the snapshot captures `bright`'s pristine bytes immediately
     before `collectComponents` mutates it as its own BFS visited-set (see
     IMPLEMENTATION-DECISIONS.md section 9, finding 4); `entities` spawns one
     stable Toph entity per detected component.
2. `compileProduction`: 0 diagnostics, byte-identical output (as always).
   `compileTrace`: 0 diagnostics; `manifest.json`/`source-map.json` are its
   output (1 stage, 7 checks, 1 asset, 1 entity kind).
3. The trace-compiled file was run against the real production harness
   (`scripts/pancake-harness.ts`'s `PANCAKE_STACK_ONLY` path) against the
   real `resources/held-out/HeritagePark-Main.png`, with `startTrace()` /
   `finishTrace()` wrapping the detection call and `getRasterBytes()`
   retrieving the snapshotted mask while the session was still active.
   `course.rawMaskObjects`/`tees`/`baskets` came back **byte-identical** to
   the untouched baseline (same check as Phase 4, re-verified here).
4. **Label-map parity check** (DESIGN.md's "approach 2" — rerun labeling
   over a captured mask and assert exact equality, rather than trusting the
   label sink blind): `collectComponents` was called a *second* time, on an
   independent copy of the snapshotted pristine mask, with the new `labels`
   sink populated. This re-run's 1697 components were compared field-by-field
   against the real run's 1697 spawned entities (same order, since both are
   produced by the identical seed-scan) — **exact match on every field, all
   1697 components.** `labelmap.json` is this label map, run-length-encoded
   (3,606,840 pixels → 20,279 runs — mostly background).
5. `truth.json`: hand-identified ground truth for hole 1's tee marker.
   `HeritagePark-Main.png` has no bundled ground truth (see
   IMPLEMENTATION-DECISIONS.md section 9) — the point `(700, 1146)` was
   found by visually inspecting the image (cropping/zooming around hole 1's
   badge) and identifying a small hollow white rectangle glyph sitting
   directly on the path leading to the basket, distinct from both the
   basket icon (a filled goblet/chalice shape) and the black number badge,
   and confirmed as a repeating pattern near other holes too — the
   strongest visual candidate for "the tee marker" in this UDisc screenshot.
6. `toph inspect --trace trace.json --manifest manifest.json --labelmap
   labelmap.json --truth truth.json --point H1` (source:
   `src/cli/inspect.ts` + `src/cli/bin.ts`) produced `inspect-output.txt`.

## Reading the result

The hand-identified point (700, 1146) does **not** land on a bright pixel
exactly (`labelAt` = 0) — a reasonable outcome for a manually-eyeballed
coordinate against a ~13×16px glyph. The query honestly reports this as
`directHit: false` rather than papering over it, then falls back to nearest
spawned entity by centroid distance: **0.94px** away, entity **900**. That
sub-pixel distance, on an image with 1697 candidate components scattered
across 3.6 million pixels, is about as strong a confirmation as a
hand-picked coordinate can get that this is the right glyph.

Entity 900's own geometry — `widthPx: 13, heightPx: 16, areaPx: 109` — and
the recorded `area.min` check (`109 >= 157.14 → FAIL`, this run's actual
computed threshold) match the product brief's own illustrative example
(`area.min: 109 < 157.14`, `min-dimension: 13 < 16.20` — this run's
`min-dimension` threshold, from `badgeMedianHeight * 0.45`, is exactly
16.2) closely enough that this is almost certainly the exact component that
example was drawn from. The one honest difference from that illustrative
composite: real short-circuit means `min-dimension` was **never evaluated**
here — `area.min` already failed and rejected the component first, so the
real trace correctly shows it under "Checks NOT evaluated," not as a second
failing check. The illustrative example is a documentation composite; the
real trace is what real control flow actually does.

The full story this run tells, without opening `rawObjectMask.ts` or
rerunning anything: the real ChainSpot tee-family filter received a
component matching hole 1's tee-marker glyph, evaluated exactly one gate
against it (`area.min`), rejected it there (109px² against a 157.14px²
floor derived from this image's own basket size), and never touched the
other six geometry gates or the appearance filter for it at all.
