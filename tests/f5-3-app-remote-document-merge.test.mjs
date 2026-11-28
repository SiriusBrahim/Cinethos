/**
 * F5.3-03 — App.tsx'ten ayrılan belge birleştirme sorumluluğu kabul testleri.
 *
 * `src/app/persistence/remote-document-merge.ts` modülü dar bağlam arabirimiyle
 * çalışır: App.tsx yalnızca ref'leri, state güncelleyicileri ve kalıcılık
 * geri çağrılarını sağlar. Bu testler sapmanın gövdesinin (ref/state girişleri,
 * taste map yükleme, profil kalıcılığı, kirli işaret, sunucu çakışma temizliği)
 * birebir korunduğunu doğrular: kayıpsız merge null-dönüşü (mevcut durumu koru),
 * yerel ileride kirli kalma (DIRTY_KEY, çakışma temizlenmez), uzak önce Nothing
 * durumunda çakışma temizliği ve hook bağımlılıklarının açık tanımı.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDataDocumentToState,
  applyMergedRemoteDocumentIntoState,
} from '../src/app/persistence/remote-document-merge.ts';
import { buildUserDataDocument } from '../src/app/user-data-payload.ts';

function makeProfile(id, items = [], extra = {}) {
  return {
    id,
    name: id === 'PROFILE-DEMO' ? 'Demo' : id,
    createdAt: '2026-01-01T00:00:00.000Z',
    preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
    items,
    ...extra,
  };
}

function savedItem(id, title) {
  return {
    id,
    title,
    media_type: 'movie',
    overview: '',
    poster_path: null,
    vote_average: 7,
    release_date: '2020-01-01',
    added_at: '2026-01-02T00:00:00.000Z',
  };
}

/** App.tsx'in sağladığı bağlamı taklit eder; ref'ler ve setter'lar kaydedilir. */
function makeContext(localDoc) {
  const calls = { setters: [], persist: [] };
  const refs = {
    profilesRef: { current: localDoc.profiles },
    activeProfileIdRef: { current: localDoc.activeProfileId },
    profileNameRef: { current: localDoc.profiles[0].name },
    preferencesRef: { current: localDoc.profiles[0].preferences },
    savedItemsRef: { current: localDoc.profiles[0].items },
    // App.tsx'te ref, canlı favori aktör state'ini tutar; stub aynı değerle tohumlanır.
    favoriteActorsRef: { current: localDoc.profiles[0].favoriteActors || [] },
    deletedKeysRef: { current: {} },
    tasteMapRef: { current: null },
    isDirtyRef: { current: false },
    applyingRemoteSnapshotRef: { current: false },
    hadStoredProfilesOnBootRef: { current: null },
  };
  const setters = {};
  for (const name of [
    'setProfiles',
    'setActiveProfileId',
    'setProfileName',
    'setPreferences',
    'setSavedItems',
    'setFavoriteActors',
    'setDeletedKeys',
    'setTasteMap',
    'setServerConflict',
  ]) {
    setters[name] = (value) => {
      calls.setters.push([name, value]);
    };
  }
  const context = {
    buildLivePayloadFromRefs: () => buildUserDataDocument({
      profiles: refs.profilesRef.current,
      activeProfileId: refs.activeProfileIdRef.current,
      profileName: refs.profileNameRef.current,
      preferences: refs.preferencesRef.current,
      savedItems: refs.savedItemsRef.current,
      favoriteActors: refs.favoriteActorsRef.current || [],
      deletedKeys: refs.deletedKeysRef.current,
    }),
    persistProfilesBestEffort: (profiles) => calls.persist.push(profiles),
    refs,
    setters,
  };
  return { context, refs, setters, calls };
}

