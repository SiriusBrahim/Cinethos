# Cinethos — Çoklu Disiplinli Derin İnceleme (Bölüm 2)

> Bu rapor, `CODE_REVIEW_REPORT.md` (Bölüm 1) üzerine **ek**tir: Mimari/Kod kalitesi, Güvenlik/Sağlamlık, UX/UI denetimi, somut Problem→Fix çiftleri ve yenilik vizyonu.
> Tüm bulgular `main` @ `eed392e` üzerinde doğrulanmıştır; her bulgu `dosya:satır` referanslıdır.

---

## 1. Mimari, Kod Kalitesi ve Ölçeklenebilirlik

### 1.1. Tasarım Desenleri & Modülerlik

**Mevcut desen:** Sunucu tarafında "hexagonal-lite" izleri var (`candidate-pool-store-port.ts` port/arayüz, `taste-store.ts` adaptör); istemci tarafında ise **tek merkezli monolit**.

**Ölçülmüş kanıtlar:**
- `src/App.tsx` = **4.466 satır**, içinde **39 `useState` + 27 `useEffect` + 27 `useCallback`**.
- Proje genelinde **tek bir `createContext` bile yok** (grep: 0 sonuç) — tüm durum `App`'ten **prop drilling** ile akıyor (örn. `detailItem`/`setDetailItem` App içinde 21 kez geçiyor, 15+ bileşene elle aktarılıyor).
- `MediaGrid.tsx:140-155`'teki `cardCallbackRefs` deseni (handler'ları ref'te tutup memoized köprü ile geçirme) prop-drilling'in **maliyetini gizleyen** iyi bir yama — ama kök sorunu çözmiyor.

**SoC ihlali somut örneği:** `App.tsx` aynı dosyada veri çekme (`loadCategoryResults`), filtreleme (`:3433`), sayfalama (`:2758`), klavye kısayolu kablolaması, senkron çakışma yönetimi ve 4 sekmeli navigasyon durumunu barındırıyor. `tab`/`category`/`listStatus`/`forYouSubTab` kombinasyonu tek bir `useState` kümesinde yaşadığı için `App.tsx:2725-2774`'teki effect'ler birbirini tetikleyen zincirler kuruyor (bu zincirler zaten 4 `exhaustive-deps` uyarısının kaynağı).

**Sürdürülebilirlik değerlendirmesi:** Çekirdek (`src/core`) saflaştırılmış ve test edilebilir (735 test bunun kanıtı); sorun **UI kabuğunda**. Yeni bir özellik eklemek = `App.tsx`'e dokunmak demek; bu, merge çakışması ve regresyon riskini sürekli büyütüyor.

**Önerilen hedef mimari (kademeli, tek seferde değil):**

```
src/
  app/                    # App.tsx → ~300 satırlık kabuk: sadece router + provider'lar
    AppShell.tsx
    routes.ts
  features/
    discover/             # DiscoverSection + kendi state'i (reducer)
    list/                 # ListSection + filtre/sıralama state'i
    stock/                # StockSection
    taste/                # zaten ayrık — referans model olarak kullanın
    relationships/
  stores/
    profile-context.tsx   # aktif profil + items (Context + useReducer)
    ui-context.tsx        # toast, modal, tab state'i
```

Geçiş stratejisi: (1) Önce `ui-context.tsx` (toast/modal) — en düşük risk; (2) `profile-context.tsx` — `detailItem` gibi 21 referansı tek provider'a topla; (3) sekmeleri `features/` altına `React.lazy` ile taşırken mevcut `lazyWithRetry` deseni (`App.tsx:5-8`) aynen korunur.

### 1.2. Veri Akışı & State Yönetimi Darboğazları

**Dört katmanlı gerçeklik:** Sunucu JSON (`data/cinetrack-data.json`, 25 MiB tavan) + IndexedDB (`storage-idb.ts`, 20+ fonksiyon) + `localStorage` (10 farklı servis dosyasında) + GitHub uzak deposu. Doğruluk (source of truth) sorusu "server wins + merge" ile çözülmüş; ama **yazma yolu tam belge tabanlı**:

