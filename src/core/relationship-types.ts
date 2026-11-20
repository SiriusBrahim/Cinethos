/**
 * Faz 3 — İlişki türlerinin nötr tip modülü.
 *
 * `relationship-explorer.ts` ile `relationship-wordlists.ts` arasındaki dosya
 * düzeyindeki bağımlılık döngüsünü kırmak için tür tanımları buraya taşındı.
 * Explorer bu türleri yeniden dışa aktarır; mevcut import yolları bozulmaz.
 */

export type RelationshipType =
  | 'semantic'
  | 'person'
  | 'universe'
  | 'atmosphere'
  | 'contrast'
  | 'personal';

export type RelationshipStatusSignal =
  | 'completed-history'
  | 'interest'
  | 'neutral'
  | 'disliked'
  | 'hidden';
