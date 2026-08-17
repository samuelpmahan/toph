/** Consumer-side comparison policy for a ChainSpot baseline and candidate run. */

export interface StageMetrics {
  stage: string;
  reached: number;
  kept: number;
}

export interface ValidationMetrics {
  corresponded: number;
  stages: readonly StageMetrics[];
  outputDigest?: string;
}

export interface ComparisonPolicy {
  maxCorrespondenceRegression?: number;
  maxStageRegression?: number;
  requireOutputParity?: boolean;
}

export interface MetricDelta {
  name: string;
  baseline: number;
  candidate: number;
  delta: number;
}

export interface ComparisonResult {
  pass: boolean;
  regressions: readonly string[];
  improvements: readonly string[];
  deltas: readonly MetricDelta[];
}

function metric(name: string, baseline: number, candidate: number): MetricDelta {
  return { name, baseline, candidate, delta: candidate - baseline };
}

/** Compare immutable baseline/candidate metrics using an explicit fail-closed policy. */
export function compareValidationMetrics(
  baseline: ValidationMetrics,
  candidate: ValidationMetrics,
  policy: ComparisonPolicy = {}
): ComparisonResult {
  const maxCorrespondenceRegression = policy.maxCorrespondenceRegression ?? 0;
  const maxStageRegression = policy.maxStageRegression ?? 0;
  const regressions: string[] = [];
  const improvements: string[] = [];
  const deltas: MetricDelta[] = [metric('corresponded', baseline.corresponded, candidate.corresponded)];

  if (candidate.corresponded < baseline.corresponded) {
    const loss = baseline.corresponded - candidate.corresponded;
    if (loss > maxCorrespondenceRegression) regressions.push(`corresponded lost ${loss} (allowed ${maxCorrespondenceRegression})`);
  } else if (candidate.corresponded > baseline.corresponded) {
    improvements.push(`corresponded gained ${candidate.corresponded - baseline.corresponded}`);
  }

  const candidateStages = new Map(candidate.stages.map((stage) => [stage.stage, stage]));
  for (const before of baseline.stages) {
    const after = candidateStages.get(before.stage);
    if (!after) {
      regressions.push(`stage ${before.stage} is missing from candidate`);
      continue;
    }
    const keptDelta = metric(`${before.stage}.kept`, before.kept, after.kept);
    const reachedDelta = metric(`${before.stage}.reached`, before.reached, after.reached);
    deltas.push(keptDelta, reachedDelta);
    if (keptDelta.delta < 0 && -keptDelta.delta > maxStageRegression) regressions.push(`${before.stage} kept lost ${-keptDelta.delta} (allowed ${maxStageRegression})`);
    if (reachedDelta.delta < 0 && -reachedDelta.delta > maxStageRegression) regressions.push(`${before.stage} reached lost ${-reachedDelta.delta} (allowed ${maxStageRegression})`);
    if (keptDelta.delta > 0) improvements.push(`${before.stage} kept gained ${keptDelta.delta}`);
    if (reachedDelta.delta > 0) improvements.push(`${before.stage} reached gained ${reachedDelta.delta}`);
  }
  for (const after of candidate.stages) {
    if (!baseline.stages.some((stage) => stage.stage === after.stage)) improvements.push(`new stage ${after.stage} observed`);
  }

  if (policy.requireOutputParity) {
    if (baseline.outputDigest === undefined || candidate.outputDigest === undefined) regressions.push('output parity requested but a digest is missing');
    else if (baseline.outputDigest !== candidate.outputDigest) regressions.push('pipeline output digest differs');
  }

  return { pass: regressions.length === 0, regressions, improvements, deltas };
}
