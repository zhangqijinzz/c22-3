import { analyzeRules } from './ruleAnalysis';
import { cloneData } from '../models/projectFactory';
import type {
  BusinessRule,
  PredicateCondition,
  RemedyCategory,
  RemedyMetrics,
  RemedySuggestion,
  RemediationPlan,
  RuleAnalysis,
  RuleField,
  RulePatch,
  RuleProject,
  SampleInput,
} from '../models/ruleModel';

const MAX_SUGGESTIONS = 8;

const categoryRank: Record<RemedyCategory, number> = {
  conflict: 0,
  unreachable: 1,
  shadowed: 2,
  duplicate: 3,
  overlap: 4,
};

export function metricsFromAnalysis(analysis: RuleAnalysis): RemedyMetrics {
  return {
    coveragePercent: analysis.coveragePercent,
    conflictCount: analysis.overlaps.filter((overlap) => overlap.conflict).length,
    overlapCount: analysis.overlaps.length,
    unreachableCount: analysis.unreachableRuleIds.length,
    shadowedCount: analysis.shadowedRuleIds.length,
  };
}

interface SimulatedSuggestion {
  category: RemedyCategory;
  title: string;
  rationale: string;
  affectedRuleIds: string[];
  resolves: string[];
  patch: RulePatch;
  projected: RemedyMetrics;
}

interface Candidate {
  category: RemedyCategory;
  title: string;
  rationale: string;
  affectedRuleIds: string[];
  resolves: string[];
  patch: RulePatch;
  groupKey: string;
  score: number[];
}

interface NumericBound {
  fieldId: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  value: number;
}

