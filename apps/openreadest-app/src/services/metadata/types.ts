export interface Metadata {
  title: string;
  subtitle?: string;
  author: string;
  publisher?: string;
  published?: string;
  language?: string;
  identifier?: string;
  subjects?: string[];
  description?: string;
  coverImageUrl?: string;
  /** 豆瓣等书评站给出的评分（0–10）。缺失即表示该来源没有评分。 */
  rating?: number;
  /** 参与评分的用户数 */
  ratingCount?: number;
  /** 评分来源（如「豆瓣」），用于在界面上标明评分出处 */
  ratingSource?: string;
  /** 页数，豆瓣详情页可得，用于补充书目信息 */
  pages?: string;
}

export interface SearchRequest {
  title?: string;
  isbn?: string;
  author?: string;
  language?: string;
}

export interface MetadataResult {
  metadata: Metadata;
  providerName: string;
  providerLabel: string;
  confidence: number;
}

export interface MetadataProvider {
  name: string;
  search(request: SearchRequest): Promise<MetadataResult[] | null>;
}
