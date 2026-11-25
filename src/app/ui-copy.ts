/**
 * F5.2-01 — Kullanıcıya gösterilen sabit arayüz metinlerinin tek kaynağı.
 *
 * Bileşenler bu sözleşmeyi kullanır; testler kaynak dosyayı taramak yerine
 * bileşeni gerçekten render edip metni render çıktısında doğrular.
 */

export const UI_COPY = {
  errorBoundary: {
    retry: 'Tekrar dene',
    resetCachesAndRetry: 'Önbellekleri sıfırla ve dene',
    resettingCaches: 'Önbellekler temizleniyor…',
    copyError: 'Hata metnini kopyala',
    copied: '✓ Hata metni kopyalandı',
  },
  stock: {
    pull: 'Stok İçerik Çek',
    pullBusy: 'Stok Çekiliyor…',
    download: 'Stok havuzunu indir',
    downloadBusy: 'Stok havuzu indiriliyor…',
  },
  library: {
    emptyTitle: 'İzleme listen henüz boş — ilk içeriğini ekle',
    emptyBody:
      'Keşfet sekmesinden izlediğin veya merak ettiğin yapımları işaretle ya da özel içerik ekle. İlk birkaç kayıttan sonra Sana Özel önerileri, Zevk Haritası ve Seriler otomatik aktifleşir.',
    goDiscover: 'Keşfet’e git',
  },
  maps: {
    preparing: 'Harita hazırlanıyor…',
  },
  profile: {
    resetDerivedCaches: 'Önbellekleri Sıfırla',
    resettingDerivedCaches: 'Önbellekler sıfırlanıyor…',
  },
  actors: {
    subtabsLabel: 'Favori oyuncular görünümü',
    actorsTab: 'Oyuncular',
    recommendationsTab: 'Öneriler',
    recommendationsToolbarLabel: 'Öneriler filtreleri',
  },
} as const;

export type UiCopy = typeof UI_COPY;
