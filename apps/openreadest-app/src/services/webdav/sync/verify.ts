import { AppService } from '@/types/system';
import { Book, BookConfig } from '@/types/book';
import { CFI } from '@/libs/document';
import { useSettingsStore } from '@/store/settingsStore';
import { WebDavClient } from '../client/WebDavClient';
import { WebDavProfile } from '../models';
import { StatisticsDb } from '@/services/statistics/statisticsDb';
import {
  parseStatisticsSnapshot,
  parseStatisticsSnapshotTolerant,
  REMOTE_STATISTICS_PATH,
} from '@/services/statistics/statisticsSync';
import { getRemoteBookPaths, READEST_WEBDAV_BOOKS_DIR } from './paths';
import { CONFIG_SYNC_PATCH_TAG } from './applyRemoteConfigs';

/**
 * 「同步验证」的只读比对逻辑。
 *
 * 不写任何本地或远端文件、不改动同步状态、不占用 isSyncing 互斥，因此可以在
 * 自动同步进行中安全调用。目的是把「进度不同步」这种模糊现象拆成可判定的
 * 证据：连接是否通、远端有没有这本书的 config.json、两端位置谁更靠后、
 * 阅读统计快照是否合法、事件行数是否一致。
 */

export type VerifyStatus = 'ok' | 'warn' | 'error' | 'info';

export interface VerifyItem {
  label: string;
  status: VerifyStatus;
  detail: string;
  /** 该条目对应的书籍（用于在验证面板里针对单本书强制拉取 / 推送）。 */
  bookHash?: string;
  /** 本地有阅读位置（可用于「推送本机进度」）。 */
  canPush?: boolean;
  /** 远端有阅读位置（可用于「覆盖为远端进度」）。 */
  canPull?: boolean;
}

export interface VerifyReport {
  checkedAt: number;
  server: string;
  items: VerifyItem[];
  summary: string;
  /** 远端 statistics.json 有损坏行，可用 repairRemoteStatistics 修复。 */
  statisticsBroken: boolean;
  /** 两端进度位置不一致的书目数。 */
  mismatchCount: number;
}

const MAX_CHECK_BOOKS = 24;
const CONCURRENCY = 6;

const decode = (data: ArrayBuffer | undefined | null): string | null => {
  if (!data || data.byteLength === 0) return null;
  try {
    return new TextDecoder().decode(data);
  } catch {
    return null;
  }
};

const parseJson = (text: string | null): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const shortCfi = (cfi?: string): string => {
  if (!cfi) return '-';
  const matched = /epubcfi\(([^)]*)\)/.exec(cfi);
  const body = matched ? matched[1]! : cfi;
  return body.length > 42 ? `…${body.slice(-42)}` : body;
};

const formatTime = (ms?: number): string => {
  if (!ms) return '无';
  try {
    const date = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return String(ms);
  }
};

const describePosition = (local: string | undefined, remote: string | undefined): string => {
  if (!local && !remote) return '两端都没有阅读位置（这本书还没被读过）';
  if (!local) return '仅远端有位置（本机打开时会跳到远端）';
  if (!remote) return '仅本地有位置（可在本机推送上去）';
  if (local === remote) return '两端位置完全一致';
  try {
    const cmp = CFI.compare(local, remote);
    if (cmp < 0) return '远端更靠后（打开书应向远端跳转）';
    if (cmp > 0) return '本地更靠后（防回退：不会把本机拉回更前面的位置）';
    return 'CFI 等价';
  } catch {
    return '两端位置不同，CFI 不可比（可能是不同来源的文件）';
  }
};

const countRemoteBooks = (parsed: unknown): number | null => {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { books?: unknown }).books)) {
    return (parsed as { books: unknown[] }).books.length;
  }
  return null;
};

