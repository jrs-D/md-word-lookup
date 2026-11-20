import * as path from 'path';
import * as vscode from 'vscode';
import { Dictionary, LookupResult, formLabel, normalizeWord, parseExchange } from './dict';

const HOVER_TTL_MS = 20_000;
const CLIPBOARD_POLL_MS = 350;

let dictionaryPromise: Promise<Dictionary> | undefined;
let lastSelection: { uri: string; range: vscode.Range; text: string; at: number } | undefined;
let autoTimer: NodeJS.Timeout | undefined;
let suppressAutoUntil = 0;
let statusItem: vscode.StatusBarItem | undefined;
let statusTimer: NodeJS.Timeout | undefined;
let clipboardTimer: NodeJS.Timeout | undefined;
let lastClipboardText: string | undefined;
let lastToast: { word: string; at: number } | undefined;

type Found = Extract<LookupResult, { found: true }>;

function config() {
  const cfg = vscode.workspace.getConfiguration('mdWordLookup');
  return {
    autoLookup: cfg.get<boolean>('autoLookup', true),
    delay: Math.min(3000, Math.max(120, cfg.get<number>('delay', 400))),
    languages: cfg.get<string[]>('languages', ['markdown']),
    showHint: cfg.get<boolean>('showStatusBarHint', true),
    clipboardWatch: cfg.get<boolean>('clipboardWatch', true),
    webviewToast: cfg.get<boolean>('webviewToast', false),
  };
}

function isEnabledLanguage(languageId: string): boolean {
  const { languages } = config();
  return languages.includes('*') || languages.includes(languageId);
}

function getDictionary(): Promise<Dictionary> {
  if (!currentContext) {
    return Promise.reject(new Error('md-word-lookup 尚未激活'));
  }
  if (!dictionaryPromise) {
    const file = path.join(currentContext.extensionUri.fsPath, 'data', 'dict.json');
    dictionaryPromise = Dictionary.load(file).catch((err) => {
      dictionaryPromise = undefined;
      throw err;
    });
  }
  return dictionaryPromise;
}

/** 优先使用中文释义，过滤掉 ECDICT 里噪音较多的网络释义。 */
function translationLines(entry: { translation: string }): string[] {
  const lines = entry.translation
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const primary = lines.filter((line) => !line.startsWith('[网络]') && !line.startsWith('[计]'));
  return primary.length ? primary : lines.slice(0, 4);
}

function buildMarkdown(result: Found): vscode.MarkdownString {
  const { entry } = result;
  const md = new vscode.MarkdownString(undefined, false);
  md.isTrusted = false;

  const phonetic = entry.phonetic ? `&nbsp;&nbsp;\`/${entry.phonetic}/\`` : '';
  md.appendMarkdown(`**${entry.word}**${phonetic}\n\n`);

  if (result.query !== entry.word) {
    const label = result.formLabel ? `（${result.formLabel}）` : '';
    md.appendMarkdown(`*${result.query}* → **${entry.word}**${label}\n\n`);
  }

  const lines = translationLines(entry).slice(0, 4);
  if (lines.length) {
    md.appendMarkdown(lines.join('  \n') + '\n\n');
  }

  const definition = entry.definition
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, lines.length ? 2 : 4);
  if (definition.length) {
    md.appendMarkdown(definition.map((line) => `> ${line}`).join('  \n') + '\n\n');
  }

  const forms = parseExchange(entry.exchange).filter((form) => formLabel(form.code));
  if (forms.length) {
    const text = forms.map((form) => `${formLabel(form.code)} \`${form.form}\``).join(' · ');
    md.appendMarkdown(`\`变形\` ${text}\n`);
  }

  return md;
}

function plainText(result: Found): string {
  const lines = translationLines(result.entry);
  const meaning = lines[0] ?? result.entry.definition.split(/\n/)[0] ?? '';
  return `${result.entry.word}${result.entry.phonetic ? ` /${result.entry.phonetic}/` : ''} — ${meaning}`;
}

function showStatusHint(result: Found): void {
  if (!config().showHint) {
    return;
  }
  if (!statusItem) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.command = 'mdWordLookup.lookup';
  }
  const text = plainText(result);
  statusItem.text = `$(book) ${text.length > 70 ? text.slice(0, 70) + '…' : text}`;
  statusItem.tooltip = buildMarkdown(result);
  statusItem.show();

  if (statusTimer) {
    clearTimeout(statusTimer);
  }
  statusTimer = setTimeout(() => statusItem?.hide(), 15_000);
}

