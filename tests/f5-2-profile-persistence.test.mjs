/**
 * Aşama 5.2 — F5.2-02 kabul testleri.
 *
 * App.tsx'ten ayrılan profil koordinasyonu ve kalıcılık planı doğrudan
 * çağrılarla doğrulanır. Senaryolar: profil oluşturma, profil değiştirme,
 * profiller arası veri sızıntısı olmaması, autosave, gereksiz tekrar yazımın
 * engellenmesi, kota düşüşü, hata sırasında mevcut verinin korunması ve
 * unmount öncesi bekleyen yazımın yeniden denenmesi.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProfileId,
  createProfileRecord,
  resolveProfileSwitchState,
  snapshotOutgoingProfile,
} from '../src/app/profile/profile-coordinator.ts';
import {
  StorageWriteMemo,
  applyLocalStoragePlan,
  applyStorageWrites,
  buildLocalStoragePlan,
  buildProfileWritePlans,
  compactSavedItems,
  decideDirtyAfterSync,
} from '../src/app/persistence/persistence-plan.ts';
import {
  ACTIVE_PROFILE_STORAGE,
  PROFILES_STORAGE,
  PROFILE_STORAGE,
  deletedKeysStorageKey,
  favActorsStorageKey,
  listStorageKey,
  preferencesStorageKey,
} from '../src/app/profile-storage.ts';

function memoryStorage(initial = {}, options = {}) {
  const data = new Map(Object.entries(initial));
  const failOn = new Set(options.failOn || []);
  const failWhen = options.failWhen || (() => false);
  return {
    data,
    failOn,
    writes: [],
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (failOn.has(key) || failWhen(key, value)) throw new Error(`kota aşıldı: ${key}`);
      this.writes.push(key);
      data.set(key, value);
    },
  };
}

/** Silme kayıtları 30 günlük saklama penceresine tabidir; taze zaman damgası üretir. */
function recentIso(offsetMs = 0) {
  return new Date(Date.now() - offsetMs).toISOString();
}

const PREFERENCES = { disliked: [], providers: [], mood: '', reminders: false, notified: [] };
const expectedTombstone = (() => {
  const iso = new Date(Date.now() - 60_000).toISOString();
  return iso;
})();

function savedItem(id, overview = 'kısa özet') {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    overview,
    status: 'watchlist',
    genre_ids: [18],
    vote_average: 7,
    vote_count: 50,
    popularity: 5,
  };
}

function profile(overrides = {}) {
  return {
    id: 'profile-a',
    name: 'A',
    createdAt: '2026-01-01T00:00:00.000Z',
    preferences: PREFERENCES,
    items: [],
    favoriteActors: [],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    profiles: [profile(), profile({ id: 'profile-b', name: 'B' })],
    activeProfileId: 'profile-a',
    profileName: 'A',
    preferences: PREFERENCES,
    favoriteActors: [],
    deletedKeys: {},
    savedItems: [],
    ...overrides,
  };
}

test('F5.2-02 profil oluşturma: yeni kimlik, varsayılan tercihler ve boş liste', () => {
  const created = createProfileRecord({ name: 'Yeni Profil', id: 'profile-yeni' });
  assert.equal(created.id, 'profile-yeni');
  assert.equal(created.name, 'Yeni Profil');
  assert.deepEqual(created.items, []);
  assert.deepEqual(created.favoriteActors, []);
  assert.deepEqual(created.preferences, {
    disliked: [],
    providers: [],
    mood: '',
    reminders: false,
    notified: [],
  });
  assert.equal(created.isDemo, false);
  assert.ok(created.createdAt);

  const demo = createProfileRecord({ name: 'Demo', id: 'profile-demo', isDemo: true });
  assert.equal(demo.isDemo, true);

  assert.equal(createProfileId(1700000000000, 0.5), createProfileId(1700000000000, 0.5));
  assert.match(createProfileId(1700000000000, 0.25), /^PROFILE-1700000000000-/i);
});

test('F5.2-02 profil değiştirme: giden profil anlık görüntüsü yalnızca kendi kaydını günceller', () => {
  const profiles = [
    profile({ id: 'profile-a', name: 'Eski ad', items: [], favoriteActors: [] }),
    profile({ id: 'profile-b', name: 'B', items: [savedItem(2)] }),
  ];
  const updated = snapshotOutgoingProfile(profiles, {
    activeProfileId: 'profile-a',
    profileName: 'Yeni ad',
    savedItems: [savedItem(1)],
    preferences: { ...PREFERENCES, mood: 'gizem' },
    favoriteActors: [{ id: 7, name: 'Oyuncu' }],
    deletedKeys: { 'movie:9': expectedTombstone },
  });

  assert.equal(updated[0].name, 'Yeni ad');
  assert.deepEqual(updated[0].items.map((item) => item.id), [1]);
  assert.equal(updated[0].preferences.mood, 'gizem');
  assert.equal(updated[0].favoriteActors.length, 1);
  assert.deepEqual(updated[0].deleted_keys, { 'movie:9': expectedTombstone });
  // Hedef profil değişmedi.
  assert.deepEqual(updated[1], profiles[1]);
});

