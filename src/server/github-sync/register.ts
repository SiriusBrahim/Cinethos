/**
 * F5.3-05 — GitHub uzak senkronizasyon motorunun kaydı (geliştirme entegrasyonu).
 *
 * Bu modül, GitHub entegrasyonunun yerel veri katmanına bağlandığı **tek**
 * noktadır. Yerel katman (`persistent-store.ts`) bu dosyayı import etmez;
 * bağlantı uygulama kabuğunda (`app.ts`) kurulur. GitHub entegrasyonu
 * kaldırılacağında silinmesi gerekenler: bu dosya, `github-*.ts` modülleri ve
 * `github-sync/` klasörü. Yerel veri okuma/yazma yolları etkilenmez.
 */

import { GitHubBidirectionalSyncManager } from '../github-bidirectional-sync.ts';
import { registerRemoteSyncEngineFactory } from '../persistence/remote-sync-registry.ts';

export function registerGitHubRemoteSyncEngine(): void {
  registerRemoteSyncEngineFactory(
    (deps) =>
      new GitHubBidirectionalSyncManager({
        dataDir: deps.dataDir,
        maxDataBytes: deps.maxDataBytes,
        enableStartupRecovery: deps.enableStartupRecovery,
        store: deps.store,
        storage: deps.storage,
        getGitHubConfig: deps.getConfig,
        onSyncCompleted: deps.onCompleted,
      })
  );
}

registerGitHubRemoteSyncEngine();