export function buildRemediationPlan(project: RuleProject, analysis: RuleAnalysis): RemediationPlan {
  const baseline = metricsFromAnalysis(analysis);
  const byId = new Map(project.rules.map((rule) => [rule.id, rule]));
  const indexOf = (ruleId: string): number => project.rules.findIndex((rule) => rule.id === ruleId);

  const candidates: Candidate[] = [];
  const addCandidate = (
    category: SimulatedSuggestion['category'],
    title: string,
    rationale: string,
    affectedRuleIds: string[],
    resolves: string[],
    patch: RulePatch,
    groupKey: string,
  ): void => {
    const trial = applyPatchToProject(project, [patch]);
    const projected = metricsFromAnalysis(analyzeRules(trial));
    if (!isSafeProjection(baseline, projected, category)) return;
    const score = scoreMetrics(baseline, projected, category);
    if (score[0] <= 0) return;
    candidates.push({ category, title, rationale, affectedRuleIds, resolves, patch, groupKey, score });
  };

  const identicalGroups = buildIdenticalGroups(project);
  const handledPairs = new Set<string>();

  // 条件完全相同的规则：结果相同视为重复，结果不同视为同条件冲突，都可以合并。
  for (const groupIds of identicalGroups) {
    const group = groupIds.map((id) => byId.get(id)!).filter(Boolean);
    const kept = [...group].sort((a, b) => (b.priority - a.priority) || indexOf(a.id) - indexOf(b.id))[0];
    const results = new Set(group.map((rule) => rule.result.trim()));
    const conflict = results.size > 1;
    const pairKey = [...groupIds].sort().join('|');
    handledPairs.add(pairKey);
    addCandidate(
      conflict ? 'conflict' : 'duplicate',
      conflict ? '合并条件相同但结果不同的规则' : '合并完全重复的规则',
      conflict
        ? `保留优先级更高的「${kept.name}」及其结果「${kept.result}」，删除其余规则；若结果需要统一，请合并后手动改结果。`
        : `这 ${group.length} 条规则命中范围与结果完全一致，保留「${kept.name}」即可。`,
      [...groupIds],
      [pairKey],
      { type: 'merge-rules', ruleIds: [...groupIds], keepRuleId: kept.id, result: kept.result },
      `identical:${[...groupIds].sort().join('|')}`,
    );
  }

  for (const overlap of analysis.overlaps) {
    const ruleA = byId.get(overlap.ruleAId);
    const ruleB = byId.get(overlap.ruleBId);
    if (!ruleA || !ruleB) continue;
    const pairKey = [overlap.ruleAId, overlap.ruleBId].sort().join('|');
    if (handledPairs.has(pairKey)) continue;

    if (overlap.conflict) {
      // 同优先级且结果不同：把其中一条排到另一条之后，由优先级决定胜负。
      const winner = ruleA.priority === ruleB.priority
        ? (indexOf(ruleA.id) < indexOf(ruleB.id) ? ruleA : ruleB)
        : (ruleA.priority > ruleB.priority ? ruleA : ruleB);
      const loser = winner === ruleA ? ruleB : ruleA;
      addCandidate(
        'conflict',
        `把「${loser.name}」排到「${winner.name}」之后`,
        `两条规则在 ${formatWitnessShort(overlap.witness, project)} 时同时命中且结果不同。将「${loser.name}」优先级降至 ${winner.priority - 1}，冲突由优先级路径消除。`,
        [loser.id],
        [pairKey],
        { type: 'set-priority', ruleId: loser.id, priority: winner.priority - 1 },
        'reorder-conflict',
      );
      continue;
    }

    // 普通重叠：找到一对数值边界，把其中一条的区间收窄到边界另一侧。
    const narrow = findNarrowPatch(ruleA, ruleB, project.fields);
    if (narrow) {
      const target = byId.get(narrow.ruleId)!;
      const field = project.fields.find((candidate) => candidate.id === narrow.fieldId);
      addCandidate(
        'overlap',
        `收窄「${target.name}」的${field ? `「${field.name}」` : ''}条件`,
        narrow.rationale,
        [target.id],
        [pairKey],
        narrow.patch,
        `narrow:${pairKey}:${narrow.fieldId}`,
      );
    }
  }

  // 被完全遮蔽：把被遮蔽规则抬到主要遮挡者之前。
  for (const ruleId of analysis.shadowedRuleIds) {
    const rule = byId.get(ruleId);
    const blockerId = analysis.shadowedBlockers[ruleId];
    const blocker = blockerId ? byId.get(blockerId) : undefined;
    if (!rule || !blocker) continue;
    addCandidate(
      'shadowed',
      `把「${rule.name}」排到「${blocker.name}」之前`,
      `「${rule.name}」的每一次命中都被「${blocker.name}」抢先。将其优先级提高到 ${blocker.priority + 1}，命中路径上优先采用本规则。`,
      [rule.id],
      [`shadow:${rule.id}`],
      { type: 'set-priority', ruleId: rule.id, priority: blocker.priority + 1 },
      `shadowed:${rule.id}`,
    );
  }

  // 不可达：优先把越界边界拉回字段范围；其次删除自相矛盾的那一半条件。
  for (const ruleId of analysis.unreachableRuleIds) {
    const rule = byId.get(ruleId);
    if (!rule || rule.conditions.operator !== 'and') continue;
    const snap = findSnapPatch(rule, project.fields);
    if (snap) {
      addCandidate(
        'unreachable',
        `放宽「${rule.name}」的${snap.fieldName}条件`,
        snap.rationale,
        [rule.id],
        [`unreachable:${rule.id}`],
        snap.patch,
        `unreachable:${rule.id}`,
      );
      continue;
    }
    const contradiction = findContradictionPatch(rule, project.fields);
    if (contradiction) {
      addCandidate(
        'unreachable',
        `移除「${rule.name}」中互相矛盾的${contradiction.fieldName}条件`,
        contradiction.rationale,
        [rule.id],
        [`unreachable:${rule.id}`],
        contradiction.patch,
        `unreachable:${rule.id}`,
      );
    }
  }

  // 同一问题（groupKey）只保留模拟效果最好的方案；相同补丁只出现一次。
  const bestByGroup = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = bestByGroup.get(candidate.groupKey);
    if (!existing || compareScore(candidate.score, existing.score) < 0) bestByGroup.set(candidate.groupKey, candidate);
  }
  const seenPatchKeys = new Set<string>();
  const suggestions: RemedySuggestion[] = [];
  const sorted = [...bestByGroup.values()].sort((a, b) => compareScore(a.score, b.score) || categoryRank[a.category] - categoryRank[b.category] || a.title.localeCompare(b.title));
  for (const candidate of sorted) {
    const patchKey = JSON.stringify(candidate.patch);
    if (seenPatchKeys.has(patchKey)) continue;
    seenPatchKeys.add(patchKey);
    suggestions.push({
      id: `remedy-${suggestions.length + 1}`,
      category: candidate.category,
      kind: patchKind(candidate.patch),
      title: candidate.title,
      rationale: candidate.rationale,
      affectedRuleIds: candidate.affectedRuleIds,
      resolves: candidate.resolves,
      patch: candidate.patch,
      projected: metricsFromAnalysis(analyzeRules(applyPatchToProject(project, [candidate.patch]))),
    });
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }

  const resolvedIssues = new Set<string>(suggestions.flatMap((suggestion) => suggestion.resolves));
  let manualCount = 0;
  for (const overlap of analysis.overlaps) {
    const pairKey = [overlap.ruleAId, overlap.ruleBId].sort().join('|');
    if (!resolvedIssues.has(pairKey)) manualCount += 1;
  }
  for (const ruleId of analysis.shadowedRuleIds) if (!resolvedIssues.has(`shadow:${ruleId}`)) manualCount += 1;
  for (const ruleId of analysis.unreachableRuleIds) if (!resolvedIssues.has(`unreachable:${ruleId}`)) manualCount += 1;

  return { suggestions, manualCount };
}

