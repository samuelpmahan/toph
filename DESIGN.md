# Toph — architecture design (pre-alpha)

Toph is a CV observability library: "Chrome DevTools for a classical CV pipeline."
This document is the result of tracing the actual ChainSpot tee-detection code
(`samuelpmahan/chainspot @ main`, Aug 2026) and designing the smallest architecture
that can instrument it without becoming ChainSpot-specific.

Everything here is grounded in specific ChainSpot files and line-level patterns.
Where the original design hypotheses (collection wrappers, structured-condition
predicates, config-driven spying) turned out not to match the real code, this
document says so and replaces them.

---

## Part 1 — What the ChainSpot tee pipeline actually looks like

### 1.1 The representative path

The production tee path (driven by `src/lib/autoAnnotation/basketDetection.worker.ts`
~line 800) is:

```
decoded RGBA raster (full resolution)
  → detectRawObjectMask()                 rawObjectMask.ts      "Pancake 1"
      bright/dark HSV threshold masks
      → connected components (hand-rolled BFS flood fill)
      → basket family (shape pool filter + dominant-size-cluster consensus)
      → badge family  (same pattern on the dark mask)
      → tee family    (bright components filtered by badge/basket-derived bounds)
      → appearance gate (rotation-normalized NCC vs. template bank, teeAppearance.ts)
  → badge labeling (holeNumberDetection.ts, OpenCV template matching)
  → detectWorldNormalizedTeeBootstrap()   cvCalibratedDetectors.ts
      measureWorldScale → maybe resize into a canonical workspace
      → detectCalibratedTeeBootstrap()
          tier "primary":  detectTeePadCandidates()          teePadDetection.ts
              gray-center: HSV window mask → cv.findContours → area/size/aspect/
                           rectangularity gates → score → sort
              edge-loop:   blur → Canny → contours → size/rectangularity/visual
                           gates → weighted score → NMS (tooClose) → top-16
              adaptive gray-center re-run (window derived from baseline candidates)
              → fuseCandidates()  (distance merge, support union, max score)
              → filterSizeConsistentCandidates()  (bimodal minor-axis split)
              → sortAndSliceFused()  (rank by support count, score; top-18)
          tier "occluded": detectOccludedEdgeLoopCandidates()
              Canny → HoughLinesP → segment length gates → spatial-hash pairing →
              parallel/geometry/visual gates → occludedPairScore → NMS
          → assessTeeBootstrap()          teeBootstrapPolicy.ts     (association)
              calibration from candidate pool (median major axis)
              per candidate: NCC orientation sweep → badge-ray ownership →
              AUTO / REVIEW / UNRESOLVED with reasons: string[]
          tier "weak-template": proposeWeakTeeCandidates() for unresolved badges
          tier "masked-recovery": re-run occluded detector with occlusion masks
          → deduplicatePhysicalTeePads()  (greedy clustering, keeps sourceIndexes)
          → assessTeeBootstrap() again (called up to 4× on a growing pool)
  → grammar/ownership downstream
```

The Heritage failure is `resources/held-out/HeritagePark-Main.png`: a UDisc app
screenshot on a satellite basemap. The pipeline reports 0 gate-passed tees on all
18 holes (`scripts/cv-probes/grayt-tuning-report.md`). The report *believes* this
is correct — the screenshot has no rendered tee glyphs — but establishing that
took a human staring at diagnostic overlay PNGs and a retracted/re-retracted
correction thread for hole 2. That thread is precisely the debugging experience
Toph exists to replace: the question "where did hole 7's tee evidence first
disappear?" is currently answered by archaeology, not by data the pipeline kept.

### 1.2 Concrete data structures

- **Rasters**: `Uint8Array` planes (`gray`, `saturation`, `value` from `readHsv`),
  binary masks (`bright`, `dark`, `centerMask`), OpenCV `Mat`s (blurred, edges) —
  all transient, freed/GC'd before return.
- **Components**: `MaskComponent` (bbox, area, centroid, PCA orientation, fill) from
  a hand-rolled flood fill; contours from `cv.findContours`.
- **Candidates**: plain readonly object literals — `AnalysisCandidate`,
  `TeePadCandidate {xPx, yPx, orientationDeg, widthPx, heightPx, score, support[],
  provenance?}`. **No classes anywhere in the CV code.** Derivation is by spread:
  `{ ...existing, score, support }`.
- **Association output**: `TeeBootstrapAssignment {holeNumber, candidateIndex,
  decision, confidence, padEvidence, orientationEvidence, ownershipEvidence,
  badgeRay, reasons: string[]}`.

### 1.3 The load-bearing observation: ChainSpot already built five ad-hoc Tophs

The codebase is saturated with hand-rolled partial observability:

