import { analyzeRules, enumerateInputCases } from './ruleAnalysis';
import { matchesRule } from './conditionEvaluator';
import type {
  BusinessRule,
  ConditionGroup,
  PredicateCondition,
  RuleAnalysis,
  RuleCondition,
  RuleField,
  RuleProject,
} from '../models/ruleModel';

export type RemediationKind = 'reorder-priority' | 'narrow-interval' | 'merge-rules' | 'widen-interval' | 'remove-rule';
export type RemediationIssueType = 'conflict' | 'overlap' | 'shadowed' | 'unreachable';

export interface RulePatch {
  targetId: string;
  rule?: BusinessRule;
  delete?: boolean;
}

export interface RuleRemediation {
  id: string;
  kind: RemediationKind;
  issueType: RemediationIssueType;
  title: string;
  description: string;
  ruleIds: string[];
  patches: RulePatch[];
}

export interface RemediationMetrics {
  coveragePercent: number;
  coveredCases: number;
  checkedCases: number;
  conflictCount: number;
  overlapCount: number;
  unreachableCount: number;
  shadowedCount: number;
}

export interface RemediationPlan {
  remediations: RuleRemediation[];
  manualIssueCount: number;
}

export interface RemediationReport {
  appliedIds: string[];
  appliedTitles: string[];
  before: RemediationMetrics;
  after: RemediationMetrics;
}

export function metricsOf(analysis: RuleAnalysis): RemediationMetrics {
  return {
    coveragePercent: analysis.coveragePercent,
    coveredCases: analysis.coveredCases,
    checkedCases: analysis.checkedCases,
    conflictCount: analysis.overlaps.filter((overlap) => overlap.conflict).length,
    overlapCount: analysis.overlaps.length,
    unreachableCount: analysis.unreachableRuleIds.length,
    shadowedCount: analysis.shadowedRuleIds.length,
  };
}

function higherFirst(project: RuleProject, left: BusinessRule, right: BusinessRule): [BusinessRule, BusinessRule] {
  const rankOf = (rule: BusinessRule): number => project.rules.indexOf(rule);
  return left.priority === right.priority
    ? rankOf(left) < rankOf(right) ? [left, right] : [right, left]
    : left.priority > right.priority ? [left, right] : [right, left];
}

export function buildRemediationPlan(project: RuleProject, analysis: RuleAnalysis): RemediationPlan {
  const byId = new Map(project.rules.map((rule) => [rule.id, rule]));
  const suggestions = new Map<string, RuleRemediation>();
  let manualIssueCount = 0;

  for (const overlap of analysis.overlaps) {
    const ruleA = byId.get(overlap.ruleAId);
    const ruleB = byId.get(overlap.ruleBId);
    if (!ruleA || !ruleB) continue;
    const sameConditions = canonicalCondition(ruleA.conditions) === canonicalCondition(ruleB.conditions);

    let suggestion: RuleRemediation | null = null;
    if (sameConditions) {
      const [keep, drop] = higherFirst(project, ruleA, ruleB);
      suggestion = mergeSuggestion(project, analysis, keep, drop, overlap.conflict);
    } else if (overlap.conflict) {
      suggestion = reorderConflictSuggestion(project, analysis, ruleA, ruleB);
    } else {
      const [higher, lower] = higherFirst(project, ruleA, ruleB);
      suggestion = narrowIntervalSuggestion(project, analysis, higher, lower);
    }
    if (suggestion) suggestions.set(suggestion.id, suggestion);
    else manualIssueCount += 1;
  }

  for (const ruleId of analysis.shadowedRuleIds) {
    const rule = byId.get(ruleId);
    if (!rule) continue;
    const suggestion = raisePrioritySuggestion(project, analysis, rule);
    if (suggestion) suggestions.set(suggestion.id, suggestion);
    else manualIssueCount += 1;
  }

  for (const ruleId of analysis.unreachableRuleIds) {
    const rule = byId.get(ruleId);
    if (!rule) continue;
    const suggestion = widenSuggestion(project, analysis, rule) ?? removeUnreachableSuggestion(project, analysis, rule);
    suggestions.set(suggestion.id, suggestion);
  }

  const order: RemediationIssueType[] = ['conflict', 'overlap', 'shadowed', 'unreachable'];
  const remediations = [...suggestions.values()].sort(
    (left, right) => order.indexOf(left.issueType) - order.indexOf(right.issueType),
  );
  return { remediations, manualIssueCount };
}

