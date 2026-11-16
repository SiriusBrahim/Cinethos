/**
 * Cinethos — M0 rapor karşılaştırması (saf; dosya yazmaz).
 *
 * Faz 3 öncesi ve sonrası M0 raporlarını karşılaştırır:
 * - yeni mimari ihlalleri,
 * - düzeltilen (artık görülmeyen) ihlaller,
 * - durumu kötüleşen/düzelen kontroller.
 */
import { extractViolations, violationKey } from './architecture-guard.mjs';
import { classifyFinding, loadRiskPolicy, summarizeRisks } from './risk-classifier.mjs';

/** Baseline veya tam raporu karşılaştırılabilir biçime getirir. */
export function normalizeSnapshot(data) {
  if (!data || typeof data !== 'object') return null;
  const checks = new Map();
  const list = Array.isArray(data.checks) ? data.checks : [];
  for (const check of list) {
    if (check && check.id) checks.set(check.id, check.status ?? 'UNKNOWN');
  }
  return {
    commit: data.meta?.commit ?? data.commit ?? null,
    generatedAt: data.meta?.generatedAt ?? data.generatedAt ?? null,
    verdict: data.verdict?.status ?? data.verdict ?? null,
    violations: extractViolations(data),
    checks,
  };
}

/**
 * @param {object} previous normalizeSnapshot çıktısı
 * @param {object} current normalizeSnapshot çıktısı
 * @returns {{
 *   previousCommit: string|null,
 *   currentCommit: string|null,
 *   newViolations: object[],
 *   fixedViolations: object[],
 *   unchangedViolations: number,
 *   checkRegressions: Array<{id: string, from: string, to: string}>,
 *   checkImprovements: Array<{id: string, from: string, to: string}>,
 *   riskSummary: {counts: {R0: number, R1: number, R2: number}, autoFixable: number, total: number}
 * }}
 */
export function compareSnapshots(previous, current) {
  const previousKeys = new Set((previous?.violations ?? []).map(violationKey));
  const currentKeys = new Set((current?.violations ?? []).map(violationKey));
  const newViolations = (current?.violations ?? []).filter(
    (violation) => !previousKeys.has(violationKey(violation)),
  );
  const fixedViolations = (previous?.violations ?? []).filter(
    (violation) => !currentKeys.has(violationKey(violation)),
  );
  const unchangedViolations = (current?.violations ?? []).length - newViolations.length;

  const checkRegressions = [];
  const checkImprovements = [];
  for (const [id, status] of current?.checks ?? []) {
    if (!previous?.checks?.has(id)) continue;
    const before = previous.checks.get(id);
    if (before === 'PASS' && status !== 'PASS') checkRegressions.push({ id, from: before, to: status });
    if (before !== 'PASS' && status === 'PASS') checkImprovements.push({ id, from: before, to: status });
  }

  const policy = loadRiskPolicy();
  const riskSummary = summarizeRisks(
    newViolations.map((violation) => ({
      source: 'architecture',
      file: violation.file,
      rule: violation.rule,
      message: violation.specifier,
    })),
    policy,
  );

  return {
    previousCommit: previous?.commit ?? null,
    currentCommit: current?.commit ?? null,
    newViolations,
    fixedViolations,
    unchangedViolations,
    checkRegressions,
    checkImprovements,
    riskSummary,
  };
}

/** Karşılaştırmayı Markdown bölümüne çevirir (rapora eklenir). */
export function formatComparisonMarkdown(comparison, previousLabel = 'önceki rapor') {
  const lines = [];
  lines.push('## 5. Önceki raporla karşılaştırma');
  lines.push('');
  if (!comparison) {
    lines.push('Karşılaştırma yapılmadı (`--compare` verilmedi).');
    lines.push('');
    return lines;
  }
  lines.push(`- Önceki commit: \`${comparison.previousCommit ?? 'bilinmiyor'}\``);
  lines.push(`- Güncel commit: \`${comparison.currentCommit ?? 'bilinmiyor'}\``);
  lines.push(`- Yeni mimari ihlali: **${comparison.newViolations.length}**`);
  lines.push(`- Düzeltilen ihlal: **${comparison.fixedViolations.length}**`);
  lines.push(`- Değişmeyen ihlal: **${comparison.unchangedViolations}**`);
  lines.push('');
  if (comparison.newViolations.length > 0) {
    lines.push('### Yeni ihlaller (risk sınıflandırması)');
    lines.push('');
    lines.push('| Risk | Dosya:satır | Kural | Hedef | Otomatik düzeltme |');
    lines.push('|---|---|---|---|---|');
    for (const violation of comparison.newViolations.slice(0, 50)) {
      const classified = classifyFinding(
        { source: 'architecture', file: violation.file, rule: violation.rule },
        loadRiskPolicy(),
      );
      lines.push(
        `| ${classified.risk} | \`${violation.file}:${violation.line ?? '?'}\` | \`${violation.rule}\` | \`${violation.specifier}\` | ${classified.autoFixable ? 'uygun' : 'hayır'} |`,
      );
    }
    lines.push('');
    if (comparison.riskSummary.counts.R2 > 0) {
      lines.push(
        `> ${comparison.riskSummary.counts.R2} yeni ihlal R2 kapsamındadır: otomatik düzeltme yapılmaz, manuel görev taslağı gerekir.`,
      );
      lines.push('');
    }
  }
  if (comparison.fixedViolations.length > 0) {
    lines.push('### Düzeltilen ihlaller (istisna listesinden çıkarılmalı)');
    lines.push('');
    for (const violation of comparison.fixedViolations.slice(0, 50)) {
      lines.push(`- \`${violation.rule}\` → \`${violation.file}\` (${violation.specifier})`);
    }
    lines.push('');
  }
  if (comparison.checkRegressions.length > 0) {
    lines.push('### Kötüleşen kontroller');
    lines.push('');
    for (const change of comparison.checkRegressions) {
      lines.push(`- \`${change.id}\`: ${change.from} → ${change.to}`);
    }
    lines.push('');
  }
  if (comparison.checkImprovements.length > 0) {
    lines.push('### Düzelen kontroller');
    lines.push('');
    for (const change of comparison.checkImprovements) {
      lines.push(`- \`${change.id}\`: ${change.from} → ${change.to}`);
    }
    lines.push('');
  }
  lines.push(`_Karşılaştırma kaynağı: ${previousLabel}._`);
  lines.push('');
  return lines;
}