- `PUT /api/data` her mutasyonda **tüm `DataDocument`'ı** (tüm profillerin tüm öğelerini) gönderir. `app.ts:389-392` body limiti `maxDataBytes` (25 MiB). ~2 KB/öğe ile bu **~12.000 öğede tavan** demek; tek kullanıcının ömrü boyunca erişilebilir ama stok modu (README: "1000+ yapım") + çoklu profille gerçekçi bir sınır.
- `api.ts:358-375` okuma tarafı `ETag` → revision çıkarımı yapıyor; yazma tarafı `If-Match` (428/409) korumalı. Bu kısım sağlam.
- Darboğaz değil ama sürtünme: her kayıtta tam belge diff'siz gönderildiği için **mobil veri + batarya maliyeti** öğe sayısıyla lineer büyüyor.

**Somut çözüm (mevcut uçların uzatması, yeni mimari değil):** `GET /api/isolated/profile` zaten var (`app.ts:648`). Aynı deseni yazmaya taşıyın:

```ts
// app.ts — yeni rota (mevcut validateAndPrepareSave'i yeniden kullanır)
app.put('/api/profiles/:profileId', originGuard, tokenGuard, async (req, res) => {
  const result = storage.saveIsolatedProfile(req.params.profileId, req.body, {
    baseRevision: Number(req.headers['if-match']?.replace(/\D/g, '') || 0),
  });
  // ... mevcut yanıt sözleşmesiyle aynı şekil
});
```

İstemcide `api.ts`'e `pushProfileDelta(profileId, items)` ekleyin; `PUT /api/data` yalnızca şema seviyesi migrasyon ve geri yükleme için kalsın. Bu, mobil yükü profil başına O(items) yerine O(delta)'ya indirir.

### 1.3. Teknik Borç ve Çökme Noktaları

| Bulgu | Kanıt | Risk |
| --- | --- | --- |
| **66 sessiz `catch {}` bloğu** | `src` genelinde (tmdb-proxy.ts:762,871; atomic-json.ts:73,169,175,198...) | Hatalar yutulur; "neden bozuk?" teşhisi imkânsızlaşır. `atomic-json.ts:73`'teki fsync fallback sessiz — metal yorgunluğu/disk dolu senaryosunda veri kaybı **log'suz** atlanır |
| `api.ts` hata ayrıştırması yok | `api.ts:377` — her başarısızlık `return null` | 401 (token), 500 (sunucu), ağ kesintisi UI'da aynı göründü; LAN modunda kullanıcı "çalışmıyor" görür, nedenini bilemez |
| Offline kuyruk **retry/backoff yok** | `offline-queue.ts` — yalnızca `console.warn` (satır 83, 131); `maxAttempts`/`backoff` grep: 0 sonuç | Çevrimdışı yapılan değişiklik tek senkron denemesi başarısız olursa **sessizce kaybolabilir**; kullanıcıya "başarısız kuyruk öğesi" sayısı hiç gösterilmiyor |
| 4 `exhaustive-deps` uyarısı | `App.tsx:1370,2748`, `DetailModal.tsx:168`, `RelationshipExplorer.tsx:383` | `App.tsx:2748`'deki effect `activeProfileId`'yi bilmiyor → **profil değişince stok sekmesi eski profilin verisini gösterebilir** |
| Bileşen testi sıfır | `tests/` yalnızca Node `.mjs`; RTL grep: 0 | 39 useState'lik `App.tsx`'in davranışı yalnızca 5 Playwright spec'iyle korunuyor |

---

## 2. Güvenlik, Veri Gizliliği ve Sağlamlık

### 2.1. Güçlü Duruş (korunmalı)

