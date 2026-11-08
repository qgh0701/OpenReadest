import { MetadataResult, SearchRequest } from '@/services/metadata/types';
import { getAPIBaseUrl } from '@/services/environment';
import { getAccessToken } from '@/utils/access';
import { fetchWithAuth } from '@/utils/fetch';
import { ClientSearchOptions, searchMetadataClient } from '@/services/metadata/clientSearch';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
  responseTime?: number;
}

const API_ENDPOINT = getAPIBaseUrl() + '/metadata/search';

const searchViaServer = async (request: SearchRequest): Promise<MetadataResult[]> => {
  const response = await fetchWithAuth(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  const result: ApiResponse<MetadataResult[]> = await response.json();

  if (!result.success) {
    throw new Error(result.error || 'Search failed');
  }

  return result.data || [];
};

/**
 * 元数据检索。
 *
 * 两条链路，按可用性依次尝试：
 *
 * 1. **官方后端**（web 版、已登录时）—— 覆盖最全，但依赖账号 token；
 * 2. **客户端直连**（桌面/安卓安装包）—— 直接抓豆瓣等公开书目站。
 *
 * 之前只有第 1 条，而 Tauri 构建是静态导出、没有 `/api` 路由，自建版也没有
 * 官方账号，所以「自动获取元数据」在安装包里必然失败。现在第 1 条失败就自动
 * 落到第 2 条；两条都没有结果时返回空数组，由界面显示「暂无相关信息」。
 */
export const searchMetadata = async (
  request: SearchRequest,
  options?: ClientSearchOptions,
): Promise<MetadataResult[]> => {
  try {
    const token = await getAccessToken();
    if (token) {
      const fromServer = await searchViaServer(request);
      if (fromServer.length > 0) return fromServer;
    }
  } catch {
    // 未登录 / 后端不可达 / 接口报错：都不是致命问题，交给下面的客户端链路
  }

  return searchMetadataClient(request, options);
};
