import { AppService } from '@/types/system';
import { Book, BookConfig } from '@/types/book';
import { FoliateView } from '@/types/view';
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
import { mergeWebDavJsonContent } from './contentMerge';

/** 补丁版本标记：显示在「同步验证」报告首行，用于确认两端跑的是同一版。 */
export const CONFIG_SYNC_PATCH_TAG = 'p5-view-ready-goto';

export type ConfigSyncResult = {
  ok: boolean;
  /** 成功：pushed / pulled；失败：no-profile / no-local-location / remote-ahead / ... */
  reason: string;
  location?: string;
  remoteLocation?: string;
  updatedAt?: number;
};

/**
 * 本设备本次会话中最近一次读到的远端进度（按 bookHash 记录），仅用于诊断与
 * 「同步验证」报告，不再作为推送放行条件。
 *
 * v4 曾用它配合 `localNewer` 放行「本地更靠前也推」的情形，但 `saveConfig`
 * 每次落盘都会把 updatedAt 刷成 Date.now()，本地时间戳恒比云端新，放行条件
 * 恒成立 —— 于是开书跳转一旦失败，旧位置就会被当成用户的最新进度推上云端，
 * 把另一台设备的真实进度洗掉。现在自动推送只认「本地位置确实更靠后」。
 */
const pulledRemoteByHash = new Map<string, { location?: string; updatedAt?: number }>();

/**
 * 本设备**确实跳到过**的远端位置（bookHash → CFI），只在 goToVerified 成功后记录。
 *
 * 用途：区分「用户在读到远端位置之后主动往回翻」与「新设备首屏还停在旧位置」。
 * 前者是真实阅读行为，应当允许把进度推上云；后者一旦推送就会洗掉云端进度。
 * 两者的区别只在于「本机有没有真的到过那个远端位置」，所以这张表只在跳转成功
 * 时写入——跳转失败（含被 init 覆盖）则不写，推送端据此拒绝回退。
 */
const appliedRemoteByHash = new Map<string, string>();

const resolveActiveProfile = (): WebDavProfile | undefined => {
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

const compareLocations = (a?: string | null, b?: string | null): number | null => {
  if (!a || !b) return null;
  try {
    return CFI.compare(a, b);
  } catch {
    return null;
  }
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 「已从云端拉下、但本机视图还没跳到位」的远端位置（bookHash → 位置 + 时间）。
 *
 * 存在的理由：pullRemoteBookProgress 把远端位置写进内存与磁盘之后，还要等
 * view.init 完成才能 goTo（几秒）。在这几秒里，useProgressAutoSave 的 5 秒
 * 定时器很可能先跑一轮，把 progress（仍是本机旧位置）写回 config.location，
 * 刚拉下来的远端位置当场被抹掉——「每次打开都得重新联网拉一次才跳」就是它。
 * 有了这个标记，自动保存会在跳转生效前保留远端位置，等 progress 真的走到那里
 * （或已读到更后面）再恢复正常写入。
 */
const pendingRemoteApply = new Map<string, { location: string; at: number }>();
const PENDING_REMOTE_TTL = 90_000;

/** 记录一次「已应用、待视图跟上」的远端位置。 */
const markPendingRemoteApply = (bookHash: string, location: string) => {
  pendingRemoteApply.set(bookHash, { location, at: Date.now() });
};

const clearPendingRemoteApply = (bookHash: string) => {
  pendingRemoteApply.delete(bookHash);
};

/**
 * 自动保存 / 关书写盘时的守卫：返回 true 表示「此刻不要用 progress 覆盖
 * config.location」，因为本机进度还停在拉取前的旧位置，覆盖会把远端进度抹掉。
 *
 * @param bookKey 形如 `<hash>-<uniqueId>`
 * @param liveLocation 当前 readerStore 里的实时阅读位置（CFI）
 */
export const shouldKeepRemoteLocation = (
  bookKey: string,
  liveLocation?: string | null,
): boolean => {
  const bookHash = bookKey.split('-')[0]!;
  const pending = pendingRemoteApply.get(bookHash);
  if (!pending) return false;
  if (Date.now() - pending.at > PENDING_REMOTE_TTL) {
    clearPendingRemoteApply(bookHash);
    return false;
  }
  if (!liveLocation) return true;
  if (liveLocation === pending.location) {
    // 已经跳到远端位置，后续走正常保存
    clearPendingRemoteApply(bookHash);
    return false;
  }
  const cmp = compareLocations(liveLocation, pending.location);
  if (cmp === null) {
    clearPendingRemoteApply(bookHash);
    return false;
  }
  if (cmp < 0) return true; // 仍在旧位置：保留 config 里的远端值
  clearPendingRemoteApply(bookHash); // 已读到更后面：正常写入
  return false;
};

/**
 * 等待这本书的阅读视图**完成初始化**（`viewState.inited === true`）。
 *
 * 为什么必须等：FoliateViewer.openBook 的执行顺序是
 *   `await view.open(book)` → `setFoliateView(bookKey, view)` → `await view.init({ lastLocation })`
 *   → `setViewInited(bookKey, true)`
 * 也就是说，view 对象在 init **之前**就已经能从 getView() 拿到了。而 init 内部
 * 会按 `config.location`（本机旧位置）再定位一次。任何在这之前发出的 goTo 都会
 * 被 init 覆盖掉——这正是「云端明明有新进度，打开就是不跳、关掉再开才跳」的
 * 直接原因。只有等 inited 之后再 goTo，结果才不会被覆盖。
 */
const waitForInitedView = async (bookKey: string, timeoutMs = 20000): Promise<FoliateView | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = useReaderStore.getState();
    // 书已经关掉了（用户快速开关 / 切书）：不必再等，让调用方按「已写盘」处理
    if (state.bookKeys.length > 0 && !state.bookKeys.includes(bookKey)) return null;
    const viewState = state.viewStates[bookKey];
    if (viewState?.view && viewState.inited) return viewState.view;
    await sleep(120);
  }
  return null;
};