- Sunucu: fail-closed auth (`security.ts:236-260`), timing-safe token (`security.ts:42-47`), origin guard, TMDB path **+ parametre bazlı** allowlist (`tmdb-proxy.ts:4-71`), upstream 10 MB sınırı, resim proxy'de host allowlist (`tmdb-proxy.ts:871-880`), gizli redaksiyon (`persistent-store.ts:336`), `frame-ancestors 'none'` + üretimde `script-src 'self'`.
- İstemci: `VITE_` önekiyle sır yok; PAT yalnızca sunucuda. `localStorage`'da yalnızca UI tercihi/önbellek var, kimlik bilgisi yok.

### 2.2. Açıklar ve Sınır Durumları

1. **LAN modu kimlik doğrulaması istemcide yok** (Bölüm 1 raporundan biliniyor; aşağıda 4.2'de kodlu çözüm). Bu, güvenlik modelinin "yarısı yazılmış" hâlidir: sunucu kilitli, anahtar eve getirilemiyor.
2. **`/api/tmdb-image` rate limiter dışında** (`app.ts:572`) + `imageCache` 300×8 MB ≈ **2,4 GB teorik RSS** (`tmdb-proxy.ts:857-920`). Loopback dışı açıksa ucuz bir bellek dolurma vektörü.
3. **`SlidingWindowRateLimiter` FIFO evict** (`security.ts:292-295`): 2000 anahtar dolunca **en eski** kayıt atılıyor; süresi geçmiş girişler haritada kalıyor. IP rotasyonuyla saldırgan kendi kayıtlarını doldurup meşru kullanıcıyı evict edebilir.
4. **Zarif çökme:** `ErrorBoundary` bölüm bazlı, "önbellekleri sıfırla" aksiyonlu (`ErrorBoundary.tsx:17-24`) — iyi. Ama boundary yalnızca render hatasını yakalar; **async event handler'daki fırlatmalar** (45 `catch`'in kapsamadıkları) unhandled rejection olarak kaybolur. Öneri: `window.addEventListener('unhandledrejection')` ile tek noktadan Toast'a bağlama.
5. **Kuyruk sağlamlığı:** `offline-queue.ts`'te tekrar sayacı yok — bir öğe sonsuza kadar "bekliyor" görünebilir (aşağıda 4.4'te kod).

---

## 3. UX/UI, Erişilebilirlik ve Akış Denetimi

### 3.1. Güçlü Yönler (ölçülmüş)

