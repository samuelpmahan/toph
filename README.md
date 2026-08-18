# Toph

Toph records execution evidence from annotated TypeScript CV pipelines, then answers
queries over that evidence. The runtime records what happened; the query layer is
responsible for correspondence and semantic verdicts and is expected to fail closed
when those cannot be established safely.

## Quickstart

```sh
npm install
npm run build
npx toph compile --mode trace --out-dir .toph/build src/pipeline.ts
node .toph/build/pipeline.js
```

`compile` writes instrumented source files plus `manifest.json` and
`source-map.json`. Use `--mode production` for an ordinary deployment. IDs are
deterministic within one compile invocation, so compile related files together.

Wrap a run to persist a self-contained trace directory:

```ts
import { withTophRun } from 'toph/run';

await withTophRun({ dir: '.toph/runs/example', pipeline: 'example', manifest }, async () => {
  await runPipeline();
});
```

The directory contains `trace.json`, `manifest.json`, and any snapshotted raster
bytes under `assets/`. A generated run can be queried without rerunning code:

```sh
npx toph inspect --trace trace.json --manifest manifest.json \
  --labelmap labelmap.json --truth truth.json --point H1
npx toph funnel --trace trace.json --manifest manifest.json \
  --labelmap labelmap.json --truth truth.json --stages p1.tee.geometry
```

## Execution stage vs semantic family

A stage name answers **where code ran**. An optional family answers **what kind of
truth that stage is entitled to adjudicate**:

```ts
/** @toph filter p1.tee.geometry family=tee */
const survivors = candidates.filter((candidate) => {
  /** @toph check area.min */
  const areaOk = candidate.area >= minimumArea;
  if (!areaOk) return false;
  return true;
});
```

Ground truth may declare `expect: "tee"`. When it does, `inspect` considers only
stages whose manifest explicitly declares `family: "tee"` when deriving the verdict.
A rejection in `family=basket` is still visible execution evidence, but it cannot be
reported as a tee's loss. Toph never infers family from stage-name spelling.

Repeated executions of one logical stage remain separate stage invocations in the
trace. Invocation-level inspection preserves all of them. Object-level funnels count
a corresponding truth/entity at most once per logical stage, and mixed kept/rejected
invocations are not silently collapsed into a clean survivor count.

## Correspondence invariants

New truth and labelmap artifacts should name their coordinate space. If the names
differ, a query requires an explicit transform from truth space to labelmap space; if
none exists, correspondence is refused before any pixel or centroid lookup.

Labelmaps may also carry `entityIds`, the ordered entity set they label. Pixel label
`N` then means `entityIds[N-1]`. Legacy ordinal lookup remains readable only when that
ordinal resolves uniquely; if multiple spawn sites make it ambiguous, Toph refuses to
guess.

Nearest-pixel/nearest-centroid correspondence always reports method and distance.
Ambiguous truth or unreliable correspondence never forces a semantic verdict.

## Population decisions and measures

Threshold checks are not the only reason an entity can disappear. Population-relative
operations such as consensus or clustering should record a `select` dataflow event with
`kept`, `rejected`, and optional primitive `basis` metadata. `selectFateOf(entityId)`
then exposes the entity's population decision directly.

Runtime-derived context that explains later checks belongs in stage-scoped measures:

```ts
recordMeasure(stageInvocationId, 'basketMedianArea', basketMedianArea, 'px2');
```

Measures are evidence, not gates: recording one cannot change control flow or an
entity's fate.

The compiler directives are comments, so production output has no Toph runtime
dependency. `examples/chainspot-validation/workflow.yml` documents the adapter contract
without being an active repository workflow. See `examples/heritage-first-loss/` for a
complete trace and inspection fixture.

Consumer-side baseline comparison is available from `toph/evaluation`.

## Replay viewer

`toph/viewer` starts a local, desktop-first diagnostic UI over a counterfactual replay
session (see `toph/replay`): one raster pane with entity/relation overlays, a stage
scrubber, a parameter pane that drives new counterfactual runs, an experiment tree, an
A/B diff panel, and a grid-search form. It is a plain Node HTTP server plus one static
HTML/CSS/JS page -- no framework, no build step, no new dependencies. It stays
application-generic: every label on the page comes from adapter/manifest/summary data,
never from hardcoded domain vocabulary.

```ts
import { startReplayViewer } from 'toph/viewer';

const { port, close } = await startReplayViewer({
  sessionDir: '.toph/replay-sessions/example',
  adapter: myReplayAdapter,          // see toph/replay's ReplayAdapter contract
  port: 4173,                        // optional, defaults to 4173
  sourceImage: { path: 'fixture.png', contentType: 'image/png' }, // optional
});
console.log(`toph replay viewer on http://localhost:${port}`);
// later: await close();
```

Opening the server ensures a baseline run exists, so the viewer always has data to show.

Endpoints:

- `GET /` -- the static viewer page.
- `GET /api/session` -- pipeline id, source, code version, defaults, param schema, all runs.
- `GET /api/run/:id` -- one `RunRecord`.
- `GET /api/run/:id/trace` / `/final` / `/manifest` / `/labelmaps` -- the run's stored artifacts (404 if absent).
- `GET /api/source-image` -- the configured source image bytes (404 if none configured).
- `GET /api/diff?a=<runId>&b=<runId>` -- `{ configDiff, summaryDiff, firstDivergentStage }`; `firstDivergentStage` (when non-null) additionally carries a `stageName` resolved server-side from manifest data.
- `POST /api/replay` `{ parentRunId, patch, label? }` -- runs a full counterfactual re-execution via the adapter, returns the new `RunRecord`.
- `POST /api/grid` `{ parentRunId, axes }` -- cartesian-product grid search, returns the new `RunRecord[]`.

Errors are always JSON `{ error }` with a 4xx/5xx status. Replays and grid runs are
awaited synchronously (they can take seconds); there is no job queue.