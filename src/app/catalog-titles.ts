/**
 * Katalog/liste başlığı ve açıklaması (F5.1-01).
 *
 * `App.tsx` içindeki saf sunum metni üretimi buraya taşındı; davranış
 * birebir korunur. Hiçbir React bağımlılığı yoktur.
 */

export interface CatalogTitleCounts {
  allListCount: number;
  watchingCount: number;
  watchlistCount: number;
  completedCount: number;
  upcomingCount: number;
  favoriteActorsCount: number;
  dislikedCount: number;
}

export interface CatalogTitleInput {
  tab: string;
  query: string;
  listStatus: string;
  selectedType: string;
  category: string;
  forYouSubTab: string;
  forYouExplanation: string;
  selectedGenre: string;
  genresMap: Record<number, string>;
  stockStats: { movieCount: number; tvCount: number };
  tvdbCount: number;
  counts: CatalogTitleCounts;
}

export interface CatalogTitle {
  title: string;
  description: string;
}

export function getCatalogTitles(input: CatalogTitleInput): CatalogTitle {
  const { tab, query, listStatus, selectedType, counts } = input;

  if (tab === 'list') {
    const typeLabel =
      selectedType === 'movie' ? 'film' : selectedType === 'tv' ? 'dizi' : 'içerik (film + dizi)';
    const statusTitles: Record<string, { title: string; count: number }> = {
      all: { title: 'Tüm takip listem', count: counts.allListCount },
      watching: { title: 'Şu an izlediklerim', count: counts.watchingCount },
      watchlist: { title: 'İzlenecekler listem', count: counts.watchlistCount },
      completed: { title: 'Tamamladıklarım', count: counts.completedCount },
      upcoming: { title: 'Yaklaşan yayınlar', count: counts.upcomingCount },
      actors: { title: 'Favori oyuncularım', count: counts.favoriteActorsCount },
      disliked: { title: 'İlgilenmediğim içerikler', count: counts.dislikedCount },
    };
    const info = statusTitles[listStatus] || statusTitles.all;
    if (listStatus === 'actors') {
      return {
        title: `${info.title} (${info.count})`,
        description: `Takip ettiğin ${info.count} favori oyuncu ve senin için kişiselleştirilmiş film & dizi önerileri`,
      };
    }
    return {
      title: `${info.title} (${info.count})`,
      description: `Listenizde toplam ${info.count} kayıtlı ${typeLabel} bulunuyor`,
    };
  }

  if (query) {
    return {
      title: `"${query}" için arama sonuçları`,
      description: 'Sonuçlar doğrudan TMDB arama servisinden alınır',
    };
  }

  const catMap: Record<string, CatalogTitle> = {
    trending: { title: 'Güncel trendler', description: "TMDB'den canlı olarak yükleniyor" },
    'for-you': {
      title: input.forYouSubTab === 'series' ? 'Sana özel · Seriler' : 'Sana özel',
      description:
        input.forYouSubTab === 'series'
          ? 'Listenizdeki film ve dizilerin aynı evrendeki diğer halkaları ve devam yapımları'
          : input.forYouExplanation ||
            (input.selectedGenre && input.genresMap[Number(input.selectedGenre)]
              ? `${input.genresMap[Number(input.selectedGenre)]} türünde zevk profiline göre oluşturulan 20 öneri`
              : selectedType === 'movie'
              ? 'Film izleme geçmişin ve kişisel puanlarından oluşturulan 20 film önerisi'
              : selectedType === 'tv'
              ? 'Dizi izleme geçmişin ve kişisel puanlarından oluşturulan 20 dizi önerisi'
              : 'İzleme listen ve kişisel puanlarından oluşturulan 20 öneri'),
    },
    gems: {
      title: 'Keşfedilmemiş mücevherler',
      description: 'Yüksek puanlı, daha az popüler ve keşfedilmeyi bekleyen film ve diziler',
    },
    upcoming: { title: 'Yakında ve yayında', description: 'Yaklaşan filmler ve yayındaki diziler' },
    'popular-movies': { title: 'Popüler filmler', description: "TMDB'de en çok ilgi gören filmler" },
    'popular-tv': { title: 'Popüler diziler', description: "TMDB'de en çok ilgi gören diziler" },
    'top-rated': { title: 'Yüksek puanlı filmler', description: 'TMDB puanına göre sıralanır' },
    stock: {
      title: `Keşfet — ${input.stockStats.movieCount} Film · ${input.stockStats.tvCount} Dizi${
        input.tvdbCount > 0 ? ` (TVDB: ${input.tvdbCount})` : ''
      }`,
      description: `Listenizde olmayan, çevrimdışı erişime hazır kişisel aday havuzu (${
        input.tvdbCount > 0 ? `${input.tvdbCount} TVDB yapımı dahil` : 'TMDB ve TVDB kaynaklı'
      }) ve zevk vektörü sıralaması`,
    },
  };
  return catMap[input.category] || catMap.trending;
}
