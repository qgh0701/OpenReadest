import { useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import {
  pullRemoteBookProgress,
  pushClosedBookConfig,
} from '@/services/webdav/sync/applyRemoteConfigs';

/**
 * 打开书时定向拉取该书的远端 config.json（一次 GET，不惊动书文件、封面、
 * 书库索引），把进度直接应用到内存、磁盘和阅读视图；关书（sync-book-progress
 * 事件）时把刚保存的进度推回 WebDAV。
 *
 * 第一版实现走 syncWebDavSelection，但它依赖引擎的指纹 / 内容合并 / 冲突
 * 策略：纯阅读书的 config.json 不含 booknotes 字段 → 内容合并返回 null →
 * 默认 manual 策略把 config 记为冲突跳过；即便成功落盘，若引擎判定「无需
 * 同步」则 appliedConfigKeys 为空，胶水根本不执行。改走直接读取后，这条
 * 链路与同步状态机完全解耦，也不会占用 isSyncing 阻塞自动同步。
 */
export const useWebDavBookProgressSync = (bookKey: string) => {
  const { appService } = useEnv();
  const _ = useTranslation();
  const remoteReachableRef = useRef(false);

  useEffect(() => {
    if (!appService || !bookKey) return;
    let cancelled = false;
    remoteReachableRef.current = false;

    const runOpenSync = async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
        const ok = await pullRemoteBookProgress(
          appService,
          bookKey,
          _('Reading Progress Synced'),
        );
        if (ok) {
          remoteReachableRef.current = true;
          return;
        }
      }
    };
    void runOpenSync();

    const handleCloseSync = (event: CustomEvent) => {
      const { bookKey: closedKey } = event.detail ?? {};
      if (closedKey !== bookKey || !appService) return;
      void pushClosedBookConfig(appService, bookKey, remoteReachableRef.current);
    };
    eventDispatcher.on('sync-book-progress', handleCloseSync);

    return () => {
      cancelled = true;
      eventDispatcher.off('sync-book-progress', handleCloseSync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey, appService]);
};
