// 从 data/dict.json 重新生成预览注入用的词库（不需要 ecdict.csv）。
// 用法：node scripts/build-preview-data.mjs
import { readDictEntries, writePreviewData } from './preview-data.mjs';

const { count, sizeMb } = writePreviewData(readDictEntries());
console.log(`预览词库 ${count} 条，${sizeMb.toFixed(2)} MB`);
