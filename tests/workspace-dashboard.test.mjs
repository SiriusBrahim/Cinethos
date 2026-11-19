/**
 * Çalışma alanı veri türetimi testleri.
 *
 * Kapsam:
 *  - Ana Sayfa panosu: devam edenler, son aktivite sıralaması, ilerleme yüzdesi,
 *    tür eğilimi, öneri seçkilerinden kütüphanede olanların elenmesi, saat
 *    tahmini ve boş arşiv davranışı.
 *  - İşlem Merkezi istemcisi: sunucu yanıtı doğrulaması, bilinmeyen alanların
 *    atılması, sayaç türetimi ve iç yolların taşınmaması.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildHomeDashboard } from '../src/modules/home/dashboard.ts';
import {
  normalizeOperationsSnapshot,
  normalizePipelineHealth,
  normalizeOperationsTask,
} from '../src/services/operations-api.ts';

function saved(overrides = {}) {
  return {
    id: 1,
    media_type: 'movie',
    title: 'Film',
    vote_average: 7,
    vote_count: 10,
    popularity: 1,
    genre_ids: [],
    status: 'watchlist',
    personal_rating: '',
    ...overrides,
  };
}

describe('Ana Sayfa panosu', () => {
  it('boş arşivde güvenli sıfır pano üretir', () => {
    const dashboard = buildHomeDashboard({ savedItems: [] });
    assert.equal(dashboard.hasLibrary, false);
    assert.deepEqual(dashboard.continueWatching, []);
    assert.deepEqual(dashboard.recentActivity, []);
    assert.deepEqual(dashboard.genres, []);
    assert.deepEqual(dashboard.picks, []);
    assert.deepEqual(dashboard.stats, {
      watching: 0,
      watchlist: 0,
      completed: 0,
      rated: 0,
      averageRating: null,
      estimatedMinutes: 0,
    });
  });

  it('devam edenleri en yeni aktiviteye göre sıralar ve dizi ilerlemesini hesaplar', () => {
    const dashboard = buildHomeDashboard({
      savedItems: [
        saved({
          id: 10,
          media_type: 'tv',
          title: 'Eski Dizi',
          name: 'Eski Dizi',
          status: 'watching',
          episodes_watched: 2,
          number_of_episodes: 10,
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
        saved({
          id: 11,
          media_type: 'tv',
          title: 'Yeni Dizi',
          name: 'Yeni Dizi',
          status: 'watching',
          episodes_watched: 7,
          number_of_episodes: 20,
          updatedAt: '2026-03-01T00:00:00.000Z',
        }),
        saved({ id: 12, status: 'completed', updatedAt: '2026-04-01T00:00:00.000Z' }),
      ],
    });

    assert.deepEqual(
      dashboard.continueWatching.map((entry) => entry.title),
      ['Yeni Dizi', 'Eski Dizi']
    );
    assert.equal(dashboard.continueWatching[0].progress.percent, 35);
    assert.equal(dashboard.continueWatching[1].progress.percent, 20);
    assert.equal(dashboard.stats.watching, 2);
    assert.equal(dashboard.stats.completed, 1);
  });

  it('ortalama puanı yalnızca puanlanmış yapımlardan hesaplar', () => {
    const dashboard = buildHomeDashboard({
      savedItems: [
        saved({ id: 1, personal_rating: 8 }),
        saved({ id: 2, personal_rating: 6 }),
        saved({ id: 3, personal_rating: '' }),
      ],
    });
    assert.equal(dashboard.stats.rated, 2);
    assert.equal(dashboard.stats.averageRating, 7);
  });

  it('tür eğilimini tamamlanan ve yüksek puanlı yapımlardan üretir', () => {
    const dashboard = buildHomeDashboard({
      savedItems: [
        saved({ id: 1, status: 'completed', personal_rating: 9, genre_ids: [878, 12] }),
        saved({ id: 2, status: 'completed', personal_rating: 8, genre_ids: [878] }),
        saved({ id: 3, status: 'completed', personal_rating: 4, genre_ids: [99] }),
        saved({ id: 4, status: 'watchlist', personal_rating: '', genre_ids: [99] }),
      ],
      genresMap: { 878: 'Bilim Kurgu', 12: 'Macera', 99: 'Belgesel' },
    });
    // 9 puanlı yapım 2 ağırlık (878 + 12), 8 puanlı yapım 2 ağırlık (878).
    assert.deepEqual(dashboard.genres, [
      { id: 878, name: 'Bilim Kurgu', score: 4 },
      { id: 12, name: 'Macera', score: 2 },
    ]);
  });

  it('öneri seçkilerinden kütüphanede zaten olanları eler', () => {
    const dashboard = buildHomeDashboard({
      savedItems: [saved({ id: 5, media_type: 'movie' })],
      forYouItems: [
        saved({ id: 5, media_type: 'movie' }),
        saved({ id: 6, media_type: 'movie' }),
        saved({ id: 5, media_type: 'tv' }),
      ],
      limit: 10,
    });
    assert.deepEqual(
      dashboard.picks.map((item) => `${item.media_type}:${item.id}`),
      ['movie:6', 'tv:5']
    );
  });

  it('limit parametresini güvenli aralığa kıstırır', () => {
    const items = Array.from({ length: 30 }, (_, index) => saved({ id: index + 1 }));
    assert.equal(buildHomeDashboard({ savedItems: items, limit: 0 }).recentActivity.length, 1);
    assert.equal(buildHomeDashboard({ savedItems: items, limit: 999 }).recentActivity.length, 24);
  });
});

describe('İşlem Merkezi yanıt doğrulaması', () => {
  const validRaw = {
    ok: true,
    checkedAt: '2026-05-01T10:00:00.000Z',
    activeProfileId: 'profile-a',
    stats: {
      events: 3,
      tasks: 3,
      byStatus: { pending: 1, processing: 0, completed: 1, retry_wait: 1, failed: 0, cancelled: 0 },
      dueRetries: 1,
    },
    store: { available: true, filePath: '/secret/path/cinetrack.db' },
    tasks: [
      {
        taskId: 't1',
        eventId: 'e1',
        handlerId: 'intelligence.taste-event-sync',
        profileId: 'profile-a',
        status: 'retry_wait',
        attempts: 2,
        maxAttempts: 5,
        nextRetryAt: '2026-05-01T10:00:30.000Z',
        createdAt: '2026-05-01T09:59:00.000Z',
        updatedAt: '2026-05-01T10:00:00.000Z',
        completedAt: null,
        lastError: 'geçici hata',
        payload: { secret: 'x' },
        filePath: '/secret/path',
      },
      { taskId: 't2', status: 'bilinmeyen-durum' },
    ],
  };

  it('geçerli yanıtı normalleştirir ve iç alanları taşımaz', () => {
    const snapshot = normalizeOperationsSnapshot(validRaw);
    assert.ok(snapshot);
    assert.equal(snapshot.tasks.length, 1, 'geçersiz durumdaki görev atılmalı');
    assert.equal(snapshot.tasks[0].status, 'retry_wait');
    assert.equal(snapshot.counts.retry_wait, 1);
    assert.equal(snapshot.storeAvailable, true);
    assert.equal(Object.hasOwn(snapshot, 'filePath'), false);
    assert.equal(Object.hasOwn(snapshot.tasks[0], 'payload'), false);
    assert.equal(Object.hasOwn(snapshot.tasks[0], 'filePath'), false);
    assert.equal(Object.hasOwn(snapshot.tasks[0], 'secret'), false);
  });

  it('ok:false veya bozuk yük yanıtını reddeder', () => {
    assert.equal(normalizeOperationsSnapshot({ ok: false }), null);
    assert.equal(normalizeOperationsSnapshot(null), null);
    assert.equal(normalizeOperationsTask({}), null);
  });

  it('sayaçlar boşsa görev listesinden türetir', () => {
    const snapshot = normalizeOperationsSnapshot({
      ok: true,
      tasks: [
        { taskId: 'a', status: 'failed' },
        { taskId: 'b', status: 'failed' },
        { taskId: 'c', status: 'pending' },
      ],
    });
    assert.ok(snapshot);
    assert.equal(snapshot.counts.failed, 2);
    assert.equal(snapshot.counts.pending, 1);
  });

  it('store.available false ise kuyruğun güvenilmez olduğunu bildirir', () => {
    const snapshot = normalizeOperationsSnapshot({ ...validRaw, store: { available: false } });
    assert.ok(snapshot);
    assert.equal(snapshot.storeAvailable, false);
  });

  it('pipeline sağlığından modül detaylarını ve yolları atar', () => {
    const health = normalizePipelineHealth({
      modules: [
        { moduleId: 'library', status: 'healthy', detail: '/secret/path' },
        { moduleId: 'content', status: 'bozuk' },
        { status: 'healthy' },
      ],
      contentIntelligence: {
        queue: { pending: 2, processing: 1, completed: 10, failed: 3 },
        filePath: '/secret/path.db',
      },
      storage: { filePath: '/secret' },
    });
    assert.ok(health);
    assert.deepEqual(health.modules, [
      { id: 'library', status: 'healthy' },
      { id: 'content', status: 'unknown' },
    ]);
    assert.deepEqual(health.queue, { pending: 2, processing: 1, completed: 10, failed: 3 });
  });
});
