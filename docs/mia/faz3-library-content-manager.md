# MIA Faz 3 — Library Manager & Content Manager

**Durum:** Uygulama tamamlandı (dal: `agent-2/phase-3`)
**Tarih:** 2026-11-16
**Kapsam:** Kod, mevcut mimariye entegrasyon, dokümantasyon. Test/CI/doğrulama işleri ayrı ajanların sorumluluğundadır.
**İlke:** Mevcut Repository, EventBus, ModuleRegistry, ProfileContext, `ContentMetadataSource` ve `ContentProcessingCoordinator` yeniden kullanılır; paralel sistem oluşturulmaz.

---

## 1. Amaç ve sonuç

| Önce | Sonra |
|---|---|
| Kütüphane kuralları (liste eşlemesi, zaman damgaları, normalize kayıt) yalnızca istemci hook'undaydı. | Kurallar `src/modules/library/operations.ts` içinde tek kaynak; istemci hook'u ve sunucu Library Manager aynı fonksiyonları kullanır. |
| Sunucuda tek öğelik kütüphane yazımı için merkezi servis yoktu; yalnızca `PUT /api/data` + diff vardı. | `ILibraryService` uygulaması `src/modules/library/service.ts`; repository + ProfileContext + EventBus üzerinden ekle/güncelle/kaldır/oku. |
| İçerik okuma yolları (TMDB, yerel katalog, içerik kaydı) dağınık tüketicilerdeydi. | `IContentService` uygulaması `src/modules/content/service.ts`; metaveri, arama, kimlik kanonikleştirme ve eksik zenginleştirme tek hattan. |
| Uygulama fabrikası yalnızca koordinatörü döndürüyordu. | `createCineTrackApp` dönüşünde `libraryService` ve `contentService`. |

## 2. Değişen / eklenen dosyalar

| Dosya | Tür | Not |
|---|---|---|
| `src/modules/library/operations.ts` | **yeni** | Saf kurallar: `mapWatchStatusToLibraryList`, `libraryListToWatchStatus`, `resolveItemActionTimestamps`, `buildLibraryItem`, `pickContentFields`, `ItemWatchStatus`, `ResolvedItemTimestamps`, `ResolveTimestampOptions`. |
| `src/modules/library/service.ts` | **yeni** | `LibraryService` / `createLibraryService` — `ILibraryService` uygulaması. |
| `src/modules/content/service.ts` | **yeni** | `ContentService` / `createContentService` — `IContentService` uygulaması. |
| `src/contracts/services.ts` | güncellendi | `AddLibraryItemInput.metadata`, `UpdateLibraryItemInput.metadata` ve `UpdateLibraryItemInput.progress` (opsiyonel, geriye dönük uyumlu). Mevcut alanlar/sözleşmeler değişmedi. |
| `src/hooks/useItemActions.ts` | güncellendi | `commitWithTimestamps` ve `rateItem` kayıt üretimini `buildLibraryItem`'a devretti. Dışa açılan API (fonksiyonlar, tipler, yeniden dışa açılan yardımcılar) aynı. |
| `src/server/content-metadata-source.ts` | güncellendi | `listCatalogEntries()` + `CatalogEntrySnapshot` — mevcut katalog okuyucusunu yeniden kullanan tek okuma metodu. |
| `src/server/app.ts` | güncellendi | Servisler oluşturulur, dönüş tipine ve dönüş nesnesine eklenir. Yeni modül kaydı yok. |
| `ARCHITECTURE.md` | güncellendi | §5 MIA Faz 3 katmanları ve veri sınırları. |
| `docs/mia/faz3-library-content-manager.md` | **yeni** | Bu belge. |

## 3. Library Manager (`ILibraryService`)

**Dosya:** `src/modules/library/service.ts`

```ts
createLibraryService({
  repository: primaryRepository,   // ServerPrimaryDataRepository
  profileContext,                  // ProfileContext
  eventPublisher: eventBus,        // AppEventBus (IEventPublisher)
})
```

| Metot | Davranış |
|---|---|
| `addItem(input)` | `parseMediaKey` doğrulaması → liste → durum eşlemesi (`not-interested` reddedilir) → `buildLibraryItem` → yeni kayıt başa eklenir, varsa güncellenir → `deleted_keys` tombstone'u temizlenir. |
| `updateItem(input)` | Kayıt yoksa `ok: false`. Liste, puan ve ilerleme (`episodes_watched`, `current_season`, `season_progress`) güncellenir; puan `ratedAt`, tamamlama `completedAt` kuralları `operations.ts`'ten gelir. |
| `removeItem(input)` | Yalnızca profil kaydı silinir; `deleted_keys[mediaKey] = now` tombstone yazılır. Ortak içerik metadata'sına dokunulmaz. |
| `getItem(ref, mediaKey)` | Profil kaydını `{ list, rating }` olarak döner; kayıt yoksa `null`. |

**Yazma hattı:**