- **Erişilebilirlik ciddiye alınmış:** 483 `aria-*`/`role` kullanımı; `aria-live` Toast'ta (`Toast.tsx:10`) ve OfflineIndicator'da `assertive` kademesiyle (`OfflineIndicator.tsx:31`); `useDialogAccessibility.ts` gerçek **focus trap + çoklu dialog yığını** (en üstteki dialog hariç Tab'i engelliyor) + odak geri yükleme; `jsx-a11y/alt-text` lint'te **error** seviyesinde.
- **Klavye:** Cmd/Ctrl+K komut paleti (`useKeyboardShortcuts.ts:20-25`), sekme kısayolları, Escape hiyerarşisi.
- **Çakışma UX'i:** `ConflictBanner` üçlü çözüm sunuyor (Kayıpsız Birleştir / Yereli Kullan / Sunucuyu Kullan) — çoğu üründe olmayan bir olgunluk.

### 3.2. Sürtünmeler

1. **Bilişsel yük:** 4 sekme × kategori × `listStatus` × `forYouSubTab` × tür × sağlayıcı × sıralama — `App.tsx:3336-3342`'deki koşul ormanı bunun kanıtı. Keşfet sekmesinde "şu an ne filtreliyim" sorusu 6 boyutlu. **Öneri:** aktif filtre özetini tek "chip satırı"nda toplayıp (her chip tek dokunuşla kaldırılabilir) filtre sayısını görünür kılın; komut paleti zaten var — palet içine "tür: dram ekle" tarzı doğal filtre komutları eklemek mevcut `cmdk` bağımlılığıyla ~1 gün iş.
2. **Toast tek kanallı ve tek mesajlı** (`Toast.tsx:7-13`): `message: string | null` — üst üste iki olay (örn. "kaydedildi" + "senkron başarısız") birbirini **eziyor**. Kuyruklu, severity'li (info/success/error) toast listesi gerekli; `aria-live` bölgesi birden çok mesajı sırayla duyurabilmeli.
3. **Yükleme durumları:** `skeleton` kavramı kodda yok (grep: 10 sonuç, hepsi yorum/başka bağlam); grid'ler metin/spinner ile bekliyor. Poster ağları için **placeholder-aspect-ratio kutuları** (CLS önleyen) + soluk poster iskeleti, algılanan performansı ölçülebilir biçimde artırır. `MediaCard.tsx:179-180`'de `loading="lazy"` + `decoding="async"` zaten doğru — eksik olan tek şey yer tutucu.
4. **Hata mesajları yönlendirici değil:** `api.ts` null döndürdüğü için UI "bir şey olmadı" diyor. 401 → "LAN modunda token gerekli" + token giriş modalı; 409 → ConflictBanner (zaten var); 503 → "uzaktan erişim için CINETRACK_TOKEN tanımlayın" ayrıştırması yapılmalı.
5. **Tek dil:** `i18n/index.ts` 61 satır, tip-güvenli sözlük — yapı EN için hazır; gerçek çeviri maliyeti düşük (string kataloğu ~200 anahtar tahmini).

---

## 4. Teşhis ve Somut Çözümler (Problem → Fix)

### 4.1. 🔴 Kritik — CI kırmızı: zod *high* (GHSA-mrhx-c7xc-m3w5)

`package.json` köküne override (kırılmayan çözüm; `@respan/respan` 2.5.0'dan bağımsız çalışır):

```jsonc
// package.json
{
  "overrides": {
    "zod": "^4.6.6"
  }
}
```

Ardından `npm install && npm audit --omit=dev --audit-level=high` ile exit 0 doğrulanır. Kalıcı koruma için `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

### 4.2. 🔴 Kritik — LAN modunda istemci token'ı gönderemiyor

`src/services/api.ts`'e tek giriş noktası sarmalayıcısı (mevcut 30+ `fetch` çağrısı kademeli taşınır):

```ts
// src/services/api.ts (yeni bölüm)
const TOKEN_KEY = 'cinetrack.lan-token';

export function setLanToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}
export function clearLanToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 || res.status === 503) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'auth_required' || body?.code === 'unauthorized_token') {
      window.dispatchEvent(new CustomEvent('cinetrack:auth-required'));
      throw new ApiError(res.status, body.code, body.status_message ?? 'Kimlik doğrulaması gerekli.');
    }
  }
  return res;
}
```

`App.tsx`'te dinleyici: `cinetrack:auth-required` olayında token modalı aç; modal `setLanToken` sonrası bekleyen kuyruğu yeniden dener. (`sessionStorage` bilinçli tercih: sekme kapanınca silinir, kalıcı saklama gereksiz risk.)

### 4.3. 🔴 Kritik — `.env.example` yabancı depoya işaret ediyor

```bash
# .env.example — düzeltilmiş hâl
CINETRACK_DATA_OWNER=
CINETRACK_DATA_REPO=
CINETRACK_DATA_BRANCH=main
```

### 4.4. 🟠 Yüksek — Offline kuyrukta retry/backoff yok

```ts
// src/services/offline-queue.ts (ek)
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2_000;

function nextDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, 5 * 60_000); // 2s → 5dk tavan
}

