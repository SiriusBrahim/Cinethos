# Bağımlılık güvenlik politikası ve kabul edilen istisnalar

Son güncelleme: 15 Kasım 2026 · `master` (`740d076` sonrası)

## Kapı (gate) politikası

| Kapsam | Komut | CI davranışı |
|---|---|---|
| Üretim bağımlılıkları, high/critical | `npm audit --omit=dev --audit-level=high` | **Bloklayıcı** (`security` işi) |
| Tüm ağaç, moderate ve üzeri | `npm audit --audit-level=moderate` | Bilgilendirici (`audit-report`, `continue-on-error`) |

Kural: üretim ağacında high veya critical bulgu varsa PR birleştirilmez. Orta/düşük
bulgular aşağıdaki kayıtla kabul edilir; yeni bir moderate bulgu çıkarsa bu dosyaya
gerekçesi yazılmadan bırakılmamalıdır.

`npm audit fix --force` **kullanılmaz**. Her bağımlılık değişikliği `npm run lint`,
`npm test`, `npm run test:taste`, `npm run build` ve üretim smoke testi ile doğrulanır.

## Güncel durum

- Üretim ağacı: **0 high, 0 critical**, 26 moderate (aşağıdaki iki kök neden).
- Tüm ağaç: 0 high, 0 critical, 36 moderate, 2 low — kalanı yalnızca geliştirme
  araçlarında (ESLint zinciri, workbox/vite-plugin-pwa, rollup eklentisi).

## Kök neden 1 — `uuid` (exceljs, gaxios üzerinden)

- **Paketler:** `exceljs` → `uuid`, `gaxios` → `uuid`.
- **Etki:** `uuid` danışmanlığı, tahmin edilebilir/`Math.random` tabanlı üretim
  yollarına ilişkin orta önemde bir uyarıdır. CineTrack'te `uuid` yalnızca Excel
  çalışma kitabı iç kimlikleri ve Google API istemcisinin dahili izleme kimlikleri
  için kullanılır; güvenlik sınırı oluşturan bir token/oturum değeri üretmez.
- **İstisna nedeni:** `exceljs` ve `gaxios` sürümleri `uuid`'nin yeni major
  sürümüyle uyumlu değil; zorla yükseltme Excel dışa aktarımını veya OAuth
  istemcisini kırar (`npm audit fix --force` bu yüzden yasak).
- **Hedef çözüm:** `exceljs` yeni major duyurduğunda birlikte yükseltme; o zamana
  kadar `uuid` yalnızca güvenlik sınırı dışı kimliklerde kullanılmaya devam eder.

## Kök neden 2 — OpenTelemetry zinciri (@respan, @traceloop)

- **Paketler:** `@respan/respan`, `@respan/tracing`, `@respan/instrumentation-*`,
  `@traceloop/instrumentation-*` → `@opentelemetry/core`, `-resources`,
  `-sdk-trace-base`.
- **Etki:** `@opentelemetry/core` danışmanlığı, güvenilmeyen girdinin izleme
  özniteliği olarak işlenmesiyle ilgili orta önemde bir uyarıdır.
- **İstisna nedeni:** Bu zincir yalnızca isteğe bağlı gözlemlenebilirlik
  (Respan/LLM telemetrisi) içindir; varsayılan yapılandırmada çağrı yapılmaz ve
  kullanıcıdan gelen serbest metin izleme özniteliğine yazılmaz. Üst paketler
  `@opentelemetry/*` sürümünü sabitlediği için tek tek yükseltmek uyumsuzluk
  üretiyor.
- **Hedef çözüm:** Respan/Traceloop yeni OpenTelemetry sürümüne geçtiğinde toplu
  yükseltme; o zamana kadar telemetri varsayılan olarak kapalı kalır. LLM/telemetri
  yatırımı, bu zincir temizlenmeden genişletilmez.

## Düşük önem (2)

`@rollup/plugin-node-resolve` ve `workbox-build` zincirindeki `minimatch`/`glob`
uyarıları yalnızca **build zamanı** araçlarıdır; çalışan uygulamaya dahil edilmez.
`vite-plugin-pwa` yeni major aldığında birlikte yükseltilecek.

## Dependabot politikası

`.github/dependabot.yml` haftalık, gruplu güncelleme açar. ESLint 10 ve TypeScript 7
major dallarında `npm ci` başarısız olduğu için bunlar otomatik birleştirilmez;
ayrı bir yükseltme işi olarak ele alınır.