export function applyRemedyPatches(
  project: RuleProject,
  patches: RulePatch[],
): { project: RuleProject; skipped: number } {
  let next = cloneData(project);
  let skipped = 0;
  const merges = patches.filter((patch) => patch.type === 'merge-rules');
  const mergeRemoveIds = new Set<string>();
  for (const merge of merges) {
    const keep = next.rules.find((rule) => rule.id === merge.keepRuleId);
    if (!keep || merge.ruleIds.some((id) => !next.rules.some((rule) => rule.id === id))) {
      skipped += 1;
      continue;
    }
    keep.result = merge.result;
    merge.ruleIds.filter((id) => id !== merge.keepRuleId).forEach((id) => mergeRemoveIds.add(id));
  }
  if (mergeRemoveIds.size) next = { ...next, rules: next.rules.filter((rule) => !mergeRemoveIds.has(rule.id)) };

  for (const patch of patches) {
    if (patch.type === 'merge-rules') continue;
    const rule = next.rules.find((candidate) => candidate.id === patch.ruleId);
    if (!rule) {
      skipped += 1;
      continue;
    }
    if (patch.type === 'set-priority') {
      rule.priority = patch.priority;
      continue;
    }
    if (rule.conditions.operator !== 'and') {
      skipped += 1;
      continue;
    }
    if (patch.type === 'add-predicate') {
      const duplicate = rule.conditions.conditions.some(
        (condition) => condition.kind === 'predicate' && samePredicate(condition, patch.predicate),
      );
      if (!duplicate) rule.conditions.conditions = [...rule.conditions.conditions, cloneData(patch.predicate)];
      continue;
    }
    const index = rule.conditions.conditions.findIndex(
      (condition) => condition.kind === 'predicate' && samePredicate(condition, patch.predicate),
    );
    if (index < 0) {
      skipped += 1;
      continue;
    }
    if (patch.type === 'replace-predicate') {
      const conditions = [...rule.conditions.conditions];
      conditions[index] = cloneData(patch.next);
      rule.conditions.conditions = conditions;
    } else {
      if (rule.conditions.conditions.length <= 1) {
        // 移除后规则将没有任何条件，不做猜测性删除：保留规则并报告跳过。
        skipped += 1;
        continue;
      }
      rule.conditions.conditions = rule.conditions.conditions.filter((_, itemIndex) => itemIndex !== index);
    }
  }

  return { project: next, skipped };
}

function applyPatchToProject(project: RuleProject, patches: RulePatch[]): RuleProject {
  return applyRemedyPatches(project, patches).project;
}

