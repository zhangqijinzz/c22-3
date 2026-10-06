import { describe, expect, it } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import { applyRemedyPatches, buildRemediationPlan } from '../domain/ruleRemediation';
import type { BusinessRule, PredicateCondition, RuleField, RuleProject } from '../models/ruleModel';

const amount: RuleField = { id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 };
const tier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['basic', 'gold'] };
const active: RuleField = { id: 'active', name: '启用', type: 'boolean' };

function makeRule(id: string, conditions: BusinessRule['conditions'], priority = 10, result = id): BusinessRule {
  return { id, name: id, conditions, priority, result };
}

function project(rules: BusinessRule[], fields: RuleField[] = [amount, tier, active]): RuleProject {
  return { id: 'p', title: '测试项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

const num = (operator: PredicateCondition['operator'], value: number | { min: number; max: number }): BusinessRule['conditions'] =>
  ({ kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator, value }] as PredicateCondition[] });

function findSuggestion(plan: ReturnType<typeof buildRemediationPlan>, titlePart: string) {
  return plan.suggestions.find((suggestion) => suggestion.title.includes(titlePart));
}

describe('remediation plan generation', () => {
  it('reorders a same-priority result conflict and projects the conflict gone', () => {
    const rules = [
      makeRule('a', num('gte', 100), 20, '结果甲'),
      makeRule('b', num('gte', 200), 20, '结果乙'),
    ];
    const source = project(rules);
    const analysis = analyzeRules(source);
    expect(analysis.overlaps.some((overlap) => overlap.conflict)).toBe(true);
    const plan = buildRemediationPlan(source, analysis);
    const suggestion = plan.suggestions.find((item) => item.category === 'conflict' && item.patch.type === 'set-priority');
    expect(suggestion).toBeDefined();
    expect(suggestion!.projected.conflictCount).toBe(0);
  });

  it('narrows the looser rule of two same-direction bounds without creating unreachable rules', () => {
    const rules = [
      makeRule('loose', num('gte', 100), 20, 'x'),
      makeRule('tight', num('gte', 300), 20, 'x'),
    ];
    const source = project(rules);
    const plan = buildRemediationPlan(source, analyzeRules(source));
    const suggestion = findSuggestion(plan, 'loose');
    expect(suggestion).toBeDefined();
    expect(suggestion!.patch.type).toBe('add-predicate');
    if (suggestion!.patch.type === 'add-predicate') {
      expect(suggestion!.patch.ruleId).toBe('loose');
      expect(suggestion!.patch.predicate).toMatchObject({ operator: 'lt', value: 300 });
    }
    expect(suggestion!.projected.unreachableCount).toBe(0);
    expect(suggestion!.projected.overlapCount).toBe(0);
  });

  it('snaps an out-of-range threshold back into the field range and raises coverage', () => {
    const rules = [makeRule('r1', num('gte', 100), 10, 'x'), makeRule('impossible', num('gte', 1001), 10, 'y')];
    const source = project(rules);
    const analysis = analyzeRules(source);
    expect(analysis.unreachableRuleIds).toContain('impossible');
    const plan = buildRemediationPlan(source, analysis);
    const suggestion = findSuggestion(plan, 'impossible');
    expect(suggestion).toBeDefined();
    expect(suggestion!.projected.unreachableCount).toBe(0);
    expect(suggestion!.projected.coveragePercent).toBeGreaterThanOrEqual(analysis.coveragePercent);
  });

  it('removes one half of a contradictory numeric condition', () => {
    const contradictory: BusinessRule['conditions'] = {
      kind: 'group', operator: 'and',
      conditions: [
        { kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 800 },
        { kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 400 },
      ],
    };
    const source = project([makeRule('contradiction', contradictory, 10, 'x'), makeRule('base', num('gte', 0), 5, 'b')]);
    const analysis = analyzeRules(source);
    expect(analysis.unreachableRuleIds).toContain('contradiction');
    const plan = buildRemediationPlan(source, analysis);
    const suggestion = findSuggestion(plan, '矛盾');
    expect(suggestion).toBeDefined();
    expect(suggestion!.projected.unreachableCount).toBe(0);
  });

  it('lifts a fully shadowed rule above its blocker', () => {
    const rules = [
      makeRule('top', num('gte', 100), 30, 'top'),
      makeRule('hidden', num('gte', 200), 10, 'hidden'),
    ];
    const source = project(rules);
    const analysis = analyzeRules(source);
    expect(analysis.shadowedRuleIds).toContain('hidden');
    const plan = buildRemediationPlan(source, analysis);
    const suggestion = plan.suggestions.find((item) => item.category === 'shadowed');
    expect(suggestion).toBeDefined();
    expect(suggestion!.patch).toMatchObject({ type: 'set-priority', ruleId: 'hidden', priority: 31 });
    expect(suggestion!.projected.shadowedCount).toBe(0);
  });

  it('merges rules with identical conditions but different results', () => {
    const conditions = num('gte', 500);
    const rules = [makeRule('a', conditions, 20, '结果甲'), makeRule('b', conditions, 20, '结果乙')];
    const source = project(rules);
    const analysis = analyzeRules(source);
    expect(analysis.overlaps[0].conflict).toBe(true);
    const plan = buildRemediationPlan(source, analysis);
    const suggestion = plan.suggestions.find((item) => item.patch.type === 'merge-rules');
    expect(suggestion).toBeDefined();
    if (suggestion!.patch.type === 'merge-rules') {
      expect(suggestion!.patch.keepRuleId).toBe('a');
      expect(suggestion!.patch.result).toBe('结果甲');
      expect(suggestion!.patch.ruleIds).toContain('b');
    }
  });
});

