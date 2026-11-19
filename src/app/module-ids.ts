/**
 * Birincil modül kimlikleri — yalnızca tip, çalışma zamanı bağımlılığı yok.
 *
 * `module-registry.ts` görünüm bileşenlerini içe aktarır. Görünüm katmanındaki
 * kartların yalnızca kimlik tipine ihtiyacı olduğundan tip burada ayrı tutulur;
 * böylece registry → DiscoverSection → MediaGrid → MediaCard → registry
 * döngüsü oluşmaz.
 */
export type ModuleId =
  | 'home'
  | 'discover'
  | 'list'
  | 'taste-map'
  | 'relationships'
  | 'series'
  | 'operations';
