import { v4 as uuidv4 } from 'uuid';
import type { SelectedFile } from '@/hooks/useFileSelector';
import type { AppService } from '@/types/system';
import { getFilename } from '@/utils/path';

/**
 * 用户自己整理的「简易词表」离线词典。
 *
 * 标准词典（StarDict/MDict/DICT/Slob）已由 dictionaryService 完整支持，这里
 * 补的是更轻量的场景：用户手上只有一份「词 → 释义」的 TXT / CSV / TSV /
 * JSON 清单（Anki 导出、自己整理的表、教材词汇表等），不需要打包成词典格式
 * 就能直接导入并用于离线查词/翻译。
 *
 * 文件解析后在 Dictionaries/wordlists/ 下写成规范化的 JSON，查词时用内存
 * Map 缓存，全程不联网、不需要 OCR 或模型。
 */

export interface WordlistDictionary {
  id: string;
  name: string;
  /** Dictionaries BaseDir 下的相对路径 */
  file: string;
  entryCount: number;
  addedAt: number;
  enabled?: boolean;
}

export interface WordlistLookupResult {
  dictionaryId: string;
  dictionaryName: string;
  headword: string;
  definition: string;
  format: 'm';
}

export interface WordlistImportResult {
  imported: WordlistDictionary[];
  /** 解析不出任何有效词条的文件名 */
  skipped: string[];
  /** 同名旧条目被替换掉的 id */
  replacedIds: string[];
}

type Entry = [string, string];

const WORDLIST_DIR = 'wordlists';
const MAX_ENTRIES = 200_000;
const lookupCache = new Map<string, Map<string, string>>();

const sanitizeFileName = (name: string): string => name.replace(/[\\/:]/g, '_');

const toFile = async (
  appService: AppService,
  selected: SelectedFile,
): Promise<{ name: string; file: File }> => {
  if (selected.file) {
    return { name: sanitizeFileName(selected.file.name), file: selected.file };
  }
  if (!selected.path) throw new Error('Wordlist file has no path');
  const file = await appService.openFile(selected.path, 'None');
  return { name: sanitizeFileName(file.name || getFilename(selected.path)), file };
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).trim();
  return trimmed;
};

/** 支持带引号逗号的简易 CSV 单行解析。 */
const splitCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
};

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN_WORD = /^[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'’.\- ]*$/;

/**
 * 「单词 释义」这种最朴素的词表（教材词汇表、自己抄的清单）里没有任何显式
 * 分隔符，只能靠字符类型切：左侧是拉丁词、右侧以汉字开头时，把第一个汉字
 * 之前的部分当词条。这样 `hello 你好`、`give up 放弃`、`apple 苹果，苹果树`
 * 都能解析，而纯英文行（`hello world`，无汉字）不敢乱切，返回 null 由调用方跳过。
 */
const splitByScript = (line: string): string[] | null => {
  const idx = line.search(HAN);
  if (idx <= 0) return null;
  const head = line.slice(0, idx).trim();
  const tail = line.slice(idx).trim();
  if (!head || !tail) return null;
  if (!LATIN_WORD.test(head)) return null;
  return [head, tail];
};

const parseLine = (line: string): Entry | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
  let parts: string[];
  if (trimmed.includes('\t')) parts = trimmed.split('\t');
  else if (trimmed.includes('::')) parts = trimmed.split('::', 2);
  else if (trimmed.includes('=')) parts = trimmed.split('=', 2);
  else if (trimmed.includes('\u3000')) parts = trimmed.split('\u3000', 2);
  else if (/\S {2,}\S/.test(trimmed)) parts = trimmed.split(/ {2,}/, 2);
  else if (trimmed.includes(',')) parts = splitCsvLine(trimmed);
  else parts = splitByScript(trimmed) ?? [];
  if (parts.length < 2) return null;
  const word = unquote(parts[0]!);
  const definition = unquote(parts.slice(1).join(' ')).replace(/\s+/g, ' ');
  return word && definition ? [word, definition] : null;
};

