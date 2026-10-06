import { useState } from 'react';
import { describePredicate, metricsFromAnalysis } from '../../domain/ruleRemediation';
import type {
  BusinessRule,
  PredicateCondition,
  RemedyCategory,
  RemedyMetrics,
  RemediationPlan,
  RuleAnalysis,
  RuleField,
  RulePatch,
  RuleProject,
} from '../../models/ruleModel';
import type { WorkspaceState } from '../../viewmodels/workspaceViewModel';
import type { InspectionViewModel } from './inspectionViewModel';

interface RemediationPanelProps {
  state: WorkspaceState;
  viewModel: InspectionViewModel;
  onOpenRule: (ruleId: string) => void;
}

const categoryCopy: Record<RemedyCategory, { label: string; tone: string }> = {
  conflict: { label: '同优先级冲突', tone: 'severity-danger' },
  overlap: { label: '条件重叠', tone: 'severity-warn' },
  shadowed: { label: '被遮蔽', tone: 'severity-warn' },
  unreachable: { label: '不可达', tone: 'severity-warn' },
  duplicate: { label: '完全重复', tone: 'severity-warn' },
};

const kindVerb: Record<RulePatch['type'], string> = {
  'set-priority': '调整优先级',
  'add-predicate': '追加收窄条件',
  'replace-predicate': '调整条件边界',
  'remove-predicate': '移除矛盾条件',
  'merge-rules': '合并规则',
};

export function RemediationPanel({ state, viewModel, onOpenRule }: RemediationPanelProps) {
  const project = state.project;
  const analysis = state.analysis;
  const plan = state.remediationPlan;
  const frozen = Boolean(project?.frozenVersionId);
  if (!project || !analysis || !plan) return null;

  const hasIssues = analysis.overlaps.length > 0 || analysis.unreachableRuleIds.length > 0 || analysis.shadowedRuleIds.length > 0;
  if (!hasIssues) return null;

  return (
    <section className="remediation-section">
      <RemediationReportCard state={state} viewModel={viewModel} />
      <div className="remediation-heading">
        <div>
          <span className="eyebrow">REMEDIATION / 处置视图</span>
          <h2>可执行的调整方向</h2>
          <p>每条建议都已在规则副本上模拟重算；勾选后一次性应用，未勾选的建议不会改动任何规则。</p>
        </div>
        {plan.suggestions.length > 0 && <span className="count-chip">{plan.suggestions.length} 条可采纳</span>}
      </div>
      {frozen && <div className="frozen-notice">◈ 当前版本已冻结，处置建议暂不可应用。请先从版本记录复制一份继续编辑。</div>}
      {plan.suggestions.length === 0 ? (
        <div className="remediation-empty card-surface"><span>✶</span><p>这些问题涉及 OR 组合或多维条件交叉，暂时没有安全的自动调整方向，请在规则工作台手动修改条件或优先级。</p></div>
      ) : (
        <RemediationList key={`${project.id}-${state.checkStatus === 'success' ? 'fresh' : 'stale'}-${plan.suggestions.length}`} project={project} plan={plan} baseline={metricsFromAnalysis(analysis)} disabled={frozen} viewModel={viewModel} onOpenRule={onOpenRule} />
      )}
      {plan.manualCount > 0 && <p className="remediation-manual">另有 {plan.manualCount} 个问题未生成安全建议，需要手动判断条件语义。</p>}
    </section>
  );
}

function RemediationList({ project, plan, baseline, disabled, viewModel, onOpenRule }: {
  project: RuleProject;
  plan: RemediationPlan;
  baseline: RemedyMetrics;
  disabled: boolean;
  viewModel: InspectionViewModel;
  onOpenRule: (ruleId: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const byId = new Map(project.rules.map((rule) => [rule.id, rule]));
  const allSelected = plan.suggestions.length > 0 && selected.size === plan.suggestions.length;

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(plan.suggestions.map((suggestion) => suggestion.id)));
  };

  const apply = (): void => {
    const ok = viewModel.applyRemedies([...selected]);
    if (ok) setSelected(new Set());
  };

  return (
    <div className="remediation-list card-surface">
      <div className="remediation-list-toolbar">
        <label className="remedy-select-all"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={disabled} /><span>全选</span></label>
        <div className="button-row">
          <span className="remedy-selected-count">已选 {selected.size} / {plan.suggestions.length}</span>
          <button className="button button-primary" disabled={disabled || selected.size === 0} onClick={apply}><span>✓</span> 应用所选并重算</button>
        </div>
      </div>
      {plan.suggestions.map((suggestion) => {
        const checked = selected.has(suggestion.id);
        const tag = categoryCopy[suggestion.category];
        return (
          <article key={suggestion.id} className={`remedy-row${checked ? ' remedy-row-selected' : ''}`}>
            <label className="remedy-check">
              <input type="checkbox" checked={checked} onChange={() => toggle(suggestion.id)} disabled={disabled} aria-label={`采纳${suggestion.title}`} />
            </label>
            <div className="remedy-copy">
              <div className="remedy-title-line">
                <span className={`severity-tag ${tag.tone}`}>{tag.label}</span>
                <strong>{suggestion.title}</strong>
                <span className="remedy-kind">{kindVerb[suggestion.patch.type]}</span>
              </div>
              <p>{suggestion.rationale}</p>
              <div className="remedy-meta">
                <span className="remedy-affected">
                  {suggestion.affectedRuleIds.map((id, index) => (
                    <span key={id}>{index > 0 && <i className="remedy-dot">·</i>}<button className="inline-rule-link" onClick={() => onOpenRule(id)}>{byId.get(id)?.name ?? id}</button></span>
                  ))}
                </span>
                <PatchDetail patch={suggestion.patch} fields={project.fields} byId={byId} />
              </div>
            </div>
            <ProjectedMetrics projected={suggestion.projected} baseline={baseline} />
          </article>
        );
      })}
    </div>
  );
}