export function applyRemediationPatches(
  project: RuleProject,
  remediations: Pick<RuleRemediation, 'patches'>[],
): RuleProject {
  const deletions = new Set<string>();
  const replacements = new Map<string, BusinessRule>();
  for (const remediation of remediations) {
    for (const patch of remediation.patches) {
      if (patch.delete) deletions.add(patch.targetId);
      else if (patch.rule) replacements.set(patch.targetId, patch.rule);
    }
  }
  const rules = project.rules
    .filter((rule) => !deletions.has(rule.id))
    .map((rule) => replacements.get(rule.id) ?? rule);
  return { ...project, rules };
}

function mergeSuggestion(
  project: RuleProject,
  baseline: RuleAnalysis,
  keep: BusinessRule,
  drop: BusinessRule,
  conflict: boolean,
): RuleRemediation | null {
  const merged: BusinessRule = { ...keep };
  const candidate = applyRemediationPatches(project, [{ patches: [{ targetId: keep.id, rule: merged }, { targetId: drop.id, delete: true }] }]);
  if (!passesGate(project, candidate, baseline, (analysis) =>
    analysis.overlaps.filter((overlap) => overlap.conflict).length <= baseline.overlaps.filter((item) => item.conflict).length
      && candidate.rules.length === project.rules.length - 1)) return null;
  const idTail = [keep.id, drop.id].sort().join('-');
  return {
    id: `rem-merge-${idTail}`,
    kind: 'merge-rules',
    issueType: conflict ? 'conflict' : 'overlap',
    title: conflict ? `合并条件相同但结果冲突的「${keep.name}」与「${drop.name}」` : `合并重复规则「${drop.name}」`,
    description: conflict
      ? `两条规则条件完全一致，合并为「${keep.name}」并保留结果“${keep.result}”，删除「${drop.name}」；之后可直接修改保留规则的结果。`
      : `两条规则条件与结果完全一致，删除重复的「${drop.name}」，命中行为不变。`,
    ruleIds: [keep.id, drop.id],
    patches: [{ targetId: keep.id, rule: merged }, { targetId: drop.id, delete: true }],
  };
}

function reorderConflictSuggestion(
  project: RuleProject,
  baseline: RuleAnalysis,
  ruleA: BusinessRule,
  ruleB: BusinessRule,
): RuleRemediation | null {
  const [winner, loser] = higherFirst(project, ruleA, ruleB);
  const lowestPriority = Math.min(...project.rules.map((rule) => rule.priority));
  const newPriority = lowestPriority - 10;
  const demoted: BusinessRule = { ...loser, priority: newPriority };
  const candidate = applyRemediationPatches(project, [{ patches: [{ targetId: loser.id, rule: demoted }] }]);
  const baselineConflicts = baseline.overlaps.filter((overlap) => overlap.conflict).length;
  if (!passesGate(project, candidate, baseline, (analysis) =>
    analysis.overlaps.filter((overlap) => overlap.conflict).length < baselineConflicts)) return null;
  return {
    id: `rem-reorder-${[winner.id, loser.id].sort().join('-')}`,
    kind: 'reorder-priority',
    issueType: 'conflict',
    title: `将「${loser.name}」排到「${winner.name}」之后`,
    description: `同优先级且结果不同，把「${loser.name}」优先级 ${loser.priority} → ${newPriority}，冲突输入统一由「${winner.name}」给出“${winner.result}”。`,
    ruleIds: [winner.id, loser.id],
    patches: [{ targetId: loser.id, rule: demoted }],
  };
}

function raisePrioritySuggestion(
  project: RuleProject,
  baseline: RuleAnalysis,
  rule: BusinessRule,
): RuleRemediation | null {
  const highestPriority = Math.max(...project.rules.map((item) => item.priority));
  const newPriority = highestPriority + 10;
  const raised: BusinessRule = { ...rule, priority: newPriority };
  const candidate = applyRemediationPatches(project, [{ patches: [{ targetId: rule.id, rule: raised }] }]);
  const previouslyShadowed = new Set(baseline.shadowedRuleIds);
  if (!passesGate(project, candidate, baseline, (analysis) =>
    !analysis.shadowedRuleIds.includes(rule.id)
      && !analysis.unreachableRuleIds.includes(rule.id)
      && analysis.shadowedRuleIds.every((id) => previouslyShadowed.has(id)))) return null;
  return {
    id: `rem-raise-${rule.id}`,
    kind: 'reorder-priority',
    issueType: 'shadowed',
    title: `将被遮蔽的「${rule.name}」前移`,
    description: `把「${rule.name}」优先级 ${rule.priority} → ${newPriority}，移到所有规则之前，其命中输入不再被更早的规则遮蔽。`,
    ruleIds: [rule.id],
    patches: [{ targetId: rule.id, rule: raised }],
  };
}

