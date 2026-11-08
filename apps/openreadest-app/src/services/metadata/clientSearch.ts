import { stubTranslation as _ } from '@/utils/misc';
import { MetadataResult, SearchRequest } from './types';
import { DoubanProvider } from './providers/douban';
import { OpenLibraryProvider } from './providers/openlibrary';

/**
 * 客户端（安装包内）元数据检索。
 *
 * 原来的自动获取走 `getAPIBaseUrl() + '/metadata/search'`，那是官方服务器 +
 * 登录 token 的链路；Tauri 静态导出里既没有 `/api` 路由，自建版也没有官方
 * 账号，所以这条路在桌面/安卓上必然失败。这里直接在主进程可用的网络层抓
 * 公开书目站，不依赖任何后端。
 *
 * 顺序与取舍：
 * - 豆瓣优先：中文书目的作者、出版社、简介、评分覆盖最好，且国内可直连；
 * - Open Library 仅作补充（英文书强，但国内网络常超时），只在前者 0 结果时尝试；
 * - 任一来源失败都静默跳过，全部为空时返回 []，由界面显示「暂无相关信息」。
 */

export type MetadataSourceName = 'douban' | 'openlibrary';

export const METADATA_SOURCES: { name: MetadataSourceName; label: string }[] = [
  { name: 'douban', label: _('豆瓣读书') },
  { name: 'openlibrary', label: _('Open Library') },
];

export interface ClientSearchOptions {
  /** 指定来源；默认只用豆瓣（最快、中文命中率最高） */
  sources?: MetadataSourceName[];
}

const searchDouban = async (request: SearchRequest): Promise<MetadataResult[]> => {
  const provider = new DoubanProvider();
  try {
    const results = await provider.search(request);
    return results ?? [];
  } catch {
    return [];
  }
};

const searchOpenLibrary = async (request: SearchRequest): Promise<MetadataResult[]> => {
  const provider = new OpenLibraryProvider();
  try {
    const results = await provider.search(request);
    return results ?? [];
  } catch {
    return [];
  }
};

/** 置信度降序、去掉标题为空的条目（豆瓣偶发返回空标题的营销条目）。 */
const normalize = (results: MetadataResult[]): MetadataResult[] =>
  results
    .filter((result) => !!result.metadata?.title?.trim())
    .sort((a, b) => b.confidence - a.confidence);

export const searchMetadataClient = async (
  request: SearchRequest,
  options?: ClientSearchOptions,
): Promise<MetadataResult[]> => {
  const sources = options?.sources?.length ? options.sources : (['douban'] as MetadataSourceName[]);

  const collected: MetadataResult[] = [];
  for (const source of sources) {
    if (source === 'douban') collected.push(...(await searchDouban(request)));
    else if (source === 'openlibrary') collected.push(...(await searchOpenLibrary(request)));
    // 某个来源已经给出结果就不再打扰其它来源（Open Library 在国内常超时，
    // 多试一次只会让用户多等十几秒）
    if (collected.length > 0) break;
  }
  return normalize(collected);
};