| Ad-hoc mechanism | Where | What it preserves | What it loses |
|---|---|---|---|
| `TeePadStageCounts` (`discovered/area/size/aspect/…/final`) | teePadDetection.ts:70 | how many survived each gate | **which** ones, and why each died |
| `support: TeePadSupport[]` + `provenance: {tier, support}[]` | teePadDetection.ts:23–49 | which detector/tier produced a candidate | the upstream component/mask evidence |
| `dedupClusters: sourceIndexes[]` + `rawCandidates` | cvCalibratedDetectors.ts:135 | which raw candidates merged into which pad | everything before the candidate pool |
| `reasons: string[]` + evidence enums | teeBootstrapPolicy.ts:85–116 | human-readable decision rationale | measured values vs. thresholds, losing rays |
| `diagnostics` + `rejectedCandidateIndexes` | rawObjectMask.ts:66, teeBootstrapPolicy.ts:110 | pool sizes, thresholds, rejected indexes | rejected *reasons* |

This is the strongest possible evidence that the need is real — and it defines
Toph's success criterion: **each of these five mechanisms should be expressible as
a Toph call, and most of the hand-rolled bookkeeping should become deletable.**
It also constrains the design: whatever Toph is, it must fit code that already
does this bookkeeping imperatively, inside loops.

### 1.4 What the code does NOT look like (hypothesis check)

The design brief hypothesized `components.filter(...).map(...).sort(...)` chains.
The real hot path is **not** fluent. The dominant pattern is an imperative loop
over OpenCV contours with sequential named gates and early `continue`
(teePadDetection.ts:609–628):

```ts
const area = cv.contourArea(contour);
if (area < 15 * scale * scale || area > 150 * scale * scale) continue;
areaAccepted += 1;
const rect = cv.minAreaRect(contour);
const { major, minor } = rectDimensions(rect);
if (minor < 5 * scale || minor > 12 * scale || major < 8 * scale || major > 20 * scale) continue;
sizeAccepted += 1;
if (major / minor < 1.1 || major / minor > 3.0) continue;
aspectAccepted += 1;
```

Array `.filter` with a compound predicate exists too (rawObjectMask.ts:324–341,
six conditions in one boolean expression; filterSizeConsistentCandidates), but
it is the minority. Any API built primarily around wrapping collections would
force the majority of the pipeline to be restructured before it could be
observed. That kills the "low instrumentation friction" requirement.

Two other realities the design must absorb:

- **Thresholds are frequently course-derived, not constants.** The tee-family
  gate compares against `basketMedianArea * 0.09`, `badgeMedianHeight * 0.45`;
  the review band comes from percentiles of AUTO assignments; the adaptive
  gray-center window is derived from baseline candidates. A trace format that
  hardcodes "the threshold" as config is wrong; thresholds are runtime values
  that must be recorded per run — and are themselves interesting evidence.
- **Stages repeat.** `assessTeeBootstrap` runs up to four times per image on a
  growing pool. Stage identity must be an *invocation*, not a global name.

---

## Part 2 — The eleven questions

### 1. What is the fundamental unit Toph tracks?

**An entity: one Toph-assigned integer ID per pipeline object (component,
candidate, assignment), forming nodes in a lineage DAG. Everything else —
checks, decisions, derivations, raster snapshots — is an append-only event
that references entity IDs and stage-invocation IDs.**

Why not the alternatives:

- *The candidate object itself* — fails because ChainSpot derives by spread;
  object identity dies at every `{...c}` and every coordinate-space mapping
  (`sourceCandidate`, `backToNative`).
- *Collection element (index)* — ChainSpot already tried this
  (`sourceIndexes`, `candidateIndex`, `rejectedCandidateIndexes`) and the
  worker has a comment apologizing that `assignments` is "not positionally
  aligned" with `candidates`. Indexes are exactly the bug-prone thing to
  abstract away.
- *Region/raster* — regions are one entity kind, not the unit; most of the
  interesting history (fusion, ranking, ownership) happens after pixels stop
  mattering.
- *Event alone* — events without stable entity IDs can't answer "show me the
  history of this pad," which is the headline query.

So: **entity ID as the spine, events as the record.** The trace is an event log;
the DAG is derived from it.

### 2. How should lineage work?

One derivation event vocabulary, kept deliberately small because every case
below is present in the tee path:

| Operation | Real example | Lineage record |
|---|---|---|
| **filter** (gate) | area/size/aspect gates | no new node; `decision {entity, stage, outcome: rejected, at: "size"}` plus the check events that caused it |
| **map/transform** | `sourceCandidate` (analysis→source px), `backToNative`, `scalePoint` | new node, `derive {child, parents: [p], kind: "transform"}`; carries a `space` change |
| **mutation/clone** | `{...existing, score, support}` in `fuseCandidates` | same as transform with `kind: "clone"`; the child is a new node — never mutate a node's recorded attrs |
| **merge** | `fuseCandidates`, `mergedCandidate` in dedup | new node, `derive {child, parents: [a, b, …], kind: "merge", rep: a}` (`rep` = which parent's geometry won, matching ChainSpot's "keep first center, best score" rule) |
| **split** | not in tee path (dash→chain grouping is a merge) | `derive {children: [...], parents: [p], kind: "split"}` — schema supports it, no adapter sugar yet |
| **suppression/NMS** | `tooClose` loops, `dedupeDashes` | `decision {entity, outcome: "suppressed", by: winnerEntityId}` — the rejection reason is a *reference to another entity*, not a threshold |
| **ranking/cap** | `sort` + `slice(0, maxCandidates)` | `decision {entity, outcome: "ranked-out", rank, cutoff}` for the losers; survivors get `rank` |
| **assignment/association** | badge-ray ownership in `assessTeeBootstrap` | `assign {entity, target: {kind: "badge", key: holeNumber}, outcome, evidence: {distancePx, angularErrorDeg, …}}`; contention loss = `decision {outcome: "lost-contention", by: winnerEntityId, target}` |

