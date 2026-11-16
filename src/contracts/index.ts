/**
 * MIA Faz 1A ② — Sözleşme barrel'ı.
 *
 * Tüm MIA sözleşmeleri tek noktadan dışa açılır. Uygulamalar (Faz 1B'de
 * mevcut sistemler, Faz 2+'da yeni yöneticiler) buradan import eder;
 * iç dosya yapısına doğrudan bağımlı olmaz.
 *
 * Kural: Bu klasörde UYGULAMA (implementation) YASAKTIR — yalnızca tip,
 * arayüz ve hatasınıf tanımları bulunur.
 */

export type {
  MediaKey,
  ModuleHealth,
  OperationOutcome,
  ProfileConflictReason,
  ProfileRef,
  ReadProfileRef,
  WriteProfileRef,
} from './common.ts';
export { ProfileConflictError } from './common.ts';

export type {
  AppEvent,
  AppEventHandler,
  AppEventMap,
  EventSubscription,
  IEventPublisher,
  IEventSubscriber,
  TypedAppEvent,
} from './events.ts';

export type {
  IApplicationModule,
  ModuleContext,
  ModuleLayer,
  IModuleRegistry,
} from './module.ts';

export type {
  IProfileContext,
  ProfileChangeEvent,
  ProfileChangeListener,
} from './profile.ts';

export type {
  IDataRepository,
  OptimisticSaveDataOptions,
  PrimaryDataRepository,
  RepositoryReadResult,
  SaveDataOptions,
  SaveDataResult,
  StorageDriverId,
  StorageHealth,
} from './data.ts';
export { StaleRevisionError } from './data.ts';

export type {
  AddLibraryItemInput,
  ContentFeatureProfileView,
  ContentFeatureSignal,
  ContentMetadata,
  ContentMoodEvaluation,
  ContentSemanticComparison,
  ContentSignalSource,
  IContentIntelligenceService,
  IContentService,
  ILibraryService,
  IMemoryService,
  IRecommendationService,
  IRelationshipService,
  ITasteService,
  LibraryListId,
  LibrarySignalKind,
  RecommendationView,
  RelationshipEdge,
  RemoveLibraryItemInput,
  TasteProfileSummaryView,
  UpdateLibraryItemInput,
} from './services.ts';
