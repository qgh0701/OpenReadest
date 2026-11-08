import { stubTranslation as _ } from '@/utils/misc';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { Metadata } from '../types';
import { BaseMetadataProvider } from './base';

/**
 * 豆瓣图书元数据（客户端直连）。
 *
 * 为什么不用服务端 `/api/metadata/search`：Tauri 桌面与安卓构建走的是
 * `output: 'export'` 静态导出，`src/app/api/**` 在安装包里根本不存在；前端
 * `searchMetadata` 打的是官方服务器并要求登录 token。所以自建版上「自动获取
 * 元数据」一直是不可用的——不是没人点，是那条链路在安装包里不通。
 *
 * 这里改成客户端直连：
 * 1. `book.douban.com/j/subject_suggest?q=` —— 公开的联想接口，返回 title /
 *    author_name / year / pic / id，用来列候选，一次请求；
 * 2. `book.douban.com/subject/<id>/` —— 详情页，含评分、评价人数、简介、ISBN、
 *    出版社、页数。只在需要时抓（候选前两条 + 用户选中时），避免频繁请求。
 *
 * 反爬说明：豆瓣对高频匿名请求会返回 403 或验证页。这里统一做超时 + 失败降级，
 * 拿不到就返回只含标题作者的候选、界面上标注「暂无相关信息」，不阻塞用户。
 */

const SUGGEST_URL = 'https://book.douban.com/j/subject_suggest';
const SUBJECT_URL = 'https://book.douban.com/subject';

/** 不带浏览器 UA 时豆瓣容易直接拒绝，这里固定一个常见 UA。 */
const DOUBAN_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

const TIMEOUT_MS = 12000;

