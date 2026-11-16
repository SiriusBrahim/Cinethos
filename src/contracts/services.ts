/**
 * MIA Faz 1A ② — Alan (domain) servis sözleşmeleri.
 *
 * KURALLAR (kullanıcı planı §4 bağımlılık tablosu):
 * - Her servis KENDİ verisinin sahibidir; başka modülün deposuna doğrudan
 *   yazamaz.
 * - Zevk profili hesaplar; Öneri servisi tercihleri KULLANIR, hafızaya
 *   doğrudan yazamaz.
 * - TMDB'den gelen metaveri puanları kullanıcı puanlarının ÜZERİNE
 *   YAZILAMAZ (İçerik ↔ Kütüphane ayrımı).
 * - Tüm yazma işlemleri `ProfileRef` (profileId + revision) zorunludur.
 *
 * Buradaki girdi/çıktı tipleri yapısal olarak minimal tutulmuştur; gerçek
 * çekirdek tipleriyle (SavedItem, TasteProfile, Recommendation vb.) eşleme
 * Faz 1B'de yapılır. Bu dosya core'dan import YAPMAZ.
 */

import type {
  LibraryListId,
  MediaKind,
  OperationOutcome,
  ProfileRef,
} from './common.ts';
import type { TypedAppEvent } from './events.ts';

/** Ortak liste/medya tipleri buradan da dışa açılır (uyumluluk). */
export type { LibraryListId, MediaKind } from './common.ts';

/* ------------------------------------------------------------------ */
/* Kütüphane — ILibraryService                                         */
/* ------------------------------------------------------------------ */

/** İzleme durumu → sinyal ağırlığı (kullanıcı planı §4 "Önemli bir ayrıntı"). */
export type LibrarySignalKind =
  | 'interest' /* İzleyeceğim  — ilgi sinyali */
  | 'ongoing' /* İzliyorum    — devam eden ilgi */
  | 'consumed' /* İzledim      — gerçek tüketim (+puan) */
  | 'rejected' /* İlgilenmiyorum — negatif tercih */;

/** Liste işlemi girdisi — profileId ZORUNLU. */
export interface AddLibraryItemInput {
  readonly ref: ProfileRef;
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly list: LibraryListId;
  /** Ekleme anında verilen puan (yalnızca 'watched' için anlamlı). */
  readonly rating?: number | null;
}

/** Durum/puan güncelleme girdisi. */
export interface UpdateLibraryItemInput {
  readonly ref: ProfileRef;
  readonly mediaKey: string;
  readonly list?: LibraryListId;
  readonly rating?: number | null;
}

/** Silme girdisi (geri alma için kayıt tutulur — mevcut tombstone davranışı). */
export interface RemoveLibraryItemInput {
  readonly ref: ProfileRef;
  readonly mediaKey: string;
}

/**
 * ILibraryService — kullanıcı içerik işlemlerinin TEK giriş noktası.
 * Bir içerik ister Dashboard'dan, ister Keşfet'ten, ister detay ekranından
 * eklenirse eklensin aynı işlem hattından geçer.
 */
export interface ILibraryService {
  addItem(input: AddLibraryItemInput): Promise<OperationOutcome>;
  updateItem(input: UpdateLibraryItemInput): Promise<OperationOutcome>;
  removeItem(input: RemoveLibraryItemInput): Promise<OperationOutcome>;
  /** Bir medyanın güncel liste/puan durumunu sorgular (profil izole). */
  getItem(ref: ProfileRef, mediaKey: string): Promise<{
    list: LibraryListId | null;
    rating: number | null;
  } | null>;
}

/* ------------------------------------------------------------------ */
/* İçerik — IContentService                                            */
/* ------------------------------------------------------------------ */

/** Normalleştirilmiş içerik metaverisi (yapısal minimal). */
export interface ContentMetadata {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly title: string;
  readonly genres: readonly string[];
  readonly overview?: string;
  readonly posterPath?: string | null;
  /** TMDB puanı — kullanıcı puanıyla KARIŞTIRILMAZ. */
  readonly externalRating?: number | null;
}

/**
 * IContentService — TMDB metaverisi, kimlik standardizasyonu ve katalog
 * stokları. Kullanıcı puanlarına YAZMA yetkisi YOKTUR.
 */