/**
 * 跳转并**校验是否真的成功**。
 *
 * foliate 的 `view.goTo` 是 async 且内部 try/catch 吞掉所有异常：定位失败时只
 * console.error 并 `return undefined`。所以「没有抛错」完全不能代表跳转成功。
 * 之前的实现用 `try { view.goTo(x); return true } catch {}` 判断，等于第一次
 * 拿到 view 就宣告成功，所谓「重试 10 次」一次也没执行过。这里改为读取返回值，
 * 失败继续重试。
 */
const goToVerified = async (
  view: FoliateView,
  location: string,
  attempts = 6,
  intervalMs = 500,
): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(intervalMs);
    try {
      const resolved = await view.goTo(location);
      if (resolved) return true;
    } catch {
      // renderer 层直接抛错（视图已销毁等）：继续重试或交由上层兜底
    }
  }
  return false;
};

const cleanConfig = (config: BookConfig): BookConfig =>
  Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== null && value !== undefined),
  ) as BookConfig;

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

/**
 * 生成要写回远端的 config：批注按 id 并集合并（不丢任一端的笔记），
 * 进度字段强制取本设备的值，updatedAt 刷新为当前时间。
 */
const buildPushPayload = (local: BookConfig, remote: BookConfig | null): BookConfig => {
  let base: BookConfig = { ...local };
  if (remote) {
    try {
      // 路径只用于让 mergeWebDavJsonContent 识别为书籍配置（它按后缀分派），
      // 走与引擎相同的合并实现，保证批注按 id 并集、不会丢另一端的笔记。
      const merged = mergeWebDavJsonContent(
        'Books/config.json',
        JSON.stringify(local),
        JSON.stringify(remote),
      );
      base = (merged?.value as BookConfig) ?? { ...remote, ...local };
    } catch {
      base = { ...remote, ...local };
    }
  }
  const payload: BookConfig = {
    ...base,
    location: local.location!,
    updatedAt: Math.max(Date.now(), local.updatedAt ?? 0),
  };
  if (local.progress) payload.progress = local.progress;
  if (local.xpointer) payload.xpointer = local.xpointer;
  return payload;
};

/** 已确认存在的远端目录（同一次会话内避免重复 MKCOL）。 */
const ensuredDirs = new Set<string>();

