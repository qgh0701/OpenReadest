import { CFI } from '@/libs/document';

import { DEVICE_LOCAL_BOOK_FIELDS } from './deviceFields';

type JsonRecord = Record<string, unknown>;

export type WebDavJsonContentMergeResult = {
  kind: 'library' | 'book-config';
  value: unknown;
  text: string;
};

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown | null => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isJsonRecord(value)) return value;

  return Object.keys(value)
    .sort()
    .reduce<JsonRecord>(
      (result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      },
      Object.create(null) as JsonRecord,
    );
};

const stableStringify = (value: unknown): string => JSON.stringify(canonicalize(value));

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const numericVersion = (record: JsonRecord, fields: string[]): number =>
  fields.reduce((version, field) => {
    const value = record[field];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(version, value) : version;
  }, 0);

const pickRecord = (
  a: JsonRecord,
  b: JsonRecord,
  versionFields: string[],
  tieValue: (record: JsonRecord) => unknown = (record) => record,
): JsonRecord => {
  const aVersion = numericVersion(a, versionFields);
  const bVersion = numericVersion(b, versionFields);
  if (aVersion !== bVersion) return aVersion > bVersion ? a : b;

  return stableStringify(tieValue(a)) >= stableStringify(tieValue(b)) ? a : b;
};

const indexUniqueRecords = (value: unknown, key: string): Map<string, JsonRecord> | null => {
  if (!Array.isArray(value)) return null;

  const records = new Map<string, JsonRecord>();
  for (const item of value) {
    if (!isJsonRecord(item)) return null;
    const id = item[key];
    if (typeof id !== 'string' || !id.trim() || records.has(id)) return null;
    records.set(id, item);
  }
  return records;
};

const mergeRecordMaps = (
  local: Map<string, JsonRecord>,
  remote: Map<string, JsonRecord>,
  versionFields: string[],
  backfillFields?: readonly string[],
): JsonRecord[] => {
  const ids = [...new Set([...local.keys(), ...remote.keys()])].sort(compareStrings);
  return ids.map((id) => {
    const localRecord = local.get(id);
    const remoteRecord = remote.get(id);
    if (!localRecord) return remoteRecord!;
    if (!remoteRecord) return localRecord;
    const winner = pickRecord(localRecord, remoteRecord, versionFields);
    if (winner !== remoteRecord || !backfillFields) return winner;
    // library 合并专用（Part 4.3）：远端记录是剥离过设备本地字段的上传产物，
    // 远端胜出整体返回时会把本设备自己的 filePath/downloadedAt 等一并丢掉——
    // 本地已下载的书退化为"未下载"，本地导入的书甚至无法再打开。把本地记录
    // 中确实存在的设备本地字段回填到胜出结果。回填按固定字段清单序进行、
    // 只依赖两端记录本身，同一输入恒同输出（确定性，不引入指纹抖动）。
    // 远端侧到达这里前已被引擎剥离（stripSyncJson），不会携带其他设备的
    // 设备字段，回填只会重新挂上本设备自己的值。
    const backfilled: JsonRecord = { ...winner };
    for (const field of backfillFields) {
      if (field in localRecord) backfilled[field] = localRecord[field];
    }
    return backfilled;
  });
};

// library.json 条目级合并语义（Part 4.1 墓碑删除）：
// - 墓碑数据形态：{ ...book, deletedAt: <毫秒时间戳> }，与本地 Book.deletedAt
//   一致；删书时引擎把本地 library.json 的墓碑条目原样上传到远端索引，
//   而非直接移除条目（远端也保留墓碑，防止旧设备的活条目复活已删书）。
// - 墓碑优先：同 hash 的墓碑条目（deletedAt）晚于对方 live 条目的
//   updatedAt/deletedAt 时，墓碑胜出（视为已删）。
// - 保留复活路径：本地重新导入同 hash 书（live 条目 updatedAt 更新）后，
//   新条目胜出，墓碑被清除并重新上传，与 engine 的条目级墓碑复活逻辑
//   （P1-1）打通。
// - 双端并发：双方都是墓碑 → 较新 deletedAt 胜出（墓碑保持，不复活）；
//   一方墓碑一方新条目 → 更新者胜（新条目复活 / 墓碑删除）。
// - 兼容旧数据：无 deletedAt 字段的条目即为 live 条目，正常解析合并。
const mergeLibrary = (local: unknown, remote: unknown): JsonRecord[] | null => {
  const localBooks = indexUniqueRecords(local, 'hash');
  const remoteBooks = indexUniqueRecords(remote, 'hash');
  if (!localBooks || !remoteBooks) return null;

  return mergeRecordMaps(
    localBooks,
    remoteBooks,
    ['updatedAt', 'lastUpdated', 'deletedAt'],
    DEVICE_LOCAL_BOOK_FIELDS,
  );
};

const hasValidOptionalId = (config: JsonRecord, key: string): boolean => {
  if (!(key in config)) return true;
  const value = config[key];
  return value === null || (typeof value === 'string' && !!value.trim());
};