function buildIdenticalGroups(project: RuleProject): string[][] {
  const groups = new Map<string, string[]>();
  for (const rule of project.rules) {
    if (rule.conditions.operator !== 'and' || rule.conditions.conditions.some((condition) => condition.kind === 'group')) continue;
    const signature = rule.conditions.conditions
      .filter((condition): condition is PredicateCondition => condition.kind === 'predicate')
      .map(predicateSignature)
      .sort()
      .join('&');
    const group = groups.get(signature) ?? [];
    group.push(rule.id);
    groups.set(signature, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function predicateSignature(condition: PredicateCondition): string {
  return JSON.stringify(condition);
}

function samePredicate(a: PredicateCondition, b: PredicateCondition): boolean {
  return predicateSignature(a) === predicateSignature(b);
}

function findNarrowPatch(
  ruleA: BusinessRule,
  ruleB: BusinessRule,
  fields: RuleField[],
): { ruleId: string; fieldId: string; rationale: string; patch: RulePatch } | undefined {
  const boundsA = collectBounds(ruleA);
  const boundsB = collectBounds(ruleB);
  for (const boundA of boundsA) {
    for (const boundB of boundsB) {
      if (boundA.fieldId !== boundB.fieldId) continue;
      if (isLowerBound(boundA) && isUpperBound(boundB) && boundB.value >= boundA.value) {
        return makeNarrow(ruleB, boundB, ruleA, boundA, fields, true);
      }
      if (isUpperBound(boundA) && isLowerBound(boundB) && boundA.value >= boundB.value) {
        return makeNarrow(ruleA, boundA, ruleB, boundB, fields, true);
      }
      if (isLowerBound(boundA) && isLowerBound(boundB) && boundA.value !== boundB.value) {
        // 两条下界 a < b：更松的规则（a）收窄到 [a, b)，≥b 的区域交给更紧的规则。
        const looser = boundA.value < boundB.value
          ? { rule: ruleA, bound: boundA, other: ruleB, tighter: boundB }
          : { rule: ruleB, bound: boundB, other: ruleA, tighter: boundA };
        const field2 = fields.find((candidate) => candidate.id === looser.bound.fieldId);
        const rationale2 = `两条规则在${field2 ? `「${field2.name}」` : '数值'}上下同向设限。把「${looser.rule.name}」的上界收到 ${boundText(looser.tighter)}，更高的区域交给「${looser.other.name}」，两者不再重叠。`;
        return {
          ruleId: looser.rule.id,
          fieldId: looser.bound.fieldId,
          rationale: rationale2,
          patch: { type: 'add-predicate', ruleId: looser.rule.id, predicate: { kind: 'predicate', fieldId: looser.bound.fieldId, operator: 'lt', value: looser.tighter.value } },
        };
      }
      if (isUpperBound(boundA) && isUpperBound(boundB) && boundA.value !== boundB.value) {
        // 两条上界 a > b：更松的规则（a）收窄到 >b，≤b 的区域交给更紧的规则。
        const looser = boundA.value > boundB.value
          ? { rule: ruleA, bound: boundA, other: ruleB, tighter: boundB }
          : { rule: ruleB, bound: boundB, other: ruleA, tighter: boundA };
        const field2 = fields.find((candidate) => candidate.id === looser.bound.fieldId);
        const rationale2 = `两条规则在${field2 ? `「${field2.name}」` : '数值'}上同向设限。把「${looser.rule.name}」的下界收到 ${boundText(looser.tighter)}，更低的区域交给「${looser.other.name}」，两者不再重叠。`;
        return {
          ruleId: looser.rule.id,
          fieldId: looser.bound.fieldId,
          rationale: rationale2,
          patch: { type: 'add-predicate', ruleId: looser.rule.id, predicate: { kind: 'predicate', fieldId: looser.bound.fieldId, operator: 'gt', value: looser.tighter.value } },
        };
      }
    }
  }
  return undefined;
}

function makeNarrow(
  target: BusinessRule,
  bound: NumericBound,
  other: BusinessRule,
  otherBound: NumericBound,
  fields: RuleField[],
  replace: boolean,
): { ruleId: string; fieldId: string; rationale: string; patch: RulePatch } {
  const field = fields.find((candidate) => candidate.id === bound.fieldId);
  const fieldName = field ? `「${field.name}」` : '数值';
  const rationale = replace
    ? `两条规则的${fieldName}区间存在重叠。把「${target.name}」的边界收紧到「${other.name}」边界（${boundText(otherBound)}）的另一侧，重叠区域不再同时命中。`
    : `两条规则在${fieldName}同向设限。把「${target.name}」收到「${other.name}」的边界 ${boundText(otherBound)} 处，重叠区域交给「${other.name}」处理。`;
  const predicate: PredicateCondition = { kind: 'predicate', fieldId: bound.fieldId, operator: isLowerBound(bound) ? 'lt' : 'gt', value: otherBound.value };
  const patch: RulePatch = replace
    ? { type: 'replace-predicate', ruleId: target.id, predicate: toPredicate(bound), next: predicate }
    : { type: 'add-predicate', ruleId: target.id, predicate };
  return { ruleId: target.id, fieldId: bound.fieldId, rationale, patch };
}

function collectBounds(rule: BusinessRule): NumericBound[] {
  const bounds: NumericBound[] = [];
  const walk = (conditions: BusinessRule['conditions']): void => {
    for (const condition of conditions.conditions) {
      if (condition.kind === 'group') {
        walk(condition);
        continue;
      }
      if (condition.operator === 'between' && typeof condition.value === 'object') {
        bounds.push({ fieldId: condition.fieldId, operator: 'gte', value: condition.value.min });
        bounds.push({ fieldId: condition.fieldId, operator: 'lte', value: condition.value.max });
      } else if (typeof condition.value === 'number' && (condition.operator === 'gt' || condition.operator === 'gte' || condition.operator === 'lt' || condition.operator === 'lte')) {
        bounds.push({ fieldId: condition.fieldId, operator: condition.operator, value: condition.value });
      }
    }
  };
  walk(rule.conditions);
  return bounds;
}

function isLowerBound(bound: NumericBound): boolean {
  return bound.operator === 'gt' || bound.operator === 'gte';
}

function isUpperBound(bound: NumericBound): boolean {
  return bound.operator === 'lt' || bound.operator === 'lte';
}

function toPredicate(bound: NumericBound): PredicateCondition {
  return { kind: 'predicate', fieldId: bound.fieldId, operator: bound.operator, value: bound.value };
}

function boundText(bound: NumericBound): string {
  return `${isLowerBound(bound) ? '≥' : '≤'} ${formatNumber(bound.value)}`;
}

function findSnapPatch(
  rule: BusinessRule,
  fields: RuleField[],
): { fieldName: string; rationale: string; patch: RulePatch } | undefined {
  const predicates = rootPredicates(rule);
  for (const predicate of predicates) {
    const field = fields.find((candidate) => candidate.id === predicate.fieldId && candidate.type === 'number');
    if (!field || field.min === undefined || field.max === undefined) continue;
    if (predicate.operator === 'between' && typeof predicate.value === 'object') {
      const { min, max } = predicate.value;
      if (min > field.max || max < field.min) {
        const next: PredicateCondition = {
          kind: 'predicate',
          fieldId: field.id,
          operator: min > field.max ? 'gte' : 'lte',
          value: min > field.max ? field.max : field.min,
        };
        return {
          fieldName: `「${field.name}」`,
          rationale: `区间 [${formatNumber(min)}, ${formatNumber(max)}] 整体落在字段范围 [${formatNumber(field.min)}, ${formatNumber(field.max)}] 之外，规则永远不会命中。把边界拉回 ${next.operator === 'gte' ? `终点 ${formatNumber(field.max)}` : `起点 ${formatNumber(field.min)}`} 即可保留命中路径。`,
          patch: { type: 'replace-predicate', ruleId: rule.id, predicate, next },
        };
      }
    }
    if (typeof predicate.value !== 'number') continue;
    if (predicate.operator === 'gt' && predicate.value >= field.max) {
      const next: PredicateCondition = { kind: 'predicate', fieldId: field.id, operator: 'gte', value: field.max };
      return {
        fieldName: `「${field.name}」`,
        rationale: `条件 > ${formatNumber(predicate.value)} 在字段上限 ${formatNumber(field.max)} 处也取不到值，合法输入永远不满足。改为 ≥ ${formatNumber(field.max)}。`,
        patch: { type: 'replace-predicate', ruleId: rule.id, predicate, next },
      };
    }
    if (predicate.operator === 'gte' && predicate.value > field.max) {
      const next: PredicateCondition = { kind: 'predicate', fieldId: field.id, operator: 'gte', value: field.max };
      return {
        fieldName: `「${field.name}」`,
        rationale: `条件 ≥ ${formatNumber(predicate.value)} 超过字段上限 ${formatNumber(field.max)}，合法输入永远不满足。改为 ≥ ${formatNumber(field.max)}。`,
        patch: { type: 'replace-predicate', ruleId: rule.id, predicate, next },
      };
    }
    if (predicate.operator === 'lt' && predicate.value <= field.min) {
      const next: PredicateCondition = { kind: 'predicate', fieldId: field.id, operator: 'lte', value: field.min };
      return {
        fieldName: `「${field.name}」`,
        rationale: `条件 < ${formatNumber(predicate.value)} 在字段起点 ${formatNumber(field.min)} 处也取不到值，合法输入永远不满足。改为 ≤ ${formatNumber(field.min)}。`,
        patch: { type: 'replace-predicate', ruleId: rule.id, predicate, next },
      };
    }
    if (predicate.operator === 'lte' && predicate.value < field.min) {
      const next: PredicateCondition = { kind: 'predicate', fieldId: field.id, operator: 'lte', value: field.min };
      return {
        fieldName: `「${field.name}」`,
        rationale: `条件 ≤ ${formatNumber(predicate.value)} 低于字段起点 ${formatNumber(field.min)}，合法输入永远不满足。改为 ≤ ${formatNumber(field.min)}。`,
        patch: { type: 'replace-predicate', ruleId: rule.id, predicate, next },
      };
    }
  }
  return undefined;
}

function findContradictionPatch(
  rule: BusinessRule,
  fields: RuleField[],
): { fieldName: string; rationale: string; patch: RulePatch } | undefined {
  const predicates = rootPredicates(rule);
  for (let left = 0; left < predicates.length; left += 1) {
    for (let right = left + 1; right < predicates.length; right += 1) {
      const a = predicates[left];
      const b = predicates[right];
      if (a.fieldId !== b.fieldId) continue;
      const field = fields.find((candidate) => candidate.id === a.fieldId);
      const contradiction = describeContradiction(a, b);
      if (contradiction) {
        return {
          fieldName: field ? `「${field.name}」` : '',
          rationale: `规则同时要求 ${contradiction}，两个条件不可能同时成立。移除较晚加入的那一半，规则即可命中。`,
          patch: { type: 'remove-predicate', ruleId: rule.id, predicate: b },
        };
      }
    }
  }
  return undefined;
}

function describeContradiction(a: PredicateCondition, b: PredicateCondition): string | undefined {
  if (typeof a.value === 'number' && typeof b.value === 'number') {
    const lower = [a, b].find((condition) => condition.operator === 'gt' || condition.operator === 'gte');
    const upper = [a, b].find((condition) => condition.operator === 'lt' || condition.operator === 'lte');
    if (lower && upper) {
      const lowerInclusive = lower.operator === 'gte';
      const upperInclusive = upper.operator === 'lte';
      const empty = lowerInclusive && upperInclusive ? lower.value > upper.value : lower.value >= upper.value;
      if (empty) return `${lower.operator === 'gt' ? '>' : '≥'} ${formatNumber(lower.value)} 与 ${upper.operator === 'lt' ? '<' : '≤'} ${formatNumber(upper.value)}`;
    }
    if (a.operator === 'eq' && b.operator === 'eq' && a.value !== b.value) {
      return `= ${formatNumber(a.value)} 与 = ${formatNumber(b.value)}`;
    }
  }
  if (a.operator === 'eq' && b.operator === 'notEq' && typeof a.value === 'string' && a.value === b.value) {
    return `等于与不等于「${a.value}」`;
  }
  if (a.operator === 'isTrue' && b.operator === 'isFalse') return '为真与为假';
  return undefined;
}

function rootPredicates(rule: BusinessRule): PredicateCondition[] {
  if (rule.conditions.operator !== 'and') return [];
  return rule.conditions.conditions.filter(
    (condition): condition is PredicateCondition => condition.kind === 'predicate',
  );
}

function isSafeProjection(baseline: RemedyMetrics, projected: RemedyMetrics, category: RemedyCategory): boolean {
  if (projected.coveragePercent < baseline.coveragePercent) return false;
  // 任何调整都不允许把别的规则变成不可达。
  if (projected.unreachableCount > baseline.unreachableCount) return false;
  // 放宽不可达边界可能与既有规则产生新的优先级关系，属于需要让用户看到的权衡
  // （投影指标会明确标出冲突/遮蔽增加），不做硬性否决；其余类别不得制造冲突或遮蔽。
  if (category !== 'unreachable') {
    if (projected.conflictCount > baseline.conflictCount) return false;
    if (projected.shadowedCount > baseline.shadowedCount) return false;
  }
  return true;
}

function scoreMetrics(baseline: RemedyMetrics, projected: RemedyMetrics, category: RemedyCategory): number[] {
  const conflictsReduced = baseline.conflictCount - projected.conflictCount;
  const overlapsReduced = baseline.overlapCount - projected.overlapCount;
  const shadowedReduced = baseline.shadowedCount - projected.shadowedCount;
  const unreachableReduced = baseline.unreachableCount - projected.unreachableCount;
  const coverageGain = projected.coveragePercent - baseline.coveragePercent;
  // 元组按字典序比较：首项是该类别要解决的主问题收益（必须 >0），
  // 其余维度只决定同问题多个方案之间的取舍，不抵消主收益。
  switch (category) {
    case 'conflict':
      if (conflictsReduced <= 0) return [0];
      return [conflictsReduced, overlapsReduced, unreachableReduced, shadowedReduced, coverageGain];
    case 'unreachable':
      if (unreachableReduced <= 0) return [0];
      return [unreachableReduced, coverageGain, conflictsReduced, shadowedReduced, overlapsReduced];
    case 'shadowed':
      if (shadowedReduced <= 0) return [0];
      return [shadowedReduced, conflictsReduced, unreachableReduced, overlapsReduced, coverageGain];
    case 'duplicate':
    case 'overlap':
      if (overlapsReduced <= 0) return [0];
      return [overlapsReduced, conflictsReduced, unreachableReduced, shadowedReduced, coverageGain];
  }
}

function compareScore(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function patchKind(patch: RulePatch): RemedySuggestion['kind'] {
  switch (patch.type) {
    case 'set-priority': return 'reorder';
    case 'add-predicate': return 'narrow';
    case 'replace-predicate': return 'widen';
    case 'remove-predicate': return 'remove-condition';
    case 'merge-rules': return 'merge';
  }
}

function formatWitnessShort(values: SampleInput, project: RuleProject): string {
  return project.fields
    .map((field) => {
      const value = values[field.id];
      if (value === undefined || value === '') return null;
      return `${field.name} ${typeof value === 'boolean' ? value ? '是' : '否' : value}`;
    })
    .filter((part): part is string => part !== null)
    .join('、');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

export function describePredicate(condition: PredicateCondition, fields: RuleField[]): string {
  const field = fields.find((candidate) => candidate.id === condition.fieldId);
  const fieldName = field?.name ?? condition.fieldId;
  if (condition.operator === 'between' && typeof condition.value === 'object') {
    return `${fieldName} ${formatNumber(condition.value.min)} – ${formatNumber(condition.value.max)}`;
  }
  if (condition.operator === 'isTrue') return `${fieldName} 为真`;
  if (condition.operator === 'isFalse') return `${fieldName} 为假`;
  const operatorText: Record<string, string> = { eq: '=', notEq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };
  return `${fieldName} ${operatorText[condition.operator] ?? condition.operator} ${String(condition.value)}`;
}
