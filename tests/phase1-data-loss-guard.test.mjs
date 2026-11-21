/**
 * Aşama 1 — Tombstone duyarlı veri kaybı koruması (B-09) ve sessiz kırpma (B-04).
 *
 * Depolama katmanı doğrudan sürülür; her ret senaryosunda diskteki verinin
 * değişmediği ayrıca doğrulanır.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDataStorage } from '../src/server/storage.ts';

const T1 = '2026-01-01T00:00:00.000Z';

function item(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    status: 'completed',
    personal_rating: 8,
    addedAt: T1,
    updatedAt: T1,
    ...overrides,
  };
}

function profile(id, items, deletedKeys = undefined, overrides = {}) {
  return {
    id,
    name: `Profil ${id}`,
    createdAt: T1,
    preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
    items,
    favoriteActors: [],
    isDemo: false,
    ...(deletedKeys ? { deleted_keys: deletedKeys } : {}),
    ...overrides,
  };
}

function doc(profiles, revision = 0) {
  return {
    version: 3,
    schemaVersion: 3,
    engineVersion: 'test',
    activeProfileId: profiles[0]?.id ?? 'PROFILE-DEFAULT',
    profiles,
    revision,
    updatedAt: T1,
  };
}

function recentIso(offsetMs = 60_000) {
  return new Date(Date.now() - offsetMs).toISOString();
}

describe('Aşama 1 — B-09 veri kaybı koruması', () => {
  let dataDir;
  let storage;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ct-loss-guard-'));
    storage = createDataStorage({ dataDir });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seed(count = 71) {
    const items = Array.from({ length: count }, (_, index) => item(1000 + index));
    const result = await storage.saveDataSerialized(doc([profile('PROFILE-DEFAULT', items)]), {
      forceOverwrite: true,
    });
    assert.equal(result.ok, true);
    return result.document.revision;
  }

  it('normal küçük değişiklik kabul edilir', async () => {
    const revision = await seed(5);
    const next = doc(
      [profile('PROFILE-DEFAULT', [...Array.from({ length: 5 }, (_, i) => item(1000 + i)), item(2000)])],
      revision
    );
    const result = await storage.saveDataSerialized(next, {
      expectedRevision: revision,
      forceOverwrite: true,
    });
    assert.equal(result.ok, true);
  });

  it('bilinçli toplu silme onayla kabul edilir', async () => {
    const revision = await seed(10);
    const result = await storage.saveDataSerialized(
      doc([profile('PROFILE-DEFAULT', [item(1000)])], revision),
      { expectedRevision: revision, forceOverwrite: true, confirmBulkDelete: true }
    );
    assert.equal(result.ok, true);
  });

  it('beklenmeyen toplu silme reddedilir ve veri korunur', async () => {
    const revision = await seed(10);
    const result = await storage.saveDataSerialized(
      doc([profile('PROFILE-DEFAULT', [item(1000)])], revision),
      { expectedRevision: revision, forceOverwrite: true }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'sudden_item_drop');
    const current = await storage.readDataAsync();
    assert.equal(current.profiles[0].items.length, 10);
  });

  it('60 silme + 11 ekleme (toplam küçülür) reddedilir', async () => {
    const revision = await seed(71);
    const remaining = Array.from({ length: 11 }, (_, index) => item(2000 + index));
    const result = await storage.saveDataSerialized(
      doc([profile('PROFILE-DEFAULT', remaining)], revision),
      { expectedRevision: revision, forceOverwrite: true }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'sudden_item_drop');
    assert.match(result.message, /silindi/);
    const current = await storage.readDataAsync();
    assert.equal(current.profiles[0].items.length, 71);
  });

  it('60 silme + 61 ekleme (toplam büyür) da reddedilir', async () => {
    const revision = await seed(71);
    const replaced = Array.from({ length: 72 }, (_, index) =>
      index < 61 ? item(5000 + index) : item(1000 + (index - 61))
    );
    const result = await storage.saveDataSerialized(
      doc([profile('PROFILE-DEFAULT', replaced)], revision),
      { expectedRevision: revision, forceOverwrite: true }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'sudden_item_drop');
    const current = await storage.readDataAsync();
    assert.equal(current.profiles[0].items.length, 71);
  });

  it('kayıt içeren profil kaybı reddedilir', async () => {
    const twoProfiles = await storage.saveDataSerialized(
      doc([
        profile('PROFILE-AAA', [item(1), item(2)]),
        profile('PROFILE-BBB', [item(3)]),
      ]),
      { forceOverwrite: true }
    );
    assert.equal(twoProfiles.ok, true);

    const dropped = await storage.saveDataSerialized(
      doc([profile('PROFILE-AAA', [item(1), item(2)])], twoProfiles.document.revision),
      { expectedRevision: twoProfiles.document.revision, forceOverwrite: true }
    );
    assert.equal(dropped.ok, false);
    assert.equal(dropped.code, 'profile_drop');
    const current = await storage.readDataAsync();
    assert.equal(current.profiles.length, 2);
  });

  it('tombstone kaybı reddedilir', async () => {
    const tombstoned = profile('PROFILE-DEFAULT', Array.from({ length: 5 }, (_, i) => item(1000 + i)), {
      'movie:9001': recentIso(),
      'movie:9002': recentIso(),
      'movie:9003': recentIso(),
    });
    const seeded = await storage.saveDataSerialized(doc([tombstoned]), { forceOverwrite: true });
    assert.equal(seeded.ok, true);

    const withoutTombstones = profile(
      'PROFILE-DEFAULT',
      Array.from({ length: 5 }, (_, i) => item(1000 + i))
    );
    const result = await storage.saveDataSerialized(
      doc([withoutTombstones], seeded.document.revision),
      { expectedRevision: seeded.document.revision, forceOverwrite: true }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tombstone_drop');
    const current = await storage.readDataAsync();
    assert.equal(Object.keys(current.profiles[0].deleted_keys || {}).length, 3);
  });

  it('tombstone içeren normal senkronizasyon kabul edilir', async () => {
    const tombstoned = profile('PROFILE-DEFAULT', Array.from({ length: 5 }, (_, i) => item(1000 + i)), {
      'movie:9001': recentIso(),
      'movie:9002': recentIso(),
      'movie:9003': recentIso(),
    });
    const seeded = await storage.saveDataSerialized(doc([tombstoned]), { forceOverwrite: true });
    assert.equal(seeded.ok, true);

    const synced = profile(
      'PROFILE-DEFAULT',
      [...Array.from({ length: 5 }, (_, i) => item(1000 + i, { personal_rating: 9 })), item(2000)],
      { 'movie:9001': recentIso(), 'movie:9002': recentIso(), 'movie:9003': recentIso() }
    );
    const result = await storage.saveDataSerialized(
      doc([synced], seeded.document.revision),
      { expectedRevision: seeded.document.revision, forceOverwrite: true }
    );
    assert.equal(result.ok, true);
  });

  it('boş belge mevcut veriyi silemez', async () => {
    const revision = await seed(8);
    const result = await storage.saveDataSerialized(doc([], revision), {
      expectedRevision: revision,
      forceOverwrite: true,
    });
    assert.equal(result.ok, false);
    assert.ok(['sudden_item_drop', 'profile_drop', 'invalid_document'].includes(result.code));
    const current = await storage.readDataAsync();
    assert.equal(current.profiles[0].items.length, 8);
  });

  it('önceki revizyona geri dönüş reddedilir', async () => {
    const revision = await seed(4);
    const next = await storage.saveDataSerialized(
      doc([profile('PROFILE-DEFAULT', [...Array.from({ length: 4 }, (_, i) => item(1000 + i)), item(2000)])], revision),
      { expectedRevision: revision, forceOverwrite: true }
    );
    assert.equal(next.ok, true);

    const rollback = await storage.saveDataSerialized(
      doc([profile('PROFILE-DEFAULT', Array.from({ length: 4 }, (_, i) => item(1000 + i)))], revision),
      { expectedRevision: revision, forceOverwrite: true }
    );
    assert.equal(rollback.ok, false);
    assert.equal(rollback.code, 'revision_conflict');
    assert.equal(rollback.currentRevision, next.document.revision);
  });
});

describe('Aşama 1 — B-04 sessiz kırpma koruması', () => {
  let dataDir;
  let storage;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ct-limit-guard-'));
    storage = createDataStorage({ dataDir, maxProfiles: 20, maxItemsPerProfile: 25_000 });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('profil limiti aşımı reddedilir (sessizce düşürülmez)', async () => {
    const profiles = Array.from({ length: 21 }, (_, index) =>
      profile(`PROFILE-${String(index).padStart(3, '0')}`, [item(index + 1)])
    );
    const result = await storage.saveDataSerialized(doc(profiles), { forceOverwrite: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'limits_exceeded');
    assert.match(result.message, /21 profil/);
    const current = await storage.readDataAsync();
    assert.equal(current.profiles.length, 0);
  });

  it('kayıt limiti aşımı reddedilir', async () => {
    const items = Array.from({ length: 25_001 }, (_, index) => item(index + 1));
    const result = await storage.saveDataSerialized(
      doc([profile('PROFILE-DEFAULT', items)]),
      { forceOverwrite: true }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'limits_exceeded');
    assert.match(result.message, /25001 kayıt/);
  });

  it('geçersiz profil kimliği sessizce düşürülmez', async () => {
    const result = await storage.saveDataSerialized(
      doc([profile('PROFILE-OK', [item(1)]), profile('user-1234', [item(2)])]),
      { forceOverwrite: true }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'limits_exceeded');
    assert.match(result.message, /geçersiz profil kimliği/);
  });
});

describe('Aşama 1 — B-09 profil kapsamlı kayıp koruması', () => {
  let dataDir;
  let storage;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ct-profile-loss-'));
    storage = createDataStorage({ dataDir });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seed(profiles) {
    const result = await storage.saveDataSerialized(doc(profiles), { forceOverwrite: true });
    assert.equal(result.ok, true, `seed başarısız: ${result.message || ''}`);
    return result.document.revision;
  }

  function save(profiles, revision, options = {}) {
    return storage.saveDataSerialized(doc(profiles, revision), {
      expectedRevision: revision,
      forceOverwrite: true,
      ...options,
    });
  }

  it('aynı içerik iki profildeyken bir profilden silinmesi yakalanır', async () => {
    const shared = item(27205);
    const revision = await seed([
      profile('PROFILE-AAA', [shared]),
      profile('PROFILE-BBB', [shared]),
    ]);

    const result = await save([profile('PROFILE-AAA', []), profile('PROFILE-BBB', [shared])], revision);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'item_drop');
    assert.match(result.message, /PROFILE-AAA/);

    const current = await storage.readDataAsync();
    const aaa = current.profiles.find((entry) => entry.id === 'PROFILE-AAA');
    const bbb = current.profiles.find((entry) => entry.id === 'PROFILE-BBB');
    assert.equal(aaa.items.length, 1);
    assert.equal(bbb.items.length, 1);
  });

  it('bir profildeki tüm kayıtların silinmesi yakalanır', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [item(1), item(2)]),
      profile('PROFILE-BBB', [item(3)]),
    ]);
    const result = await save([
      profile('PROFILE-AAA', []),
      profile('PROFILE-BBB', [item(3)]),
    ], revision);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'item_drop');
    assert.match(result.message, /PROFILE-AAA/);
    const current = await storage.readDataAsync();
    assert.equal(current.profiles.find((p) => p.id === 'PROFILE-AAA').items.length, 2);
  });

  it('yalnızca bir profilde bulunan tek kaydın silinmesi meşrudur', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [item(1)]),
      profile('PROFILE-BBB', [item(2)]),
    ]);
    const result = await save([
      profile('PROFILE-AAA', []),
      profile('PROFILE-BBB', [item(2)]),
    ], revision);
    assert.equal(result.ok, true);
    const current = await storage.readDataAsync();
    assert.equal(current.profiles.find((p) => p.id === 'PROFILE-AAA').items.length, 0);
  });

  it('içeriği olmayan boş profilin silinmesi yakalanır', async () => {
    const revision = await seed([
      profile('PROFILE-EMPTY', []),
      profile('PROFILE-BBB', [item(1)]),
    ]);
    const result = await save([profile('PROFILE-BBB', [item(1)])], revision);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'profile_metadata_drop');
    assert.match(result.message, /PROFILE-EMPTY/);
    const current = await storage.readDataAsync();
    assert.equal(current.profiles.length, 2);
  });

  it('tercihleri bulunan boş profilin silinmesi yakalanır', async () => {
    const withPrefs = profile('PROFILE-PREF', [], undefined, {
      preferences: { disliked: ['movie:1'], providers: ['Netflix'], mood: 'sakin', reminders: true, notified: [] },
    });
    const revision = await seed([withPrefs, profile('PROFILE-BBB', [item(1)])]);
    const result = await save([profile('PROFILE-BBB', [item(1)])], revision);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'profile_metadata_drop');
    assert.match(result.message, /PROFILE-PREF/);
  });

  it('favori oyuncuları bulunan profilin silinmesi yakalanır', async () => {
    const withActors = profile('PROFILE-ACTORS', [], undefined, {
      favoriteActors: [{ id: 6193, name: 'Oyuncu' }],
    });
    const revision = await seed([withActors, profile('PROFILE-BBB', [item(1)])]);
    const result = await save([profile('PROFILE-BBB', [item(1)])], revision);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'profile_metadata_drop');
  });

  it('profildeki tek tombstone silinmesi yakalanır', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [item(1)], {
        'movie:9001': recentIso(),
        'movie:9002': recentIso(),
        'movie:9003': recentIso(),
      }),
    ]);
    const result = await save([
      profile('PROFILE-AAA', [item(1)], {
        'movie:9001': recentIso(),
        'movie:9002': recentIso(),
      }),
    ], revision);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tombstone_drop');
    const current = await storage.readDataAsync();
    assert.equal(Object.keys(current.profiles[0].deleted_keys).length, 3);
  });

  it('tombstone başka profile taşınırsa kayıp yakalanır', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [item(1)], { 'movie:9001': recentIso(), 'movie:9002': recentIso() }),
      profile('PROFILE-BBB', [item(2)]),
    ]);
    const result = await save([
      profile('PROFILE-AAA', [item(1)], { 'movie:9001': recentIso() }),
      profile('PROFILE-BBB', [item(2)], { 'movie:9002': recentIso() }),
    ], revision);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tombstone_drop');
    assert.match(result.message, /PROFILE-AAA/);
  });

  it('tombstone sayısı aynı kalsa bile farklı işaret kaybı yakalanır', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [item(1)], {
        'movie:9001': recentIso(),
        'movie:9002': recentIso(),
        'movie:9003': recentIso(),
      }),
    ]);
    const result = await save([
      profile('PROFILE-AAA', [item(1)], {
        'movie:9001': recentIso(),
        'movie:9002': recentIso(),
        'movie:9004': recentIso(),
      }),
    ], revision);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tombstone_drop');
  });

  it('profil kimliği değiştirilirse kayıp yakalanır', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [item(1)]),
      profile('PROFILE-BBB', [item(2)]),
    ]);
    const result = await save([
      profile('PROFILE-CCC', [item(1)]),
      profile('PROFILE-BBB', [item(2)]),
    ], revision);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'profile_drop');
    assert.match(result.message, /PROFILE-AAA/);
  });

  it('geçerli kullanıcı silme işlemi (tek kayıt) engellenmez', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [item(1), item(2), item(3), item(4)]),
      profile('PROFILE-BBB', [item(5)]),
    ]);
    const result = await save([
      profile('PROFILE-AAA', [item(2), item(3), item(4)]),
      profile('PROFILE-BBB', [item(5)]),
    ], revision);
    assert.equal(result.ok, true);
    const current = await storage.readDataAsync();
    assert.equal(current.profiles.find((p) => p.id === 'PROFILE-AAA').items.length, 3);
    assert.equal(current.profiles.find((p) => p.id === 'PROFILE-BBB').items.length, 1);
  });

  it('onaylı boşaltma ve onaylı tombstone silme kabul edilir', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [item(1)], { 'movie:9001': recentIso() }),
      profile('PROFILE-BBB', [item(2)]),
    ]);
    const emptied = await save(
      [profile('PROFILE-AAA', []), profile('PROFILE-BBB', [item(2), item(3)])],
      revision,
      { confirmBulkDelete: true }
    );
    assert.equal(emptied.ok, true);

    const nextRevision = emptied.document.revision;
    const tombstoneRemoved = await save(
      [profile('PROFILE-AAA', []), profile('PROFILE-BBB', [item(2), item(3)])],
      nextRevision,
      { confirmBulkDelete: true }
    );
    assert.equal(tombstoneRemoved.ok, true);
  });

  it('bir profilin kaybı diğer profillerin verisini maskelemez', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [item(1), item(2)]),
      profile('PROFILE-BBB', Array.from({ length: 6 }, (_, index) => item(100 + index))),
    ]);
    const result = await save([
      profile('PROFILE-AAA', []),
      profile('PROFILE-BBB', Array.from({ length: 6 }, (_, index) => item(100 + index))),
    ], revision);
    assert.equal(result.ok, false);
    assert.match(result.code, /item_drop|sudden_item_drop/);
    assert.match(result.message, /PROFILE-AAA/);
    assert.doesNotMatch(result.message, /PROFILE-BBB/);
    const current = await storage.readDataAsync();
    assert.equal(current.profiles.find((p) => p.id === 'PROFILE-BBB').items.length, 6);
  });

  it('eski yedek silinmiş kaydı tombstone olmadan geri getiremez', async () => {
    const revision = await seed([
      profile('PROFILE-AAA', [], { 'movie:9001': recentIso() }),
      profile('PROFILE-BBB', [item(2)]),
    ]);
    const resurrected = await save([
      profile('PROFILE-AAA', [item(9001)]),
      profile('PROFILE-BBB', [item(2)]),
    ], revision);
    assert.equal(resurrected.ok, false);
    assert.equal(resurrected.code, 'tombstone_drop');
    const current = await storage.readDataAsync();
    assert.equal(current.profiles.find((p) => p.id === 'PROFILE-AAA').items.length, 0);
    assert.equal(
      Object.keys(current.profiles.find((p) => p.id === 'PROFILE-AAA').deleted_keys).length,
      1
    );
  });
});
