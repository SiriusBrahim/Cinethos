/**
 * F5.2-04 — GitHub "inspect" işlemi (uzak taraf incelemesi).
 *
 * Uzak depodaki dosyaların indirilmesi, doğrulanması ve incelenmesi burada
 * toplanır. Modül, koordinatörün kilit/kuyruk durumuna dokunmaz; yalnızca
 * ağ erişimi, boyut sınırı ve blob yardımcısını içeren dar bir ana bilgisayar
 * (host) bağlamı alır. `GitHubBidirectionalSyncManager` ince bir delege olarak
 * kalır ve public API değişmez.
 */

import path from 'node:path';
import {
  classifyGitHubHttpStatus,
  computeCatalogSemanticMapHash,
  computeCatalogManifestContentHash,
  inspectCatalogRawContent,
  inspectManifestRawContent,
  inspectUserDataRawContent,
  inspectStockRawContent,
  inspectCinemaKunyeRawContent,
  inspectDerivedProfileRawContent,
} from './sync-core.ts';
import type {
  BidirectionalSyncDependencies,
  ParsedSideBundle,
} from './sync-core.ts';
import { githubFetch } from '../github-request.ts';
import {
  isGitHubTooLargeError,
  readGitHubContentEntry,
  readGitHubDirectoryEntries,
  readGitHubErrorMessage,
} from '../github-response.ts';
import { formatMaxDataLimitMb, measureUtf8Bytes } from '../../core/limits.ts';
import {
  hashContent,
  redactSecrets,
} from '../persistent-store-utils.ts';
import type {
  CatalogManifest,
  CatalogRecord,
  DerivedProfileDocument,
} from '../persistent-store-types.ts';
import type { CinemaKunyeDocument } from '../../core/cinema-kunye.ts';
import type { DataDocument } from '../../core/cinetrack-core.ts';
import type {
  SyncErrorRecord,
  SyncFileInspection,
  SyncSideSummary,
} from '../../core/sync-display.ts';

export interface RemoteInspectionHost {
  deps: BidirectionalSyncDependencies;
  readonly maxBytes: number;
  fetchGitBlobBySha: (
    sha: string,
    owner: string,
    repo: string,
    token: string
  ) => Promise<{ ok: true; content: string } | { ok: false; error: SyncErrorRecord }>;
}