test('F5.3-03 geçersiz uzak belge: null döner, hiçbir ref ve state değişmez', () => {
  const localDoc = buildUserDataDocument({
    profiles: [makeProfile('PROFILE-A', [savedItem(550, 'Fight Club')])],
    activeProfileId: 'PROFILE-A',
    profileName: 'A',
    preferences: makeProfile('PROFILE-A').preferences,
    savedItems: [savedItem(550, 'Fight Club')],
    favoriteActors: [],
    deletedKeys: {},
  });
  const { context, refs, calls } = makeContext(localDoc);

  const result = applyMergedRemoteDocumentIntoState(context, null, {});
  assert.equal(result, null);
  // Mevcut durum korunur: setter çağrısı yok, ref'lerde değişim yok.
  assert.equal(calls.setters.length, 0);
  assert.equal(refs.applyingRemoteSnapshotRef.current, false);
  assert.equal(refs.hadStoredProfilesOnBootRef.current, null);
  assert.equal(calls.persist.length, 0);
});

test('F5.3-03 uzak önce Nothing olan belge: state ve ref güncellenir, kirli işaret temizlenir', () => {
  const localDoc = buildUserDataDocument({
    profiles: [makeProfile('PROFILE-A', [])],
    activeProfileId: 'PROFILE-A',
    profileName: 'A',
    preferences: makeProfile('PROFILE-A').preferences,
    savedItems: [],
    favoriteActors: [],
    deletedKeys: {},
  });
  const { context, refs, calls } = makeContext(localDoc);
  refs.isDirtyRef.current = true;

  const remoteDoc = buildUserDataDocument({
    profiles: [makeProfile('PROFILE-A', [savedItem(550, 'Fight Club')])],
    activeProfileId: 'PROFILE-A',
    profileName: 'A',
    preferences: makeProfile('PROFILE-A').preferences,
    savedItems: [savedItem(550, 'Fight Club')],
    favoriteActors: [],
    deletedKeys: {},
  });

  const merged = applyMergedRemoteDocumentIntoState(context, remoteDoc);
  assert.ok(merged);
  assert.equal(refs.savedItemsRef.current.length, 1);
  assert.equal(refs.savedItemsRef.current[0].id, 550);
  assert.equal(refs.profilesRef.current[0].items.length, 1);
  assert.equal(refs.activeProfileIdRef.current, 'PROFILE-A');
  assert.equal(refs.applyingRemoteSnapshotRef.current, true);
  assert.equal(refs.hadStoredProfilesOnBootRef.current, true);
  // Yerel ileride değil: kirli işaret temizlenir ve sunucu çakışması sıfırlanır.
  assert.equal(refs.isDirtyRef.current, false);
  const conflictCalls = calls.setters.filter(([name]) => name === 'setServerConflict');
  assert.deepEqual(conflictCalls, [['setServerConflict', null]]);
  // Taste map aktif profil için yüklenir; ref ve state AYNI nesneye işaret eder.
  const tasteCalls = calls.setters.filter(([name]) => name === 'setTasteMap');
  assert.equal(tasteCalls.length, 1);
  assert.ok(tasteCalls[0][1]);
  assert.equal(tasteCalls[0][1], refs.tasteMapRef.current);
  // Profiller en-iyi-çabayla kalıcılaştırılır.
  assert.equal(calls.persist.length, 1);
  assert.equal(calls.persist[0].length, 1);
  // Anahtara değer akışı: tüm state güncelleyicileri tam olarak bir kez çağrıldı.
  const setterNames = calls.setters.map(([name]) => name);
  for (const expected of [
    'setProfiles',
    'setActiveProfileId',
    'setProfileName',
    'setPreferences',
    'setSavedItems',
    'setFavoriteActors',
    'setDeletedKeys',
    'setTasteMap',
  ]) {
    assert.equal(
      setterNames.filter((n) => n === expected).length,
      1,
      `${expected} tam bir kez çağrılmalı`
    );
  }
});