describe('applyRemedyPatches', () => {
  it('applies only selected patches and leaves unselected rules untouched', () => {
    const rules = [
      makeRule('a', num('gte', 100), 20, '结果甲'),
      makeRule('b', num('gte', 200), 20, '结果乙'),
      makeRule('c', num('gte', 300), 20, '结果丙'),
    ];
    const source = project(rules);
    const plan = buildRemediationPlan(source, analyzeRules(source));
    const reorder = plan.suggestions.find((item) => item.patch.type === 'set-priority' && item.patch.ruleId === 'b');
    expect(reorder).toBeDefined();
    const { project: patched, skipped } = applyRemedyPatches(source, [reorder!.patch]);
    expect(skipped).toBe(0);
    expect(patched.rules.find((rule) => rule.id === 'b')?.priority).toBe(19);
    // 未采纳建议涉及的规则保持原值
    expect(patched.rules.find((rule) => rule.id === 'a')?.priority).toBe(20);
    expect(patched.rules.find((rule) => rule.id === 'c')?.priority).toBe(20);
    // 原项目不被修改
    expect(source.rules.find((rule) => rule.id === 'b')?.priority).toBe(20);
  });

  it('does not mutate the source project and reports skipped stale patches', () => {
    const source = project([makeRule('a', num('gte', 100), 20, 'x')]);
    const stale = { type: 'set-priority' as const, ruleId: 'missing-rule', priority: 1 };
    const { project: patched, skipped } = applyRemedyPatches(source, [stale]);
    expect(skipped).toBe(1);
    expect(patched.rules).toHaveLength(1);
    expect(patched.rules[0].priority).toBe(20);
  });

  it('merges rules by keeping the designated rule and its result', () => {
    const conditions = num('gte', 500);
    const source = project([makeRule('a', conditions, 20, '结果甲'), makeRule('b', conditions, 20, '结果乙')]);
    const plan = buildRemediationPlan(source, analyzeRules(source));
    const merge = plan.suggestions.find((item) => item.patch.type === 'merge-rules');
    expect(merge).toBeDefined();
    const { project: patched, skipped } = applyRemedyPatches(source, [merge!.patch]);
    expect(skipped).toBe(0);
    expect(patched.rules.map((rule) => rule.id)).toEqual(['a']);
    expect(patched.rules[0].result).toBe('结果甲');
  });

  it('deduplicates identical add-predicate patches applied together', () => {
    const source = project([makeRule('a', num('gte', 100), 20, 'x')]);
    const predicate: PredicateCondition = { kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 500 };
    const patch = { type: 'add-predicate' as const, ruleId: 'a', predicate };
    const { project: patched } = applyRemedyPatches(source, [patch, { ...patch }]);
    expect(patched.rules[0].conditions.conditions).toHaveLength(2);
  });

  it('refuses to remove the last remaining condition instead of silently deleting a rule', () => {
    const predicate: PredicateCondition = { kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 100 };
    const source = project([makeRule('a', num('gte', 100), 20, 'x')]);
    const { project: patched, skipped } = applyRemedyPatches(source, [{ type: 'remove-predicate', ruleId: 'a', predicate }]);
    expect(skipped).toBe(1);
    expect(patched.rules).toHaveLength(1);
    expect(patched.rules[0].conditions.conditions).toHaveLength(1);
  });
});
