import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useWebDavStore } from '@/store/webdavStore';
import { syncWebDavSelection } from '@/services/webdav/sync/engine';
import {
  applyDownloadedBookConfigs,
  pushClosedBookConfig,
} from '@/services/webdav/sync/applyRemoteConfigs';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';

/**
 * 打开书时定向预拉取该书的 config.json（仅配置文件、不拉书文件/封面/书库），
 * 拉到远端新进度立即应用到内存与阅读视图；关闭书（sync-book-progress 事件）
 * 时把刚保存的进度立即推送到 WebDAV。仅配置了 WebDAV profile 时生效。
 *
 * 此前的进度跨设备链路只有"自动同步周期 / 手动同步"一个入口，且拉取结果
 * 只落盘不进内存（见 applyDownloadedBookConfigs 的说明）——换设备接力时
 * 必须手动同步并重开书才能拿到进度，或干脆被本地旧进度覆盖。
 */
export const useWebDavBookProgressSync = (bookKey: string) => {
  const { appService } = useEnv();
  const _ = useTranslation();

  useEffect(() => {
    if (!appService || !bookKey) return;
    let cancelled = false;

    const runOpenSync = async () => {
      try {
        const store = useWebDavStore.getState();
        const profile =
          store.profiles.find((p) => p.id === store.activeProfileId) ?? store.profiles[0];
        if (!profile?.serverUrl || !profile?.username) return;
        if (store.isSyncing) return;
        const bookHash = bookKey.split('-')[0]!;
        const book = useLibraryStore.getState().library.find((b) => b.hash === bookHash);
        if (!book) return;

        useWebDavStore.getState().setSyncing(true);
        try {
          const { appliedConfigKeys } = await syncWebDavSelection(
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
            { shouldCancel: () => cancelled },
          );
          if (!cancelled) {
            await applyDownloadedBookConfigs(
              appService,
              appliedConfigKeys,
              _('Reading Progress Synced'),
            );
          }
        } finally {
          // 取消路径同样要释放互斥，否则自动同步与手动同步会被永久卡死
          useWebDavStore.getState().setSyncing(false);
        }
      } catch {
        // 打开时的预拉取失败不打断阅读：下一轮同步自然收敛
      }
    };

    runOpenSync();

    const handleCloseSync = (event: CustomEvent) => {
      const { bookKey: closedKey } = event.detail ?? {};
      if (closedKey !== bookKey || !appService) return;
      void pushClosedBookConfig(appService, bookKey);
    };
    eventDispatcher.on('sync-book-progress', handleCloseSync);

    return () => {
      cancelled = true;
      eventDispatcher.off('sync-book-progress', handleCloseSync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey, appService]);
};
