/**
 * Çekirdek portlarının uygulama katmanı adaptörleri (F5-04).
 *
 * Tek giriş noktası: bu modülü import etmek, çekirdeğin ihtiyaç duyduğu
 * API / IndexedDB / kodlama / seri kataloğu portlarını kaydeder. Adaptör
 * modülleri kendilerini kaydettikleri için sıra önemli değildir.
 */

import './core-idb-store.ts';
import './api-client.ts';
import './encoding-service.ts';
import './storage-idb.ts';
