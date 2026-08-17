# ChainSpot validation contract

A browser adapter (for example, Playwright) or a CV worker runs ChainSpot, then
stores the existing Toph TraceRun, manifest, labelmap, versioned ground truth,
and a stable detector-output digest. CI converts the Toph funnel into
ValidationMetrics and calls compareValidationMetrics.

The default policy is fail-closed: correspondence and each stage's reached/kept
counts may not decrease; output parity is optional but can be required. Any
tolerance is explicit in reviewable policy. Ground truth is versioned
independently (for example, heritage-v1), and baseline/candidate must use the
same image hash and truth version. Store trace, manifest, labelmap, truth,
metrics, first-loss/funnel output, and comparison JSON as CI artifacts.

Run the executable policy tests:

```sh
npm install
npm run check
npm test -- test/evaluation/compare.test.ts
```

The workflow demonstrates a hosted browser smoke job and a self-hosted CV job
with native OpenCV/model assets. Adapter commands are the only ChainSpot-specific
pieces; ChainSpot itself is not modified.
