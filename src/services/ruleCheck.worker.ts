import type { CheckResult, RuleProject } from '../models/ruleModel';
import { analyzeRules } from '../domain/ruleAnalysis';
import { buildRemediationPlan } from '../domain/ruleRemediation';

interface CheckRequest {
  requestId: number;
  project: RuleProject;
}

export function checkProject(project: RuleProject): CheckResult {
  const analysis = analyzeRules(project);
  const plan = buildRemediationPlan(project, analysis);
  return { analysis, plan };
}

self.onmessage = (event: MessageEvent<CheckRequest>) => {
  try {
    const result = checkProject(event.data.project);
    self.postMessage({ requestId: event.data.requestId, ...result });
  } catch (error) {
    self.postMessage({
      requestId: event.data.requestId,
      error: error instanceof Error ? error.message : '规则分析失败',
    });
  }
};
