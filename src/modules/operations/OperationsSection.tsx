import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionButton,
  Badge,
  EmptyState,
  Meter,
  Panel,
  SectionHeader,
  SkeletonRows,
  StatTile,
  Toolbar,
  type BadgeTone,
} from '../../components/ui/primitives.tsx';
import {
  OPERATIONS_STATUSES,
  cancelOperationsTask,
  fetchContentIntelligenceSummary,
  fetchOperationsSnapshot,
  fetchPipelineHealth,
  reprocessStaleContent,
  retryOperationsTask,
  type ContentIntelligenceSummary,
  type OperationsSnapshot,
  type OperationsTask,
  type OperationsTaskStatus,
  type PipelineHealth,
} from '../../services/operations-api.ts';
import {
  TASK_STATUS_HUMAN,
  describeTaskFailure,
  explainTaskActionError,
  getTaskActionAvailability,
} from './task-actions.ts';

/**
 * İşlem Merkezi.
 *
 * Gerçek kalıcı background görev kuyruğunu (`/api/background/tasks`) ve modül
 * sağlığını (`/api/health`) okur. Sunucu yalnızca aktif profile ait, sırlardan
 * arındırılmış görev özetlerini döndürür; dosya yolları ve olay payload'ı
 * arayüze taşınmaz.
 *
 * Yenileme: görünür sekmede 12 saniyelik yoklama; sekme arka plandayken durur,
 * görünür olduğunda hemen bir kez tazelenir. Bileşen kalkarken istekler iptal
 * edilir (sızan abonelik/zamanlayıcı yok).
 */

const POLL_INTERVAL_MS = 12_000;

const TASK_STATUS_TONES: Record<OperationsTaskStatus, BadgeTone> = {
  pending: 'neutral',
  processing: 'info',
  completed: 'ok',
  retry_wait: 'warn',
  failed: 'bad',
  cancelled: 'neutral',
};

const HANDLER_LABELS: Record<string, string> = {
  'library-item-added-audit': 'Kütüphane kaydı',
  'library-rating-changed-audit': 'Puan değişimi',
  'intelligence.taste-event-sync': 'Zevk profili telafisi',
};

