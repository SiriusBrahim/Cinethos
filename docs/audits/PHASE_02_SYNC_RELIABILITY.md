# Aşama 2 — Senkronizasyon güvenilirliği ve eş zamanlı işlem güvenliği

**Durum:** ✅ Tamamlandı  
**Dal:** `remediation/full-project-remediation` · **PR:** #65  
**Taban:** Aşama 1 sonu `9b3a5dd`  
**Kapsam:** B-10, B-38, B-39, B-30 + kesinti/kurtarma, hata sınıflandırması ve gözlemlenebilirlik.

Bu belge Aşama 2'nin ne yaptığını, hangi kanıtlarla doğrulandığını ve bilinçli olarak
kapatılmayan sınırları kaydeder. Aşama 1 garantileri (test veri kapısı, atomik yazma,
TOCTOU kapısı, kayıpsız birleştirme) korunmuştur; bu aşamada hiçbir güvenlik kontrolü
gevşetilmedi veya testler için devre dışı bırakılmadı.

---

## 1. Başlangıç mimarisi (denetim sonucu)

| Soru | Bulgu |
|---|---|
| Senkronizasyon nereden başlıyor? | `PersistentDataStore.pullFromGitHub/pushToGitHub/reconcileWithGitHub/inspectGitHub` → `GitHubBidirectionalSyncManager`. Ayrıca eski yollar: `syncToGitHub` (`/api/sync/trigger`), `runStagedFullSync` (`/api/sync/staged`), `testSafeConnectionAndProbeManifest` (`/api/sync/test-connection`). |
| Kuyruk nerede? | Yalnızca bellekte: `activeOperationPromise` zinciri. Görünür durum yok. |
| Kalıcı mı? | Hayır. Yalnızca `data/sync-state.json` içinde dosya bazlı `fileStates` ve son rapor saklanıyordu. |
| Yeniden yüklemede ne oluyor? | `syncing` durumundaki dosya kayıtları olduğu gibi kalıyor, sonsuza dek "gönderiliyor" görünüyordu. |
| Eşzamanlı başlatma? | Evet. `runSerialized` sıraya alıyordu ama `isSyncBusy()` yalnızca çalışanı gördüğü için `rejectIfBusy` bekleyen işi görmüyordu. |
| Aynı dosyaya eşzamanlı yazma? | Süreç içinde `storage.serialize` çoğu yolu kapsıyordu; ancak `saveData`/`saveDataAsync` dışa açık ve serileştirilmemişti. |
| Çoklu süreç? | Uygulama tek Node süreci + yerel dosya sistemi; çoklu süreç/instance için garanti yoktu. |
| Retry? | Sunucu GitHub istemcisinde (`github-request.ts`) `Retry-After` + backoff + jitter vardı. İstemci `fetchTmdb` 429'da doğrudan hata atıyordu. |
| Sayaçlar? | `recordsAdded` bazen uzak **toplam** kayıt sayısını ekliyor, türetilmiş profil önbelleği kayıt gibi sayılıyor, aynı kayıt iki kez sayılabiliyordu. |

## 2. Yapılan değişiklikler

### 2.1 B-10 — Kuyruk durumu, kalıcılık ve kurtarma

- **`src/core/sync-operation-queue.ts`** (yeni): FIFO kuyruk; `idle / queued / running / failed`
  durumları, çalışan+bekleyen `depth`, işlem başına `enqueuedAt/startedAt`, son sonuç,
  toplam başarı/başarısızlık/iptal. `isBusy()` bekleyen işi de sayar.
- Aynı `dedupeKey` ile gelen ikinci istek yeni iş açmaz; aynı promise'i paylaşır
  (aynı işlem iki kez çalışıp iki kez yazmaz).
- Kapasite (`maxDepth=4`) ve kuyrukta bekleme süresi (`120 sn`) sınırlıdır; aşım
  `sync_queue_full` / `sync_queue_timeout` kodlarıyla reddedilir.
