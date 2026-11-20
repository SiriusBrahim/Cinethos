/**
 * İçerik Zekâsı istemci köprüsü.
 *
 * Sunucudaki anlamsal analiz kayıtlarını (`/api/content-intelligence/*`) okur ve
 * öneri hattına "hangi içerik hangi sevdiğin yapıma anlamsal olarak yakın"
 * sinyalini taşır. Sunucu kapalı/boşsa boş sonuç döner; keşif akışı durmaz.
 */

import { apiFetch } from './api-client.ts';

export interface ContentRelationshipSignal {
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly cosineSimilarity: number;
  readonly atmosphereSimilarity?: number;
  readonly sharedConcepts?: string[];
  readonly confidence?: number;
}

interface RelatedResponse {
  ok?: boolean;
  related?: ContentRelationshipSignal[];
}

const RELATED_TIMEOUT_MS = 4000;

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELATED_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await apiFetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  } catch {
    return null;
  }
}

/**
 * Verilen kaynak içeriklerin anlamsal komşularını tek bir haritada toplar.
 * `limit` her kaynak için komşu sayısıdır; toplam istek sayısı kaynak sayısıyla
 * sınırlıdır (çağıran taraf en fazla birkaç tohum geçirir).
 */
export async function loadSemanticRelationHints(
  sourceKeys: readonly string[],
  options: { limit?: number; signal?: AbortSignal; maxSources?: number } = {}
): Promise<Map<string, number>> {
  const hints = new Map<string, number>();
  const uniqueKeys = Array.from(new Set(sourceKeys.filter((key) => /^(movie|tv):\d+$/.test(key))));
  const sources = uniqueKeys.slice(0, Math.max(1, options.maxSources ?? 6));
  const limit = Math.max(1, Math.min(20, options.limit ?? 8));

  await Promise.all(
    sources.map(async (sourceKey) => {
      const data = await fetchJson<RelatedResponse>(
        `/api/content-intelligence/items/${encodeURIComponent(sourceKey)}/related?limit=${limit}`,
        options.signal
      );
      for (const link of data?.related ?? []) {
        const target = link?.targetKey;
        const similarity = Number(link?.cosineSimilarity);
        if (!target || !Number.isFinite(similarity)) continue;
        const score = Math.max(0, Math.min(1, similarity));
        hints.set(target, Math.max(hints.get(target) ?? 0, score));
      }
    })
  );

  return hints;
}

export interface ContentIntelligenceStatusSummary {
  readonly ok: boolean;
  readonly completed: number;
  readonly failed: number;
  readonly pending: number;
  readonly stale: number;
}

export async function fetchContentIntelligenceStatus(): Promise<ContentIntelligenceStatusSummary | null> {
  const data = await fetchJson<{
    ok?: boolean;
    counts?: { completed?: number; failed?: number; pending?: number };
    stale?: number;
  }>('/api/content-intelligence/status');
  if (!data?.ok) return null;
  return {
    ok: true,
    completed: Number(data.counts?.completed ?? 0),
    failed: Number(data.counts?.failed ?? 0),
    pending: Number(data.counts?.pending ?? 0),
    stale: Number(data.stale ?? 0),
  };
}