const getOptionalId = (config: JsonRecord, key: string): string | undefined => {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const withoutBooknotes = (config: JsonRecord): JsonRecord => {
  const { booknotes: _booknotes, ...rest } = config;
  return rest;
};

/**
 * 合并「阅读进度」字段（location / progress / xpointer），不改动其它配置。
 *
 * 两个必须在这里保证的不变式：
 *
 * 1. **一端缺失就取另一端。** 跨设备最常见形态是：一端读过（有 location），另一端
 *    从未读过（config 只有 `updatedAt: 0`）。按 updatedAt 取 winner 时，没读过的
 *    那端只要发生过一次自动落盘就会被判「更新」而胜出，位置随之丢失；合并结果再
 *    上传，云端进度就被洗成空——「同步一次，进度反而没了」。
 * 2. **位置只进不退。** 阅读位置是单调累积的事实，不该参与「谁 updatedAt 更新」的
 *    竞争。两端都有位置时取更靠后的那一端，避免旧设备把进度整体拉回前面。
 *    需要「以本机为准强行回退」时走 pushBookConfig 的 force 分支（它直接覆盖
 *    location，不经过这里）。
 */
const mergeProgressFields = (merged: JsonRecord, local: JsonRecord, remote: JsonRecord) => {
  const localLocation = local['location'];
  const remoteLocation = remote['location'];
  const localValid = typeof localLocation === 'string' && !!localLocation;
  const remoteValid = typeof remoteLocation === 'string' && !!remoteLocation;

  let source: JsonRecord | null = null;
  if (localValid && remoteValid) {
    let localAhead = true;
    try {
      localAhead = CFI.compare(localLocation, remoteLocation) >= 0;
    } catch {
      // CFI 不可比（格式差异）：按本地为准，至少不会把本机进度丢给一段无法解析的字符串
      localAhead = true;
    }
    source = localAhead ? local : remote;
  } else if (localValid) {
    source = local;
  } else if (remoteValid) {
    source = remote;
  }

  if (!source) return;
  merged['location'] = source['location'];
  if (source['progress'] !== undefined) merged['progress'] = source['progress'];
  const xpointer = source['xpointer'];
  if (typeof xpointer === 'string' && !!xpointer) merged['xpointer'] = xpointer;
};

const mergeBookConfig = (local: unknown, remote: unknown): JsonRecord | null => {
  if (!isJsonRecord(local) || !isJsonRecord(remote)) return null;
  if (!hasValidOptionalId(local, 'bookHash') || !hasValidOptionalId(remote, 'bookHash')) {
    return null;
  }

  const localBookHash = getOptionalId(local, 'bookHash');
  const remoteBookHash = getOptionalId(remote, 'bookHash');
  if (localBookHash && remoteBookHash && localBookHash !== remoteBookHash) return null;

  // 纯阅读的书（无批注）生成的 config.json 根本不含 booknotes 字段，只有
  // updatedAt / viewSettings / searchConfig / progress / location。此前两侧都
  // 缺该字段时直接 return null，内容合并失败 → manual 策略下记为冲突并跳过
  // 整个 config.json → 阅读进度永远同步不过来。缺失字段按空数组处理即可
  // 走下方「按 updatedAt 合并标量」的分支。
  const localNotes = indexUniqueRecords('booknotes' in local ? local['booknotes'] : [], 'id');
  const remoteNotes = indexUniqueRecords('booknotes' in remote ? remote['booknotes'] : [], 'id');
  if (!localNotes || !remoteNotes) return null;

  if (localNotes.size === 0 && remoteNotes.size === 0) {
    // 无批注书籍（两侧 booknotes 均为空或缺失）此前直接返回 null，导致进度
    // 等标量字段永远无法内容合并，只能落入单边覆盖或手动冲突——纯阅读的
    // 书（大多数场景）进度同步由此反复互踩。改为：标量字段按 updatedAt 取
    // 新方，booknotes 合并为空数组，使这类书也能走内容合并路径。
    const winner = pickRecord(local, remote, ['updatedAt'], withoutBooknotes);
    const loser = winner === local ? remote : local;
    const merged: JsonRecord = { ...winner };
    for (const identityKey of ['bookHash', 'metaHash']) {
      if (!getOptionalId(merged, identityKey)) {
        const fallback = getOptionalId(loser, identityKey);
        if (fallback) merged[identityKey] = fallback;
      }
    }
    mergeProgressFields(merged, local, remote);
    merged['booknotes'] = [];
    return merged;
  }

  const winner = pickRecord(local, remote, ['updatedAt'], withoutBooknotes);
  const loser = winner === local ? remote : local;
  const merged: JsonRecord = { ...winner };

  for (const identityKey of ['bookHash', 'metaHash']) {
    if (!getOptionalId(merged, identityKey)) {
      const fallback = getOptionalId(loser, identityKey);
      if (fallback) merged[identityKey] = fallback;
    }
  }

  mergeProgressFields(merged, local, remote);
  merged['booknotes'] = mergeRecordMaps(localNotes, remoteNotes, ['updatedAt', 'deletedAt']);
  return merged;
};

const makeResult = (
  kind: WebDavJsonContentMergeResult['kind'],
  value: unknown,
): WebDavJsonContentMergeResult => {
  const text = stableStringify(value);
  return { kind, value: JSON.parse(text) as unknown, text };
};

export const mergeWebDavJsonContent = (
  path: string,
  localText: string,
  remoteText: string,
): WebDavJsonContentMergeResult | null => {
  const normalizedPath = path.replaceAll('\\', '/').toLowerCase();
  const local = parseJson(localText);
  const remote = parseJson(remoteText);
  if (local === null || remote === null) return null;

  if (normalizedPath === 'library.json' || normalizedPath.endsWith('/library.json')) {
    const value = mergeLibrary(local, remote);
    return value ? makeResult('library', value) : null;
  }

  if (normalizedPath.endsWith('/config.json')) {
    const value = mergeBookConfig(local, remote);
    return value ? makeResult('book-config', value) : null;
  }

  return null;
};
