/**
 * B-37 — Yönetilen dışa aktarma dosya adı deseni (tek kaynak).
 *
 * Hem dışa aktarma üreticisi hem saklama (retention) politikası bu deseni
 * kullanır. Ayrı modülde tutulması, `excel-profile-backup.ts` ↔
 * `export-retention.ts` arasında döngüsel import oluşmasını engeller.
 */

export const EXPORT_FILE_NAME_PATTERN =
  /^(?:Cinethos|CineTrack)_Profile_\d{4}-\d{2}-\d{2}_\d{4}(?:_\d{2,14})?\.(?:xlsx|json)$/;
