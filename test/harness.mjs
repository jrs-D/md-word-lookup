// 不启动 VS Code 的集成测试：用最小 vscode API 桩加载编译后的扩展，
// 模拟「选中单词 -> 弹出释义」的完整链路。
// 运行：npm run compile && node test/harness.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- vscode API 桩 ---------------- */
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isBefore(other) {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isEqual(other) {
    return this.line === other.line && this.character === other.character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
  contains(position) {
    return !position.isBefore(this.start) && !this.end.isBefore(position);
  }
}
class Selection extends Range {
  constructor(anchor, active) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
  get isEmpty() {
    return this.anchor.isEqual(this.active);
  }
}
class MarkdownString {
  constructor(value = '') {
    this.value = value;
    this.isTrusted = false;
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
}
class Hover {
  constructor(contents, range) {
    this.contents = contents;
    this.range = range;
  }
}

const state = {
  config: {
    autoLookup: true,
    delay: 120,
    languages: ['markdown'],
    showStatusBarHint: true,
    clipboardWatch: true,
    webviewToast: false,
  },
  hoverProvider: undefined,
  selectionListener: undefined,
  windowStateListener: undefined,
  configListener: undefined,
  commands: new Map(),
  executed: [],
  messages: [],
  activeEditor: undefined,
  clipboardText: '',
  statusText: '',
};

const vscodeStub = {
  Position,
  Range,
  Selection,
  MarkdownString,
  Hover,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  window: {
    get activeTextEditor() {
      return state.activeEditor;
    },
    state: { focused: true, active: true },
    onDidChangeTextEditorSelection(listener) {
      state.selectionListener = listener;
      return { dispose() {} };
    },
    onDidChangeWindowState(listener) {
      state.windowStateListener = listener;
      return { dispose() {} };
    },
    createStatusBarItem() {
      return {
        text: '',
        tooltip: '',
        command: '',
        show() {
          state.statusText = this.text;
        },
        hide() {},
        dispose() {},
      };
    },
    showInformationMessage(message) {
      state.messages.push(message);
      return Promise.resolve(undefined);
    },
    setStatusBarMessage(message) {
      state.messages.push(message);
      return { dispose() {} };
    },
  },
  languages: {
    registerHoverProvider(selector, provider) {
      state.hoverProvider = provider;
      return { dispose() {} };
    },
  },
  commands: {
    registerCommand(id, handler) {
      state.commands.set(id, handler);
      return { dispose() {} };
    },
    executeCommand(id, ...args) {
      state.executed.push(id);
      return Promise.resolve(undefined);
    },
  },
  env: {
    clipboard: {
      readText() {
        return Promise.resolve(state.clipboardText);
      },
      writeText(value) {
        state.clipboardText = value;
        return Promise.resolve();
      },
    },
  },
  workspace: {
    getConfiguration() {
      return {
        get(key, fallback) {
          return state.config[key] ?? fallback;
        },
        update() {
          return Promise.resolve();
        },
      };
    },
    onDidChangeConfiguration(listener) {
      state.configListener = listener;
      return { dispose() {} };
    },
  },
};

const originalLoad = require('module')._load;
require('module')._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* ---------------- 文档 / 编辑器桩 ---------------- */
function makeDocument(text, languageId = 'markdown', uri = 'file:///test/note.md') {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  const offsetAt = (position) => lineStarts[position.line] + position.character;
  return {
    uri: { toString: () => uri, fsPath: uri },
    languageId,
    text,
    getText(range) {
      return range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text;
    },
    getWordRangeAtPosition(position, regex) {
      const line = text.slice(
        lineStarts[position.line],
        text.indexOf('\n', lineStarts[position.line]) < 0
          ? undefined
          : text.indexOf('\n', lineStarts[position.line]),
      );
      const global = new RegExp(regex.source, 'g');
      for (const match of line.matchAll(global)) {
        if (position.character >= match.index && position.character <= match.index + match[0].length) {
          return new Range(
            new Position(position.line, match.index),
            new Position(position.line, match.index + match[0].length),
          );
        }
      }
      return undefined;
    },
  };
}

function makeEditor(document, startChar, endChar) {
  const editor = {
    document,
    selection: new Selection(new Position(0, startChar), new Position(0, endChar)),
  };
  return editor;
}

function selectWord(editor, startChar, endChar, kind = vscodeStub.TextEditorSelectionChangeKind.Mouse) {
  state.activeEditor = editor;
  editor.selection = new Selection(new Position(0, startChar), new Position(0, endChar));
  state.selectionListener({ textEditor: editor, selections: [editor.selection], kind });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 断言 ---------------- */
let failures = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      throw new Error('请使用 await 调用异步用例');
    }
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

/* ---------------- 用例 ---------------- */
const { Dictionary, normalizeWord } = require(path.join(projectRoot, 'out', 'dict.js'));
const extension = require(path.join(projectRoot, 'out', 'extension.js'));

console.log('normalizeWord');
test('去掉 Markdown 强调符号与标点', () => {
  assert.equal(normalizeWord('**abandon**'), 'abandon');
  assert.equal(normalizeWord('“Hello,”'), 'hello');
  assert.equal(normalizeWord("  Don't  "), "don't");
});
test('拒绝中文、数字、超长片段', () => {
  assert.equal(normalizeWord('中文'), undefined);
  assert.equal(normalizeWord('a'), undefined);
  assert.equal(normalizeWord('123'), undefined);
  assert.equal(normalizeWord('this is way too many words to look up'), undefined);
});

const dict = Dictionary.load(path.join(projectRoot, 'data', 'dict.json'));
await dict.then((d) => {
  console.log('Dictionary');
  test('词库规模可用', () => assert.ok(d.size > 20000, `只有 ${d.size} 条`));
  test('直接命中', () => {
    const result = d.lookup('abandon');
    assert.equal(result.found, true);
    assert.match(result.entry.translation, /放弃|抛弃/);
  });
  test('大小写不敏感', () => {
    assert.equal(d.lookup('ABANDON').found, true);
  });
  test('不规则变形（took -> take）', () => {
    const result = d.lookup('took');
    assert.equal(result.found, true);
    assert.equal(result.entry.word, 'take');
    assert.equal(result.formLabel, '过去式');
  });
  test('不规则变形（happier -> happy）', () => {
    const result = d.lookup('happier');
    assert.equal(result.found, true);
    assert.equal(result.entry.word, 'happy');
    assert.equal(result.formLabel, '比较级');
  });
  test('不规则变形（went -> go）', () => {
    const result = d.lookup('went');
    assert.equal(result.found, true);
    assert.equal(result.entry.word, 'go');
    assert.equal(result.formLabel, '过去式');
  });
  test('变形词自身也有词条（studies）', () => {
    const result = d.lookup('studies');
    assert.equal(result.found, true);
    assert.match(result.entry.translation, /研究|学习|study/i);
  });
  test('未收录时给出建议', () => {
    const result = d.lookup('progrmming');
    assert.equal(result.found, false);
    assert.ok(Array.isArray(result.suggestions));
  });
  test('介词短语可查', () => {
    const result = d.lookup('in spite of');
    assert.equal(result.found, true);
    assert.match(result.entry.translation, /不管/);
  });
});

console.log('预览注入脚本');
await (async () => {
  const vm = await import('node:vm');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Math,
    JSON,
    Object,
    RegExp,
    String,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.innerWidth = 1200;
  sandbox.innerHeight = 800;
  sandbox.getSelection = () => null;
  sandbox.document = {
    addEventListener() {},
    body: { appendChild() {}, nodeType: 1, childNodes: [], parentNode: null },
    createElement() {
      return { style: {}, textContent: '', appendChild() {}, remove() {}, contains: () => false };
    },
  };
  vm.createContext(sandbox);
  for (const file of ['preview/dict-data.js', 'preview/mdwl.js']) {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, file), 'utf8'), sandbox, { filename: file });
  }
  const preview = sandbox.window.__MDWL_TEST__;

  test('预览脚本自带词库可用', () => {
    assert.ok(preview, '脚本应暴露测试入口');
    assert.ok(preview.size > 50000, `只有 ${preview.size} 条`);
    assert.equal(preview.lookup('abandon').base, 'abandon');
    assert.equal(preview.lookup('Took').base, 'take');
    assert.equal(preview.lookup('took').label, '过去式');
    assert.equal(preview.lookup('中文'), null);
    assert.equal(preview.normalize('**abandon**'), 'abandon');
  });

  /* ---- 多词划选：剔除半截词 + 过滤虚词 ---- */

  const body = sandbox.document.body;

  function textNode(data, parent) {
    const node = {
      nodeType: 3,
      data,
      parentNode: parent,
      childNodes: [],
      previousSibling: null,
      nextSibling: null,
    };
    return node;
  }

  function buildLine(html) {
    const p = { nodeType: 1, childNodes: [], parentNode: body, previousSibling: null, nextSibling: null };
    for (const part of html) {
      const node = typeof part === 'string' ? textNode(part, p) : part;
      p.childNodes.push(node);
    }
    p.childNodes.forEach((node, i) => {
      node.previousSibling = p.childNodes[i - 1] ?? null;
      node.nextSibling = p.childNodes[i + 1] ?? null;
    });
    return p;
  }

  function select(container, start, end, opts = {}) {
    const flat = (() => {
      let out = '';
      (function walk(n) {
        if (n.nodeType === 3) {
          out += n.data;
          return;
        }
        (n.childNodes || []).forEach(walk);
      })(container);
      return out;
    })();

    const abs = (node, offset) => {
      let acc = 0;
      let found = -1;
      (function walk(n) {
        if (found >= 0) {
          return;
        }
        if (n.nodeType === 3) {
          if (n === node) {
            found = acc + offset;
            return;
          }
          acc += n.data.length;
          return;
        }
        (n.childNodes || []).forEach(walk);
      })(container);
      return found;
    };

    const from = abs(start.node, start.offset);
    const to = abs(end.node, end.offset);
    const text = flat.slice(from, to);

    return {
      toString: () => text,
      isCollapsed: from === to,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: start.node,
        startOffset: start.offset,
        endContainer: end.node,
        endOffset: end.offset,
        getClientRects: () => {
          const count = opts.rects ?? 1;
          const step = opts.sameLine ? 0 : 30;
          return Array.from({ length: count }, (_, i) => ({
            top: i * step,
            height: 30,
            left: 0,
            width: 100,
          }));
        },
      }),
    };
  }

  test('拖选两端是半截词时，只保留完整词并跳过虚词', () => {
    const node = textNode('The committee decided to abandon the original proposal.', body);
    const p = buildLine([node]);
    const full = node.data;
    const startText = 'ittee decided to abandon the';
    const s = full.indexOf(startText);
    const info = preview.analyzeSelection(
      select(p, { node, offset: s }, { node, offset: s + startText.length }),
    );
    assert.deepEqual([...info.partial], ['ittee'], '"ittee" 是被切断的半截词');
    assert.deepEqual([...info.items.map((i) => i.result.base)], ['decided', 'abandon']);
    assert.equal(info.stopwords, 2, 'to / the 两个虚词被跳过');
  });

  test('整行全选时半截词为空、虚词被过滤', () => {
    const node = textNode('The committee decided to abandon the original proposal.', body);
    const p = buildLine([node]);
    const info = preview.analyzeSelection(select(p, { node, offset: 0 }, { node, offset: node.data.length }));
    assert.deepEqual([...info.partial], []);
    assert.deepEqual(
      [...info.items.map((i) => i.result.base)],
      ['committee', 'decided', 'abandon', 'original', 'proposal'],
    );
    assert.equal(info.stopwords, 2, 'the / to 被跳过（重复出现的 the 去重后只算一次）');
  });

  test('只选到半截词时不产出任何词', () => {
    const node = textNode('The committee decided.', body);
    const p = buildLine([node]);
    const s = 'The committee decided.'.indexOf('ittee');
    const info = preview.analyzeSelection(select(p, { node, offset: s }, { node, offset: s + 5 }));
    assert.equal(info.complete, 0);
    assert.deepEqual([...info.partial], ['ittee']);
  });

  test('边界跨内联元素（<strong>）也判定正确', () => {
    const before = textNode('decided to ', body);
    const strongText = textNode('abandon', body);
    const strong = {
      nodeType: 1,
      childNodes: [strongText],
      parentNode: null,
      previousSibling: before,
      nextSibling: null,
    };
    strongText.parentNode = strong;
    const after = textNode(' the original', body);
    strong.nextSibling = after;
    after.previousSibling = strong;
    const p = buildLine([before, strong, after]);
    before.nextSibling = strong;

    // 从 strong 里的 "abandon" 末尾选到 "original" 中间
    const info = preview.analyzeSelection(
      select(p, { node: strongText, offset: 0 }, { node: after, offset: 5 }),
    );
    assert.deepEqual([...info.items.map((i) => i.result.base)], ['abandon']);
    assert.equal(info.complete, 2, 'abandon + orig（orig 是半截）');
  });

  test('连字符词被切断时剔除', () => {
    const node = textNode('a well-known fact', body);
    const p = buildLine([node]);
    const s = 2;
    const info = preview.analyzeSelection(select(p, { node, offset: s }, { node, offset: s + 7 }));
    assert.deepEqual([...info.partial], ['well-kn']);
    assert.equal(info.complete, 0);
  });

  test('COVID-19 选前半不算半截词（连字符后是数字）', () => {
    const node = textNode('the COVID-19 outbreak', body);
    const p = buildLine([node]);
    const s = 4;
    const info = preview.analyzeSelection(select(p, { node, offset: s }, { node, offset: s + 5 }));
    assert.deepEqual([...info.partial], [], 'COVID 不应被当作半截词');
    assert.equal(info.complete, 1, 'COVID 应是完整词');
  });

  test('多行选区被标记为 multiline', () => {
    const node = textNode('first line second line', body);
    const p = buildLine([node]);
    const info = preview.analyzeSelection(select(p, { node, offset: 0 }, { node, offset: 15 }, { rects: 3 }));
    assert.equal(info.multiline, true);
  });

  test('同一行被内联元素拆成多段时不算 multiline', () => {
    const node = textNode('some long sentence here', body);
    const p = buildLine([node]);
    const info = preview.analyzeSelection(
      select(p, { node, offset: 0 }, { node, offset: 12 }, { rects: 3, sameLine: true }),
    );
    assert.equal(info.multiline, false);
  });

  test('变形词在多词列表里保留原形提示', () => {
    const node = textNode('he took the book', body);
    const p = buildLine([node]);
    const info = preview.analyzeSelection(select(p, { node, offset: 3 }, { node, offset: 11 }));
    const took = info.items.find((i) => i.result.base === 'take');
    assert.ok(took, 'took 应还原为 take');
    assert.equal(took.word, 'took');
  });

  /* ---- dict-data.js 里的 cfg 段可覆盖默认行为 ---- */

  function loadWithDict(dictObject) {
    const box = {
      console,
      setTimeout,
      clearTimeout,
      Math,
      JSON,
      Object,
      RegExp,
      String,
    };
    box.window = box;
    box.addEventListener = () => {};
    box.innerWidth = 1200;
    box.innerHeight = 800;
    box.getSelection = () => null;
    box.document = {
      addEventListener() {},
      body: { appendChild() {}, nodeType: 1, childNodes: [], parentNode: null },
      createElement() {
        return { style: {}, textContent: '', appendChild() {}, remove() {}, contains: () => false };
      },
    };
    box.__MDWL_DICT__ = dictObject;
    vm.createContext(box);
    vm.runInContext(fs.readFileSync(path.join(projectRoot, 'preview/mdwl.js'), 'utf8'), box, {
      filename: 'preview/mdwl.js',
    });
    return box.window.__MDWL_TEST__;
  }

  const tinyDict = {
    v: 1,
    cfg: { maxWords: 5, stopwords: 'the' },
    e: {
      the: ['', '这', ''],
      to: ['', '到', ''],
      decided: ['', '决定', ''],
      abandon: ['', '放弃', ''],
    },
  };

  test('cfg.maxWords 覆盖默认上限', () => {
    const custom = loadWithDict(tinyDict);
    assert.equal(custom.maxWords, 5);
    assert.equal(preview.maxWords, 12, '默认仍是 12');
  });

  test('cfg.stopwords 覆盖默认虚词表', () => {
    const custom = loadWithDict(tinyDict);
    assert.deepEqual([...Object.keys(custom.stopwords).sort()], ['the']);
    const doc = 'the committee decided to abandon';
    const node2 = {
      nodeType: 3,
      data: doc,
      parentNode: null,
      childNodes: [],
      previousSibling: null,
      nextSibling: null,
    };
    const info = custom.analyzeSelection({
      toString: () => doc,
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: node2,
        startOffset: 0,
        endContainer: node2,
        endOffset: doc.length,
        getClientRects: () => [{ top: 0, height: 30, left: 0, width: 10 }],
      }),
    });
    const bases = [...info.items.map((i) => i.result.base)];
    assert.ok(bases.includes('to'), 'stopwords 被覆盖后 to 不应被过滤');
    assert.ok(!bases.includes('the'), 'the 仍应被过滤');
  });
})();

