/**
 * B-21 — Yerel yazım zamanlayıcısı.
 *
 * Her state değişiminde tam listenin yeniden serileştirilip senkron olarak
 * yazılması büyük arşivlerde ana iş parçacığını bloke ediyordu. Bu sınıf
 * ardışık güncellemeleri tek bir yazıma birleştirir (trailing debounce),
 * yazım sırasını korur ve sekme gizlenirken/kapanırken bekleyen yazımın
 * kaybolmaması için `flush()` sağlar.
 *
 * Veri güvenliği: yazım başarısız olursa eski değer korunur, hiçbir alan
 * kırpılmaz; hata `onResult` ile çağırana bildirilir.
 */

import {
  StorageWriteMemo,
  applyLocalStoragePlan,
  buildLocalStoragePlan,
  type ApplyStorageResult,
  type PersistenceSnapshot,
  type StorageLike,
} from './persistence-plan.ts';

export interface StorageWriteSchedulerOptions {
  storage: StorageLike;
  /** Ardışık güncellemeleri birleştirme penceresi (ms). */
  delayMs?: number;
  memo?: StorageWriteMemo;
  /** Ölçülebilirlik/test için zamanlayıcı enjeksiyonu. */
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Her gerçek yazma denemesinden sonra çağrılır. */
  onResult?: (result: ApplyStorageResult) => void;
}

export class StorageWriteScheduler {
  private readonly storage: StorageLike;
  private readonly delayMs: number;
  private readonly memo: StorageWriteMemo;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onResult?: (result: ApplyStorageResult) => void;

  private pending: PersistenceSnapshot | null = null;
  private timer: unknown = null;
  private appliedOnce = false;
  /** Gerçekleşen yazma sayısı (birleştirme etkisini ölçmek için). */
  public writeCount = 0;
  /** `request` çağrı sayısı. */
  public requestCount = 0;

  constructor(options: StorageWriteSchedulerOptions) {
    this.storage = options.storage;
    this.delayMs = Math.max(0, options.delayMs ?? 250);
    this.memo = options.memo ?? new StorageWriteMemo();
    this.setTimer =
      options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs) as unknown);
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onResult = options.onResult;
  }

  /**
   * Son anlık görüntüyü kaydeder. İlk yazma (hidrasyon) hemen uygulanır;
   * sonraki hızlı güncellemeler tek bir gecikmeli yazımda birleşir.
   */
  request(snapshot: PersistenceSnapshot): void {
    this.pending = snapshot;
    this.requestCount += 1;
    if (!this.appliedOnce) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.applyPending();
    }, this.delayMs);
  }

  /** Bekleyen yazımı hemen uygular (sekme gizlenmesi/kapanması, unmount). */
  flush(): ApplyStorageResult | null {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    return this.applyPending();
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  private applyPending(): ApplyStorageResult | null {
    if (this.pending === null) return null;
    const snapshot = this.pending;
    this.pending = null;
    // Yazım sırasında yeni güncelleme gelirse `request` tekrar doldurur; bu
    // yüzden `pending` yazımdan ÖNCE temizlenir ve sıra bozulmaz.
    const result = applyLocalStoragePlan(
      this.storage,
      buildLocalStoragePlan(snapshot),
      this.memo
    );
    this.appliedOnce = true;
    this.writeCount += 1;
    this.onResult?.(result);
    return result;
  }
}