1. `profileContext.assertWritable(ref)` — profil/revision güvencesi.
2. `repository.readRaw()` — bozuk kaynakta işlem reddedilir.
3. Derin klon (`before`) + mutasyon.
4. `repository.saveForProfileOrThrow(after, ref, 'library-service')` — iyimser kilitleme, `StaleRevisionError` / `ProfileConflictError` korunur.
5. `profileContext.commitRevision(revision, ref.profileId)`.
6. `diffLibraryEvents(before, after)` → `eventBus.publish(event)`.

**Hata sözleşmesi:** `OperationOutcome` — `{ ok: true }` veya `{ ok: false, error, retryable }`. Profil/revision çelişkileri `retryable: false`; ağ/disk hataları `retryable: true`. Kalıcı yazma başarılı olup olay yayımı başarısız olursa sonuç `ok: false, retryable: true` ve mesajda revizyon + olay kimliği belirtilir.

## 4. Content Manager (`IContentService`)

**Dosya:** `src/modules/content/service.ts`

```ts
createContentService({
  metadataSource: contentIntelligence.metadataSource,     // ContentMetadataSource
  getStoredRecord: (key) => contentIntelligence.getByMediaKey(key),
  readDocument: async () => (await primaryRepository.read()).document,
  enqueueRawItem: (item) => contentIntelligence.enqueueRawItem(item),
})
```

| Metot | Davranış |
|---|---|
| `getMetadata(mediaKey)` | Kanonik anahtar → önce tamamlanmış merkezi içerik kaydı (`normalized_metadata_json`), yoksa `metadataSource.acquireMetadata` (yerel katalog → taste önbelleği → TMDB). Geçersiz anahtarda `null`. |
| `searchCatalog(query, limit)` | Yerel katalog stokunda başlık/orijinal başlık/açıklama araması; popülerliğe göre sıralı. Ağ çağrısı yapmaz. |
| `enrichMissing(ref)` | Profildeki `hasSufficientDetail` eşiğini geçemeyen içerikleri mevcut içerik kuyruğuna devreder. Kuyruk/port yoksa açık hata. |
| `canonicalizeKey(mediaType, rawId)` | `movie`/`tv` + pozitif tamsayı kimlik doğrulaması; `movie:<id>` / `tv:<id>` döner. |

**Metaveri modeli:** dönüş tipi mevcut `ContentMetadata` sözleşmesidir. `externalRating` TMDB `vote_average` değeridir; kişisel puanla hiçbir noktada birleştirilmez.

## 5. Veri sınırları

| Kural | Uygulama noktası |
|---|---|
| Kullanıcı verisi ortak içeriğe yazılamaz | `LibraryService` yalnızca `data/cinetrack-data.json` yazar; katalog/içerik kaydı yazma metodu yoktur. |
| Ortak içerik kullanıcıdan bağımsız yaşar | `removeItem` yalnızca profil kaydı + tombstone; `ContentService` kullanıcı kaydı silmez. |
| Film/dizi kimliği ayrıdır | `parseMediaKey` + `makeMediaKey`; `canonicalizeKey` yalnızca `movie`/`tv`. |
| Kişisel puan ≠ TMDB puanı | `personal_rating` yalnızca `input.rating`; `externalRating` yalnızca `ContentMetadata`. |
| Metadata kişisel alan taşıyamaz | `pickContentFields` allowlist'i (`status`, `personal_rating`, not, ilerleme, profil alanları hariç). |
| EventBus/Repository/ProfileContext yeniden oluşturulmaz | Servisler mevcut örnekleri enjekte eder; yeni modül kaydı yok. |
| Mevcut API sözleşmeleri korunur | `PUT /api/data`, `If-Match`, yedekleme, senkronizasyon, profil akışları değişmedi. |

## 6. Kademeli entegrasyon durumu

- **UI tek öğelik eylemler:** `useItemActions` → `onCommitSavedItem` → `PUT /api/data` yolu korunur. Kayıt üretimi ve zaman damgaları artık Library Manager ile ortak `operations.ts` üzerinden yapılır (davranış ve dışa açılan API aynı).
- **Sunucu:** `PUT /api/data` mevcut `diffLibraryEvents` hattını kullanmaya devam eder; `LibraryService` programatik tek öğelik yazma hattı olarak `createCineTrackApp` üzerinden hazırdır.
- **UI'nin doğrudan `PUT /api/data` yazımının tamamen HTTP uçlarına taşınması** bu fazda yapılmadı: mevcut çevrimdışı kuyruk, çakışma çözümü ve toplu içe aktarma akışları aynı belge yazımını paylaşıyor. Bu geçiş, test/CI sahipliği ve kabul doğrulaması ile birlikte sonraki adımda ele alınmalıdır.
- **Eksik zenginleştirme:** kuyruk işleyicisi, vektör/atmosfer üretimi ve benzerlik hesapları Content Intelligence'ın sorumluluğunda kalır.

## 7. Doğrulama (bu dalda çalıştırılanlar)

- `npm run lint` — temiz (0 hata, 0 uyarı)
- `npx tsc --noEmit` — temiz
- `npm test` — 447/447 geçti
- `npm run test:taste` — 355/355 geçti
- `npm run build` — başarılı

Test ve CI dosyaları bu fazda değiştirilmedi.
