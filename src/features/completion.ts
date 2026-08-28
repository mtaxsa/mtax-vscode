import * as vscode from 'vscode';

import { Api, ApiFunction, OopClass, Side } from '../api/model';
import { ResourceIndex } from '../manifest/resource';
import { scanLua, callContextAt, identifierAt, stringAt } from '../util/lua';
import { docsLanguage, functionDoc, eventDoc, methodDoc, propertyDoc, sideLabel, nativeParamNames } from './docs';
import { MANIFEST_NAME } from '../manifest/resource';

const SIDE_ICON: Record<Side, string> = { client: '🖥️', server: '🗄️', shared: '🔗' };

export class MtaxCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly api: Api, private readonly resources: ResourceIndex) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] | undefined {
        if (!vscode.workspace.getConfiguration('mtax').get<boolean>('enable', true)) return undefined;

        const text = document.getText();
        const offset = document.offsetAt(position);
        const scan = scanLua(text);
        const lang = docsLanguage();

        const literal = stringAt(scan, offset);
        if (literal) {
            const call = callContextAt(scan.masked, literal.start);
            if (call) {
                const items = this.eventNameCompletions(call.name, call.argIndex, document, lang);
                if (items) return items;
            }
            return undefined;
        }

        const beforeCursor = scan.masked.slice(Math.max(0, offset - 200), offset);
        const memberMatch = beforeCursor.match(/([A-Za-z_][A-Za-z0-9_.]*)\s*([.:])\s*([A-Za-z0-9_]*)$/);
        if (memberMatch) {
            return this.memberCompletions(memberMatch[1], memberMatch[2] as ':' | '.', document, lang);
        }