const ensureParentDirs = async (client: WebDavClient, remoteFilePath: string): Promise<void> => {
  const parts = remoteFilePath.split('/').filter(Boolean);
  if (parts.length <= 1) return;
  let current = '';
  for (const dir of parts.slice(0, -1)) {
    current = current ? `${current}/${dir}` : dir;
    if (ensuredDirs.has(current)) continue;
    const res = await client.mkcol(`/${current}`);
    // 405 = 已存在，301/302 部分实现对已存在目录的返回
    if (res.ok || res.status === 405 || res.status === 301 || res.status === 302) {
      ensuredDirs.add(current);
    }
  }
};

/**
 * 把某一本书的进度直接 PUT 到远端（不走引擎）。
 *
 * 之所以不用 syncWebDavSelection：关书推送对时效要求高（用户关掉书就可能换
 * 设备），而引擎要为每个条目读状态、探测远端、判冲突、再合并，任何一步判定
 * 「无需同步 / 冲突 / 远端未知」都会静默跳过，表现为「推送了但云端没变」。
 * 一次 GET + 一次 PUT 是确定性的，失败也能拿到原因。
 */
export const pushBookConfig = async (
  book: Book,
  localConfigInput: BookConfig,
  options?: { force?: boolean; profile?: WebDavProfile },
): Promise<ConfigSyncResult> => {
  const profile = options?.profile ?? resolveActiveProfile();
  if (!profile?.serverUrl || !profile?.username) return { ok: false, reason: 'no-profile' };
  const localConfig = cleanConfig(localConfigInput);
  if (!localConfig.location) return { ok: false, reason: 'no-local-location' };

  const remoteConfig = await readRemoteBookConfig(profile, book);
  if (!options?.force && remoteConfig?.location) {
    const cmp = compareLocations(localConfig.location, remoteConfig.location);
    if (cmp !== null && cmp < 0) {
      // 本地位置比云端更靠前（读得少）→ 默认拒绝推送。
      //
      // v4 这里曾用「本设备读到过远端 + 本地 updatedAt 更新」放行，结果形成一条
      // 污染链：saveConfig 每次落盘都会把 updatedAt 刷成 Date.now()，本地时间戳
      // 永远比云端新，于是这条放行条件恒成立。一旦开书跳转失败（view.init 覆盖
      // 了 goTo），用户看到的是旧位置，退出时旧位置就被当成「用户主动读回来的
      // 进度」推上云端，把另一台设备真正的新进度洗掉——越同步越乱就是这么来的。
      //
      // 现在只认一个例外：本机**确实跳到过**当前云端这个位置（appliedRemoteByHash
      // 且与云端位置完全一致），之后用户又主动往回翻。这才是真实阅读行为；跳转
      // 失败的情况不会写入该表，因此不会被误放行。
      const appliedRemote = appliedRemoteByHash.get(book.hash);
      const userMovedBack =
        !!appliedRemote && compareLocations(appliedRemote, remoteConfig.location) === 0;
      if (!userMovedBack) {
        return {
          ok: false,
          reason: 'remote-ahead',
          location: localConfig.location,
          remoteLocation: remoteConfig.location,
        };
      }
    }
  }

  const payload = buildPushPayload(localConfig, remoteConfig);
  const remotePath = getRemoteBookPaths(book).configFile;
  const body = JSON.stringify(payload);
  try {
    const client = createWebDavClient(profile);
    let res = await client.put(remotePath, body, { contentType: 'application/json' });
    // 远端还没有这本书的目录（从未上传过书文件）时 PUT 会 409/404：
    // 补建目录后重试一次，避免「第一次推送必然失败」。
    if (!res.ok && (res.status === 409 || res.status === 404)) {
      await ensureParentDirs(client, remotePath);
      res = await client.put(remotePath, body, { contentType: 'application/json' });
    }
    if (!res.ok) {
      return { ok: false, reason: `put-${res.status}${res.error ? `:${res.error}` : ''}` };
    }
    pulledRemoteByHash.set(book.hash, {
      location: payload.location,
      updatedAt: payload.updatedAt,
    });
    return {
      ok: true,
      reason: 'pushed',
      location: payload.location,
      remoteLocation: remoteConfig?.location,
      updatedAt: payload.updatedAt,
    };
  } catch (error) {
    return { ok: false, reason: (error as Error).message || 'put-failed' };
  }
};