test('F5.3-03 yerel ileride: keepDirtyIfLocalAhead ile kirli kalır, çakışma sıfırlanmaz', () => {
  const activeFav = { id: 111, name: 'Efsane Aktör', profile_path: null };
  const localDoc = buildUserDataDocument({
    profiles: [makeProfile('PROFILE-A', [savedItem(550, 'Fight Club'), savedItem(42, 'İçerideki')])],
    activeProfileId: 'PROFILE-A',
    profileName: 'A',
    preferences: makeProfile('PROFILE-A').preferences,
    savedItems: [savedItem(550, 'Fight Club'), savedItem(42, 'İçerideki')],
    favoriteActors: [activeFav],
    deletedKeys: {},
  });
  const { context, refs, calls } = makeContext(localDoc);
  refs.isDirtyRef.current = true;

  // Uzakta yalnızca eski cinephile kümesi var.
  const remoteDoc = buildUserDataDocument({
    profiles: [makeProfile('PROFILE-A', [savedItem(550, 'Fight Club')])],
    activeProfileId: 'PROFILE-A',
    profileName: 'A',
    preferences: makeProfile('PROFILE-A').preferences,
    savedItems: [savedItem(550, 'Fight Club')],
    favoriteActors: [],
    deletedKeys: {},
  });

  const merged = applyMergedRemoteDocumentIntoState(context, remoteDoc, { keepDirtyIfLocalAhead: true });
  assert.ok(merged);
  // Yerel ileride: union korunur, kirli kalır.
  assert.equal(refs.savedItemsRef.current.length, 2);
  assert.equal(refs.isDirtyRef.current, true);
  // Kirliyken sunucu çakışması sıfırlanmaz.
  const conflictCalls = calls.setters.filter(([name]) => name === 'setServerConflict');
  assert.deepEqual(conflictCalls, []);
  // Aktif profilin favori aktörleri kayıpsız taşınır.
  assert.equal(refs.favoriteActorsRef.current.length, 1);
  assert.equal(refs.favoriteActorsRef.current[0].id, 111);
});

/** App.tsx'in apply bağlamını taklit eder (merge bağlamı + çakışma çözümü). */
function makeApplyContext(localDoc) {
  const { context, refs, calls } = makeContext(localDoc);
  calls.resolved = 0;
  return {
    refs,
    calls,
    context: {
      persistProfilesBestEffort: context.persistProfilesBestEffort,
      resolveQueuedConflict: () => {
        calls.resolved += 1;
      },
      refs,
      setters: context.setters,
    },
  };
}

/** DIRTY_KEY temizliğini gözlemlemek için en küçük localStorage vekili. */
function withLocalStorage(fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const removed = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
      removeItem: (key) => removed.push(key),
    },
  });
  try {
    fn(removed);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
}

test('F5.3-03 apply: geçersiz belge hiçbir ref/state değiştirmez, çakışma çözülmez', () => {
  const localDoc = buildUserDataDocument({
    profiles: [makeProfile('PROFILE-A', [savedItem(550, 'Fight Club')])],
    activeProfileId: 'PROFILE-A',
    profileName: 'A',
    preferences: makeProfile('PROFILE-A').preferences,
    savedItems: [savedItem(550, 'Fight Club')],
    favoriteActors: [],
    deletedKeys: {},
  });
  const { context, refs, calls } = makeApplyContext(localDoc);

  for (const invalid of [null, undefined, {}, { profiles: [] }, 'bozuk']) {
    assert.equal(applyDataDocumentToState(context, invalid), false);
  }

  // Mevcut durum korunur: hiçbir setter, kalıcılık veya çakışma çözümü çağrısı yok.
  assert.equal(calls.setters.length, 0);
  assert.equal(calls.persist.length, 0);
  assert.equal(calls.resolved, 0);
  assert.equal(refs.applyingRemoteSnapshotRef.current, false);
  assert.equal(refs.hadStoredProfilesOnBootRef.current, null);
  assert.equal(refs.savedItemsRef.current.length, 1);
});

