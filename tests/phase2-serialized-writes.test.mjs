import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStorage } from '../src/server/storage.ts';

function makeDoc(title, revision = 0) {
  return {
    version: 3,
    activeProfileId: 'profile-1',
    revision,
    profiles: [
      {
        id: 'profile-1',
        name: 'Profil',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [
          {
            id: 550,
            media_type: 'movie',
            title,
            genre_ids: [18],
            vote_average: 8.4,
            vote_count: 100,
            popularity: 20,
            status: 'watchlist',
            personal_rating: '',
          },
        ],
      },
    ],
  };
}

test('B-38: senkron saveData, asenkron yazma sürerken sessizce yarışmaz (fail-closed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-serialized-'));
  try {
    const storage = createDataStorage({ dataDir: dir });
    const pending = storage.saveDataSerialized(makeDoc('Birinci'));
    assert.throws(
      () => storage.saveData(makeDoc('Yarışan')),
      /eşzamanlı bir yazma sürerken çağrılamaz/
    );
    const saved = await pending;
    assert.equal(saved.ok, true);

    // Kuyruk boşaldıktan sonra senkron yol yeniden çalışır.
    const after = storage.saveData(makeDoc('Sonraki'));
    assert.equal(after.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-38: saveDataAsync de aynı serileştirilmiş kuyruktan geçer ve yazmalar kaybolmaz', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-serialized-async-'));
  try {
    const storage = createDataStorage({ dataDir: dir });
    const first = await storage.saveDataSerialized(makeDoc('Başlangıç'));
    assert.equal(first.ok, true);

    const [second, third] = await Promise.all([
      storage.saveDataAsync(makeDoc('İkinci')),
      storage.saveDataAsync(makeDoc('Üçüncü')),
    ]);
    assert.equal(second.ok, true);
    assert.equal(third.ok, true);

    const finalDoc = await storage.readDataAsync();
    assert.equal(finalDoc.profiles[0].items[0].title, 'Üçüncü', 'son yazma kazanmalı');
    assert.ok((finalDoc.revision ?? 0) >= 3, 'revizyon artmalı');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-38: paralel senkron çağrılar sırayla reddedilir, veri bozulmaz', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-serialized-race-'));
  try {
    const storage = createDataStorage({ dataDir: dir });
    await storage.saveDataSerialized(makeDoc('Başlangıç'));

    const pendingA = storage.saveDataSerialized(makeDoc('A'));
    const pendingB = storage.saveDataSerialized(makeDoc('B'));
    const results = await Promise.all([pendingA, pendingB]);
    assert.deepEqual(results.map((r) => r.ok), [true, true]);

    const doc = await storage.readDataAsync();
    assert.equal(doc.profiles[0].items[0].title, 'B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
