import { AppService } from '@/types/system';
import { Book, BookConfig } from '@/types/book';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useWebDavStore } from '@/store/webdavStore';
import { CFI } from '@/libs/document';
import { eventDispatcher } from '@/utils/event';
import { WebDavClient } from '../client/WebDavClient';
import { WebDavProfile } from '../models';
import { getRemoteBookPaths } from './paths';
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
      // 内存 config 尚未建立时同样要跳页：新设备刚从云端下载的书第一次打开
      // 往往就是这个状态，只写内存不跳页会被当成「同步没生效」。
      const initialView = getView(bookKey);
      if (initialView && diskConfig.location) {
        try {
          initialView.goTo(diskConfig.location);
          if (hintMessage) {
            eventDispatcher.dispatch('hint', { bookKey, message: hintMessage });
          }
        } catch {
          // 视图未就绪：进度已进内存，下次打开自然生效
        }
      }
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

const createWebDavClient = (profile: WebDavProfile): WebDavClient =>
  new WebDavClient({
    serverUrl: profile.serverUrl,
    rootPath: profile.remotePath,
    username: profile.username,
    password: profile.password,
    allowInsecureHttp: profile.allowInsecureHttp,
    allowInsecureTls: profile.allowInsecureTls,
  });

/**
 * 直接读取远端 config.json，绕开同步引擎的「指纹 / 内容合并 / 冲突策略」状态机。
 * 引擎路径在本场景会被多重条件挡住：config.json 不含 booknotes 字段导致内容
 * 合并返回 null、默认 manual 策略把冲突项跳过、两端已判定同步时
 * appliedConfigKeys 为空使胶水完全不执行。任一处失效都拿不到进度。
 * 这里只做一次 GET；网络失败返回 null，由上层静默重试，不影响阅读。
 */
const readRemoteBookConfig = async (
  profile: WebDavProfile,
  book: Book,
): Promise<BookConfig | null> => {
  try {
    const response = await createWebDavClient(profile).get(getRemoteBookPaths(book).configFile);
    if (!response.ok || !response.data) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(response.data));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as BookConfig;
  } catch {
    return null;
  }
};

const waitForView = async (bookKey: string) => {
  let view = useReaderStore.getState().getView(bookKey);
  for (let i = 0; i < 10 && !view; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    view = useReaderStore.getState().getView(bookKey);
  }
  return view;
};

/**
 * 开书时定向拉取远端进度并直接应用到内存 / 磁盘 / 阅读视图。
 * 返回是否成功读到远端配置（用于决定关书时是否允许反向推送）。
 */
export const pullRemoteBookProgress = async (
  appService: AppService,
  bookKey: string,
  hintMessage?: string,
): Promise<boolean> => {
  const profile = resolveActiveProfile();
  if (!profile?.serverUrl || !profile?.username) return false;
  const bookHash = bookKey.split('-')[0]!;
  const book = useLibraryStore.getState().library.find((b) => b.hash === bookHash);
  if (!book) return false;

  const remoteConfig = await readRemoteBookConfig(profile, book);
  if (!remoteConfig) return false;
  const remoteLocation = remoteConfig.location;
  if (!remoteLocation) return true;

  const settings = useSettingsStore.getState().settings;
  const { getConfig, setConfig } = useBookDataStore.getState();
  const memConfig = getConfig(bookKey);
  let diskConfig: BookConfig | undefined;
  try {
    diskConfig = (await appService.loadBookConfig(book, settings)) ?? undefined;
  } catch {
    diskConfig = undefined;
  }
  const base: BookConfig = memConfig ?? diskConfig ?? { updatedAt: 0 };
  const localLocation = base.location;

  // 判据用「位置是否更靠后」而不是 updatedAt：新设备刚从云端下载的书在开书
  // 瞬间就会生成本地 config，updatedAt 是当下时间，按时间戳永远比远端「新」，
  // 会把真正的远端进度挡掉。只比较位置可天然防回退（本地读得更远时不拉回）。
  let shouldApply = false;
  if (!localLocation) {
    shouldApply = true;
  } else {
    try {
      shouldApply = CFI.compare(localLocation, remoteLocation) < 0;
    } catch {
      shouldApply = (remoteConfig.updatedAt ?? 0) > (base.updatedAt ?? 0);
    }
  }
  if (!shouldApply) return true;

  // 只覆盖进度字段，保留本设备已有的批注 / 排版设置，避免跨端拉取丢笔记。
  const merged: BookConfig = {
    ...base,
    updatedAt: remoteConfig.updatedAt ?? base.updatedAt,
    location: remoteLocation,
    ...(remoteConfig.progress ? { progress: remoteConfig.progress } : {}),
    ...(remoteConfig.xpointer ? { xpointer: remoteConfig.xpointer } : {}),
  };
  setConfig(bookKey, merged);
  try {
    await appService.saveBookConfig(book, merged, settings);
  } catch {
    // 落盘失败不影响本次跳转：内存进度已更新，自动保存会再写一次
  }

  const view = await waitForView(bookKey);
  if (view) {
    try {
      view.goTo(remoteLocation);
      if (hintMessage) {
        eventDispatcher.dispatch('hint', { bookKey, message: hintMessage });
      }
    } catch {
      // 文档尚未渲染完成：进度已写入内存与磁盘，下次打开自然生效
    }
  }
  return true;
};

/**
 * 关书后的定向进度推送：把刚落盘的 config.json 立即同步到 WebDAV，
 * 不等自动同步间隔。仅配置了 WebDAV profile 时生效；失败静默
 * （下一轮同步会按增量重新上传，无数据丢失风险）。
 */
export const pushClosedBookConfig = async (
  appService: AppService,
  bookKey: string,
  allowPush = true,
): Promise<void> => {
  try {
    // 开书时没读到远端配置（离线 / 服务器异常）时禁止推送：否则新设备的
    // 「第一页」进度会覆盖云端真正的进度，是不可逆的数据破坏。
    if (!allowPush) return;
    const profile = resolveActiveProfile();
    if (!profile?.serverUrl || !profile?.username) return;
    if (useWebDavStore.getState().isSyncing) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (useWebDavStore.getState().isSyncing) return;
    }
    const bookHash = bookKey.split('-')[0]!;
    const book = useLibraryStore.getState().library.find((b) => b.hash === bookHash);
    if (!book) return;

    // 二次保护：远端位置比本地更靠后，说明本地仍是旧进度，不能反推覆盖。
    // 本地没有位置（没翻页就关书）时同样不推，避免把远端进度清空。
    const settings = useSettingsStore.getState().settings;
    let localConfig: BookConfig | undefined;
    try {
      localConfig = (await appService.loadBookConfig(book, settings)) ?? undefined;
    } catch {
      localConfig = undefined;
    }
    if (!localConfig?.location) return;
    const remoteConfig = await readRemoteBookConfig(profile, book);
    if (remoteConfig?.location) {
      try {
        if (CFI.compare(localConfig.location, remoteConfig.location) < 0) return;
      } catch {
        if ((remoteConfig.updatedAt ?? 0) > (localConfig.updatedAt ?? 0)) return;
      }
    }

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