function isNearSelection(selection: { range: vscode.Range }, position: vscode.Position): boolean {
  const { start, end } = selection.range;
  if (position.line < start.line || position.line > end.line) {
    return false;
  }
  // showHover 取的是鼠标位置或光标位置，可能正好落在选区边界外一个字符，这里放宽容差。
  if (position.line === start.line && position.character < start.character - 1) {
    return false;
  }
  if (position.line === end.line && position.character > end.character + 1) {
    return false;
  }
  return true;
}

class WordHoverProvider implements vscode.HoverProvider {
  constructor(private readonly getDict: () => Promise<Dictionary>) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const selection = lastSelection;
    if (!selection) {
      return undefined;
    }
    if (selection.uri !== document.uri.toString()) {
      return undefined;
    }
    if (Date.now() - selection.at > HOVER_TTL_MS) {
      return undefined;
    }
    if (!isNearSelection(selection, position)) {
      return undefined;
    }
    if (!isEnabledLanguage(document.languageId)) {
      return undefined;
    }

    const dictionary = await this.getDict();
    if (token.isCancellationRequested) {
      return undefined;
    }
    const result = dictionary.lookup(selection.text);
    if (!result.found) {
      return undefined;
    }
    return new vscode.Hover(buildMarkdown(result), selection.range);
  }
}

async function revealMeaning(editor: vscode.TextEditor, silent: boolean): Promise<void> {
  const selection = editor.selection;
  if (selection.isEmpty) {
    return;
  }
  const text = editor.document.getText(selection);
  const word = normalizeWord(text);
  if (!word) {
    if (!silent) {
      vscode.window.showInformationMessage('划词查词：请选中一个英文单词（仅支持离线英汉词典）。');
    }
    return;
  }

  const dictionary = await getDictionary();
  const result = dictionary.lookup(word);

  if (!result.found) {
    lastSelection = undefined;
    if (silent) {
      return;
    }
    const hint = result.suggestions.length ? ` 你是不是想找：${result.suggestions.join('、')}` : '';
    vscode.window.showInformationMessage(`划词查词：离线词典未收录 “${word}”。${hint}`);
    return;
  }

  if (editor !== vscode.window.activeTextEditor) {
    return;
  }
  if (normalizeWord(editor.document.getText(editor.selection)) !== word) {
    return;
  }

  lastSelection = {
    uri: editor.document.uri.toString(),
    range: new vscode.Range(editor.selection.start, editor.selection.end),
    text: word,
    at: Date.now(),
  };
  showStatusHint(result);

  try {
    await vscode.commands.executeCommand('editor.action.showHover');
  } catch {
    vscode.window.showInformationMessage(plainText(result));
  }
}

let currentContext: vscode.ExtensionContext | undefined;

interface LookupOptions {
  /** 查不到时是否提示 */
  reportMissing?: boolean;
  /** 命中时用右下角通知显示（webview 里没有 hover 可用） */
  toast?: boolean;
}

/** 用一段文本查词。webview 里扩展读不到选区，只能靠剪贴板。 */
async function lookupText(text: string, options: LookupOptions = {}): Promise<boolean> {
  const word = normalizeWord(text);
  if (!word) {
    if (options.reportMissing) {
      vscode.window.showInformationMessage(
        '划词查词：没有读到英文单词。这个界面读不到选区，请先选中单词按 Ctrl+C。'
      );
    }
    return false;
  }

  const dictionary = await getDictionary();
  const result = dictionary.lookup(word);
  if (!result.found) {
    if (options.reportMissing) {
      const hint = result.suggestions.length ? ` 你是不是想找：${result.suggestions.join('、')}` : '';
      vscode.window.showInformationMessage(`划词查词：离线词典未收录 “${word}”。${hint}`);
    }
    return false;
  }

  showStatusHint(result);

  const now = Date.now();
  const repeat = lastToast && lastToast.word === result.entry.word && now - lastToast.at < 3000;
  if (options.toast && !repeat) {
    lastToast = { word: result.entry.word, at: now };
    vscode.window.showInformationMessage(plainText(result));
  }
  return true;
}