interface NumericInterval {
  low: number;
  lowOpen: boolean;
  high: number;
  highOpen: boolean;
}

function predicateInterval(condition: PredicateCondition): NumericInterval | null {
  if (typeof condition.value !== 'number' && !isNumberRange(condition.value)) return null;
  switch (condition.operator) {
    case 'gt': return { low: condition.value as number, lowOpen: true, high: Infinity, highOpen: false };
    case 'gte': return { low: condition.value as number, lowOpen: false, high: Infinity, highOpen: false };
    case 'lt': return { low: -Infinity, lowOpen: false, high: condition.value as number, highOpen: true };
    case 'lte': return { low: -Infinity, lowOpen: false, high: condition.value as number, highOpen: false };
    case 'eq': return typeof condition.value === 'number' ? { low: condition.value, lowOpen: false, high: condition.value, highOpen: false } : null;
    case 'between': return isNumberRange(condition.value) ? { low: condition.value.min, lowOpen: false, high: condition.value.max, highOpen: false } : null;
    default: return null;
  }
}

function narrowIntervalSuggestion(
  project: RuleProject,
  baseline: RuleAnalysis,
  higher: BusinessRule,
  lower: BusinessRule,
): RuleRemediation | null {
  const higherParts = topLevelPredicates(higher.conditions);
  const lowerParts = topLevelPredicates(lower.conditions);
  if (!higherParts || !lowerParts || higher.conditions.operator !== 'and' || lower.conditions.operator !== 'and') return null;

  for (const field of project.fields) {
    if (field.type !== 'number') continue;
    const higherOnField = higherParts.filter((condition) => condition.fieldId === field.id);
    const lowerOnField = lowerParts.filter((condition) => condition.fieldId === field.id);
    if (higherOnField.length !== 1 || lowerOnField.length !== 1) continue;
    const higherInterval = predicateInterval(higherOnField[0]);
    const lowerInterval = predicateInterval(lowerOnField[0]);
    if (!higherInterval || !lowerInterval) continue;

    const beyondHigh = Number.isFinite(higherInterval.high) && lowerInterval.high > higherInterval.high;
    const beyondLow = Number.isFinite(higherInterval.low) && lowerInterval.low < higherInterval.low;
    if (beyondHigh === beyondLow) continue;

    // 保留低优先级规则落在高优先级区间「外侧」的部分：
    // 向右超出 → 从高区间右端之外开始（高区间右端闭合则严格大于），并保留低区间自己的上界；
    // 向左超出 → 截止到高区间左端之外（高区间左端闭合则严格小于），并保留低区间自己的下界。
    const newFieldConditions: PredicateCondition[] = [];
    if (beyondHigh) {
      newFieldConditions.push(higherInterval.highOpen
        ? { kind: 'predicate', fieldId: field.id, operator: 'gte', value: higherInterval.high }
        : { kind: 'predicate', fieldId: field.id, operator: 'gt', value: higherInterval.high });
      if (Number.isFinite(lowerInterval.high)) {
        newFieldConditions.push(lowerInterval.highOpen
          ? { kind: 'predicate', fieldId: field.id, operator: 'lt', value: lowerInterval.high }
          : { kind: 'predicate', fieldId: field.id, operator: 'lte', value: lowerInterval.high });
      }
    } else {
      if (Number.isFinite(lowerInterval.low)) {
        newFieldConditions.push(lowerInterval.lowOpen
          ? { kind: 'predicate', fieldId: field.id, operator: 'gt', value: lowerInterval.low }
          : { kind: 'predicate', fieldId: field.id, operator: 'gte', value: lowerInterval.low });
      }
      newFieldConditions.push(higherInterval.lowOpen
        ? { kind: 'predicate', fieldId: field.id, operator: 'lte', value: higherInterval.low }
        : { kind: 'predicate', fieldId: field.id, operator: 'lt', value: higherInterval.low });
    }

    const restConditions = lowerParts.filter((condition) => condition.fieldId !== field.id);
    const narrowedGroup: ConditionGroup = { ...lower.conditions, conditions: [...restConditions, ...newFieldConditions] };
    const narrowed: BusinessRule = { ...lower, conditions: narrowedGroup };
    const candidate = applyRemediationPatches(project, [{ patches: [{ targetId: lower.id, rule: narrowed }] }]);
    const pairGone = (analysis: RuleAnalysis): boolean => !analysis.overlaps.some((overlap) =>
      (overlap.ruleAId === higher.id && overlap.ruleBId === lower.id)
        || (overlap.ruleAId === lower.id && overlap.ruleBId === higher.id));
    const baselineConflicts = baseline.overlaps.filter((overlap) => overlap.conflict).length;
    if (!passesGate(project, candidate, baseline, (analysis) =>
      pairGone(analysis) && analysis.overlaps.filter((overlap) => overlap.conflict).length <= baselineConflicts)) continue;

    return {
      id: `rem-narrow-${lower.id}-${higher.id}-${field.id}`,
      kind: 'narrow-interval',
      issueType: 'overlap',
      title: `收窄「${lower.name}」的${field.name}条件`,
      description: `把「${lower.name}」的${field.name}区间收窄为 ${formatInterval(newFieldConditions, field)}，与「${higher.name}」不再重叠，整体覆盖不变。`,
      ruleIds: [higher.id, lower.id],
      patches: [{ targetId: lower.id, rule: narrowed }],
    };
  }
  return null;
}