        const { side } = this.resources.resolveSide(document.uri.fsPath);
        return this.globalCompletions(side, document, lang);
    }

    private globalCompletions(side: Side, document: vscode.TextDocument, lang: 'en' | 'pt'): vscode.CompletionItem[] {
        const config = vscode.workspace.getConfiguration('mtax');
        const useSnippets = config.get<boolean>('completion.snippets', true);
        const includeOop = config.get<boolean>('completion.oop', true);
        const items: vscode.CompletionItem[] = [];

        for (const fn of this.api.functions) {
            const callable = this.api.isCallableFrom(fn, side);
            const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
            item.detail = `${SIDE_ICON[fn.side]} ${signatureLine(fn)}`;
            item.documentation = functionDoc(fn, lang, { compact: true });
            item.insertText = useSnippets ? callSnippet(fn) : fn.name;
            item.sortText = callable ? `1${fn.name}` : `9${fn.name}`;
            if (!callable) {
                item.detail = `⚠ ${sideLabel(fn.side, lang)} — ${signatureLine(fn)}`;
                item.filterText = fn.name;
            }
            items.push(item);
        }

        for (const g of this.api.globals) {
            if (g.side !== 'shared' && g.side !== side && side !== 'shared') continue;
            const item = new vscode.CompletionItem(g.name, vscode.CompletionItemKind.Variable);
            item.detail = `${SIDE_ICON[g.side]} ${g.type}`;
            item.documentation = new vscode.MarkdownString(g.description);
            item.sortText = `0${g.name}`;
            items.push(item);
        }

        if (includeOop) {
            for (const cls of this.api.classes) {
                const item = new vscode.CompletionItem(cls.name, vscode.CompletionItemKind.Class);
                item.detail = `MTAX class${cls.parent ? ` : ${cls.parent}` : ''}`;
                item.sortText = `2${cls.name}`;
                items.push(item);
            }
            for (const cls of this.api.statics) {
                const item = new vscode.CompletionItem(cls.name, vscode.CompletionItemKind.Module);
                item.detail = 'MTAX static class';
                item.sortText = `2${cls.name}`;
                items.push(item);
            }
            for (const name of ['Vector2', 'Vector3', 'Vector4', 'Matrix']) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                item.detail = 'MTAX bundled type';
                item.insertText = new vscode.SnippetString(`${name}($0)`);
                item.sortText = `2${name}`;
                items.push(item);
            }
        }

        const resource = this.resources.resourceFor(document.uri.fsPath);
        if (resource?.exports.length) {
            for (const name of resource.exports) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                item.detail = `exported by ${resource.name}`;
                item.sortText = `0${name}`;
                items.push(item);
            }
        }

        return items;
    }

    private memberCompletions(
        receiver: string,
        accessor: ':' | '.',
        document: vscode.TextDocument,
        lang: 'en' | 'pt',
    ): vscode.CompletionItem[] | undefined {
        if (!vscode.workspace.getConfiguration('mtax').get<boolean>('completion.oop', true)) return undefined;

        const items: vscode.CompletionItem[] = [];
        const { side } = this.resources.resolveSide(document.uri.fsPath);

        if (receiver.startsWith('exports.')) {
            const resourceName = receiver.slice('exports.'.length);
            for (const info of this.allResources()) {
                if (info.name !== resourceName && !info.root.endsWith(resourceName)) continue;
                for (const name of info.exports) {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                    item.detail = `exported by ${info.name}`;
                    items.push(item);
                }
            }
            return items;
        }

        const staticClass = this.api.staticClass(receiver);
        if (staticClass && accessor === '.') {
            for (const m of staticClass.methods) {
                const native = this.api.fn(m.native);
                const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Method);
                item.detail = native ? `${SIDE_ICON[native.side]} ${signatureLine(native)}` : m.native;
                if (native) item.documentation = functionDoc(native, lang, { compact: true });
                item.insertText = new vscode.SnippetString(`${m.name}($0)`);
                items.push(item);
            }
            return items;
        }

        const named = this.api.class(receiver);
        const classes: OopClass[] = named ? [named] : this.api.classes;

        if (named) {
            this.pushClassMembers(named, accessor, side, lang, items);
            return items;
        }

        const seen = new Set<string>();
        for (const cls of classes) {
            for (const m of cls.methods) {
                if (seen.has(`:${m.name}`)) continue;
                seen.add(`:${m.name}`);
                if (accessor !== ':') continue;
                const native = this.api.fn(m.native);
                if (native && !this.api.isCallableFrom(native, side)) continue;
                const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Method);
                item.detail = native ? `${SIDE_ICON[native.side]} ${cls.name}:${m.name} → ${m.native}` : m.native;
                if (native) item.documentation = methodDoc(cls, m, native, lang);
                item.insertText = new vscode.SnippetString(`${m.name}($0)`);
                items.push(item);
            }
            for (const p of cls.properties) {
                if (seen.has(`.${p.name}`)) continue;
                seen.add(`.${p.name}`);
                if (accessor !== '.') continue;
                const item = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property);
                item.detail = `${cls.name}.${p.name}${p.setter ? '' : ' (read-only)'}`;
                item.documentation = propertyDoc(cls, p, this.api, lang);
                items.push(item);
            }
        }
        return items;
    }

    private pushClassMembers(
        cls: OopClass,
        accessor: ':' | '.',
        side: Side,
        lang: 'en' | 'pt',
        items: vscode.CompletionItem[],
    ): void {
        const { methods, properties } = this.api.membersOf(cls.name);
        for (const m of methods) {
            const native = this.api.fn(m.native);
            const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Method);
            item.detail = native ? `${SIDE_ICON[native.side]} → ${m.native}` : m.native;
            item.documentation = methodDoc(cls, m, native, lang);
            const args = native ? nativeParamNames(native, m) : [];
            item.insertText = new vscode.SnippetString(
                `${m.name}(${args.map((a, i) => `\${${i + 1}:${a}}`).join(', ')})`,
            );
            item.sortText = native && !this.api.isCallableFrom(native, side) ? `9${m.name}` : `1${m.name}`;
            items.push(item);
        }
        if (accessor === '.') {
            for (const p of properties) {
                const item = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property);
                item.detail = `${cls.name}.${p.name}${p.setter ? '' : ' (read-only)'}`;
                item.documentation = propertyDoc(cls, p, this.api, lang);
                item.sortText = `0${p.name}`;
                items.push(item);
            }
        }
    }

    private eventNameCompletions(
        callName: string,
        argIndex: number,
        document: vscode.TextDocument,
        lang: 'en' | 'pt',
    ): vscode.CompletionItem[] | undefined {
        const fn = this.api.fn(callName);
        if (!fn) return undefined;
        const params = fn.variants?.[0]?.params ?? [];
        const eventArg = params.findIndex((p) => /^eventName$/i.test(p.name));
        if (eventArg === -1 || eventArg !== argIndex) return undefined;

        const { side } = this.resources.resolveSide(document.uri.fsPath);
        const items: vscode.CompletionItem[] = [];

        for (const ev of this.api.events) {
            const relevant = side === 'shared' || ev.side === side;
            const item = new vscode.CompletionItem(ev.name, vscode.CompletionItemKind.Event);
            item.detail = `${SIDE_ICON[ev.side]} ${ev.side} event`;
            item.documentation = eventDoc(ev, lang);
            item.sortText = relevant ? `1${ev.name}` : `9${ev.name}`;
            items.push(item);
        }

        for (const name of this.customEventNames(document)) {
            if (this.api.event(name)) continue;
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Event);
            item.detail = 'custom event declared in this workspace';
            item.sortText = `0${name}`;
            items.push(item);
        }

        return items;
    }

    private customEventNames(document: vscode.TextDocument): string[] {
        const names = new Set<string>();
        const scan = scanLua(document.getText());
        for (const s of scan.strings) {
            const before = scan.masked.slice(Math.max(0, s.start - 40), s.start);
            if (/addEvent\s*\(\s*$/.test(before)) names.add(s.value);
        }
        return [...names];
    }

    private allResources() {
        const roots = new Set<string>();
        const out = [] as NonNullable<ReturnType<ResourceIndex['resourceFor']>>[];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const info = this.resources.resourceFor(folder.uri.fsPath);
            if (info && !roots.has(info.root)) { roots.add(info.root); out.push(info); }
        }
        return out;
    }
}

