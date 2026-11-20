/**
 * Sunucu içerik zekâsı bağlantılarının ilişki grafiğine katılması.
 *
 * Yerel grafik oyuncu/evren/atmosfer bağlarını üretir; bu modül yalnızca
 * sunucudan gelen anlamsal komşulukları mevcut düğümler arasına ekler.
 */

import type {
  RelationshipGraphData,
  RelationshipGraphLink,
} from './relationship-explorer.ts';

export interface ServerRelatedSignal {
  readonly targetKey: string;
  readonly cosineSimilarity: number;
  readonly atmosphereSimilarity?: number;
  readonly sharedConcepts?: string[];
  readonly confidence?: number;
}

/**
 * Sunucu içerik zekâsının ürettiği anlamsal komşulukları yerel ilişki
 * grafiğine katar. Yalnızca grafikte zaten görünen düğümler arasında bağ
 * kurar; yerel oyuncu/evren/atmosfer bağlantılarını silmez veya ezmez.
 */
export function mergeServerRelatedLinks(
  graph: RelationshipGraphData,
  sourceKey: string,
  related: readonly ServerRelatedSignal[]
): RelationshipGraphData {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (!nodeIds.has(sourceKey) || related.length === 0) return graph;
  const links = graph.links.map((link) => ({
    ...link,
    alsoRelatedBy: [...link.alsoRelatedBy],
    evidence: [...link.evidence],
  }));
  const byTarget = new Map<string, RelationshipGraphLink>();
  for (const link of links) {
    const target = typeof link.target === 'string' ? link.target : link.target.id;
    if (target) byTarget.set(target, link);
  }
  let changed = false;
  for (const signal of related) {
    if (!nodeIds.has(signal.targetKey) || signal.targetKey === sourceKey) continue;
    const similarity = Math.max(0, Math.min(1, Number(signal.cosineSimilarity) || 0));
    const atmosphere = Math.max(0, Math.min(1, Number(signal.atmosphereSimilarity) || similarity));
    const confidence = Math.max(
      0,
      Math.min(1, Number(signal.confidence) || similarity)
    );
    const evidence = [
      `İçerik zekâsı: %${Math.round(similarity * 100)} anlamsal benzerlik`,
      ...(atmosphere > 0 ? [`Atmosfer benzerliği: %${Math.round(atmosphere * 100)}`] : []),
      ...(signal.sharedConcepts?.length
        ? [`Ortak kavramlar: ${signal.sharedConcepts.slice(0, 4).join(', ')}`]
        : []),
    ];
    const existing = byTarget.get(signal.targetKey);
    if (existing) {
      if (!existing.alsoRelatedBy.includes('semantic')) existing.alsoRelatedBy.push('semantic');
      if (!existing.evidence.some((line) => line.startsWith('İçerik zekâsı'))) {
        existing.evidence.push(...evidence);
        existing.confidence = Math.max(existing.confidence, confidence);
        changed = true;
      }
      continue;
    }
    links.push({
      source: sourceKey,
      target: signal.targetKey,
      type: 'semantic',
      alsoRelatedBy: ['semantic'],
      score: Math.round(similarity * 100),
      confidence,
      evidence,
      distance: 96,
    });
    byTarget.set(signal.targetKey, links[links.length - 1]);
    changed = true;
  }
  return changed ? { ...graph, links } : graph;
}