The awkward cases, not waved away:

- **Repeated stages.** Every `trace.stage(name)` call opens a new *stage
  invocation* with a fresh sequential ID. Four `assessTeeBootstrap` runs are four
  invocations sharing a name; a candidate assessed four times has four decision
  events, each pinned to its invocation. The viewer's scrubber orders by
  invocation sequence, not by name.
- **Identity across function boundaries.** Entities cross functions as plain
  objects with no handle parameter. The recorder keeps a `WeakMap<object, id>`;
  `trace.spawn(obj, …)` registers, `trace.idOf(obj)` recovers. Spreads break
  WeakMap identity **by design** — a spread is a derivation and must be recorded
  as one. The vertical slice tests whether the derivation sites are few enough
  (in the tee path they are: `sourceCandidate`, `fuseCandidates`,
  `mergedCandidate`, `backToNative`, `withTier` — about six).
- **Population-relative decisions.** `dominantSizeCluster` (consensus),
  `filterSizeConsistentCandidates` (bimodal split), `deriveAdaptiveGrayCenterWindow`
  — an element's fate depends on the whole population, and there is no per-element
  threshold to record. These get a `select` event: `select {stage, name, kept: [ids],
  rejected: [ids], basis: {…free-form, e.g. anchor, splitValue}}`. If a large
  fraction of real decisions needed `basis` blobs to be intelligible, that would
  be a sign the vocabulary is too small — one of the falsification criteria below.
- **Coordinate spaces.** Every entity and raster asset carries a `space` string
  ("source", "analysis@0.5", "canonical-tee"). Transform derivations record the
  space mapping (scale/offset). Without this, the viewer draws boxes on the wrong
  raster — the world-normalization path guarantees it.

### 3. What should the API look like in normal CV code?

The core is a `Trace` handle, threaded explicitly (ChainSpot already threads a
`cv` handle and options objects everywhere — same seam). No globals, no ambient
magic in the core.

**Before** (teePadDetection.ts, gray-center loop):

```ts
let areaAccepted = 0; let sizeAccepted = 0; let aspectAccepted = 0; // …
for (let index = 0; index < contours.size(); index += 1) {
  const contour = contours.get(index);
  const area = cv.contourArea(contour);
  if (area < 15 * s2 || area > 150 * s2) continue;
  areaAccepted += 1;
  const rect = cv.minAreaRect(contour);
  const { major, minor } = rectDimensions(rect);
  if (minor < 5 * s || minor > 12 * s || major < 8 * s || major > 20 * s) continue;
  sizeAccepted += 1;
  if (major / minor < 1.1 || major / minor > 3.0) continue;
  aspectAccepted += 1;
  const rectangularity = area / (major * minor);
  if (rectangularity < 0.6) continue;
  rectangularityAccepted += 1;
  candidates.push(candidateFromRect(rect, rectangularity, 'gray-center'));
}
```

**After** (counters deleted — stage counts now derive from the trace):

```ts
t.stage('tee.grayCenter');
for (let index = 0; index < contours.size(); index += 1) {
  const contour = contours.get(index);
  const area = cv.contourArea(contour);
  const rect = cv.minAreaRect(contour);
  const { major, minor } = rectDimensions(rect);
  const e = t.spawn('component', { rect, area }, { space: 'analysis' });
  if (!t.range(e, 'area', area, 15 * s2, 150 * s2)) continue;
  if (!t.range(e, 'minor', minor, 5 * s, 12 * s) || !t.range(e, 'major', major, 8 * s, 20 * s)) continue;
  if (!t.range(e, 'aspect', major / minor, 1.1, 3.0)) continue;
  const rectangularity = area / (major * minor);
  if (!t.gte(e, 'rectangularity', rectangularity, 0.6)) continue;
  const c = candidateFromRect(rect, rectangularity, 'gray-center');
  t.keep(e, c);           // registers c as the surviving form of e
  candidates.push(c);
}
```

Notes on friction:

- One hoist (minAreaRect computed before the area gate instead of after) so the
  entity can be spawned with geometry. That is the entire restructuring cost of
  this loop. Where even that is unacceptable, `t.spawn` accepts geometry later
  via `t.attrs(e, {...})`.
- The five counter variables and the `stageCounts` return plumbing become
  deletable — instrumentation *removes* code here.
- `t.gte`/`t.range`/`t.lte`/`t.check(e, name, pass, value?, …)` return the
  boolean, so the production control flow is unchanged and the comparison is
  computed exactly once. Threshold values are recorded from the arguments —
  which is what makes course-derived thresholds come out for free.

**Before/after for a derivation site** (`fuseCandidates`):