export function signatureLine(fn: ApiFunction): string {
    const v = fn.variants?.[0];
    if (!v) return `${fn.name}(...)`;
    return v.text.replace(/\s+/g, ' ');
}

function callSnippet(fn: ApiFunction): vscode.SnippetString {
    const v = fn.variants?.[0];
    if (!v || !v.params.length) return new vscode.SnippetString(`${fn.name}($0)`);
    const required = v.params.filter((p) => !p.optional);
    const chosen = required.length ? required : v.params.slice(0, 1);
    const args = chosen.map((p, i) => `\${${i + 1}:${p.varargs ? '...' : p.name}}`);
    return new vscode.SnippetString(`${fn.name}(${args.join(', ')})$0`);
}

export class ManifestCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly api: Api, private readonly resources: ResourceIndex) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.CompletionItem[] | undefined> {
        if (!isManifest(document)) return undefined;

        const text = document.getText();
        const offset = document.offsetAt(position);
        const scan = scanLua(text);

        const literal = stringAt(scan, offset);
        if (literal) return this.pathCompletions(document, scan.masked, literal.start, literal.value, offset - literal.contentStart);

        const ident = identifierAt(scan.masked, offset);
        const lineStart = document.lineAt(position.line).text.slice(0, position.character);
        if (!/^[ \t]*[A-Za-z0-9_]*$/.test(lineStart) && !ident) return undefined;

        return this.api.manifestKeys.map((key) => {
            const item = new vscode.CompletionItem(key.name, vscode.CompletionItemKind.Field);
            item.detail = key.type;
            item.documentation = new vscode.MarkdownString(key.description);
            item.insertText = new vscode.SnippetString(manifestKeySnippet(key.name, key.type));
            return item;
        });
    }

    private async pathCompletions(
        document: vscode.TextDocument,
        masked: string,
        literalStart: number,
        value: string,
        cursorInValue: number,
    ): Promise<vscode.CompletionItem[] | undefined> {
        const resource = this.resources.resourceFor(document.uri.fsPath);
        if (!resource) return undefined;

        const listKey = enclosingListKey(masked, literalStart);
        const wantsScripts = listKey === 'server_files' || listKey === 'client_files' || listKey === 'shared_files';
        const typed = value.slice(0, Math.max(0, cursorInValue));
        const dir = typed.includes('/') ? typed.slice(0, typed.lastIndexOf('/')) : '';

        const folder = vscode.Uri.joinPath(vscode.Uri.file(resource.root), ...(dir ? dir.split('/') : []));
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(folder);
        } catch {
            return undefined;
        }

        const items: vscode.CompletionItem[] = [];
        for (const [name, type] of entries) {
            if (name.startsWith('.')) continue;
            if (name === MANIFEST_NAME) continue;
            const isDir = type === vscode.FileType.Directory;
            const isLua = name.toLowerCase().endsWith('.lua');
            if (!isDir && listKey && (wantsScripts !== isLua)) continue;

            const item = new vscode.CompletionItem(
                name,
                isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
            );
            item.insertText = isDir ? `${name}/` : name;
            item.sortText = `${isDir ? 0 : 1}${name}`;
            if (isDir) item.command = { command: 'editor.action.triggerSuggest', title: 'suggest' };
            items.push(item);
        }

        if (!dir && wantsScripts) {
            const glob = new vscode.CompletionItem('**/*.lua', vscode.CompletionItemKind.Constant);
            glob.detail = 'every .lua below this folder, in alphabetical order';
            glob.sortText = '2';
            items.push(glob);
        }
        return items;
    }
}

function manifestKeySnippet(name: string, type: string): string {
    if (type === 'string[]') return `${name} = {\n    "\${1}",\n}`;
    if (type === 'boolean') return `${name} = \${1|true,false|}`;
    if (type === 'table') return `${name} = {\n    \${1:description} = "\${2}",\n}`;
    return `${name} = "\${1}"`;
}

/** Which `xxx_files = { … }` block an offset sits inside. */
export function enclosingListKey(masked: string, offset: number): string | null {
    let depth = 0;
    for (let i = offset; i >= 0; i--) {
        const c = masked[i];
        if (c === '}') depth++;
        else if (c === '{') {
            if (depth > 0) { depth--; continue; }
            const before = masked.slice(Math.max(0, i - 80), i);
            const m = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/);
            return m ? m[1] : null;
        }
    }
    return null;
}

export function isManifest(document: vscode.TextDocument): boolean {
    return document.uri.fsPath.toLowerCase().endsWith(MANIFEST_NAME);
}
