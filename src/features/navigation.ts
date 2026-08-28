import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Api, Side } from '../api/model';
import { LuaIndex, ResourceScope } from '../lua/index';
import { ResourceIndex } from '../manifest/resource';
import { Analysis, Binding, Occurrence, occurrenceAt, stringAt, SymbolNode } from '../lua/analyze';

function rangeOf(document: vscode.TextDocument, start: number, end: number): vscode.Range {
    return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function locationIn(fsPath: string, text: string, start: number, end: number): vscode.Location {
    return new vscode.Location(vscode.Uri.file(fsPath), rangeIn(text, start, end));
}

function rangeIn(text: string, start: number, end: number): vscode.Range {
    return new vscode.Range(positionIn(text, start), positionIn(text, end));
}

function positionIn(text: string, offset: number): vscode.Position {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') { line++; lineStart = i + 1; }
    }
    return new vscode.Position(line, offset - lineStart);
}

function pathOf(analysis: Analysis, occurrence: Occurrence): string | null {
    return occurrence.binding?.path ?? null;
}

export interface ResolvedTarget {
    sites: { fsPath: string; binding: Binding }[];
    nativeName: string | null;
    eventName: string | null;
    occurrence: Occurrence | null;
    scope: ResourceScope | null;
}

export class LuaNavigation {
    constructor(
        private readonly api: Api,
        private readonly lua: LuaIndex,
        private readonly resources: ResourceIndex,
        private readonly extensionPath: string,
    ) {}

    resolve(document: vscode.TextDocument, position: vscode.Position): ResolvedTarget {
        const analysis = this.lua.forDocument(document);
        const offset = document.offsetAt(position);
        const scope = this.lua.scopeFor(document.uri.fsPath);

        const literal = stringAt(analysis, offset);
        if (literal) {
            return { sites: [], nativeName: null, eventName: literal.value, occurrence: null, scope };
        }

        const occurrence = occurrenceAt(analysis, offset);
        if (!occurrence) {
            return { sites: [], nativeName: null, eventName: null, occurrence: null, scope };
        }

        if (occurrence.kind === 'local' || occurrence.kind === 'param' || occurrence.kind === 'self') {
            return {
                sites: occurrence.binding ? [{ fsPath: document.uri.fsPath, binding: occurrence.binding }] : [],
                nativeName: null,
                eventName: null,
                occurrence,
                scope,
            };
        }

        if (occurrence.kind === 'global') {
            const isApi = this.api.has(occurrence.name)
                || Boolean(this.api.global(occurrence.name))
                || Boolean(this.api.class(occurrence.name))
                || Boolean(this.api.staticClass(occurrence.name));
            return {
                sites: scope?.globals.get(occurrence.name) ?? [],
                nativeName: isApi ? occurrence.name : null,
                eventName: null,
                occurrence,
                scope,
            };
        }

        const dotted = pathOf(analysis, occurrence);
        const sites = dotted ? scope?.fields.get(dotted) ?? [] : [];
        const isApiMember = this.api.methodsNamed(occurrence.name).length > 0;
        return {
            sites,
            nativeName: isApiMember ? this.api.methodsNamed(occurrence.name)[0].native : null,
            eventName: null,
            occurrence,
            scope,
        };
    }

    referencesOf(target: ResolvedTarget, includeDeclaration: boolean): vscode.Location[] {
        const out: vscode.Location[] = [];

        if (target.eventName) return this.eventReferences(target.eventName, target.scope);

        if (target.occurrence
            && (target.occurrence.kind === 'local' || target.occurrence.kind === 'param')
            && target.sites.length === 1) {
            const { fsPath, binding } = target.sites[0];
            const text = this.textOf(fsPath);
            if (!text) return out;
            for (const reference of binding.references) {
                if (!includeDeclaration && reference.declaration) continue;
                out.push(locationIn(fsPath, text, reference.start, reference.end));
            }
            return out;
        }

        for (const site of target.sites) {
            const text = this.textOf(site.fsPath);
            if (!text) continue;
            for (const reference of site.binding.references) {
                if (!includeDeclaration && reference.declaration) continue;
                out.push(locationIn(site.fsPath, text, reference.start, reference.end));
            }
        }

        if (!out.length && target.nativeName && target.occurrence) {
            return this.nativeReferences(target.occurrence.name, target.scope);
        }

        return out;
    }

