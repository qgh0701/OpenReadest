import { useCallback, useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { shouldKeepRemoteLocation } from '@/services/webdav/sync/applyRemoteConfigs';
import { throttle } from '@/utils/throttle';

export const useProgressAutoSave = (bookKey: string) => {
  const { envConfig } = useEnv();
  const { getConfig, saveConfig } = useBookDataStore();
  const { getProgress } = useReaderStore();
  const progress = getProgress(bookKey);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const saveBookConfig = useCallback(
    throttle(() => {
      setTimeout(async () => {
        const config = getConfig(bookKey);
        if (!config) return;
        const settings = useSettingsStore.getState().settings;
        // 阅读位置原本只活在 readerStore 的 progress 里，config.location 没有任何
        // 代码写入，落盘结果就是 `{updatedAt: 0}`。补上后：重启能续读、同步验证
        // 能比对两端位置、WebDAV 推送才有内容可推。
        const liveProgress = useReaderStore.getState().getProgress(bookKey);
        if (
          liveProgress?.location &&
          // WebDAV 刚拉下远端进度、视图还没跳到位时，progress 仍是旧位置；
          // 此刻写入会把 config.location（远端新位置）覆盖回旧的，下次开书又得
          // 重新联网拉一次才跳。跳转生效前先不动它。
          !shouldKeepRemoteLocation(bookKey, liveProgress.location)
        ) {
          config.location = liveProgress.location;
          const current = liveProgress.pageinfo?.current;
          const total = liveProgress.pageinfo?.total;
          if (typeof current === 'number' && typeof total === 'number') {
            config.progress = [current, total];
          }
        }
        await saveConfig(envConfig, bookKey, config, settings);
      }, 5000);
    }, 10000),
    [],
  );

  useEffect(() => {
    saveBookConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, bookKey]);
};