const request = async (url: string): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('douban timeout'), TIMEOUT_MS);
  try {
    const fetchImpl = isTauriAppPlatform() ? tauriFetch : window.fetch.bind(window);
    return await fetchImpl(url, { headers: DOUBAN_HEADERS, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

interface DoubanSuggestion {
  title?: string;
  url?: string;
  pic?: string;
  author_name?: string;
  year?: string;
  id?: string;
  type?: string;
}

/**
 * HTML 实体解码。
 *
 * 豆瓣的 og:description 里用的是**数字实体**（`&#34;` 包住书名号里的引号），
 * 只处理 `&quot;` 这种命名实体会让简介里残留一串 `&#34;`，看着像乱码。
 * 数字实体放在最前，且 `&amp;` 最后处理，避免把 `&amp;#34;` 二次解码。
 */
export const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const metaContent = (html: string, property: string): string | undefined => {
  const re = new RegExp(
    `<meta[^>]+property=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i',
  );
  const tag = html.match(re)?.[0];
  if (!tag) return undefined;
  const content = tag.match(/content=["']([\s\S]*?)["']/i)?.[1];
  return content ? decodeHtmlEntities(content) : undefined;
};

const fieldValue = (html: string, label: string): string | undefined => {
  const re = new RegExp(`<span class="pl">\\s*${label}:?\\s*</span>([\\s\\S]{0,200}?)<`, 'i');
  const raw = html.match(re)?.[1];
  if (!raw) return undefined;
  const text = decodeHtmlEntities(raw.replace(/<[^>]*>/g, ' '));
  return text || undefined;
};

export interface DoubanDetail {
  rating?: number;
  ratingCount?: number;
  description?: string;
  author?: string;
  publisher?: string;
  published?: string;
  isbn?: string;
  pages?: string;
  title?: string;
  coverImageUrl?: string;
}

/** 解析豆瓣详情页。任何字段缺失都不报错——缺失就留空，界面显示「暂无相关信息」。 */
export const parseDoubanDetail = (html: string): DoubanDetail => {
  const ratingText = html.match(/property=["']v:average["'][^>]*>\s*([\d.]+)\s*</)?.[1];
  const rating = ratingText ? Number.parseFloat(ratingText) : undefined;
  const votesText = html.match(/property=["']v:votes["'][^>]*>\s*(\d+)\s*</)?.[1];
  const ratingCount = votesText ? Number.parseInt(votesText, 10) : undefined;

  const authors = [...html.matchAll(/<meta[^>]+property=["']book:author["'][^>]*>/gi)]
    .map((match) => match[0].match(/content=["']([\s\S]*?)["']/i)?.[1])
    .filter((value): value is string => !!value)
    .map(decodeHtmlEntities);

  return {
    title: metaContent(html, 'og:title')?.replace(/\s*\(豆瓣\)\s*$/, ''),
    coverImageUrl: metaContent(html, 'og:image'),
    description: metaContent(html, 'og:description'),
    isbn: metaContent(html, 'book:isbn'),
    author: authors.length > 0 ? authors.join(', ') : fieldValue(html, '作者'),
    publisher: fieldValue(html, '出版社'),
    published: fieldValue(html, '出版年'),
    pages: fieldValue(html, '页数'),
    rating: Number.isFinite(rating) ? rating : undefined,
    ratingCount: Number.isFinite(ratingCount) ? ratingCount : undefined,
  };
};

const suggest = async (query: string): Promise<DoubanSuggestion[]> => {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await request(`${SUGGEST_URL}?q=${encodeURIComponent(trimmed)}`);
  if (!response.ok) throw new Error(`douban suggest ${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is DoubanSuggestion => !!item && typeof item === 'object');
};

/** 按 subject id 抓详情。失败返回 null，由调用方降级为「暂无相关信息」。 */
export const fetchDoubanDetail = async (subjectId: string): Promise<DoubanDetail | null> => {
  if (!/^\d+$/.test(subjectId)) return null;
  try {
    const response = await request(`${SUBJECT_URL}/${subjectId}/`);
    if (!response.ok) return null;
    return parseDoubanDetail(await response.text());
  } catch {
    return null;
  }
};

const subjectIdOf = (item: DoubanSuggestion): string | null => {
  if (item.id && /^\d+$/.test(item.id)) return item.id;
  const fromUrl = item.url?.match(/subject\/(\d+)/)?.[1];
  return fromUrl ?? null;
};

const toMetadata = (item: DoubanSuggestion, detail?: DoubanDetail | null): Metadata => {
  const title = detail?.title || item.title || '';
  return {
    title,
    author: detail?.author || item.author_name || '',
    published: detail?.published || item.year,
    publisher: detail?.publisher,
    identifier: detail?.isbn,
    description: detail?.description,
    coverImageUrl: detail?.coverImageUrl || item.pic,
    pages: detail?.pages,
    rating: detail?.rating,
    ratingCount: detail?.ratingCount,
    ratingSource: detail?.rating !== undefined ? _('豆瓣') : undefined,
  };
};

/** 并发抓前 N 条候选的详情，让候选列表里直接带评分与简介。 */
const DETAIL_CONCURRENCY = 2;

const withDetails = async (items: DoubanSuggestion[]): Promise<Metadata[]> => {
  const head = items.slice(0, DETAIL_CONCURRENCY);
  const tail = items.slice(DETAIL_CONCURRENCY);
  const details = await Promise.all(
    head.map(async (item) => {
      const id = subjectIdOf(item);
      return id ? await fetchDoubanDetail(id) : null;
    }),
  );
  return [
    ...head.map((item, index) => toMetadata(item, details[index])),
    ...tail.map((item) => toMetadata(item)),
  ];
};

export class DoubanProvider extends BaseMetadataProvider {
  name = 'douban';
  label = _('豆瓣读书');
  override maxResults = 5;

  protected override getProviderConfidenceBonus(): number {
    // 中文书目上豆瓣的命中率高于通用库，给一点正向加分，但仍低于完全匹配。
    return 3;
  }

  protected async searchByISBN(isbn: string): Promise<Metadata[]> {
    // 豆瓣的联想接口对 ISBN 同样有效，返回的就是对应书目
    return withDetails((await suggest(isbn)).filter((item) => item.type !== 'm'));
  }

  protected async searchByTitle(
    title: string,
    author?: string,
    _language?: string,
  ): Promise<Metadata[]> {
    const items = (await suggest(title)).filter((item) => item.type !== 'm');
    const filtered = author
      ? items.filter((item) => !item.author_name || item.author_name.includes(author))
      : items;
    // 作者过滤后若一条不剩，退回未过滤结果：豆瓣的作者写法常与书名里的署名不一致
    return withDetails((filtered.length > 0 ? filtered : items).slice(0, this.maxResults));
  }
}
