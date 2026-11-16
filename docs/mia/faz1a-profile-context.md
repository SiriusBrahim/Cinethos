# MIA Faz 1A ③ — ProfileContext Kural Belgesi

**Durum:** Faz 1A ③ tamamlandı (sözleşme: `src/contracts/profile.ts`)
**Tarih:** 2026-11-16
**Kapsam:** Profil izolasyonu kuralları — mevcut korumalarla (Faz 0 v2 §G) eşleştirme ve Faz 1B bağlama kuralları. **Bu belge kod taşımaz; yalnızca kural kesinleştirir.**

---

## 1. Amaç

Engellenecek hata senaryosu (Faz 1 hazırlık denetimi, P1-2):

```
A profilinde öneri hesabı başlar
  → kullanıcı B profiline geçer
  → A hesabı tamamlanır
  → sonuç B'nin ekranına yazılır  ← YASAK
```

Bu senaryo, Faz 1A'da tanımlanan `IProfileContext` sözleşmesi + `ProfileRef.revision` zorunluluğu ile **sözleşme düzeyinde** kapatılmıştır. Uygulama Faz 1B'de bağlanır.

## 2. Sözleşme kuralları (`src/contracts/profile.ts`)

| # | Kural | Sözleşme karşılığı |
|---|---|---|
| K1 | Her asenkron işlem `profileId` taşımak **ZORUNDADIR** | `ProfileRef.profileId` |
| K2 | Her **yazma** işlemi kaynak `revision` taşımak **ZORUNDADIR** | `WriteProfileRef.revision` (yazmada derleme zamanında zorunlu, okumada opsiyonel `ProfileRef`) |
| K3 | Async devam etmeden **hemen önce** güncellik denetimi yapılır | `assertCurrent(ref)` / `assertWritable(ref)` — uçuş öncesi son kontrol |
| K4 | Profil değiştiyse eski-profil işi **yazamaz**; arşivlenir | `ProfileConflictError('profile-switched')` |
| K5 | Revision eskiyse yazım **reddedilir** (iyimser kilitleme) | `ProfileConflictError('stale-revision')` + `StaleRevisionError` (data.ts) |
| K6 | Profil değişimi **olay olarak** yayınlanır | `ProfileSwitched` (AppEventMap, Faz 1A ④) |
| K7 | Aktif profilin tek doğruluk kaynağı **tek nesnedir** | `IProfileContext.getCurrent()` — modüller `activeProfileId`'yi doğrudan okumaz |

## 3. Mevcut korumalarla (v2 §G) eşleştirme — Faz 1B bağlama haritası

Faz 0 §G'de doğrulanan 4 koruma, Faz 1B'de **davranış değişmeden** sözleşmeye bağlanır:

| Mevcut koruma (App.tsx) | Sözleşme karşılığı | Faz 1B bağlama kuralı |
|---|---|---|
| `requestGateRef` (`createRequestGate` — begin/isCurrent biletleri, 5 çağrı noktası) | `assertCurrent()` + `ProfileRef.revision` | Bilet mekanizması KORUNUR; `isCurrent` denetimi `assertCurrent` ile birlikte çağrılır. Bilet kaldırılmaz — Faz 6/7'de yönetici kancalarına taşınırken birebir davranış. |
| `handleSwitchProfile` girişinde `invalidate()` + yükleme durumlarının sıfırlanması | `ProfileSwitched` olayı | Geçiş sırası: `invalidate()` → durum sıfırlama → `ProfileSwitched` yayını. Olay yayını, invalidate'in YERİNE geçmez; ek güvencedir. |
| `applyingRemoteSnapshotRef` (uzak doküman uygularken yerel yazım bastırma, 4 nokta) | `IProfileContext` + `PrimaryDataRepository.expectedRevision` | Uzak snapshot uygulaması sırasında yerel yazımlar `expectedRevision` çelişkisiyle doğal olarak reddedilir; ref bastırması Faz 1B'de KORUNUR (çift güvenlik). |
| Profil başına `*_ref` senkronizasyonu (`profilesRef`, `savedItemsRef`, `preferencesRef`, `favoriteActorsRef`) | `IProfileContext.getCurrent()` | Handler'lar ref'lerden okumaya devam eder; Faz 6/7'de kancalara taşınırken ref okuma → `ProfileContext` okuma olarak değişir (aynı tick içinde eşdeğer davranış şartıyla). |

## 4. Arka plan işleyici kuralları (Faz 4 ön kuralları)

1. **İşleme başlarken:** işleyici, olayın `sourceRevision`'ı ile güncel revision'ı karşılaştırır. Uyuşmazsa olayı **arşivler** (`profile-switched`), yeniden denemez.
2. **Yazmadan hemen önce:** `assertCurrent()` bir kez daha çağrılır (K3) — uzun süren hesaplarda profilin arada değişmediği doğrulanır.
3. **Yazarken:** `PrimaryDataRepository.save(..., { expectedRevision })` — çelişki beklenen bir reddir (`conflict: true`), arıza değildir; dead-letter'a düşmez.
4. **Idempotency:** aynı `eventId` ikinci kez işlenirse çift etki oluşmaz (özellikle `IMemoryService.processEvent`).
5. **Profil izolasyonu:** bir profilin kuyruk işi ASLA başka profilin verisine yazamaz; işleyici çıktısını yalnızca `event.profileId`'ye yazar.

## 5. Test stratejisi

- **Faz 1B:** mevcut profil geçişi testleri yeşil kalmalı (davranış değişikliği yasak).
- **Faz 4:** yeni testler — (a) hesap sırasında profil değişimi → sonuç yazılmaz; (b) eski revision'lı yazım → `StaleRevisionError`; (c) aynı olay iki kez → çift kanıt yok; (d) uygulama kapanıp açılınca bekleyen işler kaybolmaz (Outbox kalıcılığı).

## 6. Açık konular

- `ProfileRef.revision` okuma tarafında opsiyoneldir; Faz 2'de `PrimaryDataRepository` bağlandığında okuma tutarlılık kontrolünün zorunlu olup olmayacağı kesinleştirilecek (performans etkisi ölçülecek).
- `ProfileSwitched` olayının Outbox'ta profil kesişimiyle sıralanması (Faz 4): profil değişim olayı, eski profilin bekleyen işlerinden **önce** işlenmelidir — öncelik kuralı Faz 4'te uygulanır.