function widenSuggestion(
  project: RuleProject,
  baseline: RuleAnalysis,
  rule: BusinessRule,
): RuleRemediation | null {
  const fieldById = new Map(project.fields.map((field) => [field.id, field]));
  const notes: string[] = [];
  let changed = false;

  const relax = (condition: RuleCondition): RuleCondition => {
    if (condition.kind === 'group') return { ...condition, conditions: condition.conditions.map(relax) };
    const field = fieldById.get(condition.fieldId);
    if (!field || field.type !== 'number' || !Number.isFinite(field.min) || !Number.isFinite(field.max)) return condition;
    const min = field.min as number;
    const max = field.max as number;
    const numeric = typeof condition.value === 'number' ? condition.value : null;
    const range = isNumberRange(condition.value) ? condition.value : null;
    let next: PredicateCondition | null = null;
    if (condition.operator === 'gt' && numeric !== null && numeric >= max) {
      next = { kind: 'predicate', fieldId: field.id, operator: 'gte', value: max };
    } else if (condition.operator === 'gte' && numeric !== null && numeric > max) {
      next = { kind: 'predicate', fieldId: field.id, operator: 'gte', value: max };
    } else if (condition.operator === 'lt' && numeric !== null && numeric <= min) {
      next = { kind: 'predicate', fieldId: field.id, operator: 'lte', value: min };
    } else if (condition.operator === 'lte' && numeric !== null && numeric < min) {
      next = { kind: 'predicate', fieldId: field.id, operator: 'lte', value: min };
    } else if (condition.operator === 'eq' && numeric !== null && (numeric < min || numeric > max)) {
      next = { kind: 'predicate', fieldId: field.id, operator: 'between', value: { min, max } };
    } else if (condition.operator === 'between' && range && (range.min > max || range.max < min)) {
      next = { kind: 'predicate', fieldId: field.id, operator: 'between', value: { min, max } };
    }
    if (next) {
      changed = true;
      const nextInterval = predicateInterval(next);
      notes.push(`${field.name}放宽到 ${nextInterval ? formatInterval([next], field) : `${min} ~ ${max}`}`);
      return next;
    }
    return condition;
  };

  const widened: BusinessRule = { ...rule, conditions: relax(rule.conditions) as ConditionGroup };
  if (!changed) return null;
  const candidate = applyRemediationPatches(project, [{ patches: [{ targetId: rule.id, rule: widened }] }]);
  const baselineConflicts = baseline.overlaps.filter((overlap) => overlap.conflict).length;
  if (!passesGate(project, candidate, baseline, (analysis) =>
    !analysis.unreachableRuleIds.includes(rule.id)
      && analysis.overlaps.filter((overlap) => overlap.conflict).length <= baselineConflicts)) return null;
  return {
    id: `rem-widen-${rule.id}`,
    kind: 'widen-interval',
    issueType: 'unreachable',
    title: `放宽不可达规则「${rule.name}」的越界条件`,
    description: `条件取值超出了字段合法范围：${notes.join('；')}。放宽后规则可被命中，覆盖率不会下降。`,
    ruleIds: [rule.id],
    patches: [{ targetId: rule.id, rule: widened }],
  };
}