- Abort sinyali kuyruktayken işlemi çıkarır; çalışırken sinyali iletir.
- **`src/server/sync-attempt-journal.ts`** (yeni): işlem başında `data/sync-attempt.json`
  yazılır, bitince silinir. Süreç çökerse bir sonraki açılışta kayıt "kesinti" olarak
  raporlanır ve temizlenir; iş **başarılı sayılmaz**.
- **`data/sync-state.json` v2:** `syncStateVersion: 2` eklendi. v1 dosyaları geriye dönük
  okunur; daha yüksek sürüm sessizce yanlış yorumlanmak yerine yok sayılır (veri
  dosyalarına dokunulmaz). Açılışta `syncing` kalan dosya durumları `pending`e çevrilir,
  `lastError` ile açıkça raporlanır.
- `/api/sync/status` artık `syncQueue` (depth, runningOperation, queuedOperations,
  lastOutcome, recoveredInterrupted) ve `interruptedSync` alanlarını döner.

Bilinçli sınır: **bekleyen istekler kalıcı değildir.** Çökme sonrası istek istemci
tarafından yeniden gönderilir; sistem yarım işi başarılı gibi göstermez. Kalıcı görev
kuyruğu (background manager) SQLite üzerinde ayrıca durur ve bu aşamada değiştirilmedi.

### 2.2 B-38 — Eşzamanlı işlemlerin sıralanması ve kilitler

- Tüm `inspect/pull/push/reconcile` çağrıları tek FIFO kuyruktan geçer; işlem
  bitince (başarı, hata, abort) kuyruk `finally` ile serbest kalır.
- **`src/server/sync-file-lease.ts`** (yeni): `data/locks/github-sync.lock` üzerinde
  `open(..., 'wx', 0o600)` ile atomik advisory kilit. Aynı makinede ölü PID veya
  `staleMs` (10 dk) aşımı bayat sayılır ve `rename` ile kenara alınarak devralınır.
  `release()` yalnızca kendi token'ı dosyada yazıyorsa siler.
- Kuyruk dışındaki yazma yolları (`/api/sync/trigger`, `/api/sync/test-connection`,
  `/api/sync/staged`) `runExclusive*` sarmalayıcılarıyla aynı kuyruk ve kilitten geçer.
  Kuyruk içinden gelen iç içe çağrı (staged → reconcile) yeniden kilitlenmez; deadlock
  oluşmaz.
- Çakışma hataları 500 yerine **409** (`sync_lease_busy`, `sync_queue_full`,
  `sync_queue_timeout`, `sync_aborted`) döner.
- **`src/server/storage.ts`:** `saveDataAsync` artık serileştirilmiş kuyruğa girer;
  senkron `saveData` ise bekleyen/çalışan bir yazma varken **fail-closed** davranır
  (sessiz yarış yok). Üretim yolları `saveDataSerialized` / `applySyncedDocumentSerialized`
  kullanmaya devam eder.

Bilinçli sınır: kilit *advisory*'dir; kilidi tanımayan üçüncü taraf yazımlarını ve ağ
dosya sistemlerindeki `O_EXCL` semantiğini garanti etmez. Uygulama tek Node süreci
olarak çalışır; çoklu instance senaryosu bu depoda desteklenmez.

### 2.3 B-39 — Sayaçların tek otoritesi

- **`src/core/sync-counters.ts`** (yeni): sayaçlar artık işlem sırasında artırılmaz;
  işlem öncesi/sonrası gerçek belgelerden **türetilir**.
  - `added`: sonrasında olup öncesinde olmayan kayıt.
  - `updated`: iki tarafta da olup anlamlı alanı değişen kayıt.
  - `skipped`: her iki tarafta da değişmeden duran kayıt.
- Anahtar düzeyinde birleşim: bir tarafta eklenen kayıt diğer tarafta zaten var diye
  ayrıca "değişmeyen" sayılmaz; aynı kayıt iki kez sayılmaz.
- Kapsam: kullanıcı profili kayıtları, katalog (film/dizi) ve Sinema Künyesi.
  `data/profiles/*.json` **türetilmiş önbellek** olduğu için sayılmaz.
- Zaman damgası benzeri uçucu alanlar "güncellendi" sayılmaz.
- `BidirectionalSyncReport.recordsSkipped` eklendi (opsiyonel, geriye dönük uyumlu).