test('F5.3-03 apply: geçerli belge ref/state yazar, kirli işareti ve çakışmayı temizler', () => {
  const localDoc = buildUserDataDocument({
    profiles: [makeProfile('PROFILE-A', [])],
    activeProfileId: 'PROFILE-A',
    profileName: 'A',
    preferences: makeProfile('PROFILE-A').preferences,
    savedItems: [],
    favoriteActors: [],
    deletedKeys: {},
  });
  const { context, refs, calls } = makeApplyContext(localDoc);
  refs.isDirtyRef.current = true;

  const remoteDoc = buildUserDataDocument({
    profiles: [
      makeProfile('PROFILE-B', [savedItem(550, 'Fight Club')], { name: 'B' }),
    ],
    activeProfileId: 'PROFILE-B',
    profileName: 'B',
    preferences: makeProfile('PROFILE-B').preferences,
    savedItems: [savedItem(550, 'Fight Club')],
    favoriteActors: [],
    deletedKeys: {},
  });

  withLocalStorage((removedKeys) => {
    assert.equal(applyDataDocumentToState(context, remoteDoc), true);

    // Aktif profil ve liste belgeyle birebir değiştirilir (birleştirme yok).
    assert.equal(refs.activeProfileIdRef.current, 'PROFILE-B');
    assert.equal(refs.profileNameRef.current, 'B');
    assert.equal(refs.profilesRef.current.length, 1);
    assert.equal(refs.savedItemsRef.current.length, 1);
    assert.equal(refs.savedItemsRef.current[0].id, 550);
    assert.equal(refs.applyingRemoteSnapshotRef.current, true);
    assert.equal(refs.hadStoredProfilesOnBootRef.current, true);
    // Kirli işaret temizlenir.
    assert.equal(refs.isDirtyRef.current, false);
    assert.deepEqual(removedKeys, ['cinetrack.dirty.v2']);
    // Bekleyen çakışma bir kez çözülür, sunucu çakışması sıfırlanır.
    assert.equal(calls.resolved, 1);
    const conflictCalls = calls.setters.filter(([name]) => name === 'setServerConflict');
    assert.deepEqual(conflictCalls, [['setServerConflict', null]]);
    // Profiller en-iyi-çabayla kalıcılaştırılır.
    assert.equal(calls.persist.length, 1);
    // Taste map aktif profil için yüklenir; ref ve state aynı nesnedir.
    const tasteCalls = calls.setters.filter(([name]) => name === 'setTasteMap');
    assert.equal(tasteCalls.length, 1);
    assert.equal(tasteCalls[0][1], refs.tasteMapRef.current);
    // Tüm setter'lar tam bir kez çağrılır.
    const setterNames = calls.setters.map(([name]) => name);
    for (const expected of [
      'setProfiles',
      'setActiveProfileId',
      'setProfileName',
      'setPreferences',
      'setSavedItems',
      'setFavoriteActors',
      'setDeletedKeys',
      'setTasteMap',
      'setServerConflict',
    ]) {
      assert.equal(
        setterNames.filter((n) => n === expected).length,
        1,
        `${expected} tam bir kez çağrılmalı`
      );
    }
  });
});

test('F5.3-03 apply: deleted_keys ve favori aktörler normalize edilerek uygulanır', () => {
  const localDoc = buildUserDataDocument({
    profiles: [makeProfile('PROFILE-A', [])],
    activeProfileId: 'PROFILE-A',
    profileName: 'A',
    preferences: makeProfile('PROFILE-A').preferences,
    savedItems: [],
    favoriteActors: [],
    deletedKeys: {},
  });
  const { context, refs } = makeApplyContext(localDoc);
  // Tombstone saklama süresi geçmiş kayıtları düşürür; taze bir zaman damgası kullan.
  const recentTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const remoteDoc = buildUserDataDocument({
    profiles: [
      makeProfile('PROFILE-A', [savedItem(550, 'Fight Club')], {
        favoriteActors: [
          { id: 111, name: 'Efsane Aktör' },
          { id: 111, name: 'Efsane Aktör' },
          null,
        ],
        deleted_keys: { 'movie:42': recentTs, bozuk: 5 },
      }),
    ],
    activeProfileId: 'PROFILE-A',
    profileName: 'A',
    preferences: makeProfile('PROFILE-A').preferences,
    savedItems: [savedItem(550, 'Fight Club')],
    // Aktif profilin favorileri belgede üst düzey alandan gelir; yinelenen ve
    // geçersiz kayıtlar normalize edilmelidir.
    favoriteActors: [
      { id: 111, name: 'Efsane Aktör' },
      { id: 111, name: 'Efsane Aktör' },
      null,
    ],
    deletedKeys: { 'movie:42': recentTs, bozuk: 5 },
  });

  withLocalStorage(() => {
    assert.equal(applyDataDocumentToState(context, remoteDoc), true);
  });

  // Yinelenen/geçersiz favori aktörler tekilleşir; geçersiz silme kaydı düşer.
  assert.equal(refs.favoriteActorsRef.current.length, 1);
  assert.equal(refs.favoriteActorsRef.current[0].id, 111);
  assert.deepEqual(Object.keys(refs.deletedKeysRef.current), ['movie:42']);
  assert.equal(refs.deletedKeysRef.current['movie:42'], recentTs);
});

