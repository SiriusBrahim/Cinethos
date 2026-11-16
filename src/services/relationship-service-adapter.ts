/**
 * MIA Faz 1B ⑤a — İlişki motorunun servis sözleşmesine hazırlanması.
 *
 * BAĞLAMA STRATEJİSİ (işlev kaybı yok):
 * Mevcut `relationship-explorer.ts` saf fonksiyonlarla çalışır
 * (`relationshipNodeKey`, `strongestRelationship`). Bu adaptör onları
 * `IRelationshipService` sözleşmesine SARAR — motor koduna dokunulmaz,
 * mevcut tüm çağrılar (taste-map vb.) aynen çalışmaya devam eder.
 *
 * KURAL (kullanıcı planı §4): İlişki servisi kullanıcı profili kayıtlarına
 * YAZAMAZ; yalnızca okur ve grafik hesaplar.
 */

import type {
  IRelationshipService,
  OperationOutcome,
  ProfileRef,
  RelationshipEdge,
} from '../contracts/index.ts';
import {
  relationshipNodeKey,
  strongestRelationship,
  type RelationshipContent,
} from '../core/relationship-explorer.ts';

/** İlişki tipi → sözleşme kenar türü eşlemesi. */
function mapEdgeKind(type: string): RelationshipEdge['kind'] {
  if (type === 'person') return 'shared-actor';
  if (type === 'semantic' || type === 'atmosphere' || type === 'personal') return 'shared-concept';
  return 'similar-content'; // universe, contrast ve gelecek tipler
}

/** Adaptör seçenekleri — içerik kaynakları enjekte edilir (sahiplik kuralı). */
export interface CreateRelationshipServiceAdapterOptions {
  /** Kullanıcının kayıtlı içerikleri (Kütüphane Yöneticisinden okunur). */
  readonly getSavedItems: (ref: ProfileRef) => readonly RelationshipContent[];
  /** Aday katalog içerikleri (İçerik Yöneticisinden okunur). */
  readonly getCandidates: (ref: ProfileRef) => readonly RelationshipContent[];
  /** Tür adları (isteğe bağlı — ilişki zenginliği). */
  readonly genreNames?: Record<number, string>;
}

export function createRelationshipServiceAdapter(
  options: CreateRelationshipServiceAdapterOptions
): IRelationshipService {
  const { getSavedItems, getCandidates, genreNames } = options;

  return {
    async getRelated(
      ref: ProfileRef,
      nodeKey: string,
      limit = 10
    ): Promise<readonly RelationshipEdge[]> {
      if (!ref?.profileId) {
        throw new Error('getRelated: profileId zorunludur (K1 — profil izolasyonu)');
      }
      const all = [...getSavedItems(ref), ...getCandidates(ref)];
      const focus = all.find((item) => relationshipNodeKey(item) === nodeKey);
      if (!focus) return [];

      const edges: RelationshipEdge[] = [];
      for (const other of all) {
        const otherKey = relationshipNodeKey(other);
        if (otherKey === nodeKey) continue;
        const link = strongestRelationship(focus, other, 'all', genreNames ?? {});
        if (!link) continue;
        // source/target bazen düğüm nesnesi olabilir — anahtarlaştır:
        const sourceKey =
          typeof link.source === 'string' ? link.source : relationshipNodeKey(link.source);
        const targetKey =
          typeof link.target === 'string' ? link.target : relationshipNodeKey(link.target);
        if (sourceKey !== nodeKey && targetKey !== nodeKey) continue;
        edges.push({
          fromKey: sourceKey,
          toKey: targetKey,
          kind: mapEdgeKind(link.type),
          weight: link.confidenceScore ?? link.score / 100,
        });
      }
      edges.sort((a, b) => b.weight - a.weight);
      return edges.slice(0, Math.max(1, limit));
    },

    async recomputeEdges(_ref: ProfileRef, _nodeKeys: readonly string[]): Promise<OperationOutcome> {
      // Faz 5 işi: artımlı kenar yeniden hesaplama — mevcut grafik motoru
      // bağlandığında etkinleşecek. Şimdilik net ret (sessiz başarı YASAK).
      return {
        ok: false,
        error: 'not_implemented_faz5: artımlı kenar yeniden hesaplama Faz 5 bağlamasında etkinleşecek',
        retryable: false,
      };
    },
  };
}
