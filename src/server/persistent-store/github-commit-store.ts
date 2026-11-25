/**
 * F5.3-02 — GitHub commit sorumluluğu (Contents API yazma hattı).
 *
 * `commitFileToGitHub` (+ `fetchBlobTextBySha`/`fetchBlobBufferBySha` blob
 * yardımcıları) gövdeleri `persistent-store.ts` içinden buraya taşındı: SHA
 * çakışma yönetimi, 401 token kurtarma, 3 denemeli sınırlı yeniden deneme,
 * hata sınıflandırma, gizli bilgi maskeleme, yazma sonrası geri okuma ve hash
 * doğrulaması (>1 MB dosyalarda Git Blob API) birebir korunur. Modül
 * `GitHubCommitContext` içindeki dar bağlam dışında depolama durumuna
 * erişmez; senkron durum geçişleri (fileStates, journal vb.) facade'da kalır.
 */

import path from 'node:path';
import { BRAND_SYNC_USER_AGENT } from '../../shared/brand.ts';
import {
  findGitHubDirectoryEntry,
  isGitHubTooLargeError,
  readGitHubCommittedSha,
  readGitHubErrorMessage,
  readGitHubFileEnvelope,
} from '../github-response.ts';
import {
  classifyHttpFailure,
  isPlainRecordObject,
  type GitHubSyncErrorCategory,
} from './contracts.ts';
import { errorMessageOf, hashContent, redactSecrets } from '../persistent-store-utils.ts';

export interface RemoteRepoRef {
  token: string | undefined;
  owner: string | undefined;
  repo: string | undefined;
}

export interface GitHubCommitContext extends RemoteRepoRef {
  branch: string;
  /** Token gizliliğinin maskelemeye eklenmesi için bilinen sır listesi. */
  getKnownSecretsForRedaction(): string[];
  /** 401 reddinde geçerli token kurtarma; başarıda string, başarısızlıkta null. */
  recoverGitHubTokenOn401(failedToken?: string): Promise<string | null>;
  fetchBlobTextBySha(sha: string): Promise<string | null>;
}

export interface GitHubCommitOutcome {
  ok: boolean;
  sha?: string;
  readBackHash?: string;
  error?: string;
  errorCategory?: GitHubSyncErrorCategory;
  skippedNoop?: boolean;
  verifiedReadBack?: boolean;
}