### 2.4 B-30 — Retry/backoff ve hata sınıflandırması

- **`src/services/http-retry.ts`** (yeni): istemci isteklerinde sınırlı retry.
  - Yalnızca güvenle tekrarlanabilir metotlar (GET/HEAD/OPTIONS); POST/PUT/PATCH/DELETE
    asla otomatik tekrarlanmaz (çift yazma yok).
  - 408/429/5xx/rate-limit 403 geçici; 400/401/403/404/409 kalıcı.
  - `Retry-After` (saniye/tarih) ve `X-RateLimit-Reset` öncelikli, 30 sn üst sınır.
  - Aksi halde `min(maxDelay, base × 2^(attempt-1)) + jitter` (base 500 ms, max 8 sn,
    jitter 250 ms).
  - Abort beklerken de dinlenir; iptal edilen istek yeniden denenmez.
- `apiFetch` bu yardımcıyı kullanır; sunucu tarafındaki `githubFetch` (Retry-After +
  backoff + jitter) korunmuştur. Böylece hata sınıflandırması istemci ve sunucuda aynı
  kategori dilini kullanır.

### 2.5 Kesinti ve kurtarma

- Ağ/timeout: istemci retry testleri; sunucu `githubFetch` mevcut davranışı korundu.
- Uygulama çökmesi: deneme günlüğü + `syncing` → `pending` kurtarma.
- Uzak işlem başarılı ama yanıt kayıp: GitHub Contents PUT'ları `sha` önkoşuluyla
  idempotenttir; 409 durumunda güncel `sha` yenilenip aynı içerik yeniden yazılır.
  Mevcut 5.7 ve Senaryo 12 testleri bunu doğrular. Aşama 2'de ek çift yazma yolu
  açılmadı; sayaçlar da gerçek belgelerden türetildiği için tekrar işlem şişirmez.

## 3. Test kanıtı

Yeni test dosyaları (toplam **34** yeni test):

| Dosya | Test | Kapsam |
|---|---:|---|
| `tests/phase2-sync-queue.test.mjs` | 8 | FIFO, durum geçişleri, dedupe, kapasite, timeout, abort, hata sonrası serbest kalma, deadlock yok |
| `tests/phase2-sync-counters.test.mjs` | 7 | Ekleme/güncelleme/değişmeyen, uçucu alan, profil kapsamı, katalog/künye, çift sayım yok |
| `tests/phase2-sync-recovery.test.mjs` | 7 | Deneme günlüğü kurtarma, `syncing` kurtarma, şema sürümü, kuyruk+günlük+kilit, nested deadlock, bayat kilit, **gerçek ikinci süreç** |
| `tests/phase2-http-retry.test.mjs` | 8 | Retry sınıfları, Retry-After/reset, backoff+jitter, 429→200, POST retry yok, abort |
| `tests/phase2-serialized-writes.test.mjs` | 3 | Fail-closed senkron yazma, `saveDataAsync` serileştirme, paralel yazma |
| `tests/github-bidirectional-sync.test.mjs` (ek) | 1 | Gerçek reconcile raporunda `recordsAdded/Updated/Skipped` doğruluğu |

Komut sonuçları (son koşum):

| Komut | Sonuç |
|---|---|
| `npm run lint` | ✅ 0 hata / 0 uyarı (ESLint + 2 × `tsc --noEmit`) |
| `npm run cycles` | ✅ 0 döngü |
| `npm test` | ✅ **754/754**, 72 dosya (Aşama 1: 720 → 754) |
| `npm run test:taste` | ✅ **440/440**, 27 dosya |
| `npm run build` | ✅ başarılı |
| `npx playwright test --workers=1` | ✅ **15/15** |
| `data/` sha256 | ✅ 15 dosya, önce/sonra aynı |
| GitHub Actions `c0a93e2` | ❌ Unit Tests (Node 22.18.0) |
| GitHub Actions `94c4dca` | ✅ Lint/Test/Build/Smoke + Playwright E2E + bakım analizi + Vercel |