test('F5.2-02 profil değiştirme: geçerli silme kaydı yoksa profil kaydındaki değer korunur (mevcut davranış)', () => {
  const existing = { 'movie:1': 'x' };
  const updated = snapshotOutgoingProfile([profile({ deleted_keys: existing })], {
    activeProfileId: 'profile-a',
    profileName: 'A',
    savedItems: [],
    preferences: PREFERENCES,
    favoriteActors: [],
    deletedKeys: {},
  });
  // Geçersiz damga `normalizeDeletedKeys` tarafından elenir; alan boş nesneyle
  // ezilmez, böylece mevcut profil kaydı olduğu gibi korunur.
  assert.deepEqual(updated[0].deleted_keys, existing);
});

test('F5.2-02 profil geçişi: hedef profil kendi verisini çözer, giden profille karışmaz', () => {
  const target = profile({
    id: 'profile-b',
    name: 'B',
    items: [savedItem(20)],
    preferences: { ...PREFERENCES, mood: 'dram' },
    favoriteActors: [{ id: 3, name: 'B Oyuncusu' }],
    deleted_keys: { 'tv:4': expectedTombstone },
  });

  const resolved = resolveProfileSwitchState(target, 'profile-b', {
    loadItems: () => {
      throw new Error('profilde kayıt varken localStorage okunmamalı');
    },
    loadPreferences: () => {
      throw new Error('profilde anlamlı tercih varken localStorage okunmamalı');
    },
    loadFavoriteActors: () => {
      throw new Error('profilde oyuncu varken localStorage okunmamalı');
    },
    loadDeletedKeys: () => ({}),
  });

  assert.equal(resolved.name, 'B');
  assert.deepEqual(resolved.items.map((item) => item.id), [20]);
  assert.equal(resolved.preferences.mood, 'dram');
  assert.deepEqual(resolved.favoriteActors, [{ id: 3, name: 'B Oyuncusu' }]);
  assert.deepEqual(resolved.deletedKeys, { 'tv:4': expectedTombstone });
});

test('F5.2-02 profil geçişi: profil verisi yoksa profil kapsamlı depoya düşer', () => {
  const resolved = resolveProfileSwitchState(undefined, 'profile-c', {
    loadItems: (id) => [savedItem(id === 'profile-c' ? 30 : -1)],
    loadPreferences: () => ({ ...PREFERENCES, providers: ['netflix'] }),
    loadFavoriteActors: () => [{ id: 9, name: 'C Oyuncusu' }],
    loadDeletedKeys: () => ({ 'movie:31': expectedTombstone }),
  });
  assert.equal(resolved.name, 'Profilim');
  assert.deepEqual(resolved.items.map((item) => item.id), [30]);
  assert.deepEqual(resolved.preferences.providers, ['netflix']);
  assert.equal(resolved.favoriteActors[0].id, 9);
  assert.deepEqual(resolved.deletedKeys, { 'movie:31': expectedTombstone });
});

test('F5.2-02 autosave: plan etkin profilin anahtarlarını ve hafif profil listesini üretir', () => {
  const plan = buildLocalStoragePlan(
    snapshot({
      profileName: 'A (güncel)',
      preferences: { ...PREFERENCES, mood: 'komedi' },
      savedItems: [savedItem(1)],
    })
  );

  const keys = plan.metadata.map((write) => write.key);
  assert.deepEqual(keys, [
    PROFILES_STORAGE,
    ACTIVE_PROFILE_STORAGE,
    PROFILE_STORAGE,
    preferencesStorageKey('profile-a'),
    favActorsStorageKey('profile-a'),
    deletedKeysStorageKey('profile-a'),
  ]);
  assert.equal(plan.list.key, listStorageKey('profile-a'));

  const lightweight = JSON.parse(plan.metadata[0].value);
  assert.equal(lightweight[0].name, 'A (güncel)', 'etkin profilin güncel adı yazılmalı');
  assert.deepEqual(lightweight[0].items, [], 'ağır liste PROFILES_STORAGE içine yazılmamalı');
  assert.equal(lightweight[1].name, 'B');
  assert.deepEqual(JSON.parse(plan.list.primary).map((item) => item.id), [1]);
});

