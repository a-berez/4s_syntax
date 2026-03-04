const vscode = require('vscode');

/**
 * Определяем границы вопросов:
 * - начало: строка, начинающаяся с "?" или "№"/"№№"
 * - конец: первая пустая строка после вопроса
 */
function provideFoldingRanges(document) {
  const ranges = [];
  const lineCount = document.lineCount;
  let currentStart = null;
  let seenContentAfterStart = false;

  for (let i = 0; i < lineCount; i++) {
    const text = document.lineAt(i).text;
    const trimmed = text.trim();

    const isStart = /^(\?|№№?)(\s+|$)/.test(trimmed);
    const isBlank = trimmed.length === 0;

    if (isStart) {
      // закрываем предыдущий вопрос, если он был
      if (currentStart !== null && seenContentAfterStart && i - 1 > currentStart) {
        ranges.push(
          new vscode.FoldingRange(
            currentStart,
            i - 1,
            vscode.FoldingRangeKind.Region
          )
        );
      }
      currentStart = i;
      seenContentAfterStart = false;
      continue;
    }

    if (currentStart !== null) {
      if (!isBlank) {
        seenContentAfterStart = true;
      } else if (seenContentAfterStart) {
        // пустая строка после содержимого вопроса — конец блока
        const endLine = i - 1;
        if (endLine > currentStart) {
          ranges.push(
            new vscode.FoldingRange(
              currentStart,
              endLine,
              vscode.FoldingRangeKind.Region
            )
          );
        }
        currentStart = null;
        seenContentAfterStart = false;
      }
    }
  }

  // закрываем блок в конце файла, если он не закрыт пустой строкой
  if (currentStart !== null && seenContentAfterStart && lineCount - 1 > currentStart) {
    ranges.push(
      new vscode.FoldingRange(
        currentStart,
        lineCount - 1,
        vscode.FoldingRangeKind.Region
      )
    );
  }

  return ranges;
}

/**
 * Оборачивает выделение(я) в указанный маркер.
 * Если выделения нет — вставляет парные маркеры и ставит курсор внутрь.
 *
 * @param {string} marker
 */
async function wrapSelectionsWith(marker) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  if (doc.languageId !== '4s') return;

  const selections = editor.selections;

  await editor.edit(
    (editBuilder) => {
      for (const sel of selections) {
        if (sel.isEmpty) {
          editBuilder.insert(sel.start, marker + marker);
        } else {
          const selectedText = doc.getText(sel);
          editBuilder.replace(sel, marker + selectedText + marker);
        }
      }
    },
    { undoStopBefore: true, undoStopAfter: true }
  );

  // Обновляем позиции курсоров/выделений после правки
  const newSelections = selections.map((sel) => {
    if (sel.isEmpty) {
      const pos = sel.start.translate(0, marker.length);
      return new vscode.Selection(pos, pos);
    }

    // После replace: добавили marker слева и справа
    const start = sel.start.translate(0, marker.length);
    const end = sel.end.translate(0, marker.length);
    return new vscode.Selection(start, end);
  });

  editor.selections = newSelections;
}

/**
 * Показываем номер вопроса (предварительный, до запуска chgksuite)
 * в CodeLens над строкой с "? ..."
 */
