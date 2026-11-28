/**
 * F5.3-03 — App.tsx belge birleştirme sorumluluğu.
 *
 * `mergeRemoteDocumentIntoState` gövdesi App.tsx'ten buraya taşındı: uzak
 * belgeyi yerel canlı belgeyle kayıpsız birleştirir (`mergeRemoteDocument`,
 * hesaplama kısmı `app/server-sync.ts`'tedir), sonucu React state ve ref'lere
 * uygular, aktif profilin taste haritasını yükler, profilleri en-iyi-çabayla
 * kalıcılaştırır, kirli işareti (DIRTY_KEY) güncelleyerek sunucu çakışma
 * durumunu da koordine eder.
 *
 * Aynı dosyada `applyDataDocumentToState` de yaşar: sunucudan gelen belgeyi
 * (yedek geri yükleme, çakışmada "sunucuyu kullan") birleştirme yapmadan
 * doğrudan uygular. İki yolun ortak noktası tek bir ref/setter sözleşmesidir;
 * farkları korunur — apply yolu kirli işareti temizler ve bekleyen çevrimdışı
 * çakışmayı çözer, merge yolu ise yerel ilerideyse kirli bırakabilir.
 *
 * Modül dar bir bağlam arabirimiyle çalışır: ref'ler, state güncelleyiciler ve
 * kalıcılık geri çağrıları App'ten verilir; burada yeni bir senkron yolu
 * açılmaz, davranış birebir korunur. `useRemoteDocumentMerge` yalnızca bu
 * bağlamı `useCallback`'e bağlayan ince React kabuğudur.
 */

import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { mergeRemoteDocument } from '../server-sync.ts';
import { DIRTY_KEY } from '../profile-storage.ts';
import {
  loadPersistentTasteMap,
  normalizeDataDocument,
  normalizeDeletedKeys,
  normalizeFavoriteActors,
} from '../../core/cinetrack-core.ts';
import type {
  DataDocument,
  FavoriteActorInfo,
  PersistentTasteMapData,
  Preferences,
  Profile,
  SavedItem,
} from '../../core/cinetrack-core.ts';
import type { ServerConflictDetail } from '../../services/api.ts';

export interface RemoteDocumentMergeStateRefs {
  profilesRef: MutableRefObject<Profile[]>;
  activeProfileIdRef: MutableRefObject<string>;
  profileNameRef: MutableRefObject<string>;
  preferencesRef: MutableRefObject<Preferences>;
  savedItemsRef: MutableRefObject<SavedItem[]>;
  favoriteActorsRef: MutableRefObject<FavoriteActorInfo[]>;
  deletedKeysRef: MutableRefObject<Record<string, string>>;
  tasteMapRef: MutableRefObject<PersistentTasteMapData>;
  isDirtyRef: MutableRefObject<boolean>;
  applyingRemoteSnapshotRef: MutableRefObject<boolean>;
  hadStoredProfilesOnBootRef: MutableRefObject<boolean | null>;
}

export interface RemoteDocumentMergeSetters {
  setProfiles: Dispatch<SetStateAction<Profile[]>>;
  setActiveProfileId: Dispatch<SetStateAction<string>>;
  setProfileName: Dispatch<SetStateAction<string>>;
  setPreferences: Dispatch<SetStateAction<Preferences>>;
  setSavedItems: Dispatch<SetStateAction<SavedItem[]>>;
  setFavoriteActors: Dispatch<SetStateAction<FavoriteActorInfo[]>>;
  setDeletedKeys: Dispatch<SetStateAction<Record<string, string>>>;
  setTasteMap: Dispatch<SetStateAction<PersistentTasteMapData>>;
  setServerConflict: Dispatch<SetStateAction<ServerConflictDetail | null>>;
}

export interface RemoteDocumentMergeContext {
  /** Ref'lerden güncel canlı yerel belgeyi üretir (`buildUserDataDocument`). */
  buildLivePayloadFromRefs: () => DataDocument;
  /** Profil listesini en-iyi-çaba ile kalıcılaştırır. */
  persistProfilesBestEffort: (profiles: Profile[]) => void;
  refs: RemoteDocumentMergeStateRefs;
  setters: RemoteDocumentMergeSetters;
}

export interface ApplyMergedRemoteDocumentOptions {
  preferActiveFrom?: 'local' | 'remote';
  foldUnhydrated?: boolean;
  keepDirtyIfLocalAhead?: boolean;
}

