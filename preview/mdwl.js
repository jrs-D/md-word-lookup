// 注入到 VS Code Markdown 预览（vscode.markdown.preview.editor）里的划词查词脚本。
// 预览是 webview，扩展进程无法直接操作，所以词库随 dict-data.js 一起下发，本文件只做查询与 UI。
(function () {
  'use strict';

  if (window.__MDWL_ACTIVE__) {
    return;
  }

  function start(DATA) {
    var entries = DATA.e;
    var CFG = DATA.cfg || {};
    var STOPWORDS = buildStopwords(typeof CFG.stopwords === 'string' ? CFG.stopwords : DEFAULT_STOPWORDS);
    var MAX_WORDS = CFG.maxWords > 0 ? Math.floor(CFG.maxWords) : 12;
    var FORM_LABELS = {
      p: '过去式',
      d: '过去分词',
      i: '现在分词',
      3: '第三人称单数',
      s: '复数',
      r: '比较级',
      t: '最高级',
    };
    var has = function (obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    };

    // 变形 -> [原形, 变形说明]
    var inflections = Object.create(null);
    for (var word in entries) {
      var exchange = entries[word][2];
      if (!exchange) {
        continue;
      }
      var parts = exchange.split('/');
      for (var i = 0; i < parts.length; i++) {
        var colon = parts[i].indexOf(':');
        if (colon <= 0) {
          continue;
        }
        var form = parts[i]
          .slice(colon + 1)
          .trim()
          .toLowerCase();
        if (!form || !/^[a-z][a-z'-]*$/.test(form)) {
          continue;
        }
        if (has(entries, form) || inflections[form]) {
          continue;
        }
        inflections[form] = [word, FORM_LABELS[parts[i].slice(0, colon)] || ''];
      }
    }

    function normalize(raw) {
      var text = String(raw == null ? '' : raw)
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) {
        return '';
      }
      text = text.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z']+$/, '');
      text = text.replace(/[\u2018\u2019]/g, "'").toLowerCase();
      if (!text || text.length > 64) {
        return '';
      }
      if (!/^[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,2}$/.test(text)) {
        return '';
      }
      if (text.replace(/[^a-z]/g, '').length < 2) {
        return '';
      }
      return text;
    }

    function candidates(word) {
      var out = [];
      var add = function (value) {
        if (value.length > 1 && value !== word && out.indexOf(value) < 0) {
          out.push(value);
        }
      };
      if (/ies$/.test(word)) {
        add(word.slice(0, -3) + 'y');
      }
      if (/es$/.test(word)) {
        add(word.slice(0, -2));
        add(word.slice(0, -1));
      }
      if (/s$/.test(word) && !/ss$/.test(word)) {
        add(word.slice(0, -1));
      }
      if (/ied$/.test(word)) {
        add(word.slice(0, -3) + 'y');
      }
      if (/ed$/.test(word)) {
        add(word.slice(0, -1));
        add(word.slice(0, -2));
        if (word.length > 4 && word[word.length - 3] === word[word.length - 4]) {
          add(word.slice(0, -3));
        }
      }
      if (/ing$/.test(word)) {
        add(word.slice(0, -3));
        add(word.slice(0, -3) + 'e');
        if (word.length > 5 && word[word.length - 4] === word[word.length - 5]) {
          add(word.slice(0, -4));
        }
      }
      if (/iest$/.test(word)) {
        add(word.slice(0, -4) + 'y');
      } else if (/ier$/.test(word)) {
        add(word.slice(0, -3) + 'y');
      }
      if (/est$/.test(word)) {
        add(word.slice(0, -3));
        add(word.slice(0, -2));
      } else if (/er$/.test(word)) {
        add(word.slice(0, -2));
        add(word.slice(0, -1));
      }
      if (/ly$/.test(word)) {
        add(word.slice(0, -2));
        add(word.slice(0, -2) + 'le');
      }
      return out;
    }

    function lookup(raw) {
      var query = normalize(raw);
      if (!query) {
        return null;
      }
      if (has(entries, query)) {
        return { query: query, base: query };
      }
      var inflected = inflections[query];
      if (inflected) {
        return { query: query, base: inflected[0], label: inflected[1] };
      }
      var guesses = candidates(query);
      for (var i = 0; i < guesses.length; i++) {
        if (has(entries, guesses[i])) {
          return { query: query, base: guesses[i] };
        }
      }
      return null;
    }

    function translationLines(translation) {
      var lines = String(translation || '')
        .split('\n')
        .map(function (line) {
          return line.trim();
        })
        .filter(Boolean);
      var primary = lines.filter(function (line) {
        return line.indexOf('[网络]') !== 0 && line.indexOf('[计]') !== 0;
      });
      return (primary.length ? primary : lines).slice(0, 4);
    }

    // 多词划选时跳过的英语虚词：读者不需要查 the/to/of。
    // 可被 dict-data.js 里的 cfg.stopwords 覆盖（空格分隔，留空字符串即不过滤）。
    var DEFAULT_STOPWORDS =
      'a an the and or but if then than that this these those there here of in on at to from for with without by ' +
      'as is am are was were be been being do does did done have has had having will would shall should can could ' +
      'may might must not no nor so such very too also just only into onto about above after again against all any ' +
      'because before below between both down during each few more most other some up out over under while who whom ' +
      'whose which what when where why how it its he she they them his her their we us you your i me my our ours ' +
      'yours theirs him hers';

    function buildStopwords(text) {
      var map = Object.create(null);
      String(text || '')
        .split(/\s+/)
        .forEach(function (w) {
          if (w) {
            map[w] = true;
          }
        });
      return map;
    }

    /* ---- 选区位置信息：判断首尾 token 是否被选区边界切断 ---- */

    function deepestText(node, dir) {
      var cur = node;
      var guard = 0;
      while (cur && guard++ < 200) {
        if (cur.nodeType === 3) {
          return cur;
        }
        var kids = cur.childNodes;
        if (!kids || !kids.length) {
          return null;
        }
        cur = dir < 0 ? kids[kids.length - 1] : kids[0];
      }
      return null;
    }

    function siblingTextNode(node, dir) {
      var cur = node;
      var guard = 0;
      while (cur && guard++ < 500) {
        var sib = dir < 0 ? cur.previousSibling : cur.nextSibling;
        while (sib) {
          var t = deepestText(sib, dir);
          if (t) {
            return t;
          }
          sib = dir < 0 ? sib.previousSibling : sib.nextSibling;
        }
        cur = cur.parentNode;
        if (!cur || cur === document.body) {
          return null;
        }
      }
      return null;
    }

    /** 从 (container, offset) 往外取最多 n 个字符；dir=-1 向前、1 向后。 */
    function charsAround(container, offset, dir, n) {
      var point;
      if (!container) {
        return '';
      }
      if (container.nodeType === 3) {
        point = { node: container, offset: offset };
      } else {
        var child = container.childNodes && container.childNodes[dir < 0 ? offset - 1 : offset];
        var t = child && deepestText(child, dir);
        if (!t) {
          return '';
        }
        point = { node: t, offset: dir < 0 ? t.data.length : 0 };
      }

      var out = '';
      var guard = 0;
      while (point && out.length < n && guard++ < 200) {
        var data = point.node.data;
        if (dir < 0) {
          if (point.offset > 0) {
            var take = Math.min(n - out.length, point.offset);
            out = data.slice(point.offset - take, point.offset) + out;
            point.offset -= take;
          }
          if (out.length >= n) {
            break;
          }
          var prev = siblingTextNode(point.node, -1);
          point = prev ? { node: prev, offset: prev.data.length } : null;
        } else {
          if (point.offset < data.length) {
            var take2 = Math.min(n - out.length, data.length - point.offset);
            out += data.slice(point.offset, point.offset + take2);
            point.offset += take2;
          }
          if (out.length >= n) {
            break;
          }
          var next = siblingTextNode(point.node, 1);
          point = next ? { node: next, offset: 0 } : null;
        }
      }
      return out;
    }

    function isWordChar(ch, neighbour) {
      if (!ch) {
        return false;
      }
      if (/[A-Za-z\u2019']/.test(ch)) {
        return true;
      }
      // 连字符后面还接着字母才算词内，以区分 well-known 与 COVID-19 / "- item"
      return ch === '-' && !!neighbour && /[A-Za-z]/.test(neighbour);
    }

    /** 是否跨了多个视觉行。注意跨内联元素时同一行也会返回多个 rect，所以要看垂直位置。 */
    function isMultiline(range) {
      var rects = range.getClientRects();
      if (!rects || rects.length < 2) {
        return false;
      }
      var first = rects[0];
      var last = rects[rects.length - 1];
      var height = first.height || last.height || 20;
      var dy = Math.abs(last.top + (last.height || height) / 2 - (first.top + (first.height || height) / 2));
      return dy > height * 0.6;
    }

    /**
     * 把选区拆成完整单词列表。首尾 token 是否被切断必须靠 DOM 位置判断：
     * 纯文本无法区分半截的 ittee 和完整的 decided。
     */
    function analyzeSelection(selection) {
      var text = selection.toString();
      var range = selection.getRangeAt(0);

      var beforeChar = charsAround(range.startContainer, range.startOffset, -1, 1);
      var afterChars = charsAround(range.endContainer, range.endOffset, 1, 2);
      var startsMid = isWordChar(beforeChar, text.charAt(0));
      var endsMid = isWordChar(afterChars.charAt(0), afterChars.charAt(1));

      var tokens = [];
      var re = /[A-Za-z][A-Za-z\u2019'-]*/g;
      var m;
      while ((m = re.exec(text))) {
        tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
      }

      var complete = [];
      var partial = [];
      tokens.forEach(function (token) {
        var cut = (token.start === 0 && startsMid) || (token.end === text.length && endsMid);
        (cut ? partial : complete).push(token.word);
      });

      var seen = Object.create(null);
      var items = [];
      var stopwords = 0;
      complete.forEach(function (word) {
        var key = word.toLowerCase();
        if (seen[key]) {
          return;
        }
        seen[key] = true;
        var result = lookup(word);
        if (!result) {
          return;
        }
        if (STOPWORDS[key]) {
          stopwords++;
          return;
        }
        items.push({ result: result, word: word });
      });

      // 全是虚词时不交白卷，退回显示全部完整词。
      if (!items.length && complete.length) {
        complete.forEach(function (word) {
          var result = lookup(word);
          if (result) {
            items.push({ result: result, word: word });
          }
        });
        stopwords = 0;
      }

      return {
        items: items,
        complete: complete.length,
        partial: partial,
        stopwords: stopwords,
        multiline: isMultiline(range),
      };
    }

    var card = null;
    var hideTimer = null;

    function hide() {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (card) {
        card.remove();
        card = null;
      }
    }

    function el(tag, style, text) {
      var node = document.createElement(tag);
      if (style) {
        node.style.cssText = style;
      }
      if (text != null) {
        node.textContent = text;
      }
      return node;
    }

    var CARD_STYLE = [
      'position:fixed',
      'z-index:2147483647',
      'box-sizing:border-box',
      'padding:10px 12px',
      'border-radius:6px',
      'border:1px solid var(--vscode-editorWidget-border, #454545)',
      'background:var(--vscode-editorWidget-background, #252526)',
      'color:var(--vscode-editorWidget-foreground, #cccccc)',
      'box-shadow:0 4px 16px rgba(0,0,0,.45)',
      'font:13px/1.6 var(--vscode-font-family, sans-serif)',
      'visibility:hidden',
      'pointer-events:auto',
    ].join(';');

    function positionCard(box, rect) {
      var width = box.offsetWidth;
      var height = box.offsetHeight;
      var left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
      var top = rect.top - height - 8;
      if (top < 8) {
        top = Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - height - 8));
      }
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
      box.style.visibility = 'visible';
    }

    function render(result, rect) {
      hide();
      var data = entries[result.base];
      var box = el('div', CARD_STYLE + ';max-width:360px;min-width:180px');

      var head = el('div', 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap');
      head.appendChild(
        el(
          'span',
          'font-size:15px;font-weight:700;color:var(--vscode-textLink-foreground, #3794ff)',
          result.base,
        ),
      );
      if (data[0]) {
        head.appendChild(el('span', 'opacity:.75;font-size:12px', '/' + data[0] + '/'));
      }
      box.appendChild(head);

      if (result.query !== result.base) {
        box.appendChild(
          el(
            'div',
            'margin-top:2px;opacity:.7;font-size:12px',
            result.query + ' → ' + result.base + (result.label ? '（' + result.label + '）' : ''),
          ),
        );
      }

      var lines = translationLines(data[1]);
      if (lines.length) {
        box.appendChild(el('div', 'margin-top:6px;white-space:pre-wrap', lines.join('\n')));
      }

      var forms = [];
      String(data[2] || '')
        .split('/')
        .forEach(function (part) {
          var colon = part.indexOf(':');
          if (colon <= 0) {
            return;
          }
          var label = FORM_LABELS[part.slice(0, colon)];
          if (label) {
            forms.push(label + ' ' + part.slice(colon + 1));
          }
        });
      if (forms.length) {
        box.appendChild(el('div', 'margin-top:6px;opacity:.7;font-size:12px', forms.join(' · ')));
      }

      document.body.appendChild(box);
      card = box;
      positionCard(box, rect);
    }

    function renderMulti(info, rect) {
      hide();
      var shown = info.items.slice(0, MAX_WORDS);
      var rest = info.items.length - shown.length;

      var box = el('div', CARD_STYLE + ';max-width:420px;min-width:220px;max-height:60vh;overflow:auto');

      var notes = [];
      if (info.partial.length) {
        var cut = info.partial.slice(0, 3).join('、');
        notes.push('已忽略半截词 ' + cut + (info.partial.length > 3 ? ' 等' : ''));
      }
      if (info.stopwords) {
        notes.push('已跳过 ' + info.stopwords + ' 个虚词');
      }
      var head = el('div', 'font-size:11px;opacity:.65;margin-bottom:6px');
      head.textContent = shown.length + ' 个单词' + (notes.length ? ' · ' + notes.join(' · ') : '');
      box.appendChild(head);

      shown.forEach(function (item) {
        var data = entries[item.result.base];
        var row = el(
          'div',
          'display:flex;gap:10px;align-items:baseline;padding:3px 0 3px 0;border-top:1px solid rgba(128,128,128,.18)',
        );

        var left = el('div', 'flex:0 0 auto;min-width:110px');
        left.appendChild(
          el('span', 'font-weight:700;color:var(--vscode-textLink-foreground, #3794ff)', item.result.base),
        );
        if (data[0]) {
          left.appendChild(el('span', 'opacity:.55;font-size:11px;margin-left:4px', '/' + data[0] + '/'));
        }
        if (item.result.query !== item.result.base) {
          left.appendChild(el('span', 'opacity:.5;font-size:11px;margin-left:4px', '← ' + item.word));
        }
        row.appendChild(left);

        var lines = translationLines(data[1]);
        var gloss = lines[0] || '';
        if (gloss.length > 46) {
          gloss = gloss.slice(0, 46) + '…';
        }
        row.appendChild(el('div', 'flex:1 1 auto;opacity:.9', gloss));
        box.appendChild(row);
      });

      if (rest > 0) {
        box.appendChild(
          el('div', 'margin-top:6px;font-size:11px;opacity:.65', '还有 ' + rest + ' 个词未显示'),
        );
      }

      document.body.appendChild(box);
      card = box;
      positionCard(box, rect);
    }

    function currentSelectionRect(selection) {
      if (!selection.rangeCount) {
        return null;
      }
      var range = selection.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        return rect;
      }
      var rects = range.getClientRects();
      return rects.length ? rects[0] : null;
    }

    function handleSelection(forced) {
      var selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        hide();
        return;
      }
      if (card && selection.anchorNode && card.contains(selection.anchorNode)) {
        return;
      }
      var rect = currentSelectionRect(selection);
      if (!rect) {
        hide();
        return;
      }

      var info = analyzeSelection(selection);
      if (!info.complete) {
        // 只选到半截词（如 ittee），没有可查的完整词
        hide();
        return;
      }

      if (info.complete === 1 && info.items.length === 1) {
        render(info.items[0].result, rect);
        return;
      }

      // 多词：默认只在「同一行且不超过 MAX_WORDS」时自动弹出，避免复制长段被打扰；
      // 按 Ctrl+C 时视为明确意图，多行/长选区也显示。
      if (!forced && (info.multiline || info.complete > MAX_WORDS)) {
        hide();
        return;
      }
      if (!info.items.length) {
        hide();
        return;
      }
      renderMulti(info, rect);
    }

    var timer = null;
    function schedule(forced) {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(function () {
        timer = null;
        handleSelection(forced);
      }, 260);
    }

    document.addEventListener(
      'mouseup',
      function () {
        schedule(false);
      },
      true,
    );
    document.addEventListener(
      'keyup',
      function () {
        schedule(false);
      },
      true,
    );
    document.addEventListener(
      'selectionchange',
      function () {
        schedule(false);
      },
      true,
    );
    // Ctrl+C 复制视为明确查词意图：允许跨行、超过上限的选区。
    document.addEventListener(
      'copy',
      function () {
        schedule(true);
      },
      true,
    );
    document.addEventListener(
      'mousedown',
      function (event) {
        if (card && !card.contains(event.target)) {
          hide();
        }
      },
      true,
    );
    document.addEventListener(
      'keydown',
      function (event) {
        if (event.key === 'Escape') {
          hide();
        }
      },
      true,
    );
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide, true);

    // 供离线测试使用，不影响运行时行为。
    window.__MDWL_TEST__ = {
      lookup: lookup,
      normalize: normalize,
      analyzeSelection: analyzeSelection,
      maxWords: MAX_WORDS,
      stopwords: STOPWORDS,
      size: Object.keys(entries).length,
    };
  }

  // 预览里两个脚本的加载顺序不保证，等词库就绪（最多约 10 秒）再启动。
  var attempts = 0;
  (function boot() {
    var data = window.__MDWL_DICT__;
    if (data && data.e) {
      window.__MDWL_ACTIVE__ = true;
      start(data);
      return;
    }
    if (attempts++ < 200) {
      setTimeout(boot, 50);
    }
  })();
})();