/**
 * 把远端进度拉到本地磁盘（不依赖这本书是否已打开）。
 *
 * 供「同步验证」面板里对单本书强制拉取使用：处理「远端比本地靠后但用户就是想
 * 要云端那份」的场景；force=false 时保持防回退语义。
 */
export const pullBookConfigToDisk = async (
  appService: AppService,
  book: Book,
  options?: { force?: boolean; profile?: WebDavProfile },
): Promise<ConfigSyncResult> => {
  const profile = options?.profile ?? resolveActiveProfile();
  if (!profile?.serverUrl || !profile?.username) return { ok: false, reason: 'no-profile' };
  const remoteConfig = await readRemoteBookConfig(profile, book);
  if (!remoteConfig?.location) return { ok: false, reason: 'no-remote-location' };

  const settings = useSettingsStore.getState().settings;
  let localConfig: BookConfig | undefined;
  try {
    localConfig = (await appService.loadBookConfig(book, settings)) ?? undefined;
  } catch {
    localConfig = undefined;
  }
  if (!options?.force) {
    const cmp = compareLocations(localConfig?.location, remoteConfig.location);
    if (cmp !== null && cmp >= 0) {
      return {
        ok: false,
        reason: 'local-ahead',
        location: localConfig?.location ?? undefined,
        remoteLocation: remoteConfig.location,
      };
    }
  }

  const merged: BookConfig = {
    ...(localConfig ?? { updatedAt: 0 }),
    updatedAt: remoteConfig.updatedAt ?? Date.now(),
    location: remoteConfig.location,
  };
  if (remoteConfig.progress) merged.progress = remoteConfig.progress;
  if (remoteConfig.xpointer) merged.xpointer = remoteConfig.xpointer;

  try {
    await appService.saveBookConfig(book, merged, settings);
  } catch (error) {
    return { ok: false, reason: (error as Error).message || 'save-failed' };
  }
  pulledRemoteByHash.set(book.hash, {
    location: remoteConfig.location,
    updatedAt: remoteConfig.updatedAt,
  });
  return {
    ok: true,
    reason: 'pulled',
    location: remoteConfig.location,
    remoteLocation: remoteConfig.location,
    updatedAt: remoteConfig.updatedAt,
  };
};

/**
 * 取「关书这一刻」的配置快照，并把阅读位置补进去。
 *
 * 关键事实（读过源码确认）：这个分支里 `config.location` 平时没有任何地方写入，
 * 阅读位置只存在于 readerStore 的 progress（`getProgress(bookKey).location`）。
 * 于是磁盘上的 config.json 往往是 `{updatedAt: 0}`，推送时拿不到位置就直接
 * 放弃——「安卓读了几章，云端进度没变」的真正原因就在这里。
 * 这里以 progress 为准，把 location / progress 补进配置再交给推送。
 */
export const captureClosedBookConfig = (bookKey: string): BookConfig | null => {
  const config = useBookDataStore.getState().getConfig(bookKey);
  const progress = useReaderStore.getState().getProgress(bookKey);
  // 内存 config 与 progress 任一存在就够推送：关书阶段 clearViewState 还没执行，
  // 但 booksData 有可能已被并发回收（例如「立刻同步」正在重排书库）。此时若直接
  // 返回 null，这次关书的进度就永远推不上去，所以用 progress 兜底造一份最小配置。
  if (!config) {
    if (!progress?.location) return null;
    const minimal: BookConfig = { updatedAt: Date.now(), location: progress.location };
    const current = progress.pageinfo?.current;
    const total = progress.pageinfo?.total;
    if (typeof current === 'number' && typeof total === 'number') {
      minimal.progress = [current, total];
    }
    return minimal;
  }
  if (!progress?.location) return config;
  const next: BookConfig = { ...config, location: progress.location, updatedAt: Date.now() };
  const current = progress.pageinfo?.current;
  const total = progress.pageinfo?.total;
  if (typeof current === 'number' && typeof total === 'number') {
    next.progress = [current, total];
  }
  return next;
};