console.log('扩展集成');
const context = {
  subscriptions: [],
  extensionUri: { fsPath: projectRoot },
};
extension.activate(context);

await testAsync('选中单词后自动弹出释义', async () => {
  const text = 'The quick brown fox jumps over the lazy dog.';
  const start = text.indexOf('jumps');
  const editor = makeEditor(makeDocument(text), start, start + 5);
  state.activeEditor = editor;
  state.executed.length = 0;

  selectWord(editor, start, start + 5);
  await wait(400);

  assert.deepEqual(state.executed, ['editor.action.showHover']);
});

await testAsync('hover 内容包含中文释义，且只在选区范围内生效', async () => {
  const text = 'The quick brown fox jumps over the lazy dog.';
  const start = text.indexOf('jumps');
  const document = makeDocument(text);
  const editor = makeEditor(document, start, start + 5);
  state.activeEditor = editor;
  selectWord(editor, start, start + 5);
  await wait(300);

  const inside = await state.hoverProvider.provideHover(document, new Position(0, start + 2), {
    isCancellationRequested: false,
  });
  assert.ok(inside, '选区内的 hover 不应为空');
  assert.match(inside.contents.value, /jump/);

  const outside = await state.hoverProvider.provideHover(document, new Position(0, 1), {
    isCancellationRequested: false,
  });
  assert.equal(outside, undefined, '选区外的 hover 应为空');

  const justOutside = await state.hoverProvider.provideHover(document, new Position(0, start + 5), {
    isCancellationRequested: false,
  });
  assert.ok(justOutside, '紧邻选区边界的 hover 也应命中（showHover 可能落在边界外一格）');

  const otherDoc = makeDocument(text, 'markdown', 'file:///test/other.md');
  const otherHover = await state.hoverProvider.provideHover(otherDoc, new Position(0, start + 1), {
    isCancellationRequested: false,
  });
  assert.equal(otherHover, undefined, '其他文件不应命中');
});

