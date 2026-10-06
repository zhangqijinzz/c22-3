import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import { buildRemediationPlan } from '../domain/ruleRemediation';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    const analysis = analyzeRules(project);
    return { promise: Promise.resolve({ analysis, plan: buildRemediationPlan(project, analysis) }), cancel: () => { this.cancelled = true; } };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);

    workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.copyVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });

  it('applies only selected remedies, leaves other rules untouched, and reports before/after metrics', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const plan = workspace.getSnapshot().remediationPlan;
    expect(plan).not.toBeNull();
    expect(plan!.suggestions.length).toBeGreaterThan(0);

    const beforeRules = JSON.stringify(workspace.getSnapshot().project?.rules);
    const beforeConflictCount = workspace.getSnapshot().analysis?.overlaps.filter((overlap) => overlap.conflict).length ?? 0;
    expect(beforeConflictCount).toBeGreaterThan(0);

    // 只采纳冲突重排建议，不采纳遮蔽/收窄/放宽建议。
    const conflictSuggestion = plan!.suggestions.find((suggestion) => suggestion.category === 'conflict');
    expect(conflictSuggestion).toBeDefined();
    const untouchedTitles = plan!.suggestions
      .filter((suggestion) => suggestion.id !== conflictSuggestion!.id)
      .map((suggestion) => suggestion.title);
    const ok = workspace.applyRemedies([conflictSuggestion!.id]);
    expect(ok).toBe(true);

    const report = workspace.getSnapshot().remediationReport;
    expect(report).not.toBeNull();
    expect(report!.applied).toHaveLength(1);
    expect(report!.before.conflictCount).toBe(beforeConflictCount);
    expect(report!.applied[0].title).toBe(conflictSuggestion!.title);

    await vi.advanceTimersByTimeAsync(250);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const afterAnalysis = workspace.getSnapshot().analysis;
    expect(afterAnalysis?.overlaps.filter((overlap) => overlap.conflict)).toHaveLength(0);

    // 未被采纳的建议没有改动规则：除冲突补丁涉及的规则优先级外，其余规则与之前一致。
    const rulesById = new Map(workspace.getSnapshot().project?.rules.map((rule) => [rule.id, rule]));
    const beforeById = new Map((JSON.parse(beforeRules) as RuleProject['rules']).map((rule) => [rule.id, rule]));
    for (const [id, beforeRule] of beforeById) {
      const afterRule = rulesById.get(id);
      expect(afterRule).toBeDefined();
      if (conflictSuggestion!.affectedRuleIds.includes(id)) continue;
      expect(afterRule!.priority).toBe(beforeRule.priority);
      expect(JSON.stringify(afterRule!.conditions)).toBe(JSON.stringify(beforeRule.conditions));
    }
    expect(untouchedTitles.length).toBeGreaterThan(0);
    workspace.dispose();
  });
});