test('F5.2-02 autosave: yazım gerçekten uygulanır ve aynı veri ikinci kez yazılmaz', () => {
  const storage = memoryStorage();
  const memo = new StorageWriteMemo();
  const plan = buildLocalStoragePlan(snapshot({ savedItems: [savedItem(5)] }));

  const first = applyLocalStoragePlan(storage, plan, memo);
  assert.equal(first.failed.length, 0);
  assert.deepEqual(JSON.parse(storage.data.get(listStorageKey('profile-a'))).map((i) => i.id), [5]);

  const second = applyLocalStoragePlan(storage, plan, memo);
  assert.equal(second.written.length, 0, 'değişmeyen veri yeniden yazılmamalı');
  assert.equal(second.skipped.length, plan.metadata.length + 1);

  const changed = applyLocalStoragePlan(
    storage,
    buildLocalStoragePlan(snapshot({ savedItems: [savedItem(6)] })),
    memo
  );
  assert.deepEqual(changed.written, [listStorageKey('profile-a')]);
});

test('F5.2-02 autosave: kota düşüşünde özet kırpılmış liste yazılır', () => {
  const longOverview = 'x'.repeat(400);
  const storage = memoryStorage(
    {},
    {
      failWhen: (key, value) =>
        key === listStorageKey('profile-a') && value.length > 400,
    }
  );
  const plan = buildLocalStoragePlan(snapshot({ savedItems: [savedItem(7, longOverview)] }));
  assert.notEqual(plan.list.primary, plan.list.compactFallback);

  const result = applyLocalStoragePlan(storage, plan);
  assert.deepEqual(result.compacted, [listStorageKey('profile-a')]);
  assert.equal(result.failed.length, 0);
  const stored = JSON.parse(storage.data.get(listStorageKey('profile-a')));
  assert.equal(stored[0].overview.length, 120);
  assert.equal(compactSavedItems([savedItem(7, longOverview)])[0].overview.length, 120);
});

test('F5.2-02 persistence hatası: başarısız yazım mevcut sağlıklı veriyi bozmaz', () => {
  const key = preferencesStorageKey('profile-a');
  const existing = JSON.stringify({ disliked: ['movie:1'], providers: [], mood: 'eski', reminders: false, notified: [] });
  const storage = memoryStorage({ [key]: existing }, { failOn: [key] });

  const result = applyLocalStoragePlan(
    storage,
    buildLocalStoragePlan(snapshot({ preferences: { ...PREFERENCES, mood: 'yeni' } }))
  );

  assert.ok(result.failed.some((failure) => failure.key === key));
  assert.equal(storage.data.get(key), existing, 'eski değer korunmalı');

  // Hata giderildiğinde bekleyen yazım yeniden uygulanabilir (unmount flush).
  storage.failOn.clear();
  const retry = applyStorageWrites(
    storage,
    buildLocalStoragePlan(snapshot({ preferences: { ...PREFERENCES, mood: 'yeni' } })).metadata
  );
  assert.equal(retry.failed.length, 0);
  assert.equal(JSON.parse(storage.data.get(key)).mood, 'yeni');
});

test('F5.2-02 profil bazlı en-iyi-çaba planı: kimliksiz kayıtlar atlanır, her profil kendi anahtarını alır', () => {
  const plans = buildProfileWritePlans([
    profile({ id: 'profile-a', items: [savedItem(1)] }),
    { name: 'bozuk' },
    profile({ id: 'profile-b', deleted_keys: { 'movie:2': expectedTombstone } }),
  ]);

  assert.deepEqual(plans.map((plan) => plan.profileId), ['profile-a', 'profile-b']);
  assert.deepEqual(plans[0].writes.map((write) => write.key), [
    preferencesStorageKey('profile-a'),
    favActorsStorageKey('profile-a'),
    deletedKeysStorageKey('profile-a'),
  ]);
  assert.deepEqual(plans[0].items.map((item) => item.id), [1]);
  assert.equal(plans[1].profileId, 'profile-b');
});

test('F5.2-02 kirli işaret kararı: ilk hidrasyon ve uzak anlık görüntü yazma sayılmaz', () => {
  assert.deepEqual(decideDirtyAfterSync({ hydrated: false, applyingRemoteSnapshot: false, serverSyncReady: true }), {
    markDirty: false,
    editedDuringStartup: false,
  });
  assert.deepEqual(decideDirtyAfterSync({ hydrated: true, applyingRemoteSnapshot: true, serverSyncReady: true }), {
    markDirty: false,
    editedDuringStartup: false,
  });
  assert.deepEqual(decideDirtyAfterSync({ hydrated: true, applyingRemoteSnapshot: false, serverSyncReady: true }), {
    markDirty: true,
    editedDuringStartup: false,
  });
  assert.deepEqual(decideDirtyAfterSync({ hydrated: true, applyingRemoteSnapshot: false, serverSyncReady: false }), {
    markDirty: true,
    editedDuringStartup: true,
  });
});