function PatchDetail({ patch, fields, byId }: { patch: RulePatch; fields: RuleField[]; byId: Map<string, BusinessRule> }) {
  if (patch.type === 'set-priority') {
    return <span className="remedy-patch-detail">优先级 → <b>{patch.priority}</b></span>;
  }
  if (patch.type === 'merge-rules') {
    return <span className="remedy-patch-detail">保留「{byId.get(patch.keepRuleId)?.name ?? patch.keepRuleId}」的结果 <b>{patch.result || '（空）'}</b></span>;
  }
  if (patch.type === 'remove-predicate') {
    return <span className="remedy-patch-detail">移除：<b>{describePredicate(patch.predicate, fields)}</b></span>;
  }
  const predicate: PredicateCondition = patch.type === 'replace-predicate' ? patch.next : patch.predicate;
  return (
    <span className="remedy-patch-detail">
      {patch.type === 'replace-predicate' ? <><s>{describePredicate(patch.predicate, fields)}</s> → </> : null}
      <b>{describePredicate(predicate, fields)}</b>
    </span>
  );
}

function ProjectedMetrics({ projected, baseline }: { projected: RemedyMetrics; baseline: RemedyMetrics }) {
  const items: { label: string; value: string; delta: number; suffix?: string }[] = [
    { label: '覆盖', value: String(projected.coveragePercent), delta: projected.coveragePercent - baseline.coveragePercent, suffix: '%' },
    { label: '冲突', value: String(projected.conflictCount), delta: baseline.conflictCount - projected.conflictCount },
    { label: '重叠', value: String(projected.overlapCount), delta: baseline.overlapCount - projected.overlapCount },
    { label: '不可达', value: String(projected.unreachableCount), delta: baseline.unreachableCount - projected.unreachableCount },
    { label: '遮蔽', value: String(projected.shadowedCount), delta: baseline.shadowedCount - projected.shadowedCount },
  ];
  return (
    <div className="remedy-metrics">
      {items.map((item) => (
        <div key={item.label} className={`remedy-metric${item.delta > 0 ? ' metric-better' : item.delta < 0 ? 'metric-worse' : ''}`}>
          <span>{item.label}</span>
          <b>{item.value}{item.suffix ?? ''}</b>
          {item.delta !== 0 && <i>{item.delta > 0 ? `−${item.delta}` : `+${-item.delta}`}{item.suffix ?? ''}</i>}
        </div>
      ))}
    </div>
  );
}

function RemediationReportCard({ state, viewModel }: { state: WorkspaceState; viewModel: InspectionViewModel }) {
  const report = state.remediationReport;
  const analysis: RuleAnalysis | null = state.analysis;
  if (!report) return null;
  const after = analysis ? metricsFromAnalysis(analysis) : undefined;
  const rows: { label: string; before: number; afterValue?: number; suffix?: string }[] = [
    { label: '输入空间覆盖率', before: report.before.coveragePercent, afterValue: after?.coveragePercent, suffix: '%' },
    { label: '同优先级冲突', before: report.before.conflictCount, afterValue: after?.conflictCount },
    { label: '重叠关系', before: report.before.overlapCount, afterValue: after?.overlapCount },
    { label: '不可达规则', before: report.before.unreachableCount, afterValue: after?.unreachableCount },
    { label: '被遮蔽规则', before: report.before.shadowedCount, afterValue: after?.shadowedCount },
  ];
  const recomputing = state.checkStatus === 'checking' || state.checkStatus === 'scheduled';
  return (
    <section className="remediation-report card-surface">
      <header>
        <div><span className="eyebrow">APPLIED / 处理前后对比</span><h3>已应用 {report.applied.length} 条建议</h3></div>
        <div className="button-row">
          {recomputing && <span className="report-recomputing"><i className="spinner" /> 正在重算…</span>}
          <button className="text-button" onClick={() => viewModel.dismissReport()}>收起对比</button>
        </div>
      </header>
      <ul className="report-actions">
        {report.applied.map((item) => <li key={item.suggestionId}><span>✓</span>{item.title}</li>)}
      </ul>
      {report.skippedCount > 0 && <p className="report-skipped">有 {report.skippedCount} 条补丁因规则已被其他改动影响而跳过，未做任何猜测性修改。</p>}
      <div className="report-metrics">
        {rows.map((row) => {
          const delta = row.afterValue === undefined ? 0 : row.before - row.afterValue;
          const coverageRow = row.suffix === '%';
          const improved = row.afterValue === undefined ? false : coverageRow ? row.afterValue > row.before : delta > 0;
          const worsened = row.afterValue === undefined ? false : coverageRow ? row.afterValue < row.before : delta < 0;
          return (
            <div key={row.label} className={`report-metric${improved ? ' metric-better' : worsened ? ' metric-worse' : ''}`}>
              <span>{row.label}</span>
              <div className="report-before-after">
                <b>{row.before}{row.suffix ?? ''}</b>
                <i>→</i>
                <strong>{row.afterValue === undefined ? '…' : `${row.afterValue}${row.suffix ?? ''}`}</strong>
              </div>
              {row.afterValue !== undefined && (improved || worsened) && <em>{coverageRow ? `${row.afterValue - row.before > 0 ? '+' : ''}${row.afterValue - row.before}%` : delta > 0 ? `减少 ${delta}` : `增加 ${-delta}`}</em>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
