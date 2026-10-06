import type { RuleProject } from '../models/ruleModel';
import { analyzeRules } from '../domain/ruleAnalysis';
import { buildRemediationPlan } from '../domain/ruleRemediation';

interface CheckRequest {
  requestId: number;
  project: RuleProject;
}

self.onmessage = (event: MessageEvent<CheckRequest>) => {
  try {
    const analysis = analyzeRules(event.data.project);
    const remediationPlan = buildRemediationPlan(event.data.project, analysis);
    self.postMessage({ requestId: event.data.requestId, analysis, remediationPlan });
  } catch (error) {
    self.postMessage({
      requestId: event.data.requestId,
      error: error instanceof Error ? error.message : '规则分析失败',
    });
  }
};