export const verifyWebDavSync = async (
  appService: AppService,
  profile: WebDavProfile,
  books: Book[],
): Promise<VerifyReport> => {
  const items: VerifyItem[] = [];
  const client = new WebDavClient({
    serverUrl: profile.serverUrl,
    rootPath: profile.remotePath,
    username: profile.username,
    password: profile.password,
    allowInsecureHttp: profile.allowInsecureHttp,
    allowInsecureTls: profile.allowInsecureTls,
  });
  const settings = useSettingsStore.getState().settings;
  let statisticsBroken = false;
  let mismatchCount = 0;

  items.push({
    label: '补丁版本',
    status: 'info',
    detail: `${CONFIG_SYNC_PATCH_TAG}（两端都应是这个版本，否则一端还是旧包）`,
  });

  // 1) 连接与远端书库索引
  const libraryPath = `${READEST_WEBDAV_BOOKS_DIR}/library.json`;
  const libraryRes = await client.get(libraryPath);
  if (libraryRes.ok) {
    items.push({ label: 'WebDAV 连接', status: 'ok', detail: '服务器可达，账号可用' });
    const count = countRemoteBooks(parseJson(decode(libraryRes.data)));
    items.push({
      label: '书库索引',
      status: 'info',
      detail:
        count === null
          ? `远端 library.json 可读取（格式未识别）；本地书目 ${books.length} 本`
          : `远端 ${count} 本 / 本地 ${books.length} 本`,
    });
  } else if (libraryRes.status === 404 || libraryRes.status === 410) {
    items.push({
      label: 'WebDAV 连接',
      status: 'warn',
      detail: '服务器可达，但远端还没有 library.json（需要先上传一次书库）',
    });
  } else {
    items.push({
      label: 'WebDAV 连接',
      status: 'error',
      detail: `无法读取远端：${libraryRes.error || String(libraryRes.status)}`,
    });
    items.push({
      label: '后续检查',
      status: 'info',
      detail: '连接失败，跳过逐书与统计检查',
    });
    return {
      checkedAt: Date.now(),
      server: profile.serverUrl,
      items,
      summary: '连接失败：请检查服务器地址、账号密码与网络',
      statisticsBroken: false,
      mismatchCount: 0,
    };
  }

  // 2) 逐书比对 config.json（限制数量与并发，避免大书库拖慢或触发限流）
  const targets = books.slice(0, MAX_CHECK_BOOKS);
  const results: Array<{ book: Book; item: VerifyItem; mismatch: boolean }> = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (book) => {
        const label = book.title || book.hash.slice(0, 12);
        try {
          const res = await client.get(getRemoteBookPaths(book).configFile);
          let localConfig: BookConfig | undefined;
          try {
            localConfig = (await appService.loadBookConfig(book, settings)) ?? undefined;
          } catch {
            localConfig = undefined;
          }
          if (!res.ok) {
            return {
              book,
              mismatch: false,
              item: {
                label,
                status: 'warn' as VerifyStatus,
                detail: `远端无 config.json（HTTP ${res.status}）；本地${localConfig?.location ? '有' : '无'}阅读位置`,
                bookHash: book.hash,
                canPush: !!localConfig?.location,
                canPull: false,
              },
            };
          }
          const remoteConfig = parseJson(decode(res.data)) as BookConfig | null;
          if (!remoteConfig || typeof remoteConfig !== 'object') {
            return {
              book,
              mismatch: false,
              item: { label, status: 'error' as VerifyStatus, detail: '远端 config.json 不是合法 JSON' },
            };
          }
          const localLocation = localConfig?.location;
          const remoteLocation = remoteConfig.location;
          // 先比字符串（快路径）；不同再按 CFI 语义比较——两端跳到同一处时，
          // 序列化形式可能存在无害差异（属性断言、offset 写法），直接比字符串
          // 会把「其实一致」的书报成不一致，让人误判同步失效。
          let same = !!localLocation && !!remoteLocation && localLocation === remoteLocation;
          if (!same && localLocation && remoteLocation) {
            try {
              same = CFI.compare(localLocation, remoteLocation) === 0;
            } catch {
              same = false;
            }
          }
          const bothEmpty = !localLocation && !remoteLocation;
          const detail = [
            describePosition(localLocation, remoteLocation),
            `远端 ${formatTime(remoteConfig.updatedAt)} / 本地 ${formatTime(localConfig?.updatedAt)}`,
            `位置 本地 ${shortCfi(localLocation)} ↔ 远端 ${shortCfi(remoteLocation)}`,
          ].join('；');
          return {
            book,
            // 两端都没读过不算"不一致"：把这类书计进告警会让报告看起来远比实际
            // 严重（51 本书里大部分没读过），掩盖真正有问题的那几本。
            mismatch: !same && !bothEmpty,
            item: {
              label,
              status: same ? ('ok' as VerifyStatus) : bothEmpty ? ('info' as VerifyStatus) : ('warn' as VerifyStatus),
              detail,
              bookHash: book.hash,
              canPush: !!localLocation,
              canPull: !!remoteLocation,
            },
          };
        } catch (error) {
          return {
            book,
            mismatch: false,
            item: {
              label,
              status: 'error' as VerifyStatus,
              detail: '检查失败：' + ((error as Error).message || '未知错误'),
            },
          };
        }
      }),
    );
    results.push(...batchResults);
  }
  mismatchCount = results.filter((r) => r.mismatch).length;
  items.push({
    label: '阅读进度文件',
    status: mismatchCount === 0 ? 'ok' : 'warn',
    detail:
      `检查 ${targets.length} 本：${mismatchCount} 本两端位置不同` +
      `${books.length > targets.length ? `（仅检查前 ${MAX_CHECK_BOOKS} 本）` : ''}`,
  });
  for (const r of results) {
    if (r.item.status !== 'ok') items.push(r.item);
  }

  // 3) 阅读统计快照
  try {
    const res = await client.get(REMOTE_STATISTICS_PATH);
    const text = decode(res.data);
    if (!res.ok || !text) {
      items.push({
        label: '阅读统计',
        status: 'warn',
        detail: res.status === 404 || res.status === 410
          ? '远端还没有 statistics.json（第一次同步后会自动创建）'
          : `远端读取失败：${res.error || String(res.status)}`,
      });
    } else {
      const strict = parseStatisticsSnapshot(text);
      const tolerant = parseStatisticsSnapshotTolerant(text);
      const remoteRows = tolerant.snapshot?.pageStats.length ?? 0;
      const remoteBookCount = tolerant.snapshot
        ? Object.keys(tolerant.snapshot.books).length
        : 0;
      let localRows = -1;
      try {
        const stats = await StatisticsDb.open(appService);
        localRows = (await stats.exportAll()).events.length;
      } catch {
        localRows = -1;
      }
      if (strict.ok) {
        items.push({
          label: '阅读统计',
          status: 'ok',
          detail: `快照合法：远端 ${remoteRows} 条事件 / ${remoteBookCount} 本书；本地 ${localRows >= 0 ? `${localRows} 条事件` : '读取失败'}`,
        });
      } else if (tolerant.ok) {
        statisticsBroken = true;
        items.push({
          label: '阅读统计',
          status: 'error',
          detail: `远端快照有 ${tolerant.skippedRows} 条损坏记录、${tolerant.skippedBooks} 条损坏书目，会永久阻塞统计同步；可用「修复统计文件」处理（原文件会先备份）`,
        });
      } else {
        items.push({
          label: '阅读统计',
          status: 'error',
          detail: tolerant.error || strict.error,
        });
      }
    }
  } catch (error) {
    items.push({
      label: '阅读统计',
      status: 'error',
      detail: '检查失败：' + ((error as Error).message || '未知错误'),
    });
  }

  const errors = items.filter((i) => i.status === 'error').length;
  const warns = items.filter((i) => i.status === 'warn').length;
  const summary = errors > 0
    ? `发现 ${errors} 项错误${statisticsBroken ? '（含统计文件损坏）' : ''}，建议按下方明细处理`
    : mismatchCount > 0
      ? `连接正常；${mismatchCount} 本两端进度不同（明细里可对单本书强制拉取或推送）`
      : warns > 0
        ? `连接正常，仍有 ${warns} 项提示（见下方明细）`
        : '全部检查通过：连接、进度文件与阅读统计均一致';

  return {
    checkedAt: Date.now(),
    server: profile.serverUrl,
    items,
    summary,
    statisticsBroken,
    mismatchCount,
  };
};