export interface MergeRemoteDocumentIntoState {
  (rawRemoteDoc: DataDocument, options?: ApplyMergedRemoteDocumentOptions): DataDocument | null;
}

export interface RemoteDocumentApplyContext {
  /** Profil listesini en-iyi-çaba ile kalıcılaştırır. */
  persistProfilesBestEffort: (profiles: Profile[]) => void;
  /** Bekleyen çevrimdışı çakışmayı/snapshot'ı çözer. */
  resolveQueuedConflict: () => void;
  refs: RemoteDocumentMergeStateRefs;
  setters: RemoteDocumentMergeSetters;
}

export interface ApplyDataDocumentToState {
  (rawDoc: DataDocument): void;
}

/**
 * Kirli işareti kalıcı deposuna yazar. `localStorage` erişilemezse sessizce
 * geçilir; bu davranış App.tsx'teki orijinal `try {} catch {}` bloğuyla aynıdır.
 */
function writeDirtyFlag(dirty: boolean): void {
  try {
    if (dirty) {
      localStorage.setItem(DIRTY_KEY, '1');
    } else {
      localStorage.removeItem(DIRTY_KEY);
    }
  } catch {}
}

/**
 * F5.3-01/02 kalıbıyla aynı separasyon: bağlam (ref + setter + kalıcılık)
 * çağırandan gelir; modül saf iş kurallarını yürütür. Dönen değer orijinal
 * davranışla aynıdır: birleşme mümkün değilse `null` (çağıran mevcut durumu
 * korur), değilse birleşmiş belge.
 */
export function applyMergedRemoteDocumentIntoState(
  context: RemoteDocumentMergeContext,
  rawRemoteDoc: DataDocument,
  options: ApplyMergedRemoteDocumentOptions = {}
): DataDocument | null {
  const merged = mergeRemoteDocument(context.buildLivePayloadFromRefs(), rawRemoteDoc, {
    preferActiveFrom: options.preferActiveFrom,
    foldUnhydrated: options.foldUnhydrated,
    keepDirtyIfLocalAhead: options.keepDirtyIfLocalAhead,
  });
  if (!merged) return null;

  const {
    mergedDoc,
    activeProfile: active,
    favoriteActors: activeFavs,
    deletedKeys: activeDeleted,
    shouldStayDirty,
  } = merged;

  const { refs, setters } = context;

  refs.applyingRemoteSnapshotRef.current = true;
  refs.hadStoredProfilesOnBootRef.current = true;

  refs.profilesRef.current = mergedDoc.profiles;
  refs.activeProfileIdRef.current = mergedDoc.activeProfileId;
  refs.profileNameRef.current = active.name;
  refs.preferencesRef.current = active.preferences;
  refs.savedItemsRef.current = active.items;
  refs.favoriteActorsRef.current = activeFavs;
  refs.deletedKeysRef.current = activeDeleted;

  setters.setProfiles(mergedDoc.profiles);
  setters.setActiveProfileId(mergedDoc.activeProfileId);
  setters.setProfileName(active.name);
  setters.setPreferences(active.preferences);
  setters.setSavedItems(active.items);
  setters.setFavoriteActors(activeFavs);
  setters.setDeletedKeys(activeDeleted);

  const loadedMap = loadPersistentTasteMap(active.id);
  refs.tasteMapRef.current = loadedMap;
  setters.setTasteMap(loadedMap);

  context.persistProfilesBestEffort(mergedDoc.profiles);

  refs.isDirtyRef.current = shouldStayDirty;
  writeDirtyFlag(shouldStayDirty);

  if (!shouldStayDirty) {
    setters.setServerConflict(null);
  }

  return mergedDoc;
}

/**
 * Sunucu belgesini birleştirme yapmadan doğrudan uygular.
 *
 * Davranış App.tsx'teki orijinal `applyDataDocumentToState` ile birebir aynıdır:
 * belge normalize edilemezse hiçbir şey değişmez (`false` döner), aksi hâlde
 * ref'ler ve state yazılır, aktif profilin taste haritası yüklenir, profiller
 * en-iyi-çabayla kalıcılaştırılır, kirli işaret temizlenir, bekleyen çevrimdışı
 * çakışma çözülür ve sunucu çakışma durumu sıfırlanır.
 */