    private nativeReferences(name: string, scope: ResourceScope | null): vscode.Location[] {
        const out: vscode.Location[] = [];
        if (!scope) return out;
        for (const fsPath of scope.files) {
            const analysis = this.lua.forPath(fsPath);
            const text = this.textOf(fsPath);
            if (!analysis || !text) continue;
            for (const occurrence of analysis.occurrences) {
                if (occurrence.name !== name) continue;
                if (occurrence.kind !== 'global' && occurrence.kind !== 'method' && occurrence.kind !== 'property') continue;
                out.push(locationIn(fsPath, text, occurrence.start, occurrence.end));
            }
        }
        return out;
    }

    private eventReferences(name: string, scope: ResourceScope | null): vscode.Location[] {
        const out: vscode.Location[] = [];
        if (!scope) return out;
        for (const fsPath of scope.files) {
            const analysis = this.lua.forPath(fsPath);
            const text = this.textOf(fsPath);
            if (!analysis || !text) continue;
            for (const literal of analysis.strings) {
                if (literal.value !== name) continue;
                out.push(locationIn(fsPath, text, literal.start, literal.end));
            }
        }
        return out;
    }

    definitionsOf(target: ResolvedTarget): vscode.Location[] {
        const out: vscode.Location[] = [];

        if (target.eventName) {
            const scope = target.scope;
            if (scope?.events.has(target.eventName)) {
                for (const fsPath of scope.files) {
                    const analysis = this.lua.forPath(fsPath);
                    const text = this.textOf(fsPath);
                    if (!analysis || !text) continue;
                    for (const literal of analysis.strings) {
                        if (literal.call === 'addEvent' && literal.value === target.eventName) {
                            out.push(locationIn(fsPath, text, literal.start, literal.end));
                        }
                    }
                }
            }
            if (out.length) return out;
            const known = this.api.event(target.eventName);
            return known ? this.definitionInStubs(known.name, 'event') : [];
        }

        for (const site of target.sites) {
            const declaration = site.binding.declaration;
            if (!declaration) continue;
            const text = this.textOf(site.fsPath);
            if (!text) continue;
            out.push(locationIn(site.fsPath, text, declaration.start, declaration.end));
        }

        if (out.length) return out;
        if (target.nativeName) return this.definitionInStubs(target.nativeName, 'function');
        return out;
    }

    private definitionInStubs(name: string, kind: 'function' | 'event'): vscode.Location[] {
        if (kind === 'event') return [];
        const fn = this.api.fn(name);
        const files = fn
            ? [`mtax-${fn.side}.lua`]
            : ['mtax-shared.lua', 'mtax-client.lua', 'mtax-server.lua', 'mtax-oop.lua', 'mtax-types.lua'];

        for (const file of files) {
            const fsPath = path.join(this.extensionPath, 'definitions', file);
            let text: string;
            try {
                text = fs.readFileSync(fsPath, 'utf8');
            } catch {
                continue;
            }
            const needle = `\nfunction ${name}(`;
            const at = text.indexOf(needle);
            if (at === -1) continue;
            const start = at + '\nfunction '.length;
            return [locationIn(fsPath, text, start, start + name.length)];
        }
        return [];
    }

    textOf(fsPath: string): string | null {
        const open = vscode.workspace.textDocuments.find(
            (d) => d.uri.scheme === 'file' && path.normalize(d.uri.fsPath).toLowerCase() === path.normalize(fsPath).toLowerCase(),
        );
        if (open) return open.getText();
        try {
            return fs.readFileSync(fsPath, 'utf8');
        } catch {
            return null;
        }
    }

    sideOf(fsPath: string): Side {
        return this.resources.resolveSide(fsPath).side;
    }
}

export class MtaxDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly navigation: LuaNavigation) {}

    provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location[] {
        if (!enabled()) return [];
        const target = this.navigation.resolve(document, position);
        return this.navigation.definitionsOf(target);
    }
}

export class MtaxReferenceProvider implements vscode.ReferenceProvider {
    constructor(private readonly navigation: LuaNavigation) {}

    provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
    ): vscode.Location[] {
        if (!enabled()) return [];
        const target = this.navigation.resolve(document, position);
        return this.navigation.referencesOf(target, context.includeDeclaration);
    }
}

export class MtaxHighlightProvider implements vscode.DocumentHighlightProvider {
    constructor(private readonly lua: LuaIndex) {}

