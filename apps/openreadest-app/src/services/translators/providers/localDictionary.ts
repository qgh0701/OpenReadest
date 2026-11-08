import { stubTranslation as _ } from '@/utils/misc';
import environmentConfig from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';
import { lookupImportedDictionaries } from '@/services/dictionaries/dictionaryService';
import { lookupWordlists } from '@/services/dictionaries/wordlist';
import { buildLookupCandidates } from '@/services/dictionaries/lookupCandidates';
import { TranslationProvider } from '../types';

/**
 * 完全离线的「翻译」服务：以用户已导入的本地电子词典 / 自定义词表为数据库，
 * 对选中文本逐词查找并输出释义对照。没有任何网络请求，也不需要账号或额度。
 *
 * 说明：词典数据库给出的是**词条释义**，不是神经网络式通顺译文，这是词典
 * 这种数据源的本质决定。若用户选了一个句子，这里会把它拆成词、给出每个词
 * 的释义，适合生词对照与精读；整页翻译也会走同一逻辑，但段落多时查询量
 * 较大，建议主要用于划词。
 */

const MAX_WORDS = 16;
/**
 * 候选词上限。
 *
 * `buildLookupCandidates` 的去重后顺序是「原样 / 小写 / 首字母大写 / 全大写 /
 * 词形还原」，之前取 2 个，等于永远轮不到词形还原那一段：查 running 时只试了
 * running 和 Running，run 根本没被查——「词形变化查不到」就是这么来的。
 * 取 5 个正好覆盖前四种大小写变体加至少一个词形候选；查询本身走 reader 内的
 * Map / 索引缓存，多试几次的代价远小于查不到。
 */
const MAX_CANDIDATES = 5;
const MAX_DEFINITION_LEN = 260;

interface LookupHit {
  word: string;
  lines: string[];
}

const stripMarkup = (value: string): string =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DEFINITION_LEN);

/** 拉丁字母按词切；中文按连续汉字串，长串再按 2 字切以覆盖词表词条。 */
const tokenize = (text: string): string[] => {
  const out: string[] = [];
  const latin = text.match(/[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'’-]*/g) ?? [];
  const hanRuns = text.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const word of latin) out.push(word);
  for (const run of hanRuns) {
    if (run.length <= 6) {
      out.push(run);
    } else {
      out.push(run.slice(0, 6));
      for (let i = 0; i + 2 <= run.length && i < 30; i += 2) {
        out.push(run.slice(i, i + 2));
      }
    }
  }
  return [...new Set(out.map((word) => word.trim()).filter(Boolean))].slice(0, MAX_WORDS);
};

const lookupOne = async (
  appService: Awaited<ReturnType<typeof environmentConfig.getAppService>>,
  word: string,
  sourceLang?: string,
): Promise<LookupHit | null> => {
  const settings = useSettingsStore.getState().settings;
  // 传 sourceLang 才能走到词形还原（ran → run、mice → mouse）：只对英语类
  // 词典有意义，其它语言 getLemmaCandidates 会直接返回空。
  for (const candidate of buildLookupCandidates(word, sourceLang).slice(0, MAX_CANDIDATES)) {
    const [custom, standard] = await Promise.all([
      lookupWordlists(appService, settings.customWordlists ?? [], candidate).catch(() => []),
      lookupImportedDictionaries(appService, settings.customDictionaries ?? [], candidate).catch(
        () => [],
      ),
    ]);
    const entries = [...custom, ...standard];
    if (entries.length === 0) continue;
    return {
      word: candidate,
      lines: entries
        .slice(0, 3)
        .map((entry) => `· ${entry.dictionaryName}：${stripMarkup(entry.definition)}`),
    };
  }
  return null;
};

const formatResult = (original: string, hits: LookupHit[]): string => {
  if (hits.length === 0) {
    return `${original}\n\n（离线词典未找到词条：请先在 设置 → 语言 → 本地词典 导入词典文件或自定义词表）`;
  }
  return hits.map((hit) => `【${hit.word}】\n${hit.lines.join('\n')}`).join('\n\n');
};

export const localDictionaryProvider: TranslationProvider = {
  name: 'local-dictionary',
  label: _('本地词典（离线）'),
  translate: async (texts: string[], sourceLang?: string): Promise<string[]> => {
    if (!texts.length) return [];
    const appService = await environmentConfig.getAppService();
    const results: string[] = [];
    // 串行处理：词典查询本身已有 reader 缓存，串行可避免同时打开多个
    // 大词典文件（尤其是 MDict）造成移动端内存峰值。
    for (const text of texts) {
      if (!text?.trim()) {
        results.push(text);
        continue;
      }
      const hits: LookupHit[] = [];
      for (const word of tokenize(text)) {
        const hit = await lookupOne(appService, word, sourceLang);
        if (hit) hits.push(hit);
      }
      results.push(formatResult(text, hits));
    }
    return results;
  },
};
