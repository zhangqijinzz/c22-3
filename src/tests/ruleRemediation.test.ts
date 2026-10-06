import { describe, expect, it } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import {
  applyRemediationPatches,
  buildRemediationPlan,
  metricsOf,
  sharedCoveragePercent,
} from '../domain/ruleRemediation';
import type { BusinessRule, RuleField, RuleProject } from '../models/ruleModel';

const amount: RuleField = { id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 };
const tier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['basic', 'gold'] };

function makeRule(id: string, conditions: BusinessRule['conditions'], priority = 10, result = id, name = id): BusinessRule {
  return { id, name, conditions, priority, result };
}

function project(rules: BusinessRule[], fields: RuleField[] = [amount, tier]): RuleProject {
  return { id: 'p', title: '测试项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

const amountGte = (value: number): BusinessRule['conditions'] => ({ kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value }] });
const amountBetween = (min: number, max: number): BusinessRule['conditions'] => ({ kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min, max } }] });

function planFor(rules: BusinessRule[], fields?: RuleField[]) {
  const current = project(rules, fields);
  const analysis = analyzeRules(current);
  return { current, analysis, plan: buildRemediationPlan(current, analysis) };
}

function applyOnly(current: RuleProject, remediationIndex = 0) {
  const plan = buildRemediationPlan(current, analyzeRules(current));
  const updated = applyRemediationPatches(current, [plan.remediations[remediationIndex]]);
  return { updated, analysis: analyzeRules(updated) };
}

describe('remediation suggestions', () => {
  it('suggests demoting a same-priority conflicting rule behind the winning one', () => {
    const { current, plan } = planFor([
      makeRule('wide', amountGte(100), 20, 'free'),
      makeRule('conflict', amountGte(200), 20, 'charge'),
    ]);
    const suggestion = plan.remediations.find((item) => item.kind === 'reorder-priority' && item.issueType === 'conflict');
    expect(suggestion).toBeDefined();
    expect(suggestion?.patches[0].targetId).toBe('conflict');
    const { updated, analysis } = applyOnly(current);
    expect(analysis.overlaps.filter((overlap) => overlap.conflict)).toHaveLength(0);
    expect(sharedCoveragePercent(current, updated).after).toBeGreaterThanOrEqual(sharedCoveragePercent(current, updated).before);
  });

  it('narrows the lower-priority numeric interval so the overlap disappears without losing coverage', () => {
    const { current, plan } = planFor([
      makeRule('high', amountBetween(500, 800), 30, 'a'),
      makeRule('low', amountGte(600), 10, 'b'),
    ]);
    const suggestion = plan.remediations.find((item) => item.kind === 'narrow-interval');
    expect(suggestion).toBeDefined();
    const { updated, analysis } = applyOnly(current);
    const low = updated.rules.find((rule) => rule.id === 'low') as BusinessRule;
    const predicates = low.conditions.conditions as Extract<BusinessRule['conditions']['conditions'][number], { kind: 'predicate' }>[];
    expect(predicates.some((condition) => condition.operator === 'gt' && condition.value === 800)).toBe(true);
    expect(analysis.overlaps).toHaveLength(0);
    expect(sharedCoveragePercent(current, updated).after).toBeGreaterThanOrEqual(sharedCoveragePercent(current, updated).before);
  });

  it('merges rules with identical conditions but different results instead of leaving a conflict', () => {
    const conditions = amountGte(300);
    const { current, plan } = planFor([
      makeRule('first', conditions, 20, 'result-a'),
      makeRule('second', JSON.parse(JSON.stringify(conditions)) as BusinessRule['conditions'], 20, 'result-b'),
    ]);
    const suggestion = plan.remediations.find((item) => item.kind === 'merge-rules');
    expect(suggestion).toBeDefined();
    const { updated } = applyOnly(current);
    expect(updated.rules).toHaveLength(1);
    expect(updated.rules[0].id).toBe('first');
    expect(updated.rules[0].result).toBe('result-a');
  });

  it('raises a fully shadowed rule above the blocking rule without shadowing others', () => {
    const { current, plan } = planFor([
      makeRule('cover', amountGte(100), 30, 'cover'),
      makeRule('hidden', amountGte(200), 10, 'hidden'),
    ]);
    const suggestion = plan.remediations.find((item) => item.issueType === 'shadowed' && item.kind === 'reorder-priority');
    expect(suggestion).toBeDefined();
    const { updated, analysis } = applyOnly(current);
    const hidden = updated.rules.find((rule) => rule.id === 'hidden') as BusinessRule;
    expect(hidden.priority).toBeGreaterThan(30);
    expect(analysis.shadowedRuleIds).not.toContain('hidden');
    expect(analysis.shadowedRuleIds).not.toContain('cover');
  });

  it('widens an out-of-range condition for an unreachable rule, and deletes a contradiction when widening cannot help', () => {
    const { current: rangeProject, plan: rangePlan } = planFor([
      makeRule('normal', amountGte(0), 30, 'normal'),
      makeRule('beyond', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 1000 }] }, 10, 'review'),
    ]);
    const widen = rangePlan.remediations.find((item) => item.kind === 'widen-interval');
    expect(widen).toBeDefined();
    const widenedResult = applyRemediationPatches(rangeProject, [widen!]);
    const widenedAnalysis = analyzeRules(widenedResult);
    expect(widenedAnalysis.unreachableRuleIds).not.toContain('beyond');

    const impossible: BusinessRule['conditions'] = { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 100 },
      { kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 900 },
    ] };
    const { current: contradictionProject, plan: contradictionPlan } = planFor([
      makeRule('normal', amountGte(0), 10, 'normal'),
      makeRule('impossible', impossible, 10, 'x'),
    ]);
    const remove = contradictionPlan.remediations.find((item) => item.kind === 'remove-rule');
    expect(remove).toBeDefined();
    const removed = applyRemediationPatches(contradictionProject, [remove!]);
    expect(removed.rules.map((rule) => rule.id)).toEqual(['normal']);
  });

  it('leaves unrelated rules untouched when only selected suggestions are applied', () => {
    const current = project([
      makeRule('wide', amountGte(100), 20, 'free', '宽规则'),
      makeRule('conflict', amountGte(200), 20, 'charge', '冲突规则'),
      makeRule('beyond', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 1000 }] }, 10, 'review', '越界规则'),
    ]);
    const analysis = analyzeRules(current);
    const plan = buildRemediationPlan(current, analysis);
    const conflictFix = plan.remediations.find((item) => item.issueType === 'conflict')!;
    const updated = applyRemediationPatches(current, [conflictFix]);
    const beforeBeyond = JSON.stringify(current.rules.find((rule) => rule.id === 'beyond'));
    const afterBeyond = JSON.stringify(updated.rules.find((rule) => rule.id === 'beyond'));
    expect(afterBeyond).toBe(beforeBeyond);
  });

  it('reports metric changes between the baseline and the remediated rule set', () => {
    const current = project([
      makeRule('wide', amountGte(100), 20, 'free'),
      makeRule('conflict', amountGte(200), 20, 'charge'),
    ]);
    const before = metricsOf(analyzeRules(current));
    expect(before.conflictCount).toBe(1);
    const plan = buildRemediationPlan(current, analyzeRules(current));
    const updated = applyRemediationPatches(current, plan.remediations);
    const after = metricsOf(analyzeRules(updated));
    expect(after.conflictCount).toBe(0);
    expect(sharedCoveragePercent(current, updated).after).toBeGreaterThanOrEqual(sharedCoveragePercent(current, updated).before);
  });
});
