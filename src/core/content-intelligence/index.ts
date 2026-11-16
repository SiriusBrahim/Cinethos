/**
 * Content Intelligence Manager — dışa açılan tek nokta.
 *
 * Öneri motoru bu modülden yalnız `getFeatures` / `getFeaturesBatch` ile veri alır;
 * kullanıcı verisine (profil, puan, durum) erişmez.
 */

export * from './contracts.ts';
export * from './identity.ts';
export * from './features.ts';
export * from './manager.ts';
