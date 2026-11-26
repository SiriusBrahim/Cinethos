/**
 * Aşama 6 / B-23 — Excel önizleme sayfalama testleri.
 *
 * `buildProfileBackupPreviewPage` gerçek üretim modülünden çağrılır. Küçük ve
 * büyük veri setlerinde sayfa sınırları, son sayfa, boş veri, tam dışa aktarma
 * ile satır tutarlılığı ve önizleme yanıt boyutunun sınırlı kalması doğrulanır.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProfileBackupDataset,
  buildProfileBackupPreviewPage,
} from '../src/server/excel-profile-backup.ts';

const PREFERENCES = { disliked: [], providers: [], mood: '', reminders: false, notified: [] };

function makeItem(index, overrides = {}) {
  const isTv = index % 4 === 0;
  return {
    id: isTv ? 500000 + index : 200000 + index,
    media_type: isTv ? 'tv' : 'movie',
    title: `Önizleme ${index}`,
    status: index % 3 === 0 ? 'completed' : index % 3 === 1 ? 'watching' : 'watchlist',
    addedAt: new Date(Date.UTC(2025, 0, 1) + index * 3_600_000).toISOString(),
    updatedAt: new Date(Date.UTC(2025, 0, 1) + index * 3_600_000).toISOString(),
    vote_average: 7,
    genre_ids: [28],
    overview: 'önizleme fixture',
    ...overrides,
  };
}

function makeProfile(items, overrides = {}) {
  return {
    id: 'profile-preview',
    name: 'Önizleme Profili',
    createdAt: '2025-01-01T00:00:00.000Z',
    preferences: PREFERENCES,
    items,
    favoriteActors: [],
    ...overrides,
  };
}

const options = (profile, page, pageSize) => ({
  profile,
  page,
  pageSize,
});

test('B-23 önizleme yalnızca istenen sayfayı döndürür ve metadata tam arşivi yansıtır', async () => {
  const items = Array.from({ length: 120 }, (_, i) => makeItem(i));
  const profile = makeProfile(items);

  const first = await buildProfileBackupPreviewPage(options(profile, 1, 10));
  assert.equal(first.rows.length, 10);
  assert.equal(first.completeness.totalItemsCount, 120);
  assert.equal(first.totalPages, 12);
  assert.equal(first.hasMore, true);
  assert.equal(first.page, 1);
  assert.equal(first.pageSize, 10);

  const last = await buildProfileBackupPreviewPage(options(profile, 12, 10));
  assert.equal(last.rows.length, 10);
  assert.equal(last.hasMore, false);

  const beyond = await buildProfileBackupPreviewPage(options(profile, 13, 10));
  assert.equal(beyond.rows.length, 0, 'sayfa dışı istek boş liste döner');
  assert.equal(beyond.hasMore, false);
});

test('B-23 sayfa dilimi tam dışa aktarma sırasıyla birebir tutarlı', async () => {
  const items = Array.from({ length: 45 }, (_, i) => makeItem(i));
  const profile = makeProfile(items);

  const full = await buildProfileBackupDataset({ profile });
  const flat = [
    ...full.sheets.İzlenen.map((row) => ['İzlenen', row]),
    ...full.sheets.İzlenecek.map((row) => ['İzlenecek', row]),
    ...full.sheets.İzleniyor.map((row) => ['İzleniyor', row]),
    ...full.sheets.İlgilenmiyorum.map((row) => ['İlgilenmiyorum', row]),
  ];

  for (const pageSize of [7, 10]) {
    let offset = 0;
    const pageCount = Math.ceil(flat.length / pageSize);
    for (let page = 1; page <= pageCount; page += 1) {
      const preview = await buildProfileBackupPreviewPage(options(profile, page, pageSize));
      for (const entry of preview.rows) {
        const [expectedSheet, expectedRow] = flat[offset];
        assert.equal(entry.sheet, expectedSheet, `sayfa ${page}: sayfa adı eşleşmeli`);
        assert.equal(entry.row.canonicalKey, expectedRow.canonicalKey);
        assert.equal(entry.row.title, expectedRow.title);
        offset += 1;
      }
    }
    assert.equal(offset, flat.length, 'tüm sayfalar birleşince tam liste elde edilmeli');
  }
});

test('B-23 boş arşiv: toplam 0, sayfa 0 ve satır yok', async () => {
  const page = await buildProfileBackupPreviewPage(options(makeProfile([]), 1, 50));
  assert.equal(page.completeness.totalItemsCount, 0);
  assert.equal(page.totalPages, 0);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.rows, []);
  assert.deepEqual(page.sheetCounts.İzlenen, { total: 0, movie: 0, tv: 0 });
});

test('B-23 büyük veri: 10.000 kayıtta yanıt sayfa boyutuyla sınırlı kalır', async () => {
  const items = Array.from({ length: 10000 }, (_, i) => makeItem(i));
  const profile = makeProfile(items);

  const page = await buildProfileBackupPreviewPage(options(profile, 1, 50));
  assert.equal(page.rows.length, 50);
  assert.equal(page.completeness.totalItemsCount, 10000);
  assert.equal(page.totalPages, 200);

  const responseBytes = Buffer.byteLength(
    JSON.stringify({ ok: true, completeness: page.completeness, rows: page.rows })
  );
  assert.ok(
    responseBytes < 120_000,
    `önizleme yanıtı sınırlı olmalı, ölçülen: ${responseBytes} bayt`
  );
});

test('B-23 tam dışa aktarma hâlâ tüm kayıtları eksiksiz üretir', async () => {
  const items = Array.from({ length: 250 }, (_, i) => makeItem(i));
  const full = await buildProfileBackupDataset({ profile: makeProfile(items) });

  assert.equal(full.totalItemsCount, 250);
  assert.equal(
    Object.values(full.sheets).reduce((acc, rows) => acc + rows.length, 0),
    250,
    'sayfalamadan bağımsız tam dışa aktarma tüm satırları korur'
  );
});

test('B-23 ilgilenmiyorum kaydı önizleme sayfasında görünür ve sayılır', async () => {
  const profile = makeProfile([makeItem(1)], {
    preferences: { ...PREFERENCES, disliked: ['movie:777', 'movie:888'] },
  });
  const page = await buildProfileBackupPreviewPage(options(profile, 1, 50));

  const dislikedRows = page.rows.filter((entry) => entry.sheet === 'İlgilenmiyorum');
  assert.equal(dislikedRows.length, 2);
  assert.equal(page.sheetCounts.İlgilenmiyorum.total, 2);
  assert.equal(page.completeness.totalItemsCount, 3);
});