class QuestionNumberCodeLensProvider {
  /**
   * @param {vscode.TextDocument} document
   * @returns {vscode.CodeLens[]}
   */
  provideCodeLenses(document) {
    const lenses = [];
    const lineCount = document.lineCount;
    let currentNumber = 0;
    let pendingOverrideNumber = null;

    for (let i = 0; i < lineCount; i++) {
      const text = document.lineAt(i).text;
      const trimmed = text.trim();

      // Установка счётчика: "№№ 16" перед вопросом
      const manualSetMatch = /^№№\s+(\d+)/.exec(trimmed);
      if (manualSetMatch) {
        const n = parseInt(manualSetMatch[1], 10);
        if (!isNaN(n)) {
          currentNumber = n - 1;
        }
        continue;
      }

      // Однократное переименование номера: "№ 1" — действует только на следующий вопрос
      const singleRenameMatch = /^№\s+(\d+)/.exec(trimmed);
      if (singleRenameMatch) {
        const n = parseInt(singleRenameMatch[1], 10);
        if (!isNaN(n)) {
          pendingOverrideNumber = n;
        }
        continue;
      }

      // Начало вопроса: "? ..." или "?[Раздаточный материал: ...]"
      if (/^\?(\s+|\[|$)/.test(trimmed)) {
        const useOverride = pendingOverrideNumber != null;
        const shownNumber = useOverride ? pendingOverrideNumber : currentNumber + 1;
        if (!useOverride) {
          currentNumber += 1;
        }
        pendingOverrideNumber = null;
        const range = new vscode.Range(i, 0, i, 0);
        const lens = new vscode.CodeLens(range, {
          title: `Вопрос ${shownNumber}`,
          command: '4s.showQuestionNumber',
          arguments: []
        });
        lenses.push(lens);
      }
    }

    return lenses;
  }
}

function getImgContextAtPosition(document, position) {
  const line = document.lineAt(position.line).text;
  const uptoCursor = line.slice(0, position.character);

  // Ищем последнее вхождение "(img " или "(pic: " на строке ДО курсора
  const imgIdx = uptoCursor.lastIndexOf('(img ');
  const picIdx = uptoCursor.lastIndexOf('(pic: ');
  const startIdx = Math.max(imgIdx, picIdx);
  if (startIdx < 0) return null;

  // Если после этого уже закрыли скобку — не наш контекст
  const closedIdx = uptoCursor.indexOf(')', startIdx);
  if (closedIdx !== -1) return null;

  const prefixStart = startIdx + (startIdx === imgIdx ? '(img '.length : '(pic: '.length);
  const rawPrefix = uptoCursor.slice(prefixStart);

  return {
    line,
    prefixStart,
    rawPrefix
  };
}

class ImgFilenameCompletionProvider {
  constructor() {
    this._cacheKey = null;
    this._cacheItems = [];
  }

  async _getWorkspaceImagePaths() {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) return [];

    // Кэшируем по списку корней (обычно он один) + временем не заморачиваемся:
    // VS Code сам умеет заново вызывать completion при необходимости.
    const key = folders.map((f) => f.uri.toString()).join('|');
    if (this._cacheKey === key && this._cacheItems.length > 0) {
      return this._cacheItems;
    }

    const patterns = [
      '**/*.{png,jpg,jpeg,gif,webp,svg}',
      '**/*.{PNG,JPG,JPEG,GIF,WEBP,SVG}'
    ];

    const uris = [];
    for (const pat of patterns) {
      // Ограничим выдачу разумным количеством
      // (обычно картинок немного, но лучше не тормозить)
      const found = await vscode.workspace.findFiles(pat, '**/{node_modules,.git,.venv,venv,dist,build,out,__pycache__}/**', 5000);
      uris.push(...found);
    }

    const relPaths = Array.from(
      new Set(
        uris.map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/'))
      )
    ).sort((a, b) => a.localeCompare(b, 'ru'));

    this._cacheKey = key;
    this._cacheItems = relPaths;
    return relPaths;
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.Position} position
   * @returns {Promise<vscode.CompletionItem[]|vscode.CompletionList|undefined>}
   */
  async provideCompletionItems(document, position) {
    if (document.languageId !== '4s') return;

    const ctx = getImgContextAtPosition(document, position);
    if (!ctx) return;

    const prefix = ctx.rawPrefix.trimStart();
    const prefixNorm = prefix.replace(/\\/g, '/');

    const imagePaths = await this._getWorkspaceImagePaths();

    const suggestions = [];
    for (const rel of imagePaths) {
      if (prefixNorm.length === 0 || rel.toLowerCase().includes(prefixNorm.toLowerCase())) {
        const item = new vscode.CompletionItem(rel, vscode.CompletionItemKind.File);
        item.insertText = rel;
        suggestions.push(item);
        if (suggestions.length >= 200) break;
      }
    }

    return suggestions;
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const foldingProvider = {
    provideFoldingRanges
  };

  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider({ language: '4s' }, foldingProvider)
  );

  const codeLensProvider = new QuestionNumberCodeLensProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: '4s' }, codeLensProvider)
  );

  // регистрируем "пустую" команду, чтобы CodeLens не падали при нажатии
  context.subscriptions.push(
    vscode.commands.registerCommand('4s.showQuestionNumber', () => {
      // ничего не делаем, номер и так виден в титуле CodeLens
      return;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('4s.wrapItalic', () => wrapSelectionsWith('_'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('4s.wrapBold', () => wrapSelectionsWith('__'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('4s.wrapUnderline', () => wrapSelectionsWith('___'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('4s.wrapBoldItalic', () => wrapSelectionsWith('____'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('4s.wrapBoldUnderline', () => wrapSelectionsWith('_____'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('4s.wrapBoldItalicUnderline', () => wrapSelectionsWith('______'))
  );

  const imgCompletionProvider = new ImgFilenameCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: '4s' },
      imgCompletionProvider,
      '/', '.', '_', '-', ' '
    )
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};

