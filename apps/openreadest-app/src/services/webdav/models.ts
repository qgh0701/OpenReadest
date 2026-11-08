export type WebDavConflictResolutionStrategy = 'newest' | 'local' | 'remote' | 'manual';

/**
 * 同步范围：让用户自己决定这一次要同步什么。
 *
 * 起因是「立刻同步」默认全量——书库索引 + 全部书文件 + 封面 + config + 统计，
 * 50 本书就是 150+ 次请求，既慢又容易撞上坚果云的频率限制；而多数时候用户
 * 只想让进度和书架分组对上。拆成四项后：
 *
 * - `bookFiles`：书籍本体（大文件，最占带宽与请求数）
 * - `config`：阅读进度与单书排版设置
 * - `covers`：封面图
 * - `library`：书架索引，**分组信息（group / groupId / groupName）就存在这里**，
 *   关掉它等于「不同步分组与书架增删」
 *
 * 默认全开，保持既有行为；用户关掉哪项，引擎就不再为那一类条目发请求。
 */
export interface WebDavSyncScope {
  bookFiles: boolean;
  config: boolean;
  covers: boolean;
  library: boolean;
}

export const DEFAULT_WEBDAV_SYNC_SCOPE: WebDavSyncScope = {
  bookFiles: true,
  config: true,
  covers: true,
  library: true,
};

/** 老 profile 没有 syncScope 字段时按默认全开处理，避免升级后「突然什么都不同步」。 */
export const resolveSyncScope = (profile?: WebDavProfile | null): WebDavSyncScope => ({
  ...DEFAULT_WEBDAV_SYNC_SCOPE,
  ...(profile?.syncScope ?? {}),
});

export interface WebDavProfile {
  id: string;
  name: string;
  serverUrl: string;
  remotePath: string;
  username: string;
  password: string;
  allowInsecureHttp?: boolean;
  allowInsecureTls?: boolean;
  conflictStrategy: WebDavConflictResolutionStrategy;
  lastSyncAt?: number;
  /** 同步范围；缺省按 DEFAULT_WEBDAV_SYNC_SCOPE 全开 */
  syncScope?: WebDavSyncScope;
}

export type WebDavSyncDirection = 'upload' | 'download';

export type WebDavSyncItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'conflict';

export interface WebDavSyncLogItem {
  id: string;
  timestamp: number;
  direction: WebDavSyncDirection;
  path: string;
  status: WebDavSyncItemStatus;
  message?: string;
}

export interface WebDavSyncProgress {
  totalItems: number;
  completedItems: number;
  failedItems?: number;
  currentPath?: string;
  currentDirection?: WebDavSyncDirection;
}

export interface WebDavConflictItem {
  /**
   * 产生该冲突的 profile：resolve/查看差异用当前 profile 的服务器与凭据
   * 收敛冲突，跨 profile 条目若混入会把本地内容上传到错误的服务器。
   * 由引擎检出冲突时填充（syncWebDavSelection 是 Runner 与手动窗口的
   * 共同检出点）。
   */
  profileId: string;
  path: string;
  local?: {
    size?: number;
    md5?: string;
    observedAt?: number;
  };
  remote?: {
    etag?: string;
    lastModified?: string;
    size?: number;
  };
}
