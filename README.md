# Toph

Toph records why annotated TypeScript filter stages kept or rejected an object.
The production compiler leaves annotations unchanged; trace compilation adds the
runtime calls used by inspection.

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

The compiler directives are comments, so production output has no Toph runtime
dependency:

```ts
/** @toph filter p1.tee.geometry */
const survivors = candidates.filter((candidate) => {
  /** @toph check area.min */
  const areaOk = candidate.area >= minimumArea;
  if (!areaOk) return false;

  return true;
});
```

`examples/chainspot-validation/workflow.yml` documents the adapter contract without being an active repository workflow. See `examples/heritage-first-loss/` for a complete trace and inspection fixture.

Consumer-side baseline comparison is available from `toph/evaluation`.