export function applyDataDocumentToState(
  context: RemoteDocumentApplyContext,
  rawDoc: DataDocument
): boolean {
  const doc = normalizeDataDocument(rawDoc);
  if (!doc) return false;

  const { refs, setters } = context;

  refs.applyingRemoteSnapshotRef.current = true;
  refs.hadStoredProfilesOnBootRef.current = true;
  refs.profilesRef.current = doc.profiles;
  setters.setProfiles(doc.profiles);
  setters.setActiveProfileId(doc.activeProfileId);
  refs.activeProfileIdRef.current = doc.activeProfileId;
  const active = doc.profiles.find((p) => p.id === doc.activeProfileId) || doc.profiles[0];
  refs.profileNameRef.current = active.name;
  setters.setProfileName(active.name);
  refs.preferencesRef.current = active.preferences;
  setters.setPreferences(active.preferences);
  refs.savedItemsRef.current = active.items;
  setters.setSavedItems(active.items);
  const activeFavs = normalizeFavoriteActors(active.favoriteActors || []);
  refs.favoriteActorsRef.current = activeFavs;
  setters.setFavoriteActors(activeFavs);
  const activeDeleted = normalizeDeletedKeys(active.deleted_keys);
  refs.deletedKeysRef.current = activeDeleted;
  setters.setDeletedKeys(activeDeleted);
  const loadedMap = loadPersistentTasteMap(active.id);
  refs.tasteMapRef.current = loadedMap;
  setters.setTasteMap(loadedMap);
  context.persistProfilesBestEffort(doc.profiles);
  refs.isDirtyRef.current = false;
  writeDirtyFlag(false);
  context.resolveQueuedConflict();
  setters.setServerConflict(null);

  return true;
}

export type UseDataDocumentApplyParams = RemoteDocumentApplyContext;

export interface DataDocumentApplyController {
  applyDataDocumentToState: ApplyDataDocumentToState;
}

/**
 * `useRemoteDocumentMerge` ile aynı ref/setter sözleşmesini kullanan ince React
 * kabuğu. Bağımlılıklar App.tsx'teki orijinal callback ile aynıdır:
 * `[persistProfilesBestEffort, resolveQueuedConflict]`.
 */
export function useDataDocumentApply({
  persistProfilesBestEffort,
  resolveQueuedConflict,
  refs,
  setters,
}: UseDataDocumentApplyParams): DataDocumentApplyController {
  const payloadRef = useRef({ refs, setters });
  payloadRef.current = { refs, setters };

  const applyDocument = useCallback<ApplyDataDocumentToState>(
    (rawDoc) => {
      applyDataDocumentToState(
        {
          persistProfilesBestEffort,
          resolveQueuedConflict,
          refs: payloadRef.current.refs,
          setters: payloadRef.current.setters,
        },
        rawDoc
      );
    },
    [persistProfilesBestEffort, resolveQueuedConflict]
  );

  return { applyDataDocumentToState: applyDocument };
}

export type UseRemoteDocumentMergeParams = RemoteDocumentMergeContext;

export interface RemoteDocumentMergeController {
  mergeRemoteDocumentIntoState: MergeRemoteDocumentIntoState;
}

/**
 * App.tsx yalnızca gerekli bağımlılıkları sağlar; birleştirme sorumluluğu bu
 * modülde yaşar. `useCallback` bağımlılıkları orijinal callback ile aynıdır.
 */
export function useRemoteDocumentMerge({
  buildLivePayloadFromRefs,
  persistProfilesBestEffort,
  refs,
  setters,
}: UseRemoteDocumentMergeParams): RemoteDocumentMergeController {
  // ref/setter paketleri her render'da yeni nesne kimliğiyle gelir; App.tsx'teki
  // orijinal callback'in bağımlılık kimliği korunmalıdır — aksi hâlde callback
  // her render'da yeniden üretilir ve buna bağlı effect'ler (başlangıç
  // senkronu vb.) her render'da yeniden tetiklenir. Bu yüzden paketler en
  // güncel hâlleriyle ref'te tutulur; useCallback yalnızca orijinal iki
  // bağımlılığa bağlıdır.
  const payloadRef = useRef({ refs, setters });
  payloadRef.current = { refs, setters };

  const mergeRemoteDocumentIntoState = useCallback<MergeRemoteDocumentIntoState>(
    (rawRemoteDoc, options = {}) =>
      applyMergedRemoteDocumentIntoState(
        {
          buildLivePayloadFromRefs: buildLivePayloadFromRefs,
          persistProfilesBestEffort,
          refs: payloadRef.current.refs,
          setters: payloadRef.current.setters,
        },
        rawRemoteDoc,
        options
      ),
    [buildLivePayloadFromRefs, persistProfilesBestEffort]
  );

  return { mergeRemoteDocumentIntoState };
}
