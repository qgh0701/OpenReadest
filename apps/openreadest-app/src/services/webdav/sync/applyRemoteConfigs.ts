import { AppService } from '@/types/system';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useWebDavStore } from '@/store/webdavStore';
import { CFI } from '@/libs/document';
import { eventDispatcher } from '@/utils/event';
import { syncWebDavSelection } from './engine';

/**
 * 引擎落盘 → 应用内存 的桥（进度同步缺失的最后一环）。
 *
 * 引擎 syncWebDavSelection 只负责把远端 config.json 写到磁盘文件；
 * 在此之前，磁盘新进度与应用内存之间没有任何桥：
 * 1. 正在阅读的界面不会感知远端进度，书不跳转；
 * 2. 几秒后的本地进度自动保存（useProgressAutoSave）会用内存里的旧进度
 *    反向覆盖刚下载的 config.json，两端进度来回互踩。
 *
 * 本函数把引擎上报的 appliedConfigKeys 应用到内存与打开中的视图：
 * - 未打开的书不处理（下次打开时 readerStore 会直接从磁盘读到最新进度）；
 * - 已打开的书：磁盘 updatedAt 较新时合并进内存；远端位置比当前位置更远
 *   时跳转并提示（与 useProgressSync.applyRemoteProgress 行为一致）；
 *   远端落后时不动用户当前位置，仅吸收内存缺失的字段。
 */
export const applyDownloadedBookConfigs = async (
  appService: AppService,
  configKeys: string[],
  hintMessage?: string,
): Promise<void> => {
  if (!configKeys || configKeys.length === 0) return;

  const settings = useSettingsStore.getState().settings;
  const { getConfig, setConfig } = useBookDataStore.getState();
  const { getView, bookKeys } = useReaderStore.getState();
  const library = useLibraryStore.getState().library;

  for (const key of configKeys) {
    // key 形如 'Books/<hash>/<safeTitle>.json'
    const segments = key.replaceAll('\\', '/').split('/');
    if (segments.length < 3) continue;
    const bookHash = segments[1]!;
    // 只处理当前打开的书（bookKey = '<hash>-<随机 uniqueId>'，只能按 hash 前缀匹配）
    const bookKey = bookKeys.find((k) => k.split('-')[0] === bookHash);
    if (!bookKey) continue;
    const book = library.find((b) => b.hash === bookHash);
    if (!book) continue;

    let diskConfig;
    try {
      diskConfig = await appService.loadBookConfig(book, settings);
    } catch {
      continue;
    }
    if (!diskConfig) continue;

    const memConfig = getConfig(bookKey);
    if (!memConfig) {
      setConfig(bookKey, diskConfig);
      continue;
    }

    // 进度回退保护：磁盘快照比内存旧（引擎恰好在两次本地保存之间拉到旧
    // 远端）时，不覆盖内存——内存才是用户此刻的真实位置。
    const diskNewer = (diskConfig.updatedAt ?? 0) >= (memConfig.updatedAt ?? 0);
    if (!diskNewer) continue;
    const filteredDisk = Object.fromEntries(
      Object.entries(diskConfig).filter(([, value]) => value !== null && value !== undefined),
    );
    setConfig(bookKey, { ...memConfig, ...filteredDisk });

    const view = getView(bookKey);
    const diskLocation = diskConfig.location;
    if (!view || !diskLocation) continue;
    const memLocation = memConfig.location;
    try {
      const shouldJump =
        !memLocation || CFI.compare(memLocation, diskLocation) < 0;
      if (shouldJump) {
        view.goTo(diskLocation);
        if (hintMessage) {
          eventDispatcher.dispatch('hint', { bookKey, message: hintMessage });
        }
      }
    } catch {
      // CFI 比较/跳转失败（格式差异、已渲染文档未就绪等）：进度字段已合并，
      // 跳转留待下次打开时自然生效，不打断阅读。
    }
  }
};

const resolveActiveProfile = () => {
  const store = useWebDavStore.getState();
  if (!store.hydrated) store.restore({});
  return store.profiles.find((p) => p.id === store.activeProfileId) ?? store.profiles[0];
};

/**
 * 关书后的定向进度推送：把刚落盘的 config.json 立即同步到 WebDAV，
 * 不等自动同步间隔。仅配置了 WebDAV profile 时生效；失败静默
 * （下一轮同步会按增量重新上传，无数据丢失风险）。
 */
export const pushClosedBookConfig = async (
  appService: AppService,
  bookKey: string,
): Promise<void> => {
  try {
    const profile = resolveActiveProfile();
    if (!profile?.serverUrl || !profile?.username) return;
    const store = useWebDavStore.getState();
    if (store.isSyncing) return;
    const bookHash = bookKey.split('-')[0]!;
    const book = useLibraryStore.getState().library.find((b) => b.hash === bookHash);
    if (!book) return;

    useWebDavStore.getState().setSyncing(true);
    try {
      await syncWebDavSelection(
        appService,
        profile,
        {
          books: [book],
          includeLibrary: false,
          includeBookFiles: false,
          includeCovers: false,
          includeConfig: true,
          includeStatistics: false,
        },
        { onLog: () => {} },
        { shouldCancel: () => false },
      );
    } finally {
      useWebDavStore.getState().setSyncing(false);
    }
  } catch {
    // 静默：关书推送是尽力而为，下一轮同步自然收敛
  }
};
