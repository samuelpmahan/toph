# Phase 7 — evidence-based review

Stop point per the orchestration brief: before considering any broader
instrumentation (ChainSpot's P3–P6, additional directives, a viewer),
answer the eight questions honestly against what was actually built and
run, then recommend the next smallest increment — not the whole roadmap.

## The eight questions

**1. Did annotations improve or harm detector readability?**

Improved, with one real cost. The seven-condition compound boolean
(`return (a && b && c && d && e && f && g)`, `rawObjectMask.ts:332-340`
before) became seven independently named, ordered gates
(`examples/heritage-first-loss/rawObjectMask.patch`) — each with a name
(`area.min`, `bbox-aspect.max`, ...) a reader didn't have before. That's a
genuine readability win, matching the brief's own stated target ("the diff
makes the function more readable — the gates get names").

The real cost: the compiler's strict "every non-final statement in a
`@toph filter` body must be a check group" rule does not allow the two
pool-membership prefilters (`centroidY` band, `centerFallsInsideBadge`)
to stay inline the way the original single-pass filter had them. They had
to move into a separate, un-annotated `geometryPool` filter immediately
before. This is a real, non-trivial restructuring — not the "one hoist"
the design brief anticipated for the fixture — though the result arguably
reads *better* (pool membership and geometry admission are now two
separately-named concerns instead of one filter doing both), it is
dishonest to call it free. Flagged in "falsified," below.

**2. How many handwritten annotation lines were required?**

Precisely, for the ChainSpot `p1.tee.geometry` integration
(`examples/heritage-first-loss/rawObjectMask.patch`):

- 10 `@toph` directive comment lines total (1 `@toph filter`, 7
  `@toph check`, 1 `@toph snapshot`, 1 `@toph entities`).
- The geometry-gate block itself grew from 18 lines (original compound
  filter) to 34 lines (prefilter split + 7 named check groups + directive
  comments) — +16 lines, all hand-written, all still ordinary TypeScript a
  reader can follow with zero Toph knowledge (directives are comments; the
  rest is a `const`/`if` pair per gate, exactly the brief's own example
  shape).
- Whole file: 405 → 427 lines (+22), the remaining 6 lines being
  `export`/`labels?` additions for the label-map bridge, not the directive
  vocabulary itself.

**3. How many generated lines replaced them?**

The generated trace-mode file is **423 lines — 4 lines shorter than the
427-line annotated source it was compiled from**, not longer. Directive
comments (10 lines) are dropped entirely and replaced by runtime calls of
comparable-or-smaller line footprint (a `const x = __toph.gte(...)` is the
same line count as the `const x = expr;` it replaces; `enterStage`/`keep`/
`snapshotRaster`/`spawnEntities` add one line each at their call sites).
Line-for-line, "generated code" is not bigger than "annotated code" here —
the directive comments were the only thing purely additive to the
hand-written source, and they vanish in trace mode, replaced by calls that
fit in the space they vacated.

**4. Did exact execution differ from prior inferred Heritage reports?**

No, at the outcome level — and that consistency is itself evidence the
integration is trustworthy. `scripts/cv-probes/grayt-tuning-report.md`
already reported 0 gate-passed tees on all 18 Heritage holes; this trace
reproduces exactly that (`tees: []`, confirmed byte-identical to the
untouched baseline in both Phase 4 and Phase 6). What's different is
*depth*, not outcome: the prior report could say "0 tees, believed
correct" only after a human read diagnostic overlay PNGs; this trace says,
for any of the 313 candidates that reached the geometry gate, exactly
which check it failed and with what numbers — including, for the
hand-identified H1 candidate, `area.min: 109 >= 157.14 → FAIL`,
`min-dimension` and the other five checks never evaluated. That evidence
did not exist anywhere before this trace.

**5. Did entity identity survive ordinary transformations?**

Yes, verified twice — once synthetically (Phase 5's
`test/compiler/entities-and-assets.test.ts`, executing real generated code
against the real runtime and asserting a spawned entity's id is exactly
the `elementId` on its later check events) and once on real Heritage data:
entity 900 (spawned from `collectComponents`'s output) passed untraced
through the `geometryPool` prefilter — an ordinary `.filter()` call with
zero Toph involvement — and still showed up as `elementId: 900` in
`p1.tee.geometry`'s check events. The one transformation NOT tested here:
identity across a `{...spread}` clone (DESIGN.md flagged this as the
expected identity-breaking case, "by design" — a spread creates a new
object, so `WeakMap` lookup would correctly *not* find it, which is the
documented, intended behavior, not a bug — but it wasn't exercised against
real ChainSpot spread sites like `fuseCandidates`/`sourceCandidate`, since
those live outside `p1.tee.geometry`'s narrow slice).

**6. Was the trace comprehensible without source inspection?**

Yes. `toph inspect --trace trace.json --manifest manifest.json --labelmap
labelmap.json --truth truth.json --point H1`
(`examples/heritage-first-loss/inspect-output.txt`) was written and its
output interpreted using only the four JSON files it takes as input —
component geometry, check codes/values/thresholds/pass-fail, and
`file:line` source pointers all came from the manifest and trace, not from
opening `rawObjectMask.ts` mid-query. (I already knew the file from
building the patch — the honest claim is narrower: the *output itself* is
self-contained and requires no source access to interpret, which is the
criterion as stated.)

**7. Did production output remain clean?**

Yes, at every level checked: `compileProduction` returns the annotated
source byte-identical (no rewrite ever happens); Phase 3's adversarial
audit ran both an annotated-then-comment-stripped file and a hand-written
zero-`@toph` equivalent through `ts.transpileModule({removeComments:true})`
and got byte-identical output, plus a 60,000-element benchmark showing
execution time statistically indistinguishable from hand-written code
(ratios 1.006 and 0.958 across two runs); and — the strongest version of
this claim, on real production code rather than a synthetic
fixture — the actual ChainSpot harness run with the annotated-but-
uncompiled file in place produced `course.rawMaskObjects`/`tees`/
`baskets`/`numberDetection`/`grammar` byte-identical to the untouched
baseline, excluding pure wall-clock timing fields.

**8. Which parts of the architecture were falsified?**

Nothing was falsified against the brief's stated bar (production erasure,
identity trustworthiness, trace size, vocabulary coverage, usefulness all
held up under real adversarial and real-data testing — see the numbers
above and in Phase 3/5/6's commits). Two things were **not** anticipated
by the original Phase 1 scope and are worth naming precisely rather than
folding into "it just worked":

- **The strict filter-body shape forced a real restructuring**, not a
  single hoist, the first time it met real code with prefilter logic mixed
  into the same filter as gate logic (question 1, above). The compiler
  philosophy ("strict and narrow, not clever") predicts this exact
  outcome — a real shape it doesn't recognize is a compile error, not a
  guess — but the Phase 1 fixture never exercised it, so this is new,
  confirmed evidence, not a re-confirmation of something already known.
- **Ground truth does not exist for the integration target.** Heritage
  ships with no hand-verified tee/hole coordinates at all (confirmed by
  full-repo search in Phase 0, `IMPLEMENTATION-DECISIONS.md` section 9).
  The `H1` ground truth used in Phase 6 was hand-identified from the image
  by visual inspection, not sourced from an existing fixture. The 0.94px
  correspondence distance is strong evidence the identification was
  correct, but this is a real gap in the *integration target*, not
  something Toph's architecture can fix — a repeatable Toph workflow needs
  either hand-authored truth fixtures (matching `AlexClarkSet.chainspot.zip`
  / `GoldenTeeSet.chainspot.zip`'s existing pattern) or acceptance of
  "eyeballed, then confirmed by sub-pixel correspondence distance" as a
  documented, honest methodology.

## Final deliverable

**1. Implementation branch:** `claude/toph-lead-orchestration-ed7bly`
(`samuelpmahan/toph`), based on `claude/toph-architecture-design-f0h9nb`
(commit `7a4143b`).

**2. Commit list** (oldest first; `git log --oneline 7a4143b..HEAD`):

```
1c0a61c design: record compiler-spike decisions
512db8a docs: refine Heritage domain-match read from visual inspection
e0f494d feat: parse filter and check directives
3197ba5 feat: emit trace instrumentation and manifest
7247307 feat: add minimal trace runtime
343753d test: prove production erasure and exact control-flow preservation
b769353 feat: support the assignment-to-pre-declared-let filter shape
191f3a9 spike: instrument ChainSpot P1 tee geometry
acde750 feat: add raster/component support bridge
f1d2737 feat: emit Heritage first-loss trace
```

**3. Tests run and results:** `npm test` (vitest) — **137/137 passing**,
19 files (grew from 12 at Phase 1 to 137 across Phases 1–6, zero regressions
at any step — every phase's commit was preceded by re-running the full
suite, not just the new tests). `npm run check` (`tsc --noEmit`) — clean at
every commit. Every phase's tests execute real compiled output against the
real runtime in a subprocess wherever the claim is behavioral (short-circuit,
exactly-once evaluation, entity identity, production byte-identity), not
just structural string-matching.

**4. Transformed trace-build example:** `examples/heritage-first-loss/`
(manifest, source map, trace, RLE labelmap, and the exact patch) is the
full real one; `test/compiler/fixtures/demo-geometry.ts` compiled via
`compileTrace` is the minimal synthetic one from Phase 1.

**5. Transformed production-build example:** any `compileProduction` call
— by construction, byte-identical to its input. Verified specifically for
the ChainSpot patch: `examples/chainspot-p1-tee-geometry/rawObjectMask.patch`
run through `compileProduction` returns the patched source unchanged, 0
diagnostics.

**6. One real Heritage trace excerpt:**
`examples/heritage-first-loss/inspect-output.txt` — reproduced in full in
question 4's answer above and in that file.

**7. Production-residue audit:** `test/adversarial/09-production-residue-
audit.test.ts` (real comment-stripped build parity, scanner-based proof
every `"toph"` occurrence lives inside a comment) and
`10-bundle-size-and-benchmark.test.ts` (60k-element byte-identical output,
statistically indistinguishable timing) — both committed, both passing;
plus the real-ChainSpot-code confirmation in question 7, above.

**8. Concise architecture changes discovered during implementation:**

- DESIGN.md's explicit-`Trace`-handle-threading + `NOOP`-singleton
  mechanism (Q3/Q9) is superseded by compiler-directive erasure, per the
  orchestration brief's own "Important API correction" — recorded and
  reasoned through in `IMPLEMENTATION-DECISIONS.md` section 1. Everything
  else in DESIGN.md's data model (entities/events, raster/entity bridge,
  ground-truth-as-correspondence) held up as designed.
- Entity identity (DESIGN.md Q1/Q2's spine) could not stay deferred past
  the raster bridge — Phase 1–3's per-invocation ordinal wasn't enough to
  let a labelmap-spawned component and a later filter's check events refer
  to "the same thing," so Phase 5 added real `WeakMap`-based identity
  reuse, exactly the mechanism DESIGN.md originally proposed for its
  (superseded) API, now implemented under the directive-erasure model
  instead.
- The compiler's directive vocabulary grew from 2 to 4 (`@toph filter`,
  `@toph check`, `@toph snapshot`, `@toph entities`) — both new ones
  scoped exactly to what `rawObjectMask.ts` needed (one raster snapshot,
  one entity spawn site), not generalized ahead of a second real use.
- The compiler needed one shape extension mid-flight (assignment to a
  pre-declared `let`, not just `const` declarations) once it met
  ChainSpot's actual code, confirmed adversarially before touching
  ChainSpot per the project's own sequencing rule.
- Raw raster bytes were kept out of the JSON-serializable `TraceRun`
  entirely (`getRasterBytes`, live-session-only) rather than DESIGN.md's
  original "store rasters as PNG files" plan — Toph's core still has no
  image codec and this spike didn't need one; RLE-in-JSON was sufficient
  for a labelmap (197KB for a 1290×2796 image) and is documented as the
  first thing to revisit if trace sizes grow.

**9. Recommendation for the next smallest Toph increment:**

Not P3–P6. The falsification review found no structural problem, but it
did find that the integration target (ChainSpot) has real gaps this spike
worked around rather than fixed: no ground-truth fixture for Heritage, and
one shape-extension surprise. Both are cheap to close and both directly
strengthen the exact thing Phase 6 just proved works, rather than widening
scope:

1. **A real ground-truth fixture for Heritage** (or a similarly-sized
   held-out image), in the same `.chainspot.zip` + `project.json`
   `holes[]` shape `AlexClarkSet.chainspot.zip`/`GoldenTeeSet.chainspot.zip`
   already use, replacing this phase's single hand-eyeballed point with
   18 hand-verified ones. This turns Phase 6's one-point demo into a
   repeatable regression check ("does `toph inspect` still resolve every
   hole correctly after any P1 change") at near-zero new Toph surface —
   it only needs a truth-loading path in the harness, which
   `src/cli/inspect.ts` already accepts as a plain `TruthDocument`.
2. **Extend `p1.tee.geometry`'s sibling gates within the SAME stage** —
   the appearance filter (`rawObjectMask.ts:343-351`, deliberately
   un-instrumented so Phase 4/6's "appearance: not evaluated" claim would
   be trivially true) is one `@toph check` away from completing the P1
   picture for components that *do* pass geometry, without leaving P1's
   boundary or touching P2–P6. Given zero Heritage components currently
   reach it, this has no real data to validate against yet — worth
   deferring until a fixture where at least one candidate survives
   geometry exists (which is exactly what recommendation 1 would surface).

Both are extensions of the proven vertical slice, not the start of a new
one — consistent with "evaluate before broadening."
