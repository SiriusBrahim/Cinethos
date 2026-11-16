/**
 * MIA Faz 1A ② — Veri erişim sözleşmeleri.
 *
 * KRİTİK BULGU TEMELİ (Faz 1 hazırlık denetimi):
 * - `src/server/sqlite-primary-store.ts` SQLite sürücüsünü, `src/server/storage.ts`
 *   ise ana veri erişiminin büyük bölümünü yönetiyor. Faz 1'de yeni bir
 *   SQLiteRepository yazmak YERİNE mevcut depolama davranışını kapsayan bu
 *   sözleşme tanımlanır; Faz 1B/2'de her iki sürücü bu arayüze uyarlanır.
 * - SQLite sessiz JSON fallback (P1, §5.1): `getHealth()` gerçek aktif veri
 *   kaynağını dönmek ZORUNDADIR; kullanıcı SQLite sanarken JSON'a yazım
 *   görünmez kalamaz.
 *
 * KURAL (kullanıcı planı §4): İş mantığı doğrudan dosya/veritabanı
 * ayrıntılarına erişemez; yalnızca bu sözleşme üzerinden çalışır.
 * İki ana veri kaynağının (SQLite ve JSON) aynı anda "birincil" olması yasaktır.
 */

/** Depolama sürücüsü kimliği — mevcut `StorageDriver` ile uyumlu. */
export type StorageDriverId = 'json' | 'sqlite';

/** Depolama sağlığı — `SqlitePrimaryStore.status()` ile yapısal uyumlu. */
export interface StorageHealth {
  /** Gerçekten aktif sürücü (fallback sonrası gerçek durum). */
  readonly driver: StorageDriverId;
  /** Sürücü etkinleştirilmiş mi (ortam değişkeni/tercih düzeyinde). */
  readonly enabled: boolean;
  /** Sürücü çalışır durumda mı (SQLite açılabildi mi). */
  readonly available: boolean;
  /** Güncel revision (yoksa null). */
  readonly revision: number | null;
  /** Son yazım zamanı (ISO-8601, yoksa null). */
  readonly updatedAt: string | null;
  /** Son hata mesajı (sağlıklıysa null). */
  readonly lastError: string | null;
}

/** Okuma sonucu — belge + revision birlikte (tutarlılık için tek atom). */
export interface RepositoryReadResult<TDocument> {
  readonly document: TDocument | null;
  readonly revision: number | null;
  readonly health: StorageHealth;
}

/** Yazma seçenekleri. */
export interface SaveDataOptions {
  /**
   * İyimser kilitleme: belirtilirse güncel revision bu değerle uyuşmalıdır;
   * uyuşmazsa yazım reddedilir (StaleRevisionError). Profil izolasyonu için
   * yazan modül `ProfileRef.revision` değerini burada taşır.
   */
  readonly expectedRevision?: number;
  /** Yazma nedeni — günlük/panel için insan-okur etiket. */
  readonly reason?: string;
}

/** Yazma sonucu. */
export interface SaveDataResult {
  readonly ok: boolean;
  /** Yazım sonrası güncel revision (başarılıysa). */
  readonly revision?: number;
  /** Başarısızsa neden. */
  readonly error?: string;
  /** Revision çelişkisi mi (arıza değil, beklenen bir red). */
  readonly conflict?: boolean;
}

/** Revision çelişkisi hatası (iyimser kilitleme reddi). */
export class StaleRevisionError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number | null;

  constructor(expectedRevision: number, actualRevision: number | null) {
    super(`Revision çelişkisi: beklenen ${expectedRevision}, gerçek ${actualRevision ?? 'yok'}`);
    this.name = 'StaleRevisionError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/**
 * IDataRepository — ortak veri erişim sözleşmesi (genel, belge-agnostik).
 * Tüm repository'lerin (profil, kütüphane, katalog, keşif…) tabanı.
 */
export interface IDataRepository<TDocument = unknown> {
  /** Güncel belgeyi ve revision'ını okur. Boş depoda null döner. */
  read(): Promise<RepositoryReadResult<TDocument>>;
  /** Belgeyi yazar (iyimser kilitleme opsiyonel). */
  save(document: TDocument, options?: SaveDataOptions): Promise<SaveDataResult>;
  /** Yalnızca güncel revision (ucuz kontrol için). */
  getRevision(): Promise<number | null>;
  /** Gerçek aktif veri kaynağı dahil sağlık raporu. */
  getHealth(): Promise<StorageHealth>;
}

/**
 * PrimaryDataRepository — ANA kullanıcı verisi için birincil depo sözleşmesi.
 *
 * Kural: SQLite ve JSON aynı anda iki birincil kaynak OLAMAZ. Uygulama,
 * `getHealth().driver` değerini Sistem Yönetimi Paneli'nde göstermek
 * ZORUNDADIR (§5.1 — sessiz fallback yasağı).
 *
 * Faz 1B'de `DataDocument` (core) bu genel sözleşmenin `TDocument`
 * parametresiyle eşlenir; burada core'dan import YAPILMAZ (döngü önleme).
 */
export interface PrimaryDataRepository<TDocument = unknown>
  extends IDataRepository<TDocument> {
  /** Belgeyi yazar ve yazımın revision'ını kesin olarak döner. */
  save(document: TDocument, options?: SaveDataOptions): Promise<SaveDataResult>;
}