await testAsync('非 markdown 语言不自动查询', async () => {
  const text = 'The quick brown fox jumps over the lazy dog.';
  const start = text.indexOf('jumps');
  const editor = makeEditor(makeDocument(text, 'plaintext'), start, start + 5);
  state.executed.length = 0;
  selectWord(editor, start, start + 5);
  await wait(300);
  assert.deepEqual(state.executed, []);
});

await testAsync('快捷键查询：未选中时自动取光标下单词', async () => {
  const text = 'The abandon ship.';
  const editor = makeEditor(makeDocument(text), 5, 5);
  state.activeEditor = editor;
  state.executed.length = 0;

  await state.commands.get('mdWordLookup.lookup')();
  assert.deepEqual(state.executed, ['editor.action.showHover']);
  assert.equal(editor.document.getText(editor.selection), 'abandon');
});

await testAsync('查不到的词不弹空卡片，手动查询时给出提示', async () => {
  const text = 'zzqqxx notaword';
  const start = text.indexOf('zzqqxx');
  const editor = makeEditor(makeDocument(text), start, start + 6);
  state.activeEditor = editor;
  state.executed.length = 0;
  state.messages.length = 0;

  await state.commands.get('mdWordLookup.lookup')();
  assert.deepEqual(state.executed, []);
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /未收录/);
});