export async function fetchBlobTextByShaImpl(ctx: RemoteRepoRef, sha: string): Promise<string | null> {
  if (!ctx.token || !ctx.owner || !ctx.repo || !sha) return null;
  const blobUrl = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/git/blobs/${encodeURIComponent(
    sha
  )}`;
  try {
    const res = await fetch(blobUrl, {
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': BRAND_SYNC_USER_AGENT,
      },
    });
    if (res.status !== 200) return null;
    const envelope = readGitHubFileEnvelope(await res.json().catch(() => null));
    if (envelope?.content !== undefined && envelope.encoding === 'base64') {
      return Buffer.from(envelope.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchBlobBufferByShaImpl(ctx: RemoteRepoRef, sha: string): Promise<Buffer | null> {
  if (!ctx.token || !ctx.owner || !ctx.repo || !sha) return null;
  const blobUrl = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/git/blobs/${encodeURIComponent(
    sha
  )}`;
  try {
    const res = await fetch(blobUrl, {
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': BRAND_SYNC_USER_AGENT,
      },
    });
    if (res.status !== 200) return null;
    const envelope = readGitHubFileEnvelope(await res.json().catch(() => null));
    if (envelope?.content !== undefined && envelope.encoding === 'base64') {
      return Buffer.from(envelope.content.replace(/\s+/g, ''), 'base64');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Commit a file to GitHub via Contents API with SHA conflict management,
 * bounded retry, error classification, read-back hash verification (>1 MB Git Blob dahil), and token redaction.
 */
export async function commitFileToGitHubImpl(
  ctx: GitHubCommitContext,
  repoPath: string,
  contentString: string,
  commitMessage: string,
  options?: { isEmptyRepo?: boolean; branchToUse?: string }
): Promise<GitHubCommitOutcome> {
  if (!ctx.token || !ctx.owner || !ctx.repo) {
    return {
      ok: false,
      error: 'GitHub senkronizasyon yapılandırması eksik.',
      errorCategory: 'config_error',
    };
  }

  const apiUrl = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/contents/${repoPath}`;
  const makeAuthHeaders = (tok: string) => ({
    Authorization: `Bearer ${tok}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': BRAND_SYNC_USER_AGENT,
  });
  const targetBranch = options?.branchToUse || ctx.branch;
  const isEmptyRepo = Boolean(options?.isEmptyRepo);

  let remoteSha: string | undefined;
  let remoteContent: string | undefined;

  // 1. Fetch current remote file SHA & content (skip ref param if empty repo)
  if (!isEmptyRepo) {
    try {
      let usedGetToken = ctx.token;
      let getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(targetBranch)}`, {
        headers: makeAuthHeaders(usedGetToken),
      });
      if (getRes.status === 401) {
        const recovered = await ctx.recoverGitHubTokenOn401(usedGetToken);
        if (recovered) {
          usedGetToken = recovered;
          getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(targetBranch)}`, {
            headers: makeAuthHeaders(usedGetToken),
          });
        }
      }
      if (getRes.status === 200) {
        let fileData: unknown = null;
        try {
          fileData = await getRes.json();
        } catch {
          return {
            ok: false,
            error: 'GitHub dosya okuma yanıtı geçerli JSON değil.',
            errorCategory: 'malformed_response',
          };
        }
        const fileEnvelope = readGitHubFileEnvelope(fileData);
        if (!fileEnvelope?.sha) {
          return {
            ok: false,
            error: 'GitHub dosya yanıtında geçerli SHA alanı bulunamadı.',
            errorCategory: 'malformed_response',
          };
        }
        remoteSha = fileEnvelope.sha;
        if (
          fileEnvelope.content !== undefined &&
          fileEnvelope.encoding !== 'none' &&
          (fileEnvelope.content.length > 0 || fileEnvelope.size === 0)
        ) {
          remoteContent = Buffer.from(fileEnvelope.content.replace(/\s+/g, ''), 'base64').toString('utf8');
        } else if (remoteSha) {
          const blobText = await ctx.fetchBlobTextBySha(remoteSha);
          if (blobText !== null) remoteContent = blobText;
        }
      } else if (getRes.status === 403) {
        const errBody = await getRes.json().catch(() => ({}));
        const rawMsg = readGitHubErrorMessage(errBody);
        const isTooLarge = isGitHubTooLargeError(errBody);
        if (isTooLarge) {
          const parentDir = path.posix.dirname(repoPath);
          const baseName = path.posix.basename(repoPath);
          const dirRes = await fetch(
            `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/contents/${parentDir}?ref=${encodeURIComponent(
              targetBranch
            )}`,
            { headers: makeAuthHeaders(ctx.token) }
          );
          if (dirRes.status === 200) {
            const found = findGitHubDirectoryEntry(
              await dirRes.json().catch(() => null),
              baseName
            );
            if (found?.sha) {
              remoteSha = found.sha;
              const blobText = await ctx.fetchBlobTextBySha(found.sha);
              if (blobText !== null) remoteContent = blobText;
            }
          }
        }
        if (!remoteSha) {
          const category = classifyHttpFailure(getRes.status, getRes.headers, rawMsg);
          return {
            ok: false,
            error: redactSecrets(
              `GitHub okuma hatası (${category}): HTTP ${getRes.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
              ctx.getKnownSecretsForRedaction()
            ),
            errorCategory: category,
          };
        }
      } else if (getRes.status !== 404) {
        const errBody = await getRes.json().catch(() => ({}));
        const rawMsg = readGitHubErrorMessage(errBody);
        const category = classifyHttpFailure(getRes.status, getRes.headers, rawMsg);
        return {
          ok: false,
          error: redactSecrets(
            `GitHub okuma hatası (${category}): HTTP ${getRes.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
            ctx.getKnownSecretsForRedaction()
          ),
          errorCategory: category,
        };
      }
    } catch (e) {
      return {
        ok: false,
        error: redactSecrets(
          `GitHub ağ bağlantı hatası: ${errorMessageOf(e, 'bağlantı kurulamadı')}`,
          ctx.getKnownSecretsForRedaction()
        ),
        errorCategory: 'network_error',
      };
    }
  }

  // 2. Prevent no-op commit if content is identical
  if (remoteContent !== undefined && remoteContent.trim() === contentString.trim()) {
    return {
      ok: true,
      sha: remoteSha,
      readBackHash: hashContent(remoteContent.trim()),
      skippedNoop: true,
      verifiedReadBack: true,
    };
  }

  // 3. Put content (with bounded retry up to 3 attempts on 409 conflict, 401 token failover, or transient network error)
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const activePutToken = ctx.token || '';
    const baseHeaders = makeAuthHeaders(activePutToken);
    const payload: Record<string, unknown> = {
      message: commitMessage,
      content: Buffer.from(contentString, 'utf8').toString('base64'),
    };
    // Boş depolarda ilk commit'te branch verilmez; GitHub varsayılan dalı başlatır
    if (!isEmptyRepo) {
      payload.branch = targetBranch;
    }
    if (remoteSha) payload.sha = remoteSha;

    try {
      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (putRes.status === 401 && attempt < maxAttempts) {
        const recovered = await ctx.recoverGitHubTokenOn401(activePutToken);
        if (recovered) {
          continue;
        }
      }

      if (putRes.status === 200 || putRes.status === 201) {
        let resData: unknown = null;
        try {
          resData = await putRes.json();
        } catch {
          return {
            ok: false,
            error: 'GitHub yazma yanıtı geçerli JSON değil.',
            errorCategory: 'malformed_response',
          };
        }
        if (!isPlainRecordObject(resData)) {
          return {
            ok: false,
            error: 'GitHub yazma yanıtı beklenmeyen biçimde döndü.',
            errorCategory: 'malformed_response',
          };
        }
        const committedSha = readGitHubCommittedSha(resData) || remoteSha;

        // 4. Yazma sonrası GitHub'dan geri okuma ve içerik hash doğrulaması (>1 MB dosyalarda Git Blob API ile)
        const expectedHash = hashContent(contentString.trim());
        let readBackHash: string | undefined;
        let verifiedReadBack = false;
        try {
          const verifyRefParam = encodeURIComponent(targetBranch);
          const readBackRes = await fetch(`${apiUrl}?ref=${verifyRefParam}`, {
            headers: baseHeaders,
          });
          let readBackText: string | null = null;
          if (readBackRes.status === 200) {
            const readBackData = await readBackRes.json().catch(() => null);
            if (
              readBackData &&
              typeof readBackData.content === 'string' &&
              readBackData.encoding !== 'none' &&
              (readBackData.content.length > 0 || readBackData.size === 0)
            ) {
              readBackText = Buffer.from(
                readBackData.content.replace(/\s+/g, ''),
                'base64'
              ).toString('utf8');
            } else if (committedSha) {
              readBackText = await ctx.fetchBlobTextBySha(committedSha);
            }
          } else if (readBackRes.status === 403 && committedSha) {
            readBackText = await ctx.fetchBlobTextBySha(committedSha);
          }

          if (readBackText !== null) {
            readBackHash = hashContent(readBackText.trim());
            if (readBackHash !== expectedHash) {
              return {
                ok: false,
                readBackHash,
                verifiedReadBack: false,
                error: `${repoPath}: Yazma sonrası hash doğrulaması başarısız oldu (GitHub özeti: ${readBackHash.slice(
                  0,
                  8
                )}, beklenen yerel özet: ${expectedHash.slice(0, 8)}).`,
                errorCategory: 'conflict',
              };
            }
            verifiedReadBack = true;
          } else if (committedSha) {
            verifiedReadBack = true;
          }
        } catch {
          if (committedSha) verifiedReadBack = true;
        }

        return {
          ok: true,
          sha: committedSha,
          verifiedReadBack,
          ...(readBackHash ? { readBackHash } : {}),
        };
      }

      if (putRes.status === 409) {
        if (attempt < maxAttempts) {
          const refetch = await fetch(`${apiUrl}?ref=${encodeURIComponent(targetBranch)}`, {
            headers: baseHeaders,
          });
          if (refetch.status === 200) {
            const refetchedData = await refetch.json().catch(() => null);
            if (refetchedData && typeof refetchedData.sha === 'string') {
              remoteSha = refetchedData.sha;
              if (typeof refetchedData.content === 'string' && refetchedData.encoding !== 'none') {
                const latestRemote = Buffer.from(
                  refetchedData.content.replace(/\s+/g, ''),
                  'base64'
                ).toString('utf8');
                if (latestRemote.trim() === contentString.trim()) {
                  return {
                    ok: true,
                    sha: remoteSha,
                    readBackHash: hashContent(latestRemote.trim()),
                    skippedNoop: true,
                    verifiedReadBack: true,
                  };
                }
              }
              continue;
            }
          }
        }
        return {
          ok: false,
          error: `GitHub SHA çakışması (HTTP 409): ${maxAttempts} deneme sonunda giderilemedi.`,
          errorCategory: 'conflict',
        };
      }

      const errJson = await putRes.json().catch(() => ({}));
      const rawErrDetail = String(errJson?.message || '');
      const acceptedPerms = putRes.headers.get('x-accepted-github-permissions');
      const category = classifyHttpFailure(putRes.status, putRes.headers, rawErrDetail);
      let errDetail = rawErrDetail;
      if (
        putRes.status === 403 &&
        rawErrDetail.toLowerCase().includes('resource not accessible by personal access token')
      ) {
        errDetail += ` (Kişisel Erişim Anahtarının (Fine-grained PAT) '${ctx.owner}/${ctx.repo}' deposu için 'Contents: Read and write' iznine sahip olduğunu doğrulayın${
          acceptedPerms ? `; beklenen izin: ${acceptedPerms}` : ''
        })`;
      }
      return {
        ok: false,
        error: redactSecrets(
          `GitHub yazma reddedildi (${category}): HTTP ${putRes.status}${
            errDetail ? ` - ${errDetail}` : ''
          }`,
          ctx.getKnownSecretsForRedaction()
        ),
        errorCategory: category,
      };
    } catch (e) {
      if (attempt === maxAttempts) {
        return {
          ok: false,
          error: redactSecrets(
            `GitHub ağ hatası (${maxAttempts} deneme başarısız): ${errorMessageOf(e, 'bağlantı hatası')}`,
            ctx.getKnownSecretsForRedaction()
          ),
          errorCategory: 'network_error',
        };
      }
    }
  }

  return {
    ok: false,
    error: 'GitHub yazma yeniden deneme sınırı aşıldı.',
    errorCategory: 'conflict',
  };
}
