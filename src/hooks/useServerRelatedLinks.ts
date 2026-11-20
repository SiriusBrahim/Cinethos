import { useEffect, useRef } from 'react';
import type { RelationshipGraphData, RelationshipMode } from '../core/relationship-explorer.ts';
import { mergeServerRelatedLinks } from '../core/relationship-server-links.ts';
import { fetchRelatedContent } from '../services/content-intelligence-api.ts';

/**
 * İçerik zekâsı → İlişki Keşfi köprüsü.
 *
 * Sunucudaki anlamsal/atmosferik komşular yalnızca grafikte görünen düğümler
 * arasında bağa dönüşür. Sunucu erişilemezse yerel grafik aynen kalır.
 */
export function useServerRelatedLinks(options: {
  readonly graphData: RelationshipGraphData | null;
  readonly mode: RelationshipMode;
  readonly sourceKey: string;
  readonly setGraphData: (updater: (prev: RelationshipGraphData | null) => RelationshipGraphData | null) => void;
}): void {
  const { graphData, mode, sourceKey, setGraphData } = options;
  const lastMergeRef = useRef('');

  useEffect(() => {
    if (!graphData || mode !== 'relationships' || !sourceKey) return undefined;
    if (!graphData.nodes.some((node) => node.id === sourceKey)) return undefined;
    const mergeKey = `${graphData.createdAt}|${sourceKey}`;
    if (lastMergeRef.current === mergeKey) return undefined;
    lastMergeRef.current = mergeKey;
    const controller = new AbortController();
    void fetchRelatedContent(sourceKey, { limit: 12, signal: controller.signal })
      .then((related) => {
        if (controller.signal.aborted || related.length === 0) return;
        setGraphData((prev) =>
          prev ? mergeServerRelatedLinks(prev, sourceKey, related) : prev
        );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [graphData, mode, sourceKey, setGraphData]);
}