    provideDocumentHighlights(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.DocumentHighlight[] {
        if (!enabled()) return [];
        const analysis = this.lua.forDocument(document);
        const offset = document.offsetAt(position);

        const literal = stringAt(analysis, offset);
        if (literal) {
            return analysis.strings
                .filter((s) => s.value === literal.value)
                .map((s) => new vscode.DocumentHighlight(rangeOf(document, s.start, s.end)));
        }

        const occurrence = occurrenceAt(analysis, offset);
        if (!occurrence) return [];

        if (occurrence.binding) {
            return occurrence.binding.references.map((reference) => new vscode.DocumentHighlight(
                rangeOf(document, reference.start, reference.end),
                reference.write ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read,
            ));
        }

        return analysis.occurrences
            .filter((o) => o.name === occurrence.name && o.kind === occurrence.kind)
            .map((o) => new vscode.DocumentHighlight(rangeOf(document, o.start, o.end)));
    }
}

export class MtaxRenameProvider implements vscode.RenameProvider {
    constructor(private readonly api: Api, private readonly navigation: LuaNavigation, private readonly lua: LuaIndex) {}

    prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
        const analysis = this.lua.forDocument(document);
        const offset = document.offsetAt(position);
        const occurrence = occurrenceAt(analysis, offset);
        if (!occurrence) throw new Error('There is nothing to rename here.');
        if (this.api.has(occurrence.name) || this.api.global(occurrence.name)) {
            throw new Error(`${occurrence.name} is part of the MTAX API and cannot be renamed.`);
        }
        return rangeOf(document, occurrence.start, occurrence.end);
    }

    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
    ): vscode.WorkspaceEdit {
        const edit = new vscode.WorkspaceEdit();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
            throw new Error(`"${newName}" is not a valid Lua name.`);
        }

        const target = this.navigation.resolve(document, position);
        if (target.nativeName) throw new Error('The MTAX API cannot be renamed.');

        for (const location of this.navigation.referencesOf(target, true)) {
            edit.replace(location.uri, location.range, newName);
        }
        return edit;
    }
}

export class MtaxDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    constructor(private readonly lua: LuaIndex) {}

    provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        if (!enabled()) return [];
        const analysis = this.lua.forDocument(document);
        return analysis.symbols.map((symbol) => toDocumentSymbol(symbol, document));
    }
}

export class MtaxWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
    constructor(
        private readonly lua: LuaIndex,
        private readonly resources: ResourceIndex,
        private readonly navigation: LuaNavigation,
    ) {}

    provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
        if (!enabled() || query.length < 2) return [];
        const needle = query.toLowerCase();
        const out: vscode.SymbolInformation[] = [];

        for (const root of this.lua.allResourceRoots()) {
            const resource = this.resources.load(root);
            if (!resource) continue;
            const scope = this.lua.scopeOf(resource);

            for (const fsPath of scope.files) {
                const analysis = this.lua.forPath(fsPath);
                const text = this.navigation.textOf(fsPath);
                if (!analysis || !text) continue;

                const visit = (symbol: SymbolNode, container: string) => {
                    if (symbol.name.toLowerCase().includes(needle)) {
                        out.push(new vscode.SymbolInformation(
                            symbol.name,
                            symbolKind(symbol.kind),
                            container || scope.name,
                            locationIn(fsPath, text, symbol.selectionStart, symbol.selectionEnd),
                        ));
                    }
                    for (const child of symbol.children) visit(child, symbol.name);
                };
                for (const symbol of analysis.symbols) visit(symbol, '');
                if (out.length > 512) return out;
            }
        }
        return out;
    }
}

function toDocumentSymbol(symbol: SymbolNode, document: vscode.TextDocument): vscode.DocumentSymbol {
    const node = new vscode.DocumentSymbol(
        symbol.name,
        symbol.detail,
        symbolKind(symbol.kind),
        rangeOf(document, symbol.start, symbol.end),
        rangeOf(document, symbol.selectionStart, symbol.selectionEnd),
    );
    node.children = symbol.children.map((child) => toDocumentSymbol(child, document));
    return node;
}

function symbolKind(kind: SymbolNode['kind']): vscode.SymbolKind {
    switch (kind) {
        case 'function': return vscode.SymbolKind.Function;
        case 'method': return vscode.SymbolKind.Method;
        case 'namespace': return vscode.SymbolKind.Namespace;
        case 'field': return vscode.SymbolKind.Field;
        case 'constant': return vscode.SymbolKind.Constant;
        case 'event': return vscode.SymbolKind.Event;
        default: return vscode.SymbolKind.Variable;
    }
}

function enabled(): boolean {
    return vscode.workspace.getConfiguration('mtax').get<boolean>('enable', true);
}
