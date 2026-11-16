/**
 * Cinethos — bulgu risk sınıflandırıcısı (M0).
 *
 * Bu modül yalnızca ETİKETLER: R0 / R1 / R2 ve otomatik düzeltmeye uygunluk.
 * Otomatik düzeltme uygulamaz, dosya yazmaz, branch/PR üretmez.
 *
 * - R0: deterministik, davranış değiştirmeyen düzeltme (ör. kullanılmayan import).
 * - R1: insan incelemesine sunulacak öneri (ayrı branch/PR).
 * - R2: insan tasarımı ve açık onayı zorunlu; otomatik onarım YASAK.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp } from './architecture-boundaries.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RISK_POLICY_PATH = path.join(MODULE_DIR, 'risk-policy.json');

export const DEFAULT_RISK_POLICY = {
  r2Globs: [],
  r1Sources: ['tsc', 'test', 'build', 'audit', 'config'],
  r0Rules: ['no-unused-vars', '@typescript-eslint/no-unused-vars', 'prefer-const'],
  r2Topics: [],
};

export function loadRiskPolicy(filePath = RISK_POLICY_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...DEFAULT_RISK_POLICY,
      ...parsed,
      r2Matchers: (parsed.r2Globs ?? DEFAULT_RISK_POLICY.r2Globs).map(globToRegExp),
      r2MatchersCompiled: true,
    };
  } catch {
    return { ...DEFAULT_RISK_POLICY, r2Matchers: [] };
  }
}

function policyMatchers(policy) {
  if (Array.isArray(policy?.r2Matchers)) return policy.r2Matchers;
  return (policy?.r2Globs ?? []).map(globToRegExp);
}

/**
 * @param {{ source: string, file?: string|null, rule?: string|null, severity?: string, fixable?: boolean, message?: string }} finding
 * @param {object} [policy]
 * @returns {{ risk: 'R0'|'R1'|'R2', autoFixable: boolean, rationale: string }}
 */
export function classifyFinding(finding, policy = DEFAULT_RISK_POLICY) {
  const source = String(finding?.source ?? 'unknown');
  const file = typeof finding?.file === 'string' ? finding.file : null;
  const rule = typeof finding?.rule === 'string' ? finding.rule : null;

  if (source === 'architecture') {
    return {
      risk: 'R2',
      autoFixable: false,
      rationale:
        'Mimari sınır ihlalleri taşıma/refaktör gerektirir; insan tasarımı ve onayı olmadan otomatik düzeltilemez.',
    };
  }

  if (file) {
    const matched = policyMatchers(policy).some((matcher) => matcher.test(file));
    if (matched) {
      return {
        risk: 'R2',
        autoFixable: false,
        rationale: `R2 alanı (${file}): şema/migration, kullanıcı verisi, senkronizasyon, öneri algoritmaları veya sözleşme sınırı.`,
      };
    }
  }

  if (source === 'eslint' && rule && (policy?.r0Rules ?? DEFAULT_RISK_POLICY.r0Rules).includes(rule)) {
    return {
      risk: 'R0',
      autoFixable: Boolean(finding.fixable),
      rationale: `R0 kuralı (${rule}): deterministik ve davranış değiştirmeyen lint düzeltmesi.`,
    };
  }

  if (source === 'audit') {
    return {
      risk: 'R1',
      autoFixable: false,
      rationale:
        'Bağımlılık güvenlik bulgusu: uyumlu sürüm yükseltmesi ayrı PR ve insan incelemesi gerektirir; major sürümler otomatik yükseltilmez.',
    };
  }

  if ((policy?.r1Sources ?? DEFAULT_RISK_POLICY.r1Sources).includes(source)) {
    return {
      risk: 'R1',
      autoFixable: Boolean(finding.fixable),
      rationale:
        'R1 bulgusu: düzeltme öneri olarak ayrı branch/PR üzerinde sunulur; otomatik merge yapılmaz.',
    };
  }

  return {
    risk: 'R1',
    autoFixable: false,
    rationale: 'Sınıflandırılmamış bulgu; insan incelemesi gerekir.',
  };
}

/** Bulgu listesini risk dağılımıyla özetler. */
export function summarizeRisks(findings, policy = DEFAULT_RISK_POLICY) {
  const counts = { R0: 0, R1: 0, R2: 0 };
  let autoFixable = 0;
  for (const finding of findings ?? []) {
    const classified = classifyFinding(finding, policy);
    counts[classified.risk] += 1;
    if (classified.autoFixable) autoFixable += 1;
  }
  return { counts, autoFixable, total: (findings ?? []).length };
}
