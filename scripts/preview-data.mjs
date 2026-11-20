import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

export const PREVIEW_DATA_FILE = path.join(projectRoot, 'preview', 'dict-data.js');
export const PREVIEW_CONFIG_FILE = path.join(projectRoot, 'preview', 'config.json');

export function readPreviewConfig() {
  if (!fs.existsSync(PREVIEW_CONFIG_FILE)) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(PREVIEW_CONFIG_FILE, 'utf8'));
  const cfg = { maxWords: raw.maxWords, stopwords: raw.stopwords };
  return Object.fromEntries(Object.entries(cfg).filter(([, value]) => value !== undefined));
}

/**
 * 生成注入到 Markdown 预览里的词库脚本。
 * 预览 webview 拿不到扩展进程里的数据，因此词库与配置必须随脚本一起下发。
 * cfg 放在最前面，方便直接改安装目录里的 dict-data.js 调试。
 */
export function writePreviewData(entries, config = readPreviewConfig()) {
  const map = {};
  for (const [word, phonetic, translation, , exchange] of entries) {
    if (translation) {
      map[word] = [phonetic, translation, exchange];
    }
  }
  fs.mkdirSync(path.dirname(PREVIEW_DATA_FILE), { recursive: true });
  const payload = `{"v":1,"cfg":${JSON.stringify(config)},"e":`;
  fs.writeFileSync(PREVIEW_DATA_FILE, `window.__MDWL_DICT__=${payload}${JSON.stringify(map)}};\n`);
  return {
    count: Object.keys(map).length,
    sizeMb: fs.statSync(PREVIEW_DATA_FILE).size / 1024 / 1024,
  };
}

export function readDictEntries(file = path.join(projectRoot, 'data', 'dict.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).entries;
}