Ortam: Linux (Ubuntu 24.04 tabanlı VM), yerel Node v26.13.1, npm 11.20.0, root
olmayan kullanıcı. CI `.nvmrc` gereği **Node 22.18.0** kullanır; nihai ağaç bu
sürümde de tam suite ile doğrulandı. Playwright Chromium ve sistem kütüphaneleri
bu makinede `/tmp/pwlibs` altına çıkarıldı; depoya eklenmedi.

CI'ın yakaladığı gerçek hata: retry gecikmesi `setTimeout(...).unref()` ile
kurulduğu için Node 22'de bekleyen istek sürerken event loop boşalıyor ve promise
hiç sonuçlanmıyordu (mevcut `api-error-policy` testleri bunu gösterdi). `94c4dca`
gecikmeyi referanslı bırakır; hem Node 22 hem Node 26'da 754/754 geçer.

## 4. Geri alma

- Aşama 2 commit'leri tek tek `git revert <sha>` ile geri alınabilir; hiçbiri geçmişi
  yeniden yazmaz, `master`a yazmaz.
- Kod geri alınırsa `data/sync-state.json` içindeki ek alanlar (`syncStateVersion`,
  `syncQueue` raporu) eski sürüm tarafından yok sayılır; kullanıcı verisi dosyaları
  (`data/cinetrack-data.json`, profiller) bu aşamada **şema değişikliğine uğramadı**.
- Kilit/günlük dosyaları (`data/locks/*`, `data/sync-attempt.json`) yardımcı dosyalardır;
  yoklukları veri kaybına neden olmaz.

## 5. Bilinen sınırlar (dürüst beyan)

- Kuyruk süreç içidir; çoklu süreç/instance için yalnızca advisory dosya kilidi vardır.
- Bekleyen istekler çökme sonrası otomatik yeniden oluşturulmaz; istemci yeniden dener.
- Dosya kilidi ağ dosya sistemlerinde `O_EXCL` atomikliğini garanti etmez.
- GitHub/TMDB/TVDB canlı uçlarına karşı test, kimlik bilgisi yokluğu nedeniyle koşulmadı;
  tüm doğrulama yerel sahte GitHub sunucusu ve stub `fetch` ile yapıldı.
- Bu aşamada UI'da kuyruk derinliğinin görsel sunumu yapılmadı; durum API'si hazırdır
  (Aşama 4).


## 6. Phase 2.1 — Eşzamanlılık, lease ve journal güvenliği

- İç içe senkronizasyon çağrıları global boolean ile değil `AsyncLocalStorage`
  işlem bağlamıyla tanınır. Bağımsız HTTP istekleri FIFO kuyruğunu atlayamaz.
- Aynı makinedeki canlı PID, lock mtime değeri stale eşiğini aşsa dahi kilidini
  kaybetmez. Lease sahibi inode doğrulamalı heartbeat ile kilidi yeniler.
- Journal lease token'ını saklar. Başlangıç kurtarması önce süreçler-arası lease
  alır; başka süreç kilidi tutuyorsa journal'a dokunmaz. Her yeni işlem kendi
  lease'i altında eski journal'ı kurtarır ve yalnızca kendi token'ıyla tamamlar.
- GitHub senkronizasyonu yalnızca `--dev` geliştirme sunucusunda etkinleşir.
  Production modunda uzak kimlik bilgileri store'a verilmez; sync-state dosyası
  yüklenmez, journal başlangıç kurtarması/lease oluşturma çalışmaz ve otomatik
  eşitleme ile token yenileme zamanlayıcıları kurulmaz.
- Production'da `GET /api/sync/status` yalnızca kimlik/durum kontrolü için açık
  kalır ve `mode: local_only` döner. GitHub'a veri aktaran/indiren diğer
  `/api/sync/*` uçları ile GitHub profil yedek yükleme kapalıdır.
- Geliştirme modunda `CINETHOS_ENABLE_GITHUB_DEV_SYNC=false` ile ayrıca kapatılabilir.
- Ağ dosya sistemleri ve farklı makineler için dağıtık kilit garantisi verilmez.
