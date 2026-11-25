/**
 * Yayın hatırlatıcısı adayları (F5.1-01).
 *
 * `App.tsx` içindeki hatırlatma taraması saf bir fonksiyona taşındı.
 * Bildirim gösterimi (yan etki) çağıranda kalır; kural ve metin üretimi
 * birebir korunur.
 */

import { displayTitle } from '../utils/helpers.ts';
import { reminderDaysUntil, resolveAirDate, type Preferences, type SavedItem } from '../core/cinetrack-core.ts';

export interface DueReminder {
  /** `preferences.notified` içinde kullanılan benzersiz anahtar. */
  key: string;
  /** Bildirime tıklandığında açılacak kayıt. */
  item: SavedItem;
  /** Bildirim gövdesi. */
  body: string;
}

export function collectDueReminders(
  items: SavedItem[],
  preferences: Preferences,
  today: Date
): DueReminder[] {
  if (!preferences.reminders) return [];

  const due: DueReminder[] = [];

  for (const item of items) {
    if (item.status === 'completed') continue;
    const airDate = resolveAirDate(item);
    if (!airDate) continue;
    const days = reminderDaysUntil(airDate, today);
    if (days === null) continue;
    const key = `${item.media_type}:${item.id}:${airDate}`;
    if (preferences.notified.includes(key) || due.some((entry) => entry.key === key)) continue;

    const next = item.next_episode_to_air;
    const episodeTag =
      item.media_type === 'tv' && next?.air_date === airDate && next.season_number
        ? ` (S${next.season_number}B${next.episode_number})`
        : '';
    const when = days === 0 ? 'bugün' : `${days} gün içinde`;

    due.push({
      key,
      item,
      body: `${displayTitle(item)} ${when} yayınlanıyor${episodeTag}.`,
    });
  }

  return due;
}