function removeUnreachableSuggestion(
  project: RuleProject,
  baseline: RuleAnalysis,
  rule: BusinessRule,
): RuleRemediation {
  const candidate = applyRemediationPatches(project, [{ patches: [{ targetId: rule.id, delete: true }] }]);
  const baselineConflicts = baseline.overlaps.filter((overlap) => overlap.conflict).length;
  passesGate(project, candidate, baseline, (analysis) =>
    analysis.overlaps.filter((overlap) => overlap.conflict).length <= baselineConflicts);
  return {
    id: `rem-remove-${rule.id}`,
    kind: 'remove-rule',
    issueType: 'unreachable',
    title: `删除始终不可达的「${rule.name}」`,
    description: '该规则的条件在合法输入范围内从不成立（如同一字段要求两个互斥值），删除它不会改变任何输入的决策。',
    ruleIds: [rule.id],
    patches: [{ targetId: rule.id, delete: true }],
  };
}

function passesGate(
  project: RuleProject,
  candidate: RuleProject,
  baseline: RuleAnalysis,
  extra: (analysis: RuleAnalysis) => boolean,
): boolean {
  if (candidate.rules.some((rule) => !project.rules.some((original) => original.id === rule.id))) return false;
  const analysis = analyzeRules(candidate);
  if (!preservesCoverage(project, candidate)) return false;
  void baseline;
  return extra(analysis);
}

// 用前后两套规则边界的并集作为统一采样网格，
// 避免「收窄后断点消失导致分区重算、覆盖率百分比口径漂移」的误判。
function preservesCoverage(before: RuleProject, after: RuleProject): boolean {
  const mergedProject: RuleProject = {
    ...before,
    rules: [...before.rules, ...after.rules.filter((rule) => !before.rules.some((original) => original.id === rule.id))],
  };
  const { cases } = enumerateInputCases(mergedProject);
  if (cases.length === 0) return true;
  let beforeCovered = 0;
  let afterCovered = 0;
  for (const values of cases) {
    if (before.rules.some((rule) => matchesRule(rule, values))) beforeCovered += 1;
    if (after.rules.some((rule) => matchesRule(rule, values))) afterCovered += 1;
  }
  return afterCovered >= beforeCovered;
}

export function sharedCoveragePercent(before: RuleProject, after: RuleProject): { before: number; after: number; cases: number } {
  const mergedProject: RuleProject = {
    ...before,
    rules: [...before.rules, ...after.rules.filter((rule) => !before.rules.some((original) => original.id === rule.id))],
  };
  const { cases } = enumerateInputCases(mergedProject);
  if (cases.length === 0) return { before: 0, after: 0, cases: 0 };
  let beforeCovered = 0;
  let afterCovered = 0;
  for (const values of cases) {
    if (before.rules.some((rule) => matchesRule(rule, values))) beforeCovered += 1;
    if (after.rules.some((rule) => matchesRule(rule, values))) afterCovered += 1;
  }
  return {
    before: Math.round((beforeCovered / cases.length) * 100),
    after: Math.round((afterCovered / cases.length) * 100),
    cases: cases.length,
  };
}

function topLevelPredicates(group: ConditionGroup): PredicateCondition[] | null {
  return group.conditions.every((condition) => condition.kind === 'predicate')
    ? group.conditions as PredicateCondition[]
    : null;
}

function canonicalCondition(condition: RuleCondition): string {
  if (condition.kind === 'group') {
    return `g(${condition.operator},[${condition.conditions.map(canonicalCondition).sort().join(',')}])`;
  }
  return `p(${condition.fieldId},${condition.operator},${JSON.stringify(condition.value)})`;
}

function isNumberRange(value: PredicateCondition['value']): value is { min: number; max: number } {
  return typeof value === 'object' && value !== null && 'min' in value && 'max' in value;
}

function formatInterval(conditions: PredicateCondition[], field: RuleField): string {
  const intervals = conditions.map(predicateInterval).filter((item): item is NumericInterval => item !== null);
  if (intervals.length !== conditions.length || intervals.length === 0) return '更窄的区间';
  const low = Math.max(...intervals.map((interval) => interval.low));
  const high = Math.min(...intervals.map((interval) => interval.high));
  const lowOpen = intervals.some((interval) => interval.low === low && interval.lowOpen);
  const highOpen = intervals.some((interval) => interval.high === high && interval.highOpen);
  const lowText = Number.isFinite(low) ? `${lowOpen ? '(' : '['}${low}` : `(${field.min ?? '-∞'}`;
  const highText = Number.isFinite(high) ? `${high}${highOpen ? ')' : ']'}` : `${field.max ?? '∞'})`;
  return `${lowText}, ${highText}`;
}