test('F5.3-03 apply: hook bağımlılık kimliği orijinal callback ile aynıdır', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../src/app/persistence/remote-document-merge.ts', import.meta.url),
    'utf8'
  );
  const match = source.match(/useCallback<ApplyDataDocumentToState>[\s\S]*?\[([^\]]*)\]/);
  assert.ok(match, 'useCallback<ApplyDataDocumentToState> dep array bulunamadı');
  const deps = match[1].split(',').map((d) => d.trim()).filter(Boolean);
  assert.deepEqual(deps, ['persistProfilesBestEffort', 'resolveQueuedConflict']);
  const mod = await import('../src/app/persistence/remote-document-merge.ts');
  assert.equal(typeof mod.useDataDocumentApply, 'function');
  assert.equal(typeof mod.applyDataDocumentToState, 'function');
});

test('F5.3-03 hook bağımlılıkları açıklı: useRemoteDocumentMerge çağrı mimarisi', async () => {
  // Hook saf modülün ince kabuğudur; test yalnızca export mimarisini doğrular
  // (App.tsx yalnızca bağımlılıkları sağlar, sorumluluk modüldedir).
  const mod = await import('../src/app/persistence/remote-document-merge.ts');
  assert.equal(typeof mod.applyMergedRemoteDocumentIntoState, 'function');
  assert.equal(typeof mod.useRemoteDocumentMerge, 'function');
  // Kayıpsız merge hesaplama App'ten bağımsız, server-sync'ten gelir.
  const sync = await import('../src/app/server-sync.ts');
  assert.equal(typeof sync.mergeRemoteDocument, 'function');
});

test('F5.3-03 hook useCallback bağımlılık kimliği orijinal callback ile aynıdır', async () => {
  // REGRESYON KAPISI: App.tsx'teki orijinal mergeRemoteDocumentIntoState
  // useCallback'i yalnızca [buildCurrentLivePayloadFromRefs,
  // persistProfilesBestEffort] bağımlıydı. ref/setter paketleri her render'da
  // yeni nesne kimliğiyledir; hook bunları dep array'e alırsa callback her
  // render'da yeniden üretilir ve bağlı effect'ler (başlangıç senkronu) her
  // render'da tetiklenir — CI Playwright E2E'de 409 çakışma banner
  // regresyonu olarak gözlemlenmişti. Kaynak üzerinden bu kısıt sabitlenir.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../src/app/persistence/remote-document-merge.ts', import.meta.url),
    'utf8'
  );
  const match = source.match(/useCallback<MergeRemoteDocumentIntoState>[\s\S]*?\[([^\]]*)\]/);
  assert.ok(match, 'useCallback<MergeRemoteDocumentIntoState> dep array bulunamadı');
  const deps = match[1].split(',').map((d) => d.trim()).filter(Boolean);
  assert.deepEqual(deps, ['buildLivePayloadFromRefs', 'persistProfilesBestEffort']);
});
