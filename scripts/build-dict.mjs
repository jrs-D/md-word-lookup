// 从 ECDICT (https://github.com/skywind3000/ECDICT, MIT) 的 ecdict.csv 生成扩展内置的
// 精简离线词典 data/dict.json。
//
// 用法：node scripts/build-dict.mjs [ecdict.csv 路径] [--max-rank 50000]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePreviewData } from './preview-data.mjs';
import { parseCsv } from './csv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith('--')) ?? path.join(process.env.TEMP ?? '.', 'ecdict.csv');
const maxRankArg = args[args.indexOf('--max-rank') + 1];
const MAX_RANK = args.includes('--max-rank') ? Number(maxRankArg) : 50000;
const OUT = args.includes('--out')
  ? path.resolve(args[args.indexOf('--out') + 1])
  : path.join(projectRoot, 'data', 'dict.json');
const PREVIEW_OUT = path.join(projectRoot, 'preview', 'dict-data.js');

if (!fs.existsSync(csvPath)) {
  console.error(`找不到 ECDICT csv：${csvPath}`);
  process.exit(1);
}

const startedAt = Date.now();
console.log(`读取 ${csvPath} ...`);
const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
console.log(`解析完成：${rows.length} 行，耗时 ${Date.now() - startedAt}ms`);

const header = rows[0];
const col = (name) => header.indexOf(name);
const IDX = {
  word: col('word'),
  phonetic: col('phonetic'),
  definition: col('definition'),
  translation: col('translation'),
  pos: col('pos'),
  collins: col('collins'),
  oxford: col('oxford'),
  tag: col('tag'),
  bnc: col('bnc'),
  frq: col('frq'),
  exchange: col('exchange'),
};
for (const [name, idx] of Object.entries(IDX)) {
  if (idx < 0) {
    throw new Error(`ECDICT csv 缺少列：${name}`);
  }
}

const WORD_RE = /^[a-z][a-z' -]{0,47}$/;
const cleanup = (value) => (value ?? '').replace(/\\n/g, '\n').replace(/\r/g, '').trim();
const rankOf = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
};

const picked = new Map();
let candidates = 0;

for (let i = 1; i < rows.length; i++) {
  const cells = rows[i];
  if (cells.length < header.length) {
    continue;
  }
  const word = cleanup(cells[IDX.word]).toLowerCase();
  if (!word || word !== word.trim() || !WORD_RE.test(word)) {
    continue;
  }
  const translation = cleanup(cells[IDX.translation]);
  const definition = cleanup(cells[IDX.definition]);
  if (!translation && !definition) {
    continue;
  }

  const rank = Math.min(rankOf(cells[IDX.bnc]), rankOf(cells[IDX.frq]));
  const tagged = cleanup(cells[IDX.tag]).length > 0;
  const collins = Number.parseInt(cells[IDX.collins] ?? '0', 10) || 0;
  const oxford = (cells[IDX.oxford] ?? '').trim().length > 0;
  if (rank > MAX_RANK && !tagged && !collins && !oxford) {
    continue;
  }
  candidates++;

  const priority =
    (rank === Number.POSITIVE_INFINITY ? 10_000_000 : rank) -
    collins * 500 -
    (oxford ? 300 : 0) -
    (tagged ? 200 : 0);
  const entry = [
    word,
    cleanup(cells[IDX.phonetic]),
    translation,
    (cells[IDX.pos] ?? '').trim(),
    cleanup(cells[IDX.exchange]),
    definition,
  ];
  const existing = picked.get(word);
  if (!existing || priority < existing.priority || (!existing.entry[2] && translation)) {
    picked.set(word, { priority, entry });
  }
}

const entries = [...picked.values()]
  .sort((a, b) => a.priority - b.priority || a.entry[0].localeCompare(b.entry[0]))
  .map((item) => item.entry);

const payload = { v: 1, source: 'ECDICT (MIT)', entries };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));

// Markdown 预览里注入的脚本无法访问扩展进程，因此再生成一份自带词库的 JS 文件。
const preview = writePreviewData(entries);

const words = entries.filter((e) => !e[0].includes(' ')).length;
const withTranslation = entries.filter((e) => e[2]).length;
console.log(
  `候选 ${candidates} 条，写入 ${entries.length} 条（单词 ${words}，含中文释义 ${withTranslation}），` +
    `文件 ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB -> ${OUT}`,
);
console.log(`预览词库 ${preview.count} 条，${preview.sizeMb.toFixed(2)} MB -> ${PREVIEW_OUT}`);