export async function flushQueueWithRetry(flush: () => Promise<boolean>): Promise<FlushReport> {
  const pending = await loadQueue();
  const failed: QueuedMutation[] = [];
  for (const mutation of pending) {
    let attempt = mutation.attempts ?? 0;
    while (attempt < MAX_ATTEMPTS) {
      if (await flush()) break;
      attempt += 1;
      await new Promise((r) => setTimeout(r, nextDelayMs(attempt)));
    }
    if (attempt >= MAX_ATTEMPTS) failed.push({ ...mutation, attempts: attempt });
  }
  if (failed.length > 0) {
    window.dispatchEvent(new CustomEvent('cinetrack:queue-failed', { detail: failed.length }));
  }
  return { delivered: pending.length - failed.length, failed };
}
```

`OfflineIndicator`'a `cinetrack:queue-failed` dinleyicisi eklenip "N değişiklik senkronlanamadı — Yeniden dene" aksiyonu gösterilir.

### 4.5. 🟠 Yüksek — Resim proxy bellek bütçesi

```ts
// tmdb-proxy.ts — imageCache yerine byte bütçeli LRU
const MAX_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
let imageCacheBytes = 0;
const imageLru = new Map<string, { at: number; buffer: Buffer; contentType: string }>();

function cacheImage(url: string, buffer: Buffer, contentType: string): void {
  if (buffer.byteLength > MAX_IMAGE_CACHE_BYTES) return;
  while (imageCacheBytes + buffer.byteLength > MAX_IMAGE_CACHE_BYTES) {
    const oldest = imageLru.keys().next().value;
    if (!oldest) break;
    imageCacheBytes -= imageLru.get(oldest)!.buffer.byteLength;
    imageLru.delete(oldest);
  }
  imageLru.set(url, { at: Date.now(), buffer, contentType });
  imageCacheBytes += buffer.byteLength;
}
```

Ve rota bağlama: `app.get('/api/tmdb-image', tmdbRateLimiter, tmdbProxy.handleTmdbImage);`

### 4.6. 🟡 Orta — `exhaustive-deps` düzeltmeleri

- `App.tsx:2748`: bağımlılık dizisine `activeProfileId` ekleyin; effect gövdesi başına `if (!activeProfileId) return;` — aksi hâlde profil değişiminde eski profilin stoğu yeniden yüklenebilir.
- `DetailModal.tsx:168`: effect `[isOpen, savedItem]` olmalı; `savedItem` referansı değişince yerel status/rating state'i yeniden senkronlanır (düzenleme sırasında ezilmemesi için `isDirty` ref'i ile korunmalı).
- `RelationshipExplorer.tsx:383`: `selectedNode` bağımlılığa eklenmeli veya seçim `useReducer` state'ine taşınmalı.

### 4.7. 🟡 Orta — Hata ayrıştırma ve tek noktadan yakalama

`api.ts`'teki `return null` desenini `ApiError` fırlatmayla değiştirin (4.2'deki sınıfla); `main.tsx`'e:

```ts
window.addEventListener('unhandledrejection', (event) => {
  const err = event.reason;
  if (err instanceof ApiError) return; // kendi akışında ele alınıyor
  console.error('[Cinethos] Yakalanmamış promise hatası:', err);
});
```

Ve 66 sessiz `catch {}` için en azından `catch (e) { console.warn('[modül-adı]', e); }` dönüşümü — `atomic-json.ts` öncelikli (veri kaybı sınırında).

---

## 5. Yenilikçi Vizyon ve Gelecek Evrimi

Mevcut altyapının en büyük avantajı: **zevk motoru (`src/core/taste/` — 21 modül), worker'lar (`encoding.worker.ts`, `taste-profile-worker.ts`) ve Respan LLM entegrasyonu zaten kurulu.** Öneriler bu sermayenin üzerine kurulur:

### 5.1. "Zevk Anlatıcısı" — LLM ile doğal dil zevk profili özeti 💰düşük ⭐yüksek

`evidence-ledger.ts` ve `profile-explainer.ts` zaten kanıt listeleri üretiyor; Respan anahtarı sunucuda hazır bekliyor (tanımsızsa devre dışı kalıyor — mevcut desen). Sunucuya `/api/taste/narrative` ucu ekleyip kanıt defterini LLM'e verin; çıktı: *"Son 3 ayda karanlık suç dramalarına yöneldin; 2. sezon sendromu yaşayan dizileri bırakıyorsun."* Kural motoru dokunulmaz kalır (determinizm korunur), LLM yalnızca **sunum katmanı** olur. Maliyet: ~2 gün; bağımlılık yok.

### 5.2. Tahmine Dayalı Detay Isınması (predictive prewarm) 💰çok düşük ⭐orta

`idle-enrichment-service.ts` zaten boşta kalan zamanda veri zenginleştiriyor. Buna ekle: görünür alandaki kartlara `IntersectionObserver` ile **hover/focus öncesi** detay ön-çekme (`/movie/:id` + providers + similar) — `DetailModal.tsx:150-166`'daki üç ayrı fetch'i modal açıldığında önbellekten okur. Algılanan açılış ~1 sn'den ~0'a iner. Maliyet: ~1 gün.

### 5.3. "Ruh Hâline Göre Semantik Arama" 💰orta ⭐yüksek

`encoding.worker.ts` ve `mood-affinity.ts` mevcut. TMDB keyword/overview metinlerini worker içinde basit TF-IDF/vektör temsiliyle indeksleyip arama çubuğuna *"hüzünlü ama umut veren bilim kurgu"* gibi serbest formlu sorgu desteği ekle — tamamen deterministik, cihaz üstü, TMDB maliyeti sıfır (mevcut katalog üzerinden). `cmdk` paletine ikinci mod olarak gömülür. Maliyet: ~1 hafta.

### 5.4. Ortak İzleme Listesi (lossless sync'in doğal uzantısı) 💰orta ⭐yüksek

Çift yönlü GitHub senkronu zaten iki yerel profili kayıpsız birleştiriyor ve "Birlikte Ne İzlesek?" kesişimi var. Bir adım öteye: **paylaşılan liste sözleşmesi** — `data/shared/watch-party.json` dosyası için `shared/` ad alanı + madde başına `proposedBy`/`votes` alanları. Mevcut `hybrid-merge.ts` birleştirme kurallarına "oy birliği" stratejisi eklenir. `.ics` üretimi zaten var; planlanan ortak seans takvime düşer. Maliyet: ~1 hafta; yeni infra gerektirmez (GitHub depo = transport).

### 5.5. Zevk İkizi Eşleşmesi (gizlilik korumalı) 💰orta ⭐orta-yüksek

`TasteComparePanel` iki yerel profili karşılaştırıyor. Bunu dışa açın: zevk profilinin **ham veri değil, kanıt ağırlıklarının özeti** (örn. 64 baytlık hash'lenmiş vektör) dışa aktarılsın; iki kullanıcı bu özeti dosya/kod paylaşımında karşılaştırıp "zevk benzerliği %82 — ortak kaçırdığınız: X, Y" çıktısı alsın. Sunucu/LLM gerekmez, kişisel öğe listesi asla paylaşılır (gizlilik ilkeleriyle birebir uyumlu). Maliyet: ~3-4 gün.

**Önerilen sıra:** 5.2 → 4.1-4.3 düzeltmeleri → 5.1 → 5.4 → 5.3 → 5.5. (5.2 ve kritik düzeltmeler ilk sprint; 5.1 en yüksek değer/iş oranına sahip.)

---

## Doğrulama

Bu rapordaki tüm sayısal iddialar şu komutlarla doğrulanabilir:

```bash
grep -c "useState" src/App.tsx                     # 39
grep -rn "catch {}" src --include="*.ts" --include="*.tsx" | wc -l   # 66
grep -rn "createContext" src | wc -l               # 0
grep -rn "maxAttempts\|backoff" src/services/offline-queue.ts | wc -l  # 0
npm audit --omit=dev --audit-level=high            # exit 1
```