await testAsync('关闭自动查词后只保留手动触发', async () => {
  state.config.autoLookup = false;
  const text = 'The abandon ship.';
  const start = text.indexOf('abandon');
  const editor = makeEditor(makeDocument(text), start, start + 7);
  state.executed.length = 0;
  selectWord(editor, start, start + 7);
  await wait(300);
  assert.deepEqual(state.executed, []);
  state.config.autoLookup = true;
});

await testAsync('webview 里复制单词后自动出释义', async () => {
  // 模拟焦点在 webview：没有活动文本编辑器
  state.activeEditor = undefined;
  state.messages.length = 0;
  state.clipboardText = 'resilient';
  await wait(900);
  // 默认只更新状态栏，不弹通知（通知不会自动消失，连续查词会堆叠）
  assert.equal(state.messages.length, 0, `默认不应弹通知，实际：${JSON.stringify(state.messages)}`);
  assert.match(state.statusText, /resilient/, '状态栏应显示释义');
});

await testAsync('打开 webviewToast 后才弹通知', async () => {
  state.config.webviewToast = true;
  state.messages.length = 0;
  state.clipboardText = 'serendipity';
  await wait(900);
  assert.equal(state.messages.length, 1, `应有一条通知，实际：${JSON.stringify(state.messages)}`);
  assert.match(state.messages[0], /serendipity/);
  state.config.webviewToast = false;
});

await testAsync('同一单词 3 秒内不重复弹通知', async () => {
  state.config.webviewToast = true;
  const before = state.messages.length;
  state.clipboardText = 'serendipity ';
  await wait(900);
  assert.equal(state.messages.length, before, '重复单词不应再弹通知');
  state.config.webviewToast = false;
});

await testAsync('复制整句不改动剪贴板时不触发', async () => {
  const before = state.messages.length;
  state.clipboardText = 'the quick brown fox jumps over the lazy dog';
  await wait(900);
  assert.equal(state.messages.length, before, '非单词内容不应弹通知');
});

await testAsync('关闭 clipboardWatch 后停止监听', async () => {
  state.config.clipboardWatch = false;
  state.configListener({ affectsConfiguration: (key) => key === 'mdWordLookup.clipboardWatch' });
  const before = state.messages.length;
  state.clipboardText = 'ambiguous';
  await wait(900);
  assert.equal(state.messages.length, before, '关闭后不应再触发');
  state.config.clipboardWatch = true;
});

extension.deactivate();

console.log(failures ? `\n${failures} 个用例失败` : '\n全部用例通过');
process.exit(failures ? 1 : 0);
