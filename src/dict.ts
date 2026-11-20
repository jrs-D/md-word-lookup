import * as fs from 'fs';

export interface Entry {
  word: string;
  phonetic: string;
  translation: string;
  pos: string;
  exchange: string;
  definition: string;
}

export type LookupResult =
  | { found: true; entry: Entry; query: string; formLabel?: string }
  | { found: false; query: string; suggestions: string[] };

const FORM_LABELS: Record<string, string> = {
  p: '过去式',
  d: '过去分词',
  i: '现在分词',
  '3': '第三人称单数',
  s: '复数',
  r: '比较级',
  t: '最高级',
};

export function formLabel(code: string): string | undefined {
  return FORM_LABELS[code];
}

/** 从 exchange 字段（如 `p:took/d:taken/i:taking`）中取出词形变化。 */
export function parseExchange(exchange: string): Array<{ code: string; form: string }> {
  if (!exchange) {
    return [];
  }
  const result: Array<{ code: string; form: string }> = [];
  for (const part of exchange.split('/')) {
    const idx = part.indexOf(':');
    if (idx <= 0) {
      continue;
    }
    const code = part.slice(0, idx);
    const form = part.slice(idx + 1).trim();
    if (form && /^[A-Za-z][A-Za-z'-]*$/.test(form)) {
      result.push({ code, form });
    }
  }
  return result;
}

/**
 * 把用户选中的文本规范化为可查询的词条：去掉首尾空白与标点（Markdown 的 `**`、括号、逗号等），
 * 只接受 1~3 个英文单词（可含连字符 / 撇号）。返回 undefined 表示这段文本不该被当成单词查询。
 */
export function normalizeWord(raw: string): string | undefined {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) {
    return undefined;
  }
  text = text.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z']+$/, '');
  text = text.replace(/[’‘]/g, "'").toLowerCase();
  if (!text || text.length > 64) {
    return undefined;
  }
  if (!/^[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,2}$/.test(text)) {
    return undefined;
  }
  if (text.replace(/[^a-z]/g, '').length < 2) {
    return undefined;
  }
  return text;
}

/** 词典未收录某变形时的兜底词形还原候选。 */
export function morphologicalCandidates(word: string): string[] {
  const out: string[] = [];
  const add = (candidate: string) => {
    if (candidate.length > 1 && candidate !== word && !out.includes(candidate)) {
      out.push(candidate);
    }
  };

  if (word.endsWith("'s")) {
    add(word.slice(0, -2));
  }
  if (word.endsWith('ies')) {
    add(word.slice(0, -3) + 'y');
  }
  if (word.endsWith('es')) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
  }
  if (word.endsWith('s') && !word.endsWith('ss')) {
    add(word.slice(0, -1));
  }
  if (word.endsWith('ied')) {
    add(word.slice(0, -3) + 'y');
  }
  if (word.endsWith('ed')) {
    add(word.slice(0, -1));
    add(word.slice(0, -2));
    if (word.length > 4 && word[word.length - 3] === word[word.length - 4]) {
      add(word.slice(0, -3));
    }
  }
  if (word.endsWith('ing')) {
    add(word.slice(0, -3));
    add(word.slice(0, -3) + 'e');
    if (word.length > 5 && word[word.length - 4] === word[word.length - 5]) {
      add(word.slice(0, -4));
    }
  }
  if (word.endsWith('iest')) {
    add(word.slice(0, -4) + 'y');
  } else if (word.endsWith('ier')) {
    add(word.slice(0, -3) + 'y');
  }
  if (word.endsWith('est')) {
    add(word.slice(0, -3));
    add(word.slice(0, -2));
  } else if (word.endsWith('er')) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
  }
  if (word.endsWith('ly')) {
    add(word.slice(0, -2));
    add(word.slice(0, -2) + 'le');
  }
  return out;
}

interface DictFile {
  v: number;
  entries: Array<[string, string, string, string, string, string]>;
}

export class Dictionary {
  private readonly entries = new Map<string, Entry>();
  private readonly forms = new Map<string, { word: string; label?: string }>();
  private sortedWords: string[] | undefined;

  private constructor(file: DictFile) {
    for (const [word, phonetic, translation, pos, exchange, definition] of file.entries) {
      if (!word || this.entries.has(word)) {
        continue;
      }
      this.entries.set(word, { word, phonetic, translation, pos, exchange, definition });
      for (const { code, form } of parseExchange(exchange)) {
        const key = form.toLowerCase();
        if (!this.entries.has(key) && !this.forms.has(key)) {
          this.forms.set(key, { word, label: formLabel(code) });
        }
      }
    }
  }

  static fromJSON(raw: string): Dictionary {
    return new Dictionary(JSON.parse(raw) as DictFile);
  }

  static async load(file: string): Promise<Dictionary> {
    return Dictionary.fromJSON(await fs.promises.readFile(file, 'utf8'));
  }

  get size(): number {
    return this.entries.size;
  }

  lookup(raw: string): LookupResult {
    const query = normalizeWord(raw) ?? raw.trim().toLowerCase();
    if (!query) {
      return { found: false, query: raw.trim(), suggestions: [] };
    }

    const direct = this.entries.get(query);
    if (direct) {
      return { found: true, entry: direct, query };
    }

    const inflected = this.forms.get(query);
    if (inflected) {
      const entry = this.entries.get(inflected.word);
      if (entry) {
        return { found: true, entry, query, formLabel: inflected.label };
      }
    }

    for (const candidate of morphologicalCandidates(query)) {
      const entry = this.entries.get(candidate);
      if (entry) {
        return { found: true, entry, query };
      }
    }

    return { found: false, query, suggestions: this.suggest(query) };
  }

  /** 前缀相近的词，用于「没查到，你是不是想找…」。 */
  suggest(query: string, limit = 5): string[] {
    if (query.length < 2) {
      return [];
    }
    if (!this.sortedWords) {
      this.sortedWords = [...this.entries.keys()].sort();
    }
    const words = this.sortedWords;
    let lo = 0;
    let hi = words.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid] < query) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const prefix = query.slice(0, Math.min(3, query.length));
    const out: string[] = [];
    for (let i = lo; i < words.length && out.length < limit; i++) {
      if (!words[i].startsWith(prefix)) {
        break;
      }
      out.push(words[i]);
    }
    return out;
  }
}
