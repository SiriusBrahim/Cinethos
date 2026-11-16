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
  WriteProfileRef,
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

/** Liste işlemi girdisi — profileId ve revision ZORUNLU (`WriteProfileRef`). */
export interface AddLibraryItemInput {
  readonly ref: WriteProfileRef;
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly list: LibraryListId;
  /** Ekleme anında verilen puan (yalnızca 'watched' için anlamlı). */
  readonly rating?: number | null;
}

/** Durum/puan güncelleme girdisi — `WriteProfileRef` ZORUNLU. */
export interface UpdateLibraryItemInput {
  readonly ref: WriteProfileRef;
  readonly mediaKey: string;
  readonly list?: LibraryListId;
  readonly rating?: number | null;
}

/** Silme girdisi (geri alma için kayıt tutulur — mevcut tombstone davranışı). */
export interface RemoveLibraryItemInput {
  readonly ref: WriteProfileRef;
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
/* İçerik Yöneticisi — IContentService                                 */
/* ------------------------------------------------------------------ */
/* SINIR KURALI (Content Manager ↔ Content Intelligence):               */
/* - Content Manager (`IContentService`): TMDB erişimi, kimlik          */
/*   standartlaştırma, katalog stoku, posterler ve ham/normalize       */
/*   `ContentMetadata` sahipliği. Vektör/atmosfer/benzerlik HESAPLAMAZ;*/
/*   kullanıcı puanlarına ASLA yazamaz.                                */
/* - Content Intelligence (`IContentIntelligenceService`): yalnızca      */
/*   normalize `ContentMetadata` üzerinden saf anlam çıkarma, 48-dim   */
/*   vektör kodlama, taksonomi özniteliği ve anlamsal karşılaştırma    */
/*   yapar. TMDB ağına doğrudan yazamaz, stok/kütüphane mutasyonu YAPMAZ.*/
/* ------------------------------------------------------------------ */

/** Normalleştirilmiş içerik metaverisi (Content Manager sahipliğinde). */
export interface ContentMetadata {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly title: string;
  readonly genres: readonly string[];
  readonly genreIds?: readonly number[];
  readonly overview?: string;
  readonly posterPath?: string | null;
  readonly releaseDate?: string;
  readonly keywords?: ReadonlyArray<{ readonly id: number; readonly name?: string }>;
  readonly originalLanguage?: string;
  readonly originCountries?: readonly string[];
  readonly runtimeMinutes?: number | null;
  readonly voteCount?: number | null;
  readonly popularity?: number | null;
  /** TMDB puanı — kullanıcı puanıyla KARIŞTIRILMAZ. */
  readonly externalRating?: number | null;
}

/**
 * IContentService — Content Manager sözleşmesi.
 * TMDB metaverisi, kanonik kimlik standardizasyonu ve katalog stoklarının
 * sahibidir. Kullanıcı puanlarına YAZMA ve anlamsal zevk skoru üretme yetkisi YOKTUR.
 */
export interface IContentService {
  /** Metaveriyi getirir (önbellek → TMDB proxy sırasıyla). */
  getMetadata(mediaKey: string): Promise<ContentMetadata | null>;
  /** Eksik metaverileri arka planda tamamlar (CatalogItemEnriched olayı üretir). */
  enrichMissing(ref: ProfileRef): Promise<OperationOutcome>;
  /** Katalog stok araması (keşif/aday havuzu girdisi). */
  searchCatalog(query: string, limit?: number): Promise<readonly ContentMetadata[]>;
  /** Ham tür ve kimliği kanonik anahtara (`movie:123` / `tv:456`) çevirir. */
  canonicalizeKey(mediaType: MediaKind, rawId: string | number): string;
}

/* ------------------------------------------------------------------ */
/* İçerik Zekâsı — IContentIntelligenceService                         */
/* ------------------------------------------------------------------ */

/** İçerik sinyalinin türetilme kaynağı. */
export type ContentSignalSource = 'tmdb' | 'semantic' | 'inferred' | 'manual';

/** Tekil içerik özniteliği (taksonomi / vektör sinyali). */
export interface ContentFeatureSignal {
  readonly metricId: string;
  /** 0-100 güç puanı. */
  readonly strength: number;
  /** 0-1 güven katsayısı. */
  readonly confidence: number;
  readonly source: ContentSignalSource;
  readonly evidence?: readonly string[];
}

/** İçeriğin çıkarılmış çok-boyutlu zekâ profili (kullanıcıdan bağımsız). */
export interface ContentFeatureProfileView {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly layoutVersion: number;
  readonly extractorVersion: string;
  /** Girdi metaverisinin deterministik özet imzası (önbellek anahtarı). */
  readonly signature: string;
  /** 48-boyutlu yoğun öznitelik vektörü. */
  readonly denseVector: readonly number[];
  /** 0-1 metaveri eksiksizlik oranı. */
  readonly completeness: number;
  readonly toneTags: readonly string[];
  readonly features: Readonly<Record<string, ContentFeatureSignal>>;
  readonly computedAt: string;
}

/** Belirli bir ruh hâli için aday içerik uyum değerlendirmesi. */
export interface ContentMoodEvaluation {
  readonly mediaKey: string;
  readonly moodId: string;
  /** 0-1 gerçek atmosfer/içerik uyum puanı (sabit sabitlenmiş değer değil). */
  readonly affinity: number;
  readonly confidence: number;
  readonly matchedSignals: readonly string[];
}

/** İki içerik arasındaki çok-katmanlı anlamsal karşılaştırma. */
export interface ContentSemanticComparison {
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly cosineSimilarity: number;
  readonly atmosphereSimilarity: number;
  readonly sharedConcepts: readonly string[];
  readonly confidence: number;
}

/**
 * IContentIntelligenceService — Content Intelligence sözleşmesi.
 * İçerik öznitelik çıkarımı, yoğun vektör kodlama, ruh hâli/atmosfer
 * analizi ve içerik-içi anlamsal karşılaştırmaların tek sahibidir.
 *
 * Yasaklar:
 * - Uzak TMDB HTTP çağrısı yapmaz (ham metaveriyi `IContentService`'ten alır).
 * - Kullanıcı listesi, kişisel puanı veya kalıcı kanıt defterine YAZMAZ.
 */
export interface IContentIntelligenceService {
  /** Tekil içerik için deterministik öznitelik profili ve yoğun vektör üretir. */
  analyzeContent(metadata: ContentMetadata): Promise<ContentFeatureProfileView>;
  /** Toplu içerik analizi (önbellek/worker uyumlu). */
  analyzeBatch(items: readonly ContentMetadata[]): Promise<readonly ContentFeatureProfileView[]>;
  /** İçeriğin verilen ruh hâliyle gerçek atmosfer/kavram uyumunu hesaplar. */
  evaluateMood(metadata: ContentMetadata, moodId: string): Promise<ContentMoodEvaluation>;
  /** İki içerik arasındaki anlamsal ve atmosferik benzerliği kanıtlarıyla ölçer. */
  compareContents(
    source: ContentMetadata,
    target: ContentMetadata
  ): Promise<ContentSemanticComparison>;
  /** Metaverisi güncellenen içeriğin önbellekteki öznitelik imzasını geçersizler. */
  invalidateSignature(mediaKey: string): Promise<void>;
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
  /** Profili verilen revision tabanından yeniden hesaplar (`WriteProfileRef` zorunlu). */
  refreshProfile(ref: WriteProfileRef): Promise<OperationOutcome>;
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
  /** Etkilenen kenarları artımlı yeniden hesaplar (`WriteProfileRef` zorunlu). */
  recomputeEdges(ref: WriteProfileRef, nodeKeys: readonly string[]): Promise<OperationOutcome>;
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
  /** Öneri önbelleğini geçersizleştirip yeniden hesaplamayı kuyruğa alır (`WriteProfileRef` zorunlu). */
  refresh(ref: WriteProfileRef): Promise<OperationOutcome>;
}
