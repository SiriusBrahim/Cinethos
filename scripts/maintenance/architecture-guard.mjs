/**
 * Cinethos — mimari sınır koruma yardımcıları (saf; dosya yazmaz).
 *
 * Amaç: mevcut ihlalleri gerekçeli istisna listesinde tutarken
 *  - yeni ihlali görünür kılmak,
 *  - düzeltilen ihlalin istisnada kalmasını engellemek,
 *  - kuralların sessizce gevşetilmesini yakalamak.
 *
 * `architecture-baseline.json` istisnaları, `architecture-rules.lock.json`
 * kural bütünlüğünü (SHA-256 + zorunlu yasak kümeleri) tutar.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const BASELINE_VERSION = 1;
export const RULES_LOCK_VERSION = 1;

export function violationKey(violation) {
  return `${violation.rule}\u0000${violation.file}\u0000${violation.specifier}`;
}

export function computeRulesHash(rawText) {
  return crypto.createHash('sha256').update(rawText, 'utf8').digest('hex');
}

/**
 * İstisna listesi ile güncel ihlalleri karşılaştırır.
 * @returns {{ unexpected: object[], stale: object[], matched: object[] }}
 */
export function diffAgainstBaseline(violations, exceptions) {
  const expected = new Map();
  for (const exception of exceptions ?? []) {
    expected.set(violationKey(exception), exception);
  }
  const seen = new Set();
  const unexpected = [];
  const matched = [];
  for (const violation of violations ?? []) {
    const key = violationKey(violation);
    if (expected.has(key)) {
      seen.add(key);
      matched.push({ violation, exception: expected.get(key) });
    } else {
      unexpected.push(violation);
    }
  }
  const stale = [...expected.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([, exception]) => exception);
  return { unexpected, stale, matched };
}

/**
 * Kural dosyasının bütünlüğünü denetler.
 * - SHA-256 kilidi tutmalı (kural dosyası değiştiyse kilit de bilinçli güncellenir),
 * - kural kimlikleri ve her kuralın zorunlu yasak kümeleri korunmalı.
 * @returns {string[]} hata listesi (boşsa geçerli)
 */
export function validateRulesIntegrity(rulesRawText, rules, lock) {
  const errors = [];
  if (!lock || typeof lock !== 'object') return ['Kural kilidi (architecture-rules.lock.json) okunamadı.'];
  if (lock.version !== RULES_LOCK_VERSION) {
    errors.push(`Kural kilidi sürümü beklenen ${RULES_LOCK_VERSION} değil: ${lock.version}`);
  }
  const actualHash = computeRulesHash(rulesRawText);
  if (lock.sha256 !== actualHash) {
    errors.push(
      `architecture-rules.json özeti kilitle uyuşmuyor (beklenen ${lock.sha256}, gerçek ${actualHash}). Kural değişikliği bilinçliyse kilidi inceleyerek güncelleyin.`,
    );
  }

  const rulesById = new Map((rules?.rules ?? []).map((rule) => [rule.id, rule]));
  const expectedIds = Array.isArray(lock.ruleIds) ? lock.ruleIds : [];
  const actualIds = [...rulesById.keys()];
  for (const id of expectedIds) {
    if (!rulesById.has(id)) errors.push(`Zorunlu mimari kural eksik: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`Kilitsiz yeni mimari kural: ${id} (kilide eklenmeden kullanılamaz)`);
  }

  for (const [id, required] of Object.entries(lock.required ?? {})) {
    const rule = rulesById.get(id);
    if (!rule) continue;
    for (const layer of required.forbidLayers ?? []) {
      if (!(rule.forbidLayers ?? []).includes(layer)) {
        errors.push(`${id}: yasak katman gevşetilmiş, eksik: ${layer}`);
      }
    }
    for (const pkg of required.forbidPackages ?? []) {
      if (!(rule.forbidPackages ?? []).includes(pkg)) {
        errors.push(`${id}: yasak paket gevşetilmiş, eksik: ${pkg}`);
      }
    }
    for (const glob of required.from ?? []) {
      if (!(rule.from ?? []).includes(glob)) {
        errors.push(`${id}: kapsam globu kaldırılmış, eksik: ${glob}`);
      }
    }
    if (required.forbidNodeBuiltins === true && rule.forbidNodeBuiltins !== true) {
      errors.push(`${id}: Node yerleşik modül yasağı kaldırılmış.`);
    }
  }
  return errors;
}

export function loadJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Baseline/report dosyasından karşılaştırılabilir ihlal listesi çıkarır. */
export function extractViolations(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.violations)) return data.violations;
  if (Array.isArray(data.architecture?.ruleResults)) {
    return data.architecture.ruleResults.flatMap((rule) =>
      (rule.violations ?? []).map((violation) => ({ rule: rule.id, ...violation })),
    );
  }
  if (Array.isArray(data.exceptions)) return data.exceptions;
  return [];
}
