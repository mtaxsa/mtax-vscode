import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class Position {
    constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
    constructor(a, b, c, d) {
        this.start = typeof a === 'number' ? new Position(a, b) : a;
        this.end = typeof a === 'number' ? new Position(c, d) : b;
    }
}
class MarkdownString {
    constructor(value = '') { this.value = value; }
    appendMarkdown(v) { this.value += v; return this; }
    appendCodeblock(v, lang = '') { this.value += `\n\`\`\`${lang}\n${v}\n\`\`\`\n`; return this; }
}
class SnippetString { constructor(value = '') { this.value = value; } }
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class Diagnostic {
    constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; }
}
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
class SignatureHelp { constructor() { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0; } }
class SignatureInformation { constructor(label) { this.label = label; this.parameters = []; } }
class ParameterInformation { constructor(label, doc) { this.label = label; this.documentation = doc; } }
class EventEmitter {
    constructor() { this.listeners = []; }
    get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
    fire(value) { for (const l of this.listeners) l(value); }
    dispose() {}
}
class DocumentLink { constructor(range, target) { this.range = range; this.target = target; } }
class Location { constructor(uri, range) { this.uri = uri; this.range = range; } }
class DocumentHighlight { constructor(range, kind) { this.range = range; this.kind = kind; } }
class DocumentSymbol {
    constructor(name, detail, kind, range, selectionRange) {
        this.name = name; this.detail = detail; this.kind = kind;
        this.range = range; this.selectionRange = selectionRange; this.children = [];
    }
}
class SymbolInformation {
    constructor(name, kind, containerName, location) {
        this.name = name; this.kind = kind; this.containerName = containerName; this.location = location;
    }
}
class SemanticTokensLegend {
    constructor(types, modifiers) { this.tokenTypes = types; this.tokenModifiers = modifiers; }
}
class SemanticTokensBuilder {
    constructor(legend) { this.legend = legend; this.tokens = []; }
    push(line, char, length, type, modifiers) {
        this.tokens.push({ line, char, length, type: this.legend.tokenTypes[type], modifiers });
    }
    build() { return { tokens: this.tokens }; }
}
class TextEdit {
    constructor(range, newText) { this.range = range; this.newText = newText; }
    static replace(range, newText) { return new TextEdit(range, newText); }
}
class WorkspaceEdit {
    constructor() { this.edits = new Map(); }
    replace(uri, range, newText) {
        const list = this.edits.get(uri.fsPath) ?? [];
        list.push(new TextEdit(range, newText));
        this.edits.set(uri.fsPath, list);
    }
    set(uri, edits) { this.edits.set(uri.fsPath, edits); }
}

const registered = { completion: [], hover: [], signature: [], codeActions: [], links: [], commands: new Map() };
const diagnosticsByUri = new Map();

const settings = new Map();
{
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const [key, value] of Object.entries(pkg.contributes.configuration.properties)) {
        if ('default' in value) settings.set(key.replace(/^mtax\./, ''), value.default);
    }
}