export interface IContentService {
  /** Metaveriyi getirir (önbellek → TMDB proxy sırasıyla). */
  getMetadata(mediaKey: string): Promise<ContentMetadata | null>;
  /** Eksik metaverileri arka planda tamamlar (CatalogItemEnriched olayı üretir). */
  enrichMissing(profileId: string): Promise<OperationOutcome>;
  /** Katalog stok araması (keşif/aday havuzu girdisi). */
  searchCatalog(query: string, limit?: number): Promise<readonly ContentMetadata[]>;
}

/* ------------------------------------------------------------------ */
/* Zevk — ITasteService                                                */
/* ------------------------------------------------------------------ */

/** Zevk profili özeti (yapısal minimal; gerçek tip Faz 1B'de eşlenir). */
export interface TasteProfileSummaryView {
  readonly profileId: string;
  /** Hesaplandığı revision — eski hesap reddi için. */
  readonly revision: number;
  readonly pillars: Readonly<Record<string, number>>;
  readonly updatedAt: string | null;
}

/**
 * ITasteService — zevk profili erişimi ve yeniden hesaplama.
 * Zevk motoru (core/taste) KORUNUR; bu sözleşme onun dış yüzüdür.
 */
export interface ITasteService {
  /** Güncel zevk profili özetini döner (revision damgalı). */
  getProfile(ref: ProfileRef): Promise<TasteProfileSummaryView | null>;
  /** Profili verilen revision tabanından yeniden hesaplar (arka plan çağırır). */
  refreshProfile(ref: ProfileRef): Promise<OperationOutcome>;
}

/* ------------------------------------------------------------------ */
/* Hafıza — IMemoryService                                             */
/* ------------------------------------------------------------------ */

/**
 * IMemoryService — kanıt defteri ve öğrenme durumu.
 * Hafıza, profil verisinden AYRIDIR (kullanıcı planı §4 üç veri katmanı).
 */
export interface IMemoryService {
  /**
   * Bir uygulama olayını hafızaya işler.
   * ZORUNLU: idempotent — aynı `eventId` ikinci kez işlenirse çift kanıt
   * oluşmaz (kullanıcı planı §3 güvenlik kuralları).
   */
  processEvent(event: TypedAppEvent): Promise<OperationOutcome>;
}

/* ------------------------------------------------------------------ */
/* İlişki — IRelationshipService                                       */
/* ------------------------------------------------------------------ */

/** İlişki kenarı (içerik/oyuncu/kavram düğümleri arası). */
export interface RelationshipEdge {
  readonly fromKey: string;
  readonly toKey: string;
  readonly kind: 'similar-content' | 'shared-concept' | 'shared-actor';
  readonly weight: number;
}

/** IRelationshipService — ilişki grafiği erişimi. */
export interface IRelationshipService {
  /** Bir düğümden çıkan ilişkileri ağırlık sırasıyla döner. */
  getRelated(ref: ProfileRef, nodeKey: string, limit?: number): Promise<readonly RelationshipEdge[]>;
  /** Etkilenen kenarları artımlı yeniden hesaplar (arka plan çağırır). */
  recomputeEdges(ref: ProfileRef, nodeKeys: readonly string[]): Promise<OperationOutcome>;
}

/* ------------------------------------------------------------------ */
/* Öneri — IRecommendationService                                      */
/* ------------------------------------------------------------------ */

/** Öneri sonucu (yapısal minimal; gerçek tip Faz 1B'de eşlenir). */
export interface RecommendationView {
  readonly mediaKey: string;
  readonly score: number;
  /** Öneri nedeni — kullanıcıya gösterilen açıklama. */
  readonly reason: string;
}

/**
 * IRecommendationService — öneri üretimi ve sıralama.
 * KURAL: Öneri motoru kullanıcı hafızasına DOĞRUDAN YAZAMAZ; yalnızca zevk
 * profili + katalog + geri bildirim okur.
 */
export interface IRecommendationService {
  /** Güncel önerileri döner (önbellekli). */
  getRecommendations(ref: ProfileRef, limit?: number): Promise<readonly RecommendationView[]>;
  /** Öneri önbelleğini geçersizleştirip yeniden hesaplamayı kuyruğa alır. */
  refresh(ref: ProfileRef): Promise<OperationOutcome>;
}