function handlerLabel(handlerId: string): string {
  return HANDLER_LABELS[handlerId] || handlerId;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface OperationsSectionProps {
  profileId: string;
  onOpenBackup?: () => void;
}

export const OperationsSection: React.FC<OperationsSectionProps> = ({ profileId, onOpenBackup }) => {
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [health, setHealth] = useState<PipelineHealth | null>(null);
  const [intel, setIntel] = useState<ContentIntelligenceSummary | null>(null);
  const [reprocessBusy, setReprocessBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<OperationsTaskStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [taskErrors, setTaskErrors] = useState<
    Record<string, { message: string; technical: string; permanent: boolean }>
  >({});
  const mountedRef = useRef(true);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        // B-26: uçlar birbirinden bağımsız yüklenir. Görev kuyruğu okunamazsa
        // modül sağlığı ve içerik zekâsı yine gösterilir.
        const [snapshotResult, healthResult, intelResult] = await Promise.allSettled([
          fetchOperationsSnapshot({ status: statusFilter, limit: 200, ...(signal ? { signal } : {}) }),
          fetchPipelineHealth(signal),
          fetchContentIntelligenceSummary(signal),
        ]);
        if (!mountedRef.current) return;

        if (snapshotResult.status === 'fulfilled') {
          const nextSnapshot = snapshotResult.value;
          setSnapshot(nextSnapshot);
          setError(null);
          setTaskErrors((prev) => {
            const present = new Set(nextSnapshot.tasks.map((task) => task.taskId));
            const next: typeof prev = {};
            for (const [taskId, value] of Object.entries(prev)) {
              if (present.has(taskId)) next[taskId] = value;
            }
            return next;
          });
        } else {
          const reason = snapshotResult.reason;
          if (reason?.name !== 'AbortError') {
            setError(explainTaskActionError(reason).message);
          }
        }

        setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);
        setIntel(intelResult.status === 'fulfilled' ? intelResult.value : null);
      } catch (err: any) {
        if (err?.name === 'AbortError' || !mountedRef.current) return;
        setError(err?.message || 'Görev kuyruğu okunamadı.');
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [statusFilter]
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void load(controller.signal);
    }, POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void load(controller.signal);
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      mountedRef.current = false;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [load]);

  const runAction = useCallback(
    async (task: OperationsTask, action: 'retry' | 'cancel') => {
      setBusyTaskId(task.taskId);
      setTaskErrors((prev) => {
        if (!prev[task.taskId]) return prev;
        const next = { ...prev };
        delete next[task.taskId];
        return next;
      });
      try {
        if (action === 'retry') await retryOperationsTask(task.taskId);
        else await cancelOperationsTask(task.taskId);
        await load();
      } catch (err: any) {
        if (!mountedRef.current) return;
        const explanation = explainTaskActionError(err);
        setTaskErrors((prev) => ({ ...prev, [task.taskId]: explanation }));
        // Kalıcı (4xx) hatalarda liste de tazelenir: düğme durumu sunucu
        // durumuyla yeniden eşleşsin.
        if (explanation.permanent) void load();
      } finally {
        if (mountedRef.current) setBusyTaskId(null);
      }
    },
    [load]
  );

  const handleReprocess = useCallback(async () => {
    setReprocessBusy(true);
    setNotice(null);
    try {
      const result = await reprocessStaleContent(100);
      if (mountedRef.current) {
        setNotice(
          result.total === 0
            ? 'Yeniden işlenecek eski veya başarısız analiz yok.'
            : `${result.total} kayıt yeniden işleme kuyruğuna verildi (${result.accepted} kabul, ${result.rejected} yinelenen).`
        );
      }
      await load();
    } catch (err: any) {
      if (mountedRef.current) setError(err?.message || 'Yeniden işleme başlatılamadı.');
    } finally {
      if (mountedRef.current) setReprocessBusy(false);
    }
  }, [load]);

  const counts = snapshot?.counts;
  const tasks = snapshot?.tasks || [];
  const queue = health?.queue;
  const queueTotal = queue ? queue.pending + queue.processing + queue.completed + queue.failed : 0;
  const queuePercent =
    queue && queueTotal > 0 ? Math.round((queue.completed / queueTotal) * 100) : 0;

  return (
    <div className="ws-page ws-operations">
      <Panel ariaLabel="İşlem merkezi özeti">
        <SectionHeader
          eyebrow="Sistem"
          title="İşlem Merkezi"
          description="Arka plan görevleri, içerik işleme kuyruğu ve modül sağlığı. Liste yalnızca aktif profile ait görevleri gösterir."
          action={
            <div className="ws-section-actions">
              <ActionButton onClick={() => void load()} disabled={loading}>
                {loading ? 'Yenileniyor…' : 'Yenile'}
              </ActionButton>
              {onOpenBackup && <ActionButton onClick={onOpenBackup}>Yedekleme</ActionButton>}
            </div>
          }
        />

        {counts && (
          <div className="ws-stats" role="group" aria-label="Görev durum sayaçları">
            <StatTile label="Bekleyen" value={counts.pending} />
            <StatTile label="Çalışan" value={counts.processing} tone="info" />
            <StatTile label="Yeniden deneme" value={counts.retry_wait} tone="warn" />
            <StatTile label="Başarısız" value={counts.failed} tone={counts.failed > 0 ? 'bad' : 'ok'} />
            <StatTile label="Tamamlanan" value={counts.completed} tone="ok" />
            <StatTile label="İptal" value={counts.cancelled} />
          </div>
        )}

        {snapshot && !snapshot.storeAvailable && (
          <p className="ws-alert ws-alert--warn" role="status">
            Görev deposu şu anda kullanılamıyor. Kuyruk boş görünse de görevler kalıcı olmayabilir.
          </p>
        )}

        {error && (
          <div className="ws-alert ws-alert--bad" role="alert">
            <span>{error}</span>
            <ActionButton onClick={() => void load()}>Tekrar dene</ActionButton>
          </div>
        )}

        <Toolbar
          label="Görev filtresi"
          trailing={
            snapshot ? (
              <span className="ws-hint tabular-nums">
                {snapshot.tasks.length} görev · {formatTime(snapshot.checkedAt)} itibarıyla
              </span>
            ) : undefined
          }
        >
          <button
            type="button"
            className={`ws-filter ${statusFilter === 'all' ? 'is-active' : ''}`}
            onClick={() => setStatusFilter('all')}
            aria-pressed={statusFilter === 'all'}
          >
            Tümü
          </button>
          {OPERATIONS_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`ws-filter ${statusFilter === status ? 'is-active' : ''}`}
              onClick={() => setStatusFilter(status)}
              aria-pressed={statusFilter === status}
            >
              {TASK_STATUS_HUMAN[status]}
            </button>
          ))}
        </Toolbar>

        {loading && !snapshot ? (
          <SkeletonRows rows={5} label="Görevler yükleniyor" />
        ) : tasks.length === 0 ? (
          <EmptyState
            title="Kuyrukta görev yok"
            description="Kütüphanene bir yapım eklediğinde veya puanladığında arka plan görevleri burada belirir."
          />
        ) : (
          <div className="ws-table-wrap">
            <table className="ws-table">
              <caption className="ws-sr-only">
                Aktif profile ait arka plan görevleri: durum, deneme sayısı, hata ve zaman bilgileri.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Görev</th>
                  <th scope="col">Durum</th>
                  <th scope="col">Deneme</th>
                  <th scope="col">Son hata</th>
                  <th scope="col">Başlangıç / Bitiş</th>
                  <th scope="col">Eylem</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const actionError = taskErrors[task.taskId];
                  const availability = getTaskActionAvailability(task, {
                    busy: busyTaskId === task.taskId,
                    blocked: Boolean(actionError?.permanent),
                  });
                  const failure = describeTaskFailure(task.lastError);
                  return (
                  <tr key={task.taskId}>
                    <td data-label="Görev">
                      <span className="ws-table-title">{handlerLabel(task.handlerId)}</span>
                      <span className="ws-table-sub">
                        {task.profileId}
                        {task.profileId === profileId ? ' (aktif)' : ''}
                      </span>
                    </td>
                    <td data-label="Durum">
                      <Badge tone={TASK_STATUS_TONES[task.status]}>
                        {TASK_STATUS_HUMAN[task.status]}
                      </Badge>
                      {task.status === 'retry_wait' && task.nextRetryAt && (
                        <span className="ws-table-sub">
                          Sonraki: {formatTime(task.nextRetryAt)}
                        </span>
                      )}
                    </td>
                    <td data-label="Deneme" className="tabular-nums">
                      {task.attempts}/{task.maxAttempts}
                    </td>
                    <td data-label="Son hata">
                      {task.lastError ? (
                        <details className="ws-error-details">
                          <summary className="ws-error-text">{failure.summary}</summary>
                          {failure.technical && (
                            <pre className="ws-error-technical">{failure.technical}</pre>
                          )}
                        </details>
                      ) : (
                        <span className="ws-hint">—</span>
                      )}
                      {actionError && (
                        <p
                          className="ws-table-sub ws-error-text"
                          role="status"
                          id={`task-error-${task.taskId}`}
                        >
                          {actionError.message}
                          {actionError.technical && (
                            <span className="ws-error-technical"> {actionError.technical}</span>
                          )}
                        </p>
                      )}
                    </td>
                    <td data-label="Başlangıç / Bitiş">
                      <span className="ws-table-sub">Başlangıç: {formatTime(task.createdAt)}</span>
                      <span className="ws-table-sub">Bitiş: {formatTime(task.completedAt)}</span>
                    </td>
                    <td data-label="Eylem">
                      <div className="ws-row-actions">
                        <ActionButton
                          onClick={() => void runAction(task, 'retry')}
                          disabled={!availability.retry}
                          ariaLabel={`Yeniden dene: ${handlerLabel(task.handlerId)}`}
                        >
                          Yeniden dene
                        </ActionButton>
                        <ActionButton
                          variant="danger"
                          onClick={() => void runAction(task, 'cancel')}
                          disabled={!availability.cancel}
                          ariaLabel={`İptal: ${handlerLabel(task.handlerId)}`}
                        >
                          İptal
                        </ActionButton>
                      </div>
                      {(!availability.retry && availability.retryReason) ||
                      (!availability.cancel && availability.cancelReason) ? (
                        <p className="ws-table-sub">
                          {!availability.retry && availability.retryReason
                            ? availability.retryReason
                            : availability.cancelReason}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="ws-columns">
        <Panel className="ws-column" ariaLabel="İçerik işleme kuyruğu">
          <SectionHeader
            eyebrow="Content Intelligence"
            title="İçerik işleme kuyruğu"
            description="Katalog yapımlarının vektör ve semantik indeksleme durumu."
            action={
              <ActionButton onClick={() => void handleReprocess()} disabled={reprocessBusy || !intel}>
                {reprocessBusy ? 'Kuyruğa veriliyor…' : 'Eskileri yeniden işle'}
              </ActionButton>
            }
          />
          {intel ? (
            <div className="ws-mini-grid" role="group" aria-label="İçerik zekâsı özeti">
              <span>İndekslenen</span>
              <strong className="tabular-nums">{intel.completed}</strong>
              <span>Bekleyen</span>
              <strong className="tabular-nums">{intel.pending}</strong>
              <span>Çalışan</span>
              <strong className="tabular-nums">{intel.processing}</strong>
              <span>Başarısız</span>
              <strong className="tabular-nums">{intel.failed}</strong>
              <span>Eski sürüm / eksik</span>
              <strong className="tabular-nums">{intel.stale}</strong>
              <span>Kuyrukta başarısız</span>
              <strong className="tabular-nums">{intel.queue.failed}</strong>
            </div>
          ) : (
            <EmptyState
              title="İçerik zekâsı durumu alınamadı"
              description="Sunucu içerik zekâsı ucu yanıt vermedi."
            />
          )}
          {intel && intel.failed > 0 && (
            <p className="ws-alert ws-alert--warn" role="status">
              {intel.failed} kayıt başarısız analiz durumunda. Yeniden işleme kuyruğa alınabilir.
            </p>
          )}
          {notice && (
            <p className="ws-hint" role="status">
              {notice}
            </p>
          )}
          {queue && (
            <Meter
              label="Tamamlanan işleme"
              value={queuePercent}
              hint={`${queue.completed}/${queueTotal} iş`}
            />
          )}
        </Panel>

        <Panel className="ws-column" ariaLabel="Modül sağlığı">
          <SectionHeader
            eyebrow="Runtime"
            title="Modül sağlığı"
            description="Kayıtlı modüllerin anlık durumu."
          />
          {!health || health.modules.length === 0 ? (
            <EmptyState title="Sağlık bilgisi yok" description="Modül listesi alınamadı." />
          ) : (
            <ul className="ws-health-list">
              {health.modules.map((module) => (
                <li key={module.id} className="ws-health-row">
                  <span>{module.id}</span>
                  <Badge
                    tone={
                      module.status === 'healthy'
                        ? 'ok'
                        : module.status === 'degraded'
                          ? 'warn'
                          : module.status === 'unhealthy'
                            ? 'bad'
                            : 'neutral'
                    }
                  >
                    {module.status === 'healthy'
                      ? 'Sağlıklı'
                      : module.status === 'degraded'
                        ? 'Kısıtlı'
                        : module.status === 'unhealthy'
                          ? 'Sorunlu'
                          : 'Bilinmiyor'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
};

export default OperationsSection;
