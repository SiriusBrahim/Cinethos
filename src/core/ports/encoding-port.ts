/**
 * Çekirdek içerik kodlama portu (F5-04).
 *
 * `relationship-explorer` öğe kodlamasını (vektör) hesaplamak için istemci
 * servisindeki önbellekli çözümleyiciyi kullanıyordu. Bu port ile çekirdek
 * somut servise bağımlı olmaz; adaptör (`src/services/encoding-service.ts`)
 * kendisini kaydeder ve mevcut davranış birebir korunur.
 */

import type { ItemFeatureEncoding } from '../encoding.ts';

export type ItemEncodingResolver = (item: unknown) => ItemFeatureEncoding;

let activeResolver: ItemEncodingResolver | null = null;

export function registerItemEncodingResolver(resolver: ItemEncodingResolver): void {
  activeResolver = resolver;
}

export function getItemEncodingResolver(): ItemEncodingResolver | null {
  return activeResolver;
}

/** Test izolasyonu: kayıtlı çözümleyiciyi temizler. */
export function resetItemEncodingResolverForTests(): void {
  activeResolver = null;
}