const parseTextWordlist = (text: string): Entry[] => {
  const entries: Entry[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
};

const readStringField = (record: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

const parseJsonWordlist = (text: string): Entry[] => {
  const value: unknown = JSON.parse(text);
  const entries: Entry[] = [];
  const push = (word: string | null, definition: string | null) => {
    if (word && definition) entries.push([word, definition]);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item)) {
        push(
          typeof item[0] === 'string' ? item[0] : null,
          typeof item[1] === 'string' ? item[1] : null,
        );
      } else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        push(
          readStringField(record, ['word', 'term', 'headword', 'key', '单词', '词语']),
          readStringField(record, ['definition', 'meaning', 'translation', 'def', 'value', '释义', '翻译']),
        );
      }
      if (entries.length >= MAX_ENTRIES) break;
    }
  } else if (value && typeof value === 'object') {
    for (const [word, definition] of Object.entries(value as Record<string, unknown>)) {
      if (typeof definition === 'string') push(word, definition);
      if (entries.length >= MAX_ENTRIES) break;
    }
  }
  return entries;
};

const normalize = (entries: Entry[]): Entry[] => {
  const map = new Map<string, string>();
  for (const [word, definition] of entries) {
    const key = word.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, definition.trim());
  }
  return [...map.entries()].map(([word, definition]) => [word, definition] as Entry);
};

export const deleteWordlist = async (
  appService: AppService,
  dictionary: WordlistDictionary,
): Promise<void> => {
  lookupCache.delete(dictionary.id);
  try {
    await appService.deleteFile(dictionary.file, 'Dictionaries');
  } catch {
    // 文件已不存在：缓存仍要清掉，忽略
  }
};

export const clearWordlistCache = (id?: string): void => {
  if (id) lookupCache.delete(id);
  else lookupCache.clear();
};

export const importWordlists = async (
  appService: AppService,
  selected: SelectedFile[],
  existing: WordlistDictionary[],
): Promise<WordlistImportResult> => {
  const imported: WordlistDictionary[] = [];
  const skipped: string[] = [];
  const replacedIds: string[] = [];
  for (const item of selected) {
    const { name, file } = await toFile(appService, item);
    const baseName = name.replace(/\.[^.]+$/, '') || name;
    let entries: Entry[];
    try {
      const text = await file.text();
      entries = name.toLowerCase().endsWith('.json')
        ? parseJsonWordlist(text)
        : parseTextWordlist(text);
    } catch {
      skipped.push(name);
      continue;
    }
    const normalized = normalize(entries);
    if (normalized.length === 0) {
      skipped.push(name);
      continue;
    }
    // 同名旧词表视为同一份的更新：先删旧条目与旧文件，避免越导越多
    for (const old of existing) {
      if (old.name === baseName && !replacedIds.includes(old.id)) {
        replacedIds.push(old.id);
        await deleteWordlist(appService, old);
      }
    }
    const id = uuidv4();
    const target = `${WORDLIST_DIR}/${id}.json`;
    await appService.writeFile(
      target,
      'Dictionaries',
      JSON.stringify({ version: 1, entries: normalized }),
    );
    lookupCache.set(id, new Map(normalized));
    imported.push({
      id,
      name: baseName,
      file: target,
      entryCount: normalized.length,
      addedAt: Date.now(),
    });
  }
  return { imported, skipped, replacedIds };
};

/** 按词精确查已启用的自定义词表；大小写不敏感，结果按导入顺序返回。 */
export const lookupWordlists = async (
  appService: AppService,
  dictionaries: WordlistDictionary[],
  query: string,
): Promise<WordlistLookupResult[]> => {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  const results: WordlistLookupResult[] = [];
  for (const dictionary of dictionaries) {
    if (dictionary.enabled === false) continue;
    let map = lookupCache.get(dictionary.id);
    if (!map) {
      try {
        const text = (await appService.readFile(dictionary.file, 'Dictionaries', 'text')) as string;
        const parsed = JSON.parse(text) as { entries?: unknown };
        const raw = Array.isArray(parsed.entries) ? parsed.entries : [];
        map = new Map<string, string>();
        for (const entry of raw) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'string'
          ) {
            map.set(entry[0].toLowerCase(), entry[1]);
          }
        }
        lookupCache.set(dictionary.id, map);
      } catch {
        continue;
      }
    }
    const definition = map.get(key);
    if (definition) {
      results.push({
        dictionaryId: dictionary.id,
        dictionaryName: dictionary.name,
        headword: query.trim(),
        definition,
        format: 'm',
      });
    }
  }
  return results;
};