const vscodeStub = {
    Position, Range, MarkdownString, SnippetString, CompletionItem, Diagnostic, CodeAction,
    Hover, SignatureHelp, SignatureInformation, ParameterInformation, EventEmitter, DocumentLink,
    TextEdit, WorkspaceEdit, Location, DocumentHighlight, DocumentSymbol, SymbolInformation,
    SemanticTokensLegend, SemanticTokensBuilder,
    CompletionItemKind: new Proxy({}, { get: (_, k) => String(k) }),
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeActionKind: { QuickFix: 'quickfix' },
    SymbolKind: new Proxy({}, { get: (_, k) => String(k) }),
    DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Workspace: 2 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    ProgressLocation: { Notification: 15 },
    FileType: { File: 1, Directory: 2 },
    Uri: {
        file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}`, path: p }),
        parse: (p) => ({ fsPath: p, scheme: 'https', toString: () => p }),
        joinPath: (base, ...parts) => vscodeStub.Uri.file(path.join(base.fsPath, ...parts)),
    },
    env: { language: 'en', openExternal: async () => true },
    languages: {
        createDiagnosticCollection: () => ({
            set: (uri, list) => diagnosticsByUri.set(uri.fsPath, list),
            delete: (uri) => diagnosticsByUri.delete(uri.fsPath),
            clear: () => diagnosticsByUri.clear(),
            dispose: () => {},
        }),
        registerCompletionItemProvider: (_s, p) => { registered.completion.push(p); return { dispose() {} }; },
        registerHoverProvider: (_s, p) => { registered.hover.push(p); return { dispose() {} }; },
        registerSignatureHelpProvider: (_s, p) => { registered.signature.push(p); return { dispose() {} }; },
        registerCodeActionsProvider: (_s, p) => { registered.codeActions.push(p); return { dispose() {} }; },
        registerDocumentLinkProvider: (_s, p) => { registered.links.push(p); return { dispose() {} }; },
        registerDefinitionProvider: (_s, p) => { registered.definition = p; return { dispose() {} }; },
        registerReferenceProvider: (_s, p) => { registered.references = p; return { dispose() {} }; },
        registerDocumentHighlightProvider: (_s, p) => { registered.highlight = p; return { dispose() {} }; },
        registerRenameProvider: (_s, p) => { registered.rename = p; return { dispose() {} }; },
        registerDocumentSymbolProvider: (_s, p) => { registered.symbols = p; return { dispose() {} }; },
        registerWorkspaceSymbolProvider: (p) => { registered.workspaceSymbols = p; return { dispose() {} }; },
        registerDocumentSemanticTokensProvider: (_s, p) => { registered.semantic = p; return { dispose() {} }; },
    },
    workspace: {
        workspaceFolders: [],
        textDocuments: [],
        getConfiguration: () => ({
            get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
            update: async () => {},
        }),
        createFileSystemWatcher: () => ({
            onDidChange: () => ({ dispose() {} }),
            onDidCreate: () => ({ dispose() {} }),
            onDidDelete: () => ({ dispose() {} }),
            dispose() {},
        }),
        onDidChangeTextDocument: () => ({ dispose() {} }),
        onDidOpenTextDocument: () => ({ dispose() {} }),
        onDidCloseTextDocument: () => ({ dispose() {} }),
        onDidChangeConfiguration: () => ({ dispose() {} }),
        getWorkspaceFolder: () => undefined,
        findFiles: async () => [],
        openTextDocument: async () => { throw new Error('not needed'); },
        applyEdit: async () => true,
        fs: {
            readDirectory: async (uri) => fs.readdirSync(uri.fsPath, { withFileTypes: true })
                .map((e) => [e.name, e.isDirectory() ? 2 : 1]),
            writeFile: async () => {},
            stat: async () => ({}),
        },
    },
    window: {
        activeTextEditor: undefined,
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        showErrorMessage: (m) => { throw new Error(`unexpected error message: ${m}`); },
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        setStatusBarMessage: () => {},
        showQuickPick: async () => undefined,
        showInputBox: async () => undefined,
        showTextDocument: async () => ({}),
        withProgress: async (_o, task) => task(),
    },
    commands: {
        registerCommand: (id, handler) => { registered.commands.set(id, handler); return { dispose() {} }; },
        executeCommand: async () => {},
    },
    extensions: { getExtension: () => undefined },
};

// Make `require('vscode')` inside the bundle resolve to the stub.
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad(request, parent, isMain);
};

const require = Module.createRequire(import.meta.url);
const bundle = path.join(ROOT, 'dist', 'extension.js');
if (!fs.existsSync(bundle)) {
    throw new Error(
        `${bundle} is missing. These tests drive the real bundle — run "npm run compile" first, `
        + 'or "npm test", which builds it for you.',
    );
}
const extension = require(bundle);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mtax-test-'));
const resourceRoot = path.join(workspace, 'my-resource');
fs.mkdirSync(path.join(resourceRoot, 'server'), { recursive: true });
fs.mkdirSync(path.join(resourceRoot, 'client'), { recursive: true });
fs.mkdirSync(path.join(resourceRoot, 'shared'), { recursive: true });

fs.writeFileSync(path.join(resourceRoot, 'mtaxmanifest.lua'), `resource_name = "my-resource"

server_files = {
    "server/main.lua",
}

client_files = {
    "client/main.lua",
    "client/class.lua",
}

shared_files = {
    "shared/util.lua",
}

files = {
    "server/oops.lua",
}
`);

const SERVER_LUA = `addEventHandler("onPlayerJoin", root, function()
    local who = getPlayerName(source)
    outputDebugString(formatMoney(100) .. who)
end)

dxDrawText("hello", 0, 0)
outputChatBox("hi")
setElemenPosition(source, 1, 2, 3)
require("something")
`;

fs.writeFileSync(path.join(resourceRoot, 'server', 'main.lua'), SERVER_LUA);
fs.writeFileSync(path.join(resourceRoot, 'client', 'main.lua'), 'setElementPosition(localPlayer, 0, 0, 5)\n');
fs.writeFileSync(path.join(resourceRoot, 'client', 'class.lua'), `local Panel = {}
Panel.__index = Panel

function Panel:open()
    self.visible = true
    self:redraw()
end

function Panel:redraw()
    dxDrawText(tostring(self.visible), 0, 0)
end
`);
fs.writeFileSync(path.join(resourceRoot, 'shared', 'util.lua'), `function formatMoney(amount)
    return ("$%s"):format(tostring(amount))
end
`);

function makeDocument(fsPath) {
    const text = fs.readFileSync(fsPath, 'utf8');
    const lines = text.split('\n');
    const offsets = [];
    let total = 0;
    for (const line of lines) { offsets.push(total); total += line.length + 1; }
    return {
        languageId: 'lua',
        uri: vscodeStub.Uri.file(fsPath),
        getText: (range) => {
            if (!range) return text;
            return text.slice(
                offsets[range.start.line] + range.start.character,
                offsets[range.end.line] + range.end.character,
            );
        },
        offsetAt: (position) => offsets[position.line] + position.character,
        positionAt: (offset) => {
            let line = 0;
            while (line + 1 < offsets.length && offsets[line + 1] <= offset) line++;
            return new Position(line, offset - offsets[line]);
        },
        lineCount: lines.length,
        lineAt: (line) => ({
            text: lines[line],
            range: new Range(line, 0, line, lines[line].length),
            rangeIncludingLineBreak: new Range(line, 0, line + 1, 0),
        }),
    };
}

const context = {
    extensionPath: ROOT,
    subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} },
};

test('activates without throwing', async () => {
    await extension.activate(context);
    assert.ok(context.subscriptions.length > 0, 'nothing was registered');
    assert.ok(registered.completion.length >= 2);
    assert.ok(registered.commands.has('mtax.newResource'));
    assert.ok(registered.commands.has('mtax.searchApi'));
});

test('completion offers natives and marks the wrong side', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const items = registered.completion[0].provideCompletionItems(document, new Position(4, 3));
    assert.ok(items.length > 1000, `only ${items.length} items`);

    const setPosition = items.find((i) => i.label === 'setElementPosition');
    assert.ok(setPosition, 'setElementPosition missing');
    assert.ok(setPosition.insertText.value.startsWith('setElementPosition('));

    const clientOnly = items.find((i) => i.label === 'dxDrawText');
    assert.ok(clientOnly.detail.startsWith('⚠'), 'a client native should be marked in a server file');
    assert.ok(clientOnly.sortText.startsWith('9'), 'and sorted last');
});

test('completion inside addEventHandler offers event names', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const items = registered.completion[0].provideCompletionItems(document, new Position(0, 20));
    assert.ok(items, 'no items in the event-name position');
    assert.ok(items.some((i) => i.label === 'onPlayerJoin'));
    assert.ok(items.some((i) => i.label === 'onPlayerQuit'));
    assert.ok(!items.some((i) => i.label === 'createVehicle'), 'natives should not show up there');
});

test('hover explains a native and warns about the side', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const hover = registered.hover[0].provideHover(document, new Position(4, 3));
    assert.ok(hover, 'no hover on dxDrawText');
    assert.ok(hover.contents.value.includes('dxDrawText'));
    assert.ok(hover.contents.value.includes('client'), 'the hover should say which side it is on');
});

test('signature help reports the right parameter', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const help = registered.signature[0].provideSignatureHelp(document, new Position(4, 20));
    assert.ok(help, 'no signature help');
    assert.ok(help.signatures[0].label.startsWith('dxDrawText('));
    assert.ok(help.activeParameter >= 1);
});

test('diagnostics catch the side, the typo, the missing function and the sandbox', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const collection = context.subscriptions.find((d) => typeof d.refresh === 'function');
    assert.ok(collection, 'the diagnostics object is not in the subscriptions');
    collection.refresh(document);

    const found = diagnosticsByUri.get(document.uri.fsPath) ?? [];
    const codes = found.map((d) => d.code);
    assert.ok(codes.includes('wrong-side'), 'dxDrawText in a server file');
    assert.ok(codes.includes('typo'), 'setElemenPosition');
    assert.ok(codes.includes('unknown-native'), 'outputChatBox');
    assert.ok(codes.includes('sandbox-global'), 'require');

    const typo = found.find((d) => d.code === 'typo');
    assert.match(typo.message, /Did you mean setElementPosition\?/);
});

test('the client script is clean', () => {
    const document = makeDocument(path.join(resourceRoot, 'client', 'main.lua'));
    const collection = context.subscriptions.find((d) => typeof d.refresh === 'function');
    collection.refresh(document);
    assert.deepEqual(diagnosticsByUri.get(document.uri.fsPath) ?? [], []);
});

test('the manifest is validated the way the server would', () => {
    const document = makeDocument(path.join(resourceRoot, 'mtaxmanifest.lua'));
    const collection = context.subscriptions.find((d) => typeof d.refresh === 'function');
    collection.refresh(document);

    const found = diagnosticsByUri.get(document.uri.fsPath) ?? [];
    const codes = found.map((d) => d.code);
    assert.ok(codes.includes('manifest-script-split'), 'a .lua listed in files');
});

test('a quick fix is offered for the typo', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const collection = context.subscriptions.find((d) => typeof d.refresh === 'function');
    collection.refresh(document);
    const found = diagnosticsByUri.get(document.uri.fsPath) ?? [];
    const typo = found.filter((d) => d.code === 'typo');

    const actions = registered.codeActions[0].provideCodeActions(
        document,
        typo[0].range,
        { diagnostics: typo },
    );
    assert.ok(actions.some((a) => a.title === 'Replace with setElementPosition'));
});

test('go to definition crosses files inside the resource', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const text = document.getText();
    const at = document.positionAt(text.indexOf('formatMoney') + 2);

    const locations = registered.definition.provideDefinition(document, at);
    assert.equal(locations.length, 1, 'formatMoney is defined once');
    assert.ok(locations[0].uri.fsPath.endsWith(path.join('shared', 'util.lua')));
    assert.equal(locations[0].range.start.line, 0);
});

test('go to definition on a native lands in the generated definitions', () => {
    const document = makeDocument(path.join(resourceRoot, 'client', 'main.lua'));
    const at = document.positionAt(document.getText().indexOf('setElementPosition') + 3);
    const locations = registered.definition.provideDefinition(document, at);
    assert.equal(locations.length, 1);
    assert.ok(locations[0].uri.fsPath.endsWith('mtax-shared.lua'));
});

test('a local resolves to its own declaration, not to a same-named global', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const text = document.getText();
    const use = document.positionAt(text.lastIndexOf('who'));
    const locations = registered.definition.provideDefinition(document, use);
    assert.equal(locations.length, 1);
    assert.equal(locations[0].range.start.line, 1, 'declared on the second line');
});

test('find references spans the resource', () => {
    const document = makeDocument(path.join(resourceRoot, 'shared', 'util.lua'));
    const at = document.positionAt(document.getText().indexOf('formatMoney') + 2);
    const locations = registered.references.provideReferences(document, at, { includeDeclaration: true });

    const files = new Set(locations.map((l) => path.basename(l.uri.fsPath)));
    assert.deepEqual([...files].sort(), ['main.lua', 'util.lua']);
    assert.equal(locations.length, 2);
});

test('references of a native list its call sites', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const at = document.positionAt(document.getText().indexOf('getPlayerName') + 2);
    const locations = registered.references.provideReferences(document, at, { includeDeclaration: false });
    assert.ok(locations.length >= 1);
    assert.ok(locations.every((l) => l.uri.fsPath.endsWith('.lua')));
});

test('the outline reports the file structure', () => {
    const document = makeDocument(path.join(resourceRoot, 'shared', 'util.lua'));
    const symbols = registered.symbols.provideDocumentSymbols(document);
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, 'formatMoney');
    assert.equal(symbols[0].detail, '(amount)');
});

test('highlight marks every occurrence of the name under the cursor', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const at = document.positionAt(document.getText().indexOf('local who') + 7);
    const highlights = registered.highlight.provideDocumentHighlights(document, at);
    assert.equal(highlights.length, 2, 'the declaration and the use');
});

test('rename rewrites every reference and refuses the API', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const text = document.getText();

    const local = document.positionAt(text.indexOf('local who') + 7);
    const edit = registered.rename.provideRenameEdits(document, local, 'playerName');
    const edits = [...edit.edits.values()].flat();
    assert.equal(edits.length, 2);
    assert.ok(edits.every((e) => e.newText === 'playerName'));

    const native = document.positionAt(text.indexOf('getPlayerName') + 2);
    assert.throws(() => registered.rename.prepareRename(document, native), /cannot be renamed/);
});

test('semantic tokens cover what a grammar cannot, and nothing it already paints', () => {
    const document = makeDocument(path.join(resourceRoot, 'server', 'main.lua'));
    const result = registered.semantic.provideDocumentSemanticTokens(document);
    const text = document.getText();
    const lines = text.split('\n');
    const byName = new Map();
    for (const token of result.tokens) {
        const name = lines[token.line].slice(token.char, token.char + token.length);
        if (!byName.has(name)) byName.set(name, token);
    }

    for (const name of ['getPlayerName', 'outputDebugString', 'root', 'source', 'onPlayerJoin']) {
        assert.ok(!byName.has(name), `${name} must be left to the grammar`);
    }

    assert.equal(byName.get('who').type, 'variable');
    assert.equal(byName.get('who').modifiers & (1 << 0), 1 << 0, 'the declaration is marked');

    const DEPRECATED = 1 << 4;
    assert.ok(byName.get('dxDrawText'), 'the wrong-side native still gets a token');
    assert.ok(byName.get('dxDrawText').modifiers & DEPRECATED);
});

test('self keeps the Lua grammar colour and navigates to its method', () => {
    const document = makeDocument(path.join(resourceRoot, 'client', 'class.lua'));
    const text = document.getText();

    const tokens = registered.semantic.provideDocumentSemanticTokens(document).tokens;
    const lines = text.split('\n');
    const claimed = tokens.map((t) => lines[t.line].slice(t.char, t.char + t.length));
    assert.ok(!claimed.includes('self'), 'self is left to variable.language.self.lua');

    const at = document.positionAt(text.indexOf('self.visible'));
    const definitions = registered.definition.provideDefinition(document, at);
    assert.equal(definitions.length, 1);
    const line = definitions[0].range.start.line;
    assert.match(lines[line], /function Panel:open\(\)/);

    const references = registered.references.provideReferences(document, at, { includeDeclaration: false });
    assert.equal(references.length, 2);
});

test('completion after self. offers the fields of that class', () => {
    const document = makeDocument(path.join(resourceRoot, 'client', 'class.lua'));
    const text = document.getText();
    const at = document.positionAt(text.indexOf('self.visible') + 'self.'.length);
    const items = registered.completion[0].provideCompletionItems(document, at);

    const labels = items.map((i) => i.label);
    assert.ok(labels.includes('visible'), 'a field the class assigns');
    assert.ok(labels.includes('redraw'), 'a method the class declares');

    const redraw = items.find((i) => i.label === 'redraw');
    assert.equal(redraw.detail, 'Panel.redraw function()');
});

test('self.field is the same field as Class.field', () => {
    const document = makeDocument(path.join(resourceRoot, 'client', 'class.lua'));
    const text = document.getText();

    const at = document.positionAt(text.indexOf('self:redraw') + 6);
    const definitions = registered.definition.provideDefinition(document, at);
    assert.equal(definitions.length, 1);
    const line = definitions[0].range.start.line;
    assert.match(text.split('\n')[line], /function Panel:redraw\(\)/);
});

test('the outline of a broken file still comes back', () => {
    const broken = path.join(resourceRoot, 'server', 'broken.lua');
    fs.writeFileSync(broken, 'function good() end\nif then\nfunction alsoGood() end\n');
    const document = makeDocument(broken);
    const symbols = registered.symbols.provideDocumentSymbols(document);
    assert.ok(symbols.some((s) => s.name === 'good'));
    assert.ok(symbols.some((s) => s.name === 'alsoGood'));
    fs.rmSync(broken);
});

test.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});