```ts
// before
fused[existingIndex] = { ...existing, score: Math.max(existing.score, candidate.score), support };

// after
const merged = { ...existing, score: Math.max(existing.score, candidate.score), support };
t.merge([existing, candidate], merged, { rep: existing });
fused[existingIndex] = merged;
```

**Association** (`assessTeeBootstrap`) — the existing `reasons.push(...)` strings
become structured but stay one-liners:

```ts
t.assign(e, { badge: best.holeNumber }, 'auto', {
  distancePx: best.distancePx, angularErrorDeg: best.angularErrorDeg, acrossPx: best.acrossPx
});
// and for the loser of contention:
t.decide(e, 'lost-contention', { by: winnerId, badge: badge.holeNumber });
```

### 4. How much can function passing simplify the API?

Less than hypothesized, for the majority of the code — and where it applies, the
proposed structured-condition form is actively harmful.

The brief proposed predicates returning condition arrays:

```ts
trace.filter("tee.geometry", components, c => [trace.gte("area", c.area, 8), …]);
```

Problem: the predicate is production logic. When tracing is disabled the filter
must still run, so this form allocates an array of condition objects per element
per gate *in production*. That violates the zero-cost constraint at the exact
place it matters (hot per-contour loops). It also can't express early-exit
short-circuiting (ChainSpot's gates deliberately skip computing later
measurements for dead candidates — e.g. `rotatedRectVisualStats` only runs after
rectangularity passes, and it's a pixel loop).

What function passing *is* good for: the minority of sites that already are
array operations. For those, thin sugar that sets an ambient "current entity"
around the predicate call:

```ts
// rawObjectMask.ts:324 today: brightComponents.filter(c => sixConditions)
teeComponents = t.filter('tee.family', brightComponents, (c) =>
  t.range('areaVsBasket', c.areaPx, basketMedianArea * 0.09, basketMedianArea * 0.35) &&
  t.gte('minDim', minDimension, badgeMedianHeight * 0.45) &&
  t.lte('maxDim', maxDimension, basketMedianWidth * 2) &&
  t.lte('bboxAspect', bboxAspect, 2.2) &&
  t.range('fill', c.fill, 0.12, 0.55)
);
```

Inside `t.filter`, gate calls omit the entity argument and bind to the element
being tested; `&&` gives short-circuit for free; disabled `t.filter` is
`(name, xs, fn) => xs.filter(fn)` and the gates degrade to bare comparisons. So
Toph learns pass/fail, measured value, threshold, and the semantic name — from
arguments the code was already computing — without per-element allocation.
Semantic rejection reasons come from the gate *names*; the first failing gate in
an `&&` chain is the rejection reason (later gates simply have no events, which
the viewer renders as "not evaluated" — an honest representation of
short-circuiting).

One rule makes the whole API safe: **trace calls take scalars and references the
code already has; they never take freshly-built objects or closures on the hot
path.** The only exception is `spawn`/`attrs` payloads, which are per-entity
(tens–hundreds per image), not per-pixel.

### 5. Should Toph wrap collections?

**No trace-aware collection abstraction, and no fluent `trace(xs).filter(…)`
builder.** Compared:

- `trace(xs).filter(name, fn).map(name, fn)` — matches almost none of the
  existing code (imperative loops, spatial-hash pairing, greedy NMS, union-find
  chaining are not expressible as filter/map); would force a rewrite of the
  pipeline to observe it; adds a wrapper type that every signature would have to
  either accept or unwrap. Rejected.
- `trace.filter(name, xs, fn)` — fine as optional sugar over plain arrays (see
  Q4), because it returns a plain array and touches nothing else. Adopted, as
  sugar only.
- Plain arrays + explicit calls (`spawn`/gates/`keep`/`merge`/`decide`) — the
  core. It is the only form that fits the dominant loop shape, and it degrades
  gracefully: any code Toph's vocabulary can't express can still emit raw
  `check`/`decide`/`select` events.

Core = explicit calls on plain data. Sugar = `t.filter`, later maybe `t.nms`,
built on the same events. Nothing in the core knows what a collection is.

### 6. Where does raster provenance meet entity provenance?

**At the component, via label maps — never per-pixel events.**

Three raster asset kinds, all stored as PNG (binary masks and label maps are
near-flat images; they compress to a few KB):

- `image` — the input raster (or a stage's derived plane like the HSV value
  channel), for viewer display.
- `mask` — a binary mask (bright, dark, centerMask, Canny edges). Records the
  operation metadata that produced it (`{op: "threshold", params: {valueMin: 210,
  saturationMax: 45}}`) so the viewer can explain any pixel's mask value from
  the source pixel without Toph storing anything per pixel.
- `labelmap` — component index per pixel (16-bit PNG). ChainSpot's
  `collectComponents` flood fill can emit this with one extra write per visited
  pixel, done only when tracing (the one legitimate `if (t.enabled)` site).
  Component entities record `{asset: labelmapId, label: n}` plus bbox/area.

The pixel query then needs no stored events at all — the viewer computes:

```
pixel (x,y)
  → mask asset:      bright[x,y] = 1?  (explained by the recorded threshold params)
  → labelmap asset:  label 17 → component entity C17
  → lineage DAG:     C17 → candidate T4 → decision events → "rejected at aspect, 1.40 < 1.55"
```

and the headline first-loss query is its inverse: GT point → labelmap hit? If no
bright pixel at the GT point, the loss happened at thresholding, and the viewer
can display the actual RGB/HSV values there against the recorded window — the
exact Heritage answer ("the mask never contained tee pixels because nothing at
that location is value≥210/sat<45").

Region geometry beyond bbox is *not* duplicated into entities; the labelmap is
the region store. RLE per entity is a later optimization if labelmaps prove
awkward, not part of the slice.

### 7. Can generic method/class spying work?

Evaluated against the real code; the answer is: **as a coarse capture layer yes,
as a lineage/explanation mechanism no — and in this codebase there is barely
anything to hook.**

- **Class/method interception (Mockito-style, decorators):** ChainSpot's CV code
  contains no classes and almost no methods — it is module-level functions
  producing frozen-shape object literals. There is no `TeeDetector.findCandidates`
  to spy on. Decorators and prototype patching have no attachment points.
- **Function wrapping at module boundaries** (wrap `detectTeePadCandidates`,
  `fuseCandidates`, …): can capture arguments and return values, giving
  stage-level input/output snapshots for free. But every interesting decision is
  loop-local: the six-way `continue` chain, the `findIndex` inside
  `fuseCandidates`, the greedy `usedCandidates` claim in `assessTeeBootstrap`.
  None of that crosses a function boundary. A wrapper can tell you 143
  components went in and 12 candidates came out; it cannot tell you which gate
  killed component 89, because that fact exists only transiently in a local
  boolean. **Rejection reasons, merge membership, and suppression references are
  semantic facts that must be stated at the point where the code knows them.**
  This confirms the brief's skepticism — but now with a mechanical argument, not
  a hunch: the information is not present at any interceptable boundary.
- **Config-driven watching** (`watch: {class, method, objects}`): strictly
  weaker than function wrapping plus it adds a config language, name coupling to
  app internals, and a false sense of coverage. Rejected outright.

Where interception *does* pay: the `cv` module handle. See Q8.

Verdict: automatic capture is an adapter-layer convenience for *raster
operations and stage boundaries*; entity lineage and decisions are semantic
instrumentation, full stop.

### 8. Where can framework adapters help?

ChainSpot hands every detector an explicit `cv: TeePadCv` object (a narrowed
OpenCV surface — teePadDetection.ts:159). That is a perfect seam: an adapter
`wrapCv(cv, t)` returns a same-shaped object whose methods delegate and record:

- Automatic capture is realistic for: `GaussianBlur`, `Canny`, `threshold`,
  `inRange`, morphology, `resize`, `warpAffine` (raster in → raster asset out,
  op + params as metadata); `findContours` / `connectedComponents(WithStats)`
  (mask in → auto-spawned component entities + labelmap); `matchTemplate`
  (score-map asset); `HoughLinesP` (segment entities).
- Remains application-defined, always: what the mask *means* (`tee.brightMask`
  vs. just "output of inRange"), gate names and thresholds, candidate
  construction, fusion/dedup semantics, association targets (badges), scoring
  formulas. The adapter names ops; the app names intent.

Two cautions from the actual code: half of ChainSpot's raster work is *not*
OpenCV (`readHsv`, `collectComponents`, the bright/dark mask loops are hand-rolled
typed-array code) — so the manual `t.raster(...)` path is the primary API and the
cv adapter is sugar over it; and the adapter must not snapshot every Mat
unconditionally (edge images at full res on every blur would bloat traces) —
capture policy (all / named-only / off) belongs to the recorder config.

Adapters live in separate entry points (`toph/opencv`), never in core. Core
knows nothing about OpenCV, Mats, or ChainSpot.

### 9. How should tracing compile out?

Compared, for a TS/JS Vite/tsx codebase:

1. **Runtime no-op singleton, recorder tree-shaken out** *(recommended)*.
2. Conditional package exports (`"toph": {"production": "./noop.js"}`) — build
   flavor selects the module. Works, but ties enablement to build mode; you
   often want a *production build* with tracing available behind a flag for a
   one-off repro. Kept as an option, not the mechanism.
3. Compile-time define + minifier DCE (`if (__TOPH__) t.…` or a `/* @__PURE__ */`
   discipline) — actually eliminates call sites, but only if every call is
   guarded (ugly everywhere) or `t` is a module global (kills explicit
   threading). Deferred until measurement justifies it.
4. Source transforms / babel strip plugins — magical, breaks sourcemaps and
   editor navigation, another build dependency. Rejected.

The recommended shape:

- `Trace` is an interface. Core exports `NOOP: Trace` — a frozen singleton whose
  gate methods are bare comparisons (`gte: (_e, _n, a, b) => a >= b`), whose
  spawn returns `0`, and whose other methods are empty bodies. `enabled: false`
  as a readonly field for the rare expensive-capture guard.
- Pipeline code: `const t = options.trace ?? NOOP;` — same pattern as the
  existing `cv` handle. Call sites are always monomorphic in production (always
  the same singleton → JIT inlines the empty bodies).
- The recorder (`toph/record`) is only imported by debug harnesses
  (`scripts/detect-tees.ts`, the verify-cv-gallery runner, a dev-mode UI toggle).
  A production bundle that never imports it tree-shakes the entire recorder,
  serializer, and PNG encoder out. **What production code actually becomes:**
  the ~50-line noop module, plus calls that pass numbers already in registers
  and return comparisons the code performed anyway. No strings are built, no
  objects allocated, no images retained, no branches beyond the ones the
  detector already had.
- Residual cost is a function call per gate per entity: on this pipeline,
  hundreds of entities × a handful of gates ≈ low thousands of no-op calls per
  image, against a pipeline doing multiple full-raster pixel passes — noise. The
  spike includes a benchmark to verify this claim rather than assert it; if it
  measurably registers, escalate to mechanism 3 for the hot loops only.

The one honest cost: `t.spawn(...)` payload objects would be allocated even when
disabled if written naively. Rule: spawn takes references to objects the code
already built (the rect, the candidate) — the noop discards them; only the
recorder copies. Sites with no existing object use `spawn(kind)` + later
`keep(e, obj)`.

### 10. What is the trace data model?

Minimum schema (TypeScript-flavored; serialized as one JSON manifest + PNG
assets in a directory — inspectable with jq and an image viewer, no custom
tooling required):

```ts
interface TophTrace {
  version: 1;
  meta: { pipeline: string; startedAt: string; source?: { image: string; widthPx: number; heightPx: number };
          spaces: Record<string, SpaceDef> };          // "source", "analysis", "canonical-tee"
  stages: StageInvocation[];
  assets: Asset[];
  entities: Entity[];
  events: Event[];
  groundTruth?: GroundTruth;
}

interface SpaceDef { toSource: { scale: number; dx?: number; dy?: number } }   // affine-lite; enough for this pipeline

interface StageInvocation { id: number; name: string; seq: number; parent?: number }

interface Asset {
  id: number; stage: number; name: string;
  kind: 'image' | 'mask' | 'labelmap' | 'scoremap';
  space: string; widthPx: number; heightPx: number;
  uri: string;                                          // relative PNG path
  op?: { name: string; params: Record<string, number | string> };   // e.g. threshold window
  inputs?: number[];                                    // asset lineage (mask ← image)
}

interface Entity {
  id: number; kind: string;                             // 'component' | 'candidate' | ... app-defined
  stage: number;                                        // spawning invocation
  space: string;
  geom?: { x: number; y: number; w?: number; h?: number; angleDeg?: number };
  region?: { asset: number; label: number };            // ← raster↔entity join point
  attrs?: Record<string, number | string | boolean>;    // score, support, fill, …
}

type Event =
  | { t: 'check';  stage: number; entity: number; name: string;
      op: 'gte' | 'lte' | 'range' | 'eq' | 'custom'; value: number;
      min?: number; max?: number; pass: boolean }
  | { t: 'decide'; stage: number; entity: number;
      outcome: 'kept' | 'rejected' | 'suppressed' | 'ranked-out' | 'lost-contention' | 'selected';
      at?: string;                                      // gate/step name
      by?: number;                                      // winning entity (suppression/contention)
      rank?: number; cutoff?: number;
      info?: Record<string, number | string> }
  | { t: 'derive'; stage: number; parents: number[]; children: number[];
      kind: 'transform' | 'clone' | 'merge' | 'split'; rep?: number }
  | { t: 'select'; stage: number; name: string; kept: number[]; rejected: number[];
      basis?: Record<string, number | string> }         // population-relative decisions
  | { t: 'assign'; stage: number; entity: number;
      target: { kind: string; key: string | number };   // {kind:'badge', key: 7}
      outcome: string;                                  // 'auto' | 'review' | app-defined
      evidence?: Record<string, number> }
  | { t: 'measure'; stage: number; entity: number; name: string; value: number };  // non-gate measurements

interface GroundTruth {
  objects: { label: string;                              // "tee H7"
             point: { x: number; y: number; space: string };
             expect?: string }[];                        // expected entity kind
}
```

Deliberately absent (viewer-computed, not stored): stage counts (fold of
`decide`), the lineage DAG adjacency (fold of `derive`), first-loss analysis
(GT point → labelmap → walk lineage → first non-kept decision; if no labelmap
hit, loss = the mask stage, explained by the mask's recorded `op.params`).
Storing only facts and deriving all analysis keeps the writer dumb and the
format stable.

### 11. What should NOT be generalized yet?

- **No pipeline/graph framework.** Toph never runs, schedules, or defines
  stages; it observes code that runs itself. (`stages` are just invocation
  markers.)
- **No OpenCV adapter in the slice.** The spike path (`rawObjectMask` +
  gray-center) is mostly hand-rolled typed arrays; the adapter is phase 2, after
  the manual API is validated.
- **No generic condition/DSL language.** Gate ops are `gte/lte/range/eq/custom`.
  Composite scoring formulas (edge-loop's 8-term score) are recorded as
  `measure` events per term if the app cares, not modeled.
- **No video/multi-frame, no tracking, no async/streaming trace transport.**
  One image, one trace, written at end of run.
- **No viewer framework.** First viewer is a static HTML page reading the
  manifest — scrub stages, click entities, run the GT query. No server.
- **No config-driven watching, no auto-diffing between runs, no VLM interface.**
  The serialized trace being plain JSON+PNG *is* the VLM interface for now.
- **No general affine/homography space model** — `scale+offset` covers every
  space in this pipeline (analysis downsample, world-normalization resize).
- **No storage budget machinery** beyond "recorder off / on / named-assets-only".
- **Only one consumer.** API changes freely until a second pipeline exists;
  nothing is versioned except the trace format itself (`version: 1`).

---

## Part 3 — The vertical slice

Instrument exactly: `input → white mask → connected components → initial tee
candidates → accepted/rejected + why`, in ChainSpot's `detectRawObjectMask`
(rawObjectMask.ts) — the "Pancake 1" path that runs first in production and is
OpenCV-free, so the slice tests the core API with zero adapter work. It is also
the path where Heritage's "0 tees" is decided.

### Tiny core API (the whole surface for the spike)

```ts
// package: toph  (core, ~200 lines + types)
interface Trace {
  readonly enabled: boolean;
  stage(name: string): number;
  raster(name: string, kind: 'image' | 'mask' | 'labelmap',
         data: Uint8Array | Uint8ClampedArray, widthPx: number, heightPx: number,
         opts?: { space?: string; op?: { name: string; params: Record<string, number | string> } }): number;
  spawn(kind: string, obj?: object,
        opts?: { space?: string; geom?: Geom; region?: { asset: number; label: number };
                 attrs?: Record<string, number | string | boolean> }): number;
  idOf(obj: object): number;                       // 0 when unknown/disabled
  attrs(e: number, attrs: Record<string, number | string | boolean>): void;
  gte(e: number, name: string, value: number, min: number): boolean;
  lte(e: number, name: string, value: number, max: number): boolean;
  range(e: number, name: string, value: number, min: number, max: number): boolean;
  check(e: number, name: string, pass: boolean, value?: number): boolean;
  keep(e: number, obj?: object): void;             // survived the stage; optionally bind surviving object
  reject(e: number, at: string): void;             // explicit rejection (when not implied by a failed gate)
  merge(parents: object[], child: object, opts?: { rep?: object }): number;
  transform(parent: object, child: object, space?: string): number;
  select(name: string, kept: object[], rejected: object[], basis?: Record<string, number | string>): void;
  assign(e: number, target: { kind: string; key: string | number }, outcome: string,
         evidence?: Record<string, number>): void;
  filter<T>(name: string, xs: readonly T[], fn: (x: T) => boolean): T[];   // sugar; binds ambient entity
}
export const NOOP: Trace;

// package: toph/record
export function createTrace(opts: { pipeline: string; dir: string }): RecordingTrace; // .finish(): Promise<manifestPath>
```

Gate semantics: a failed gate auto-records `decide{rejected, at: name}` for that
entity in the current stage; `keep` records the survivor. Inside `t.filter`, the
entity argument is implicit.

### Tiny trace schema

Exactly the Part 2 §10 schema, restricted to what the slice emits: `check`,
`decide`, `derive(kind: transform)`, `select`, `measure`; asset kinds `image`,
`mask`, `labelmap`; spaces `{"source": {toSource: {scale: 1}}}`. Output layout:

```
trace-heritage/
  manifest.json
  assets/000-input.png  001-bright-mask.png  002-dark-mask.png  003-bright-labels.png
```

### Exact ChainSpot call sites (rawObjectMask.ts, `detectRawObjectMask`)

1. **Signature**: add `trace?: Trace` to `RawObjectMaskRaster`'s companion options
   (or a second param); `const t = trace ?? NOOP;`.
2. **line ~268 (mask build loop)**: after the loop, `t.raster('brightMask', 'mask',
   bright, width, height, { op: { name: 'hsvThreshold', params: { valueMin: 210,
   saturationMax: 45 } } })`; same for `dark`. (Input image registered by the
   caller/harness, not by this function.)
3. **`collectComponents` (line ~121)**: accept optional `labels?: Uint16Array`;
   when `t.enabled`, fill it during the flood fill (one write per visited pixel)
   and `t.raster('brightLabels', 'labelmap', …)`. Each returned `MaskComponent`
   is spawned: `t.spawn('component', component, { geom: bbox, region: { asset,
   label } , attrs: { areaPx, fill, orientationDeg } })`.
4. **basket pool filter (line ~289)** and **badge pool filter (line ~300)**:
   rewrite the compound predicates as gate chains via `t.filter('basket.shapePool',
   …)` / `t.filter('badge.shapePool', …)`.
5. **`dominantSizeCluster` (line ~208)**: after choosing `best`,
   `t.select('basket.sizeConsensus', best, pool minus best, { anchorW, anchorH,
   anchorArea })` — the population-relative case.
6. **tee family filter (lines ~324–341)**: the six-condition predicate becomes
   the Q4 gate chain (`verticalBand`, `insideBadge` via `t.check`, `areaVsBasket`,
   `minDim`, `maxDim`, `bboxAspect`, `fill`) — thresholds here are the
   course-derived `basketMedianArea`/`badgeMedianHeight` values, recorded per run.
7. **appearance filter (lines ~343–351)**: `passesTeeAppearanceCheck` already
   computes a score internally; expose it (`bestTeeTemplateScore`) at this call
   site and record `t.gte(e, 'appearanceNcc', score, 0.38)`.
8. **final mapping (line ~354)**: `t.transform(component, teeObject)` +
   `t.keep(...)` for each emitted `RawMaskTee`; the `diagnostics` block
   (line ~389) becomes redundant and is a deletion candidate once the trace
   covers it.
9. **Harness**: `scripts/detect-tees.ts` (or a 30-line sibling script) creates the
   recorder, registers the input PNG, runs `detectRawObjectMask` on
   `resources/held-out/HeritagePark-Main.png`, calls `.finish()`.

Roughly 15 call sites, one signature change, one optional out-param on the flood
fill. Nothing outside `rawObjectMask.ts` + `teeAppearance.ts` (one exported
score) + the harness.

### What one resulting Heritage trace contains

- 1 stage tree (`rawObjectMask` → `brightComponents` → `basket.shapePool` →
  `badge.shapePool` → `tee.family`), 4 assets (input, bright mask, dark mask,
  bright labelmap; PNG total well under ~1 MB).
- One `component` entity per bright/dark component (order 10²–10³ on a satellite
  screenshot — this is the trace-size stress test).
- Per bright component in the tee stage: check events with measured value,
  threshold, pass/fail — including the derived thresholds
  (`basketMedianArea * 0.09` etc.) as concrete numbers for *this* image.
- `select` events showing which components the basket/badge consensus clusters
  kept, with the anchor basis.
- Final: 0 `tee` entities kept, and — the point — for any pixel the user clicks
  on a tee pad in the screenshot, the viewer answers one of:
  (a) "not in bright mask — value/sat here is 174/61 vs. required ≥210/<45"
  (thresholding loss — the expected Heritage answer),
  (b) "component C143, rejected at `areaVsBasket`: 3120 outside [491, 1907]", or
  (c) "rejected at `appearanceNcc`: 0.31 < 0.38",
  each with the full gate table (✓/✗ per gate, observed vs. required).

### What this spike tests

1. **Friction**: can the compound predicates be rewritten as gate chains without
   distorting the code? (Target: the diff makes the function *more* readable —
   the gates get names.)
2. **Zero-cost claim**: benchmark `detectRawObjectMask` with `NOOP` vs. the
   un-instrumented original on the fixture corpus. Target: within noise (<1%).
3. **Identity model**: WeakMap + explicit `transform` at the component→tee
   boundary — is the number of derivation sites really small?
4. **Raster↔entity join**: is labelmap-per-mask enough to answer the pixel query
   with no per-pixel events, at acceptable file size?
5. **Vocabulary coverage**: do `check/decide/derive/select` cover this stage's
   decisions, including the consensus clustering?
6. **Payoff**: can `diagnostics`, and later `stageCounts`, be deleted because
   the trace subsumes them?

### What would falsify the architecture

- **Perf**: NOOP instrumentation costs >1% on the fixture benchmark and can't be
  fixed by hoisting — forces the compile-time-define mechanism into the core
  design (Q9 option 3) or coarser-grained instrumentation.
- **Friction**: instrumenting `detectRawObjectMask` requires restructuring
  beyond hoisting a measurement or splitting a compound predicate — e.g. if
  gate chains force computing measurements for entities that the original code
  skipped, changing performance or behavior. Forces a rethink toward
  post-hoc/replay-based capture instead of inline calls.
- **Identity**: entity IDs get lost or duplicated in practice (spread sites
  missed, WeakMap misses across the worker boundary) at a rate that makes
  lineage untrustworthy. Forces either an ID-carrying field on the domain
  objects (invasive) or index-based lineage (the thing we rejected).
- **Trace size**: the satellite screenshot produces so many mask components
  that entities+events dominate (≫10 MB) — forces lazy/streaming recording or
  component sampling, which changes the "preserve rejected evidence" promise.
- **Vocabulary**: more than ~⅓ of this single stage's decisions end up as
  opaque `select`/`custom` events with free-form `basis` blobs — the event
  vocabulary is wrong, and a redesign should start from ChainSpot's decision
  taxonomy rather than the generic one.
- **Usefulness**: with the trace in hand, the Heritage hole-2 question ("which
  gate would a real pad at the badge-2 location have failed?") still requires
  reading detector source — the trace records mechanics but not the explanation.
  That would mean the unit of record is wrong (events too fine, missing a
  stage-level narrative layer).

If the spike passes, phase 2 extends the same API up the tee path
(`detectTeePadCandidates` gates, `fuseCandidates`/dedup merges,
`assessTeeBootstrap` assignments — replacing `stageCounts`, `provenance`,
`dedupClusters`, `reasons`) and adds the static viewer; phase 3 is the OpenCV
adapter on the `TeePadCv` seam.