/**
 * 引擎落盘 → 应用内存 的桥（供「立刻同步」等走引擎的路径使用）。
 *
 * 引擎 syncWebDavSelection 只负责把远端 config.json 写到磁盘文件；
 * 在此之前，磁盘新进度与应用内存之间没有任何桥：
 * 1. 正在阅读的界面不会感知远端进度，书不跳转；
 * 2. 几秒后的本地进度自动保存（useProgressAutoSave）会用内存里的旧进度
 *    反向覆盖刚下载的 config.json，两端进度来回互踩。
 *
 * 本函数把引擎上报的 appliedConfigKeys 应用到内存与打开中的视图：
 * - 未打开的书不处理（下次打开时 readerStore 会直接从磁盘读到最新进度）；
 * - 已打开的书：磁盘位置更靠后时合并进内存并跳转提示；远端落后时不动用户
 *   当前位置，仅吸收内存缺失的字段。
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
    // key 形如 'Books/<hash>/config.json'
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
        const jumped = await goToVerified(initialView, diskConfig.location, 3, 400);
        if (jumped) {
          appliedRemoteByHash.set(bookHash, diskConfig.location);
          if (hintMessage) {
            eventDispatcher.dispatch('hint', { bookKey, message: hintMessage });
          }
        }
        // 跳转失败（文档仍在解析）：进度已进内存与磁盘，下次打开自然生效
      }
      continue;
    }

    // 这里原先用 updatedAt 判「磁盘是否更新」，但 saveConfig 每次落盘都会把
    // updatedAt 刷成 Date.now()：内存里那份几乎总是比刚从云端下载的磁盘文件
    // 「更新」，于是引擎辛苦拉下来的进度被这一行直接 continue 掉——「点立刻同步
    // 显示成功、书却不跳」就是它。改用阅读位置本身判断：磁盘位置更靠后才应用。
    const locCmp = compareLocations(memConfig.location, diskConfig.location);
    const diskAhead = locCmp === null ? true : locCmp < 0;
    if (!diskAhead) continue;
    const filteredDisk = Object.fromEntries(
      Object.entries(diskConfig).filter(([, value]) => value !== null && value !== undefined),
    );
    setConfig(bookKey, { ...memConfig, ...filteredDisk });

    const view = getView(bookKey);
    const diskLocation = diskConfig.location;
    if (!view || !diskLocation) continue;
    const memLocation = memConfig.location;
    let shouldJump = true;
    try {
      shouldJump = !memLocation || CFI.compare(memLocation, diskLocation) < 0;
    } catch {
      // CFI 无法比较（格式差异）：按远端来，避免「永远不跳」
      shouldJump = true;
    }
    if (!shouldJump) continue;
    const jumped = await goToVerified(view, diskLocation, 4, 400);
    if (jumped) {
      appliedRemoteByHash.set(bookHash, diskLocation);
      if (hintMessage) {
        eventDispatcher.dispatch('hint', { bookKey, message: hintMessage });
      }
    }
  }
};

/**
 * 开书时定向拉取远端进度并直接应用到内存 / 磁盘 / 阅读视图。
 * 返回是否成功读到远端配置（用于诊断，不再作为关书推送的前置条件——
 * 推送前的防回退检查本身会再读一次远端）。
 */
