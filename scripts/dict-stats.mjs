// 词库扩容可行性分析：对比不同收录阈值下的词条数与体积。
// 用法：node scripts/dict-stats.mjs [ecdict.csv 路径]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseCsv } from './csv.mjs';

const csvPath = process.argv[2] ?? path.join(process.env.TEMP ?? '.', 'ecdict-full.csv');
if (!fs.existsSync(csvPath)) {
  console.error(`找不到 ECDICT csv：${csvPath}`);
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const header = rows[0];
const col = (name) => header.indexOf(name);
const IDX = {
  word: col('word'),
  phonetic: col('phonetic'),
  definition: col('definition'),
  translation: col('translation'),
  collins: col('collins'),
  oxford: col('oxford'),
  tag: col('tag'),
  bnc: col('bnc'),
  frq: col('frq'),
  exchange: col('exchange'),
};

const WORD_RE = /^[a-z][a-z' -]{0,47}$/;
const cleanup = (v) => (v ?? '').replace(/\\n/g, '\n').replace(/\r/g, '').trim();
const rankOf = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
};
const kb = (bytes) => (bytes / 1024).toFixed(0);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);

const base = [];
for (let i = 1; i < rows.length; i++) {
  const cells = rows[i];
  if (cells.length < header.length) {
    continue;
  }
  const word = cleanup(cells[IDX.word]).toLowerCase();
  if (!word || !WORD_RE.test(word)) {
    continue;
  }
  const translation = cleanup(cells[IDX.translation]);
  const definition = cleanup(cells[IDX.definition]);
  if (!translation && !definition) {
    continue;
  }
  base.push({
    word,
    phonetic: cleanup(cells[IDX.phonetic]),
    translation,
    definition,
    exchange: cleanup(cells[IDX.exchange]),
    collins: Number.parseInt(cells[IDX.collins] ?? '0', 10) || 0,
    oxford: (cells[IDX.oxford] ?? '').trim().length > 0,
    tagged: cleanup(cells[IDX.tag]).length > 0,
    rank: Math.min(rankOf(cells[IDX.bnc]), rankOf(cells[IDX.frq])),
  });
}

console.log(`CSV 共 ${rows.length - 1} 行，通过基础校验的 ${base.length} 条\n`);

function previewMap(list, lean) {
  const map = {};
  for (const e of list) {
    if (!e.translation) {
      continue;
    }
    if (lean) {
      const first = e.translation.split('\n')[0].trim().slice(0, 60);
      map[e.word] = e.phonetic && e.phonetic.length <= 20 ? [e.phonetic, first] : [first];
    } else {
      map[e.word] = [e.phonetic, e.translation, e.exchange];
    }
  }
  return map;
}

const variants = [
  { name: 'rank ≤ 50000（当前）', keep: (e) => e.rank <= 50000 || e.tagged || e.collins || e.oxford },
  {
    name: '仅单词（去掉 35 万短语）',
    keep: (e) => !e.word.includes(' '),
  },
  {
    name: '仅单词 + 非纯网络释义',
    keep: (e) => !e.word.includes(' ') && !/^\[网络\]/.test(e.translation),
  },
  { name: '全部（不限词频）', keep: () => true },
];

const table = variants.map((v) => {
  const list = base.filter(v.keep);
  const dictBytes = Buffer.byteLength(
    JSON.stringify({
      v: 1,
      entries: list.map((e) => [e.word, e.phonetic, e.translation, '', e.exchange, e.definition]),
    }),
  );
  const fullJson = JSON.stringify(previewMap(list, false));
  const leanJson = JSON.stringify(previewMap(list, true));
  return {
    name: v.name,
    count: list.length,
    dictBytes,
    previewBytes: Buffer.byteLength(fullJson),
    previewGzip: zlib.gzipSync(Buffer.from(fullJson), { level: 9 }).length,
    leanBytes: Buffer.byteLength(leanJson),
    leanGzip: zlib.gzipSync(Buffer.from(leanJson), { level: 9 }).length,
  };
});

console.log('| 方案 | 词条数 | dict.json | 预览 JS | 预览 gzip | 精简预览 | 精简 gzip |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of table) {
  console.log(
    `| ${r.name} | ${r.count.toLocaleString()} | ${mb(r.dictBytes)} MB | ${mb(r.previewBytes)} MB | ` +
      `${mb(r.previewGzip)} MB | ${mb(r.leanBytes)} MB | ${mb(r.leanGzip)} MB |`,
  );
}

const current = table[0];
const all = table[table.length - 1];
console.log(
  `\n全量是当前的 ${(all.count / current.count).toFixed(1)} 倍词条，` +
    `预览体积 ${(all.previewBytes / current.previewBytes).toFixed(1)} 倍；` +
    `精简后 ${kb(all.leanBytes)} KB（gzip ${kb(all.leanGzip)} KB）。`,
);