export async function fetchRemoteFileRaw(
    host: RemoteInspectionHost,
    repoPath: string,
    cfg: { token: string; owner: string; repo: string; branch: string }
  ): Promise<
    | { ok: true; exists: false }
    | { ok: true; exists: true; content: string; sha: string }
    | { ok: false; error: SyncErrorRecord }
  > {
    const apiUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${repoPath}?ref=${encodeURIComponent(
      cfg.branch
    )}`;
    const makeHeaders = (tok: string) => ({
      Authorization: `Bearer ${tok}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Cinethos-Sync-Agent',
    });

    try {
      let res = await githubFetch(apiUrl, { headers: makeHeaders(cfg.token) });
      if (res.status === 401 && typeof host.deps.store.recoverGitHubTokenOn401 === 'function') {
        const recovered = await host.deps.store.recoverGitHubTokenOn401(cfg.token);
        if (recovered) {
          cfg.token = recovered;
          res = await githubFetch(apiUrl, { headers: makeHeaders(cfg.token) });
        }
      }
      if (res.status === 404) {
        // Yalnızca HTTP 404 dosya mevcut değil anlamına gelir
        return { ok: true, exists: false };
      }

      if (res.status === 403) {
        const errBody: unknown = await res.json().catch(() => ({}));
        const rawMsg = readGitHubErrorMessage(errBody);
        const isTooLarge = isGitHubTooLargeError(errBody);

        if (isTooLarge) {
          // >1 MB dosyalarda Contents API too_large döndürürse üst dizinden SHA bulup Git Blob API ile indir
          const parentDir = path.posix.dirname(repoPath);
          const baseName = path.posix.basename(repoPath);
          const dirUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${parentDir}?ref=${encodeURIComponent(
            cfg.branch
          )}`;
          const dirRes = await githubFetch(dirUrl, { headers: makeHeaders(cfg.token) });
          if (dirRes.status === 200) {
            const list = readGitHubDirectoryEntries(await dirRes.json().catch(() => null));
            if (list) {
              const entry = list.find((it) => it.name === baseName && typeof it.sha === 'string');
              if (entry) {
                if (entry.size !== undefined && entry.size > host.maxBytes) {
                  return {
                    ok: false,
                    error: {
                      repoPath,
                      category: 'payload_too_large',
                      message: `${repoPath}: Uzak dosya boyutu izin verilen sınırı (${formatMaxDataLimitMb(
                        host.maxBytes
                      )}) aşıyor.`,
                    },
                  };
                }
                const blobRes = await host.fetchGitBlobBySha(
                  entry.sha as string,
                  cfg.owner,
                  cfg.repo,
                  cfg.token
                );
                if (!blobRes.ok) {
                  return {
                    ok: false,
                    error: { ...blobRes.error, repoPath },
                  };
                }
                return { ok: true, exists: true, content: blobRes.content, sha: entry.sha as string };
              }
            }
          }
        }

        const category = classifyGitHubHttpStatus(res.status, res.headers, rawMsg);
        return {
          ok: false,
          error: {
            repoPath,
            category,
            status: res.status,
            message: redactSecrets(
              `${repoPath}: GitHub okuma reddedildi (${category}, HTTP 403)${
                rawMsg ? ` - ${rawMsg}` : ''
              }`,
              [cfg.token]
            ),
          },
        };
      }

      if (res.status !== 200) {
        const errBody: unknown = await res.json().catch(() => ({}));
        const rawMsg = readGitHubErrorMessage(errBody);
        const category = classifyGitHubHttpStatus(res.status, res.headers, rawMsg);
        return {
          ok: false,
          error: {
            repoPath,
            category,
            status: res.status,
            message: redactSecrets(
              `${repoPath}: GitHub okuma hatası (${category}, HTTP ${res.status})${
                rawMsg ? ` - ${rawMsg}` : ''
              }`,
              [cfg.token]
            ),
          },
        };
      }

      let fileData: ReturnType<typeof readGitHubContentEntry> = null;
      try {
        fileData = readGitHubContentEntry(await res.json());
      } catch {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'malformed_response',
            message: `${repoPath}: GitHub API yanıt zarfı geçerli JSON değil.`,
          },
        };
      }

      if (!fileData) {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'malformed_response',
            message: `${repoPath}: GitHub yanıtında geçerli SHA alanı eksik.`,
          },
        };
      }

      if (fileData.size !== undefined && fileData.size > host.maxBytes) {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'payload_too_large',
            message: `${repoPath}: Uzak dosya boyutu (${fileData.size} bayt) izin verilen sınırı (${formatMaxDataLimitMb(
              host.maxBytes
            )}) aşıyor.`,
          },
        };
      }

      let decodedContent: string | undefined;
      if (
        typeof fileData.content === 'string' &&
        fileData.content.length > 0 &&
        fileData.encoding !== 'none'
      ) {
        decodedContent = Buffer.from(fileData.content.replace(/\s+/g, ''), 'base64').toString(
          'utf8'
        );
      } else if (fileData.size === 0 && fileData.content === '') {
        decodedContent = '';
      } else {
        // >1 MB dosyalarda Contents API content="" ve encoding="none" döndürür; Git Blob API ile indir
        const blobRes = await host.fetchGitBlobBySha(
          fileData.sha,
          cfg.owner,
          cfg.repo,
          cfg.token
        );
        if (blobRes.ok) {
          decodedContent = blobRes.content;
        } else if (
          typeof fileData.downloadUrl === 'string' &&
          fileData.downloadUrl.startsWith('https://')
        ) {
          const dlRes = await githubFetch(fileData.downloadUrl, {
            headers: {
              Authorization: `Bearer ${cfg.token}`,
              'User-Agent': 'Cinethos-Sync-Agent',
            },
          });
          if (dlRes.status === 200) {
            decodedContent = await dlRes.text();
          } else {
            return { ok: false, error: { ...blobRes.error, repoPath } };
          }
        } else {
          return { ok: false, error: { ...blobRes.error, repoPath } };
        }
      }

      if (decodedContent === undefined || ((fileData.size ?? 0) > 0 && decodedContent.length === 0)) {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'malformed_response',
            message: `${repoPath}: Uzak dosya içeriği eksik veya kesilmiş döndü.`,
          },
        };
      }

      if (measureUtf8Bytes(decodedContent) > host.maxBytes) {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'payload_too_large',
            message: `${repoPath}: İndirilen UTF-8 boyutu sınırı (${formatMaxDataLimitMb(
              host.maxBytes
            )}) aşıyor.`,
          },
        };
      }

      return { ok: true, exists: true, content: decodedContent, sha: fileData.sha };
    } catch (err: any) {
      return {
        ok: false,
        error: {
          repoPath,
          category: 'network_error',
          message: redactSecrets(
            `${repoPath}: GitHub ağ bağlantı hatası - ${err?.message || 'bağlantı kurulamadı'}`,
            [cfg.token]
          ),
        },
      };
    }
  }

export async function listRemoteProfilePaths(
    host: RemoteInspectionHost,
    cfg: { token: string; owner: string; repo: string; branch: string },
    localHintPaths: string[]
  ): Promise<{ ok: true; paths: string[] } | { ok: false; error: SyncErrorRecord }> {
    const dirUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/data/profiles?ref=${encodeURIComponent(
      cfg.branch
    )}`;
    try {
      let res = await githubFetch(dirUrl, {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Cinethos-Sync-Agent',
        },
      });
      if (res.status === 401 && typeof host.deps.store.recoverGitHubTokenOn401 === 'function') {
        const recovered = await host.deps.store.recoverGitHubTokenOn401(cfg.token);
        if (recovered) {
          cfg.token = recovered;
          res = await githubFetch(dirUrl, {
            headers: {
              Authorization: `Bearer ${cfg.token}`,
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'Cinethos-Sync-Agent',
            },
          });
        }
      }

      if (res.status === 404) {
        // Dizin listesi yoksa veya mock ortamında yalnızca tekil dosya uçları tanımlıysa yerel ipuçlarını da yokla
        return { ok: true, paths: [...localHintPaths] };
      }

      if (res.status !== 200) {
        const errBody: unknown = await res.json().catch(() => ({}));
        const rawMsg = readGitHubErrorMessage(errBody);
        const category = classifyGitHubHttpStatus(res.status, res.headers, rawMsg);
        return {
          ok: false,
          error: {
            repoPath: 'data/profiles',
            category,
            status: res.status,
            message: redactSecrets(
              `data/profiles dizini okunamadı (${category}, HTTP ${res.status})${
                rawMsg ? ` - ${rawMsg}` : ''
              }`,
              [cfg.token]
            ),
          },
        };
      }

      const data = readGitHubDirectoryEntries(await res.json().catch(() => null));
      if (!data) {
        return { ok: true, paths: [...localHintPaths] };
      }

      const discovered = new Set<string>(localHintPaths);
      for (const item of data) {
        if (
          (item.type === 'file' || !item.type) &&
          /^[a-zA-Z0-9_-]+\.json$/.test(item.name)
        ) {
          discovered.add(`data/profiles/${item.name}`);
        }
      }

      return {
        ok: true,
        paths: Array.from(discovered).sort((a, b) => a.localeCompare(b)),
      };
    } catch (err: any) {
      return {
        ok: false,
        error: {
          repoPath: 'data/profiles',
          category: 'network_error',
          message: redactSecrets(
            `data/profiles ağ hatası: ${err?.message || 'bağlantı kurulamadı'}`,
            [cfg.token]
          ),
        },
      };
    }
  }

export async function inspectRemoteSide(
    host: RemoteInspectionHost,
    cfg: { token: string; owner: string; repo: string; branch: string },
    options: {
      includePersonalFiles: boolean;
      includeCatalogFiles?: boolean;
      localProfilePaths: string[];
    }
  ): Promise<{
    bundle: ParsedSideBundle;
    rawRemoteContents: Record<string, { content: string; sha: string }>;
    transportFailed: boolean;
  }> {
    const includeCatalog = options.includeCatalogFiles !== false;
    const inspectedAt = new Date().toISOString();
    const files: Record<string, SyncFileInspection> = {};
    const errors: SyncErrorRecord[] = [];
    const rawRemoteContents: Record<string, { content: string; sha: string }> = {};
    let transportFailed = false;

    let movies: Record<string, CatalogRecord> = {};
    let tv: Record<string, CatalogRecord> = {};
    let manifest: CatalogManifest | null = null;
    let userData: DataDocument | null = null;
    let cinemaKunye: CinemaKunyeDocument | null = null;
    const derivedProfiles: Record<string, DerivedProfileDocument> = {};

    let manifestValid = true;
    let manifestMismatchReason: string | undefined;

    if (includeCatalog) {
      // 1. movies.json
      const moviesRes = await fetchRemoteFileRaw(host, 'data/catalog/movies.json', cfg);
      if (!moviesRes.ok) {
        transportFailed = true;
        errors.push(moviesRes.error);
        files['data/catalog/movies.json'] = {
          repoPath: 'data/catalog/movies.json',
          category: 'catalog_movies',
          personal: false,
          exists: false,
          valid: false,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
          error: moviesRes.error.message,
          errorCategory: moviesRes.error.category,
        };
      } else if (!moviesRes.exists) {
        files['data/catalog/movies.json'] = {
          repoPath: 'data/catalog/movies.json',
          category: 'catalog_movies',
          personal: false,
          exists: false,
          valid: true,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
        };
      } else {
        rawRemoteContents['data/catalog/movies.json'] = {
          content: moviesRes.content,
          sha: moviesRes.sha,
        };
        const inspected = inspectCatalogRawContent(
          'data/catalog/movies.json',
          moviesRes.content,
          'movie',
          host.maxBytes,
          moviesRes.sha
        );
        files['data/catalog/movies.json'] = inspected.inspection;
        if (inspected.parsedMap) movies = inspected.parsedMap;
        if (!inspected.inspection.valid && inspected.inspection.error) {
          errors.push({
            repoPath: 'data/catalog/movies.json',
            category: inspected.inspection.errorCategory || 'corrupt_remote_json',
            message: `data/catalog/movies.json: ${inspected.inspection.error}`,
          });
        }
      }

      // 2. tv.json
      const tvRes = await fetchRemoteFileRaw(host, 'data/catalog/tv.json', cfg);
      if (!tvRes.ok) {
        transportFailed = true;
        errors.push(tvRes.error);
        files['data/catalog/tv.json'] = {
          repoPath: 'data/catalog/tv.json',
          category: 'catalog_tv',
          personal: false,
          exists: false,
          valid: false,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
          error: tvRes.error.message,
          errorCategory: tvRes.error.category,
        };
      } else if (!tvRes.exists) {
        files['data/catalog/tv.json'] = {
          repoPath: 'data/catalog/tv.json',
          category: 'catalog_tv',
          personal: false,
          exists: false,
          valid: true,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
        };
      } else {
        rawRemoteContents['data/catalog/tv.json'] = { content: tvRes.content, sha: tvRes.sha };
        const inspected = inspectCatalogRawContent(
          'data/catalog/tv.json',
          tvRes.content,
          'tv',
          host.maxBytes,
          tvRes.sha
        );
        files['data/catalog/tv.json'] = inspected.inspection;
        if (inspected.parsedMap) tv = inspected.parsedMap;
        if (!inspected.inspection.valid && inspected.inspection.error) {
          errors.push({
            repoPath: 'data/catalog/tv.json',
            category: inspected.inspection.errorCategory || 'corrupt_remote_json',
            message: `data/catalog/tv.json: ${inspected.inspection.error}`,
          });
        }
      }

      // 3. manifest.json
      const manifestRes = await fetchRemoteFileRaw(host, 'data/catalog/manifest.json', cfg);
      if (!manifestRes.ok) {
        transportFailed = true;
        errors.push(manifestRes.error);
        manifestValid = false;
        files['data/catalog/manifest.json'] = {
          repoPath: 'data/catalog/manifest.json',
          category: 'catalog_manifest',
          personal: false,
          exists: false,
          valid: false,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
          error: manifestRes.error.message,
          errorCategory: manifestRes.error.category,
        };
      } else if (!manifestRes.exists) {
        const hasRemoteCatalog = Object.keys(movies).length > 0 || Object.keys(tv).length > 0;
        manifestValid = !hasRemoteCatalog;
        manifestMismatchReason = hasRemoteCatalog
          ? "GitHub'da katalog dosyaları mevcut ancak manifest.json eksik"
          : undefined;
        files['data/catalog/manifest.json'] = {
          repoPath: 'data/catalog/manifest.json',
          category: 'catalog_manifest',
          personal: false,
          exists: false,
          valid: !hasRemoteCatalog,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
          ...(hasRemoteCatalog
            ? {
                error: manifestMismatchReason,
                errorCategory: 'schema_mismatch' as const,
              }
            : {}),
        };
      } else {
        rawRemoteContents['data/catalog/manifest.json'] = {
          content: manifestRes.content,
          sha: manifestRes.sha,
        };
        const inspected = inspectManifestRawContent(
          manifestRes.content,
          movies,
          tv,
          host.maxBytes,
          manifestRes.sha
        );
        files['data/catalog/manifest.json'] = inspected.inspection;
        manifest = inspected.manifest || null;
        manifestValid = inspected.manifestConsistent;
        manifestMismatchReason = inspected.mismatchReason;
      }
    }

    // 4. Kişisel veriler (yalnızca özel depoda okunur/yazılır)
    let userRawItems = 0;
    let userUniqueItems = 0;
    let derivedRecordsTotal = 0;

    if (options.includePersonalFiles) {
      const userRes = await fetchRemoteFileRaw(host, 'data/cinetrack-data.json', cfg);
      if (!userRes.ok) {
        transportFailed = true;
        errors.push(userRes.error);
        files['data/cinetrack-data.json'] = {
          repoPath: 'data/cinetrack-data.json',
          category: 'user_data',
          personal: true,
          exists: false,
          valid: false,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
          error: userRes.error.message,
          errorCategory: userRes.error.category,
        };
      } else if (!userRes.exists) {
        files['data/cinetrack-data.json'] = {
          repoPath: 'data/cinetrack-data.json',
          category: 'user_data',
          personal: true,
          exists: false,
          valid: true,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
        };
      } else {
        rawRemoteContents['data/cinetrack-data.json'] = {
          content: userRes.content,
          sha: userRes.sha,
        };
        const inspected = inspectUserDataRawContent(
          userRes.content,
          host.maxBytes,
          userRes.sha
        );
        files['data/cinetrack-data.json'] = inspected.inspection;
        if (inspected.doc) userData = inspected.doc;
        userRawItems = inspected.rawItemsCount;
        userUniqueItems = inspected.uniqueItemsCount;
        if (!inspected.inspection.valid && inspected.inspection.error) {
          errors.push({
            repoPath: 'data/cinetrack-data.json',
            category: inspected.inspection.errorCategory || 'corrupt_remote_json',
            message: `data/cinetrack-data.json: ${inspected.inspection.error}`,
          });
        }
      }

      const stockRes = await fetchRemoteFileRaw(host, 'data/stock.json', cfg);
      if (!stockRes.ok) {
        transportFailed = true;
        errors.push(stockRes.error);
        files['data/stock.json'] = {
          repoPath: 'data/stock.json',
          category: 'stock',
          personal: true,
          exists: false,
          valid: false,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
          error: stockRes.error.message,
          errorCategory: stockRes.error.category,
        };
      } else if (!stockRes.exists) {
        files['data/stock.json'] = {
          repoPath: 'data/stock.json',
          category: 'stock',
          personal: true,
          exists: false,
          valid: true,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
        };
      } else {
        rawRemoteContents['data/stock.json'] = { content: stockRes.content, sha: stockRes.sha };
        const inspected = inspectStockRawContent(stockRes.content, host.maxBytes, stockRes.sha);
        files['data/stock.json'] = inspected.inspection;
        if (!inspected.inspection.valid && inspected.inspection.error) {
          errors.push({
            repoPath: 'data/stock.json',
            category: inspected.inspection.errorCategory || 'corrupt_remote_json',
            message: `data/stock.json: ${inspected.inspection.error}`,
          });
        }
      }

      const kunyeRes = await fetchRemoteFileRaw(host, 'data/sinema-kunyesi.json', cfg);
      if (!kunyeRes.ok) {
        transportFailed = true;
        errors.push(kunyeRes.error);
        files['data/sinema-kunyesi.json'] = {
          repoPath: 'data/sinema-kunyesi.json',
          category: 'cinema_kunye',
          personal: true,
          exists: false,
          valid: false,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
          error: kunyeRes.error.message,
          errorCategory: kunyeRes.error.category,
        };
      } else if (!kunyeRes.exists) {
        files['data/sinema-kunyesi.json'] = {
          repoPath: 'data/sinema-kunyesi.json',
          category: 'cinema_kunye',
          personal: true,
          exists: false,
          valid: true,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
        };
      } else {
        rawRemoteContents['data/sinema-kunyesi.json'] = {
          content: kunyeRes.content,
          sha: kunyeRes.sha,
        };
        const inspected = inspectCinemaKunyeRawContent(
          kunyeRes.content,
          host.maxBytes,
          kunyeRes.sha
        );
        files['data/sinema-kunyesi.json'] = inspected.inspection;
        if (inspected.doc) cinemaKunye = inspected.doc;
        if (!inspected.inspection.valid && inspected.inspection.error) {
          errors.push({
            repoPath: 'data/sinema-kunyesi.json',
            category: inspected.inspection.errorCategory || 'corrupt_remote_json',
            message: `data/sinema-kunyesi.json: ${inspected.inspection.error}`,
          });
        }
      }

      const dirListRes = await listRemoteProfilePaths(host, cfg, options.localProfilePaths);
      if (!dirListRes.ok) {
        transportFailed = true;
        errors.push(dirListRes.error);
      } else {
        for (const repoPath of dirListRes.paths) {
          const profRes = await fetchRemoteFileRaw(host, repoPath, cfg);
          if (!profRes.ok) {
            transportFailed = true;
            errors.push(profRes.error);
            files[repoPath] = {
              repoPath,
              category: 'derived_profile',
              personal: true,
              exists: false,
              valid: false,
              sizeBytes: 0,
              rawFileHash: null,
              semanticHash: null,
              recordCount: 0,
              uniqueKeyCount: 0,
              error: profRes.error.message,
              errorCategory: profRes.error.category,
            };
          } else if (profRes.exists) {
            rawRemoteContents[repoPath] = { content: profRes.content, sha: profRes.sha };
            const inspected = inspectDerivedProfileRawContent(
              repoPath,
              profRes.content,
              host.maxBytes,
              profRes.sha
            );
            files[repoPath] = inspected.inspection;
            if (inspected.doc) {
              derivedProfiles[repoPath] = inspected.doc;
              derivedRecordsTotal += inspected.inspection.uniqueKeyCount;
            } else if (inspected.inspection.error) {
              errors.push({
                repoPath,
                category: inspected.inspection.errorCategory || 'corrupt_remote_json',
                message: `${repoPath}: ${inspected.inspection.error}`,
              });
            }
          }
        }
      }
    }

    const catalogContentHash = computeCatalogManifestContentHash(movies, tv);
    const catalogSemanticHash = hashContent(
      computeCatalogSemanticMapHash(movies) + computeCatalogSemanticMapHash(tv)
    );

    const summary: SyncSideSummary = {
      inspectedAt,
      catalogMovieCount: Object.keys(movies).length,
      catalogTvCount: Object.keys(tv).length,
      catalogRawMovieRecords: files['data/catalog/movies.json']?.recordCount ?? 0,
      catalogRawTvRecords: files['data/catalog/tv.json']?.recordCount ?? 0,
      catalogContentHash,
      catalogSemanticHash,
      manifestPresent: Boolean(files['data/catalog/manifest.json']?.exists),
      manifestValid,
      manifestMovieCount: manifest ? Number(manifest.movieCount) : null,
      manifestTvCount: manifest ? Number(manifest.tvCount) : null,
      manifestContentHash: manifest?.contentHash || null,
      ...(manifestMismatchReason ? { manifestMismatchReason } : {}),
      userDataPresent: Boolean(files['data/cinetrack-data.json']?.exists),
      userProfilesCount: userData?.profiles?.length ?? 0,
      userTotalSavedItemsCount: userRawItems,
      userUniqueSavedItemsCount: userUniqueItems,
      userDataSemanticHash: files['data/cinetrack-data.json']?.semanticHash ?? null,
      userDataRawHash: files['data/cinetrack-data.json']?.rawFileHash ?? null,
      derivedProfileFilesCount: Object.keys(derivedProfiles).length,
      derivedProfileTotalRecordsCount: derivedRecordsTotal,
      files,
    };

    return {
      bundle: { summary, movies, tv, manifest, userData, cinemaKunye, derivedProfiles, errors },
      rawRemoteContents,
      transportFailed,
    };
  }