export const pullRemoteBookProgress = async (
  appService: AppService,
  bookKey: string,
  hintMessage?: string,
  options?: { force?: boolean },
): Promise<boolean> => {
  const profile = resolveActiveProfile();
  if (!profile?.serverUrl || !profile?.username) return false;
  const bookHash = bookKey.split('-')[0]!;
  const book = useLibraryStore.getState().library.find((b) => b.hash === bookHash);
  if (!book) return false;

  const remoteConfig = await readRemoteBookConfig(profile, book);
  if (!remoteConfig) return false;
  pulledRemoteByHash.set(book.hash, {
    location: remoteConfig.location,
    updatedAt: remoteConfig.updatedAt,
  });
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
    const cmp = compareLocations(localLocation, remoteLocation);
    if (cmp === null) {
      // CFI 无法比较（两种格式、解析差异）时按「以远端为准」处理。原先这里拿
      // updatedAt 比新旧，但 saveConfig 每次落盘都会把本地时间戳刷成 Date.now()，
      // 本地永远「更新」，于是这条分支等于永远不跳——这正是部分书「云端有进度
      // 却死活不跳」的来源。
      shouldApply = true;
    } else {
      shouldApply = cmp < 0;
    }
  }
  if (!options?.force && !shouldApply) return true;

  // 只覆盖进度字段，保留本设备已有的批注 / 排版设置，避免跨端拉取丢笔记。
  const merged: BookConfig = {
    ...base,
    updatedAt: remoteConfig.updatedAt ?? base.updatedAt,
    location: remoteLocation,
  };
  if (remoteConfig.progress) merged.progress = remoteConfig.progress;
  if (remoteConfig.xpointer) merged.xpointer = remoteConfig.xpointer;
  setConfig(bookKey, merged);
  try {
    await appService.saveBookConfig(book, merged, settings);
  } catch {
    // 落盘失败不影响本次跳转：内存进度已更新，自动保存会再写一次
  }
  // 视图跳到位之前，禁止自动保存用本机旧位置回写 config.location（见守卫注释）
  markPendingRemoteApply(book.hash, remoteLocation);

  // 跳转必须等 view.init 完成。
  //
  // 这里曾经是「轮询 getView()，拿到就 goTo 然后 return true」。两个问题叠加，
  // 使跨端跳转几乎从不生效：
  //   1. getView() 在 view.init 之前就返回了 view，此时 goTo 会被紧随其后的
  //      init({ lastLocation: 本机旧位置 }) 覆盖；
  //   2. goTo 内部吞掉异常、失败返回 undefined，外层 try/catch 抓不到任何东西，
  //      于是第一次就 return true，「重试 10 次」形同虚设。
  // 现在：等 inited → await goTo → 看返回值，失败继续重试。
  const view = await waitForInitedView(bookKey);
  let jumped = false;
  if (view) {
    jumped = await goToVerified(view, remoteLocation);
  }
  if (jumped) {
    clearPendingRemoteApply(book.hash);
    appliedRemoteByHash.set(book.hash, remoteLocation);
    if (hintMessage) {
      eventDispatcher.dispatch('hint', { bookKey, message: hintMessage });
    }
  }
  // 未跳成功（视图超时未就绪 / 定位失败）：进度已写入内存与磁盘，下次打开
  // 时 init 会直接按 config.location 定位，依然会落到远端位置。
  return true;
};

/**
 * 关书后的定向进度推送。
 *
 * 关键点：sync-book-progress 事件是在 saveConfig 落盘**之前**派发的
 * （ReaderContent.saveConfigAndCloseBook → saveBookConfig 里先 dispatch 再
 * await saveConfig）。此刻磁盘上还是上一次节流保存的内容——可能是几页之前，
 * 甚至因为刚打开还没自动保存过而没有 location。因此必须优先使用调用方传入的
 * **内存快照**，读磁盘只作为兜底。这正是「安卓读了几章退回书架，云端进度却
 * 没变」的根因。
 */
export const pushClosedBookConfig = async (
  appService: AppService,
  bookKey: string,
  snapshot?: BookConfig | null,
): Promise<ConfigSyncResult> => {
  try {
    const bookHash = bookKey.split('-')[0]!;
    const book = useLibraryStore.getState().library.find((b) => b.hash === bookHash);
    if (!book) return { ok: false, reason: 'book-not-found' };
    const settings = useSettingsStore.getState().settings;

    let localConfig: BookConfig | undefined = snapshot ?? undefined;
    if (!localConfig?.location) {
      try {
        localConfig = (await appService.loadBookConfig(book, settings)) ?? undefined;
      } catch {
        localConfig = undefined;
      }
    }
    if (!localConfig?.location) return { ok: false, reason: 'no-local-location' };

    // 自动同步进行中时稍等，避免引擎与本函数同时写同一个 config.json；
    // 等不到也照常推送——直写与引擎互不依赖，最坏情况是下一轮合并收敛。
    for (let i = 0; i < 6 && useWebDavStore.getState().isSyncing; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return await pushBookConfig(book, localConfig);
  } catch (error) {
    return { ok: false, reason: (error as Error).message || 'push-failed' };
  }
};