async function lookupFromClipboard(): Promise<void> {
  await lookupText(await vscode.env.clipboard.readText(), { reportMissing: true, toast: true });
}

async function pollClipboard(): Promise<void> {
  let text: string;
  try {
    text = await vscode.env.clipboard.readText();
  } catch {
    return;
  }
  if (text === lastClipboardText) {
    return;
  }
  lastClipboardText = text;

  // 文本编辑器内有选区时 hover 已经覆盖，避免重复打扰。
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    return;
  }
  await lookupText(text, { toast: config().webviewToast });
}

function updateClipboardWatch(): void {
  const { clipboardWatch } = config();
  const shouldRun = clipboardWatch && vscode.window.state.focused;

  if (!shouldRun) {
    if (clipboardTimer) {
      clearInterval(clipboardTimer);
      clipboardTimer = undefined;
    }
    return;
  }
  if (clipboardTimer) {
    return;
  }
  void vscode.env.clipboard.readText().then(
    (text) => {
      lastClipboardText = text;
    },
    () => undefined
  );
  clipboardTimer = setInterval(() => void pollClipboard(), CLIPBOARD_POLL_MS);
}


export function activate(context: vscode.ExtensionContext): void {
  currentContext = context;

  context.subscriptions.push(
    vscode.languages.registerHoverProvider('*', new WordHoverProvider(getDictionary)),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const editor = event.textEditor;
      if (editor !== vscode.window.activeTextEditor) {
        return;
      }
      if (!isEnabledLanguage(editor.document.languageId)) {
        return;
      }
      if (event.kind === vscode.TextEditorSelectionChangeKind.Command) {
        return;
      }

      if (autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = undefined;
      }

      const selection = editor.selection;
      if (selection.isEmpty || event.selections.length !== 1) {
        lastSelection = undefined;
        return;
      }
      const word = normalizeWord(editor.document.getText(selection));
      if (!word) {
        lastSelection = undefined;
        return;
      }
      lastSelection = {
        uri: editor.document.uri.toString(),
        range: new vscode.Range(selection.start, selection.end),
        text: word,
        at: Date.now(),
      };

      const { autoLookup, delay } = config();
      if (!autoLookup || Date.now() < suppressAutoUntil) {
        return;
      }
      autoTimer = setTimeout(() => {
        autoTimer = undefined;
        void revealMeaning(editor, true);
      }, delay);
    }),
    vscode.commands.registerCommand('mdWordLookup.lookup', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      if (editor.selection.isEmpty) {
        const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z][A-Za-z'-]*/);
        if (!range) {
          vscode.window.showInformationMessage('划词查词：请先选中一个英文单词。');
          return;
        }
        suppressAutoUntil = Date.now() + 1500;
        editor.selection = new vscode.Selection(range.start, range.end);
      }
      await revealMeaning(editor, false);
    }),
    vscode.commands.registerCommand('mdWordLookup.lookupClipboard', lookupFromClipboard),
    vscode.commands.registerCommand('mdWordLookup.openPreview', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showInformationMessage('划词查词：请先打开一个 Markdown 文件。');
        return;
      }
      await vscode.commands.executeCommand('markdown.showPreviewToSide', editor.document.uri);
    }),
    vscode.commands.registerCommand('mdWordLookup.toggleAutoLookup', async () => {
      const cfg = vscode.workspace.getConfiguration('mdWordLookup');
      const next = !cfg.get<boolean>('autoLookup', true);
      await cfg.update('autoLookup', next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`划词查词：选中即查词已${next ? '开启' : '关闭'}`, 4000);
    }),
    vscode.window.onDidChangeWindowState(() => updateClipboardWatch()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mdWordLookup.clipboardWatch')) {
        updateClipboardWatch();
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      if (autoTimer) {
        clearTimeout(autoTimer);
      }
      if (statusTimer) {
        clearTimeout(statusTimer);
      }
      statusItem?.dispose();
    },
  });

  // 提前把词典读进内存，保证第一次划词也是秒开。
  setTimeout(() => void getDictionary().catch(() => undefined), 1200);

  updateClipboardWatch();
}

export function deactivate(): void {
  lastSelection = undefined;
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
    clipboardTimer = undefined;
  }
}
