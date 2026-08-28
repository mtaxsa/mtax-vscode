import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Api, LUA_STDLIB, Side } from '../api/model';
import { ResourceIndex, MANIFEST_NAME } from '../manifest/resource';
import {
    parseManifest, isSafeRelativePath, isLuaPath, isCrossResourceEntry,
    splitCrossResourceEntry, hasGlob, globMatches, SCRIPT_LIST_KEYS, FILE_LIST_KEY_NAMES,
} from '../manifest/parse';
import { scanLua, findCalls, findIdentifiers, declaredNames, editDistance } from '../util/lua';
import { symbolsOf, clearSymbolCache, ResourceSymbols } from '../manifest/symbols';
import { isManifest } from './completion';

export const SOURCE = 'mtax';

export const CODE = {
    wrongSide: 'wrong-side',
    sandboxGlobal: 'sandbox-global',
    sandboxLibrary: 'sandbox-library',
    sandboxOsField: 'sandbox-os-field',
    typo: 'typo',
    unknownNative: 'unknown-native',
    eventTypo: 'event-typo',
    eventSide: 'event-side',
    undeclaredFile: 'undeclared-file',
    manifestUnknownKey: 'manifest-unknown-key',
    manifestBadPath: 'manifest-bad-path',
    manifestScriptSplit: 'manifest-script-split',
    manifestMissingFile: 'manifest-missing-file',
    manifestUiPage: 'manifest-ui-page',
    manifestExport: 'manifest-export',
    manifestFlag: 'manifest-flag',
    manifestSandbox: 'manifest-sandbox',
    manifestDuplicate: 'manifest-duplicate',
    manifestEscrow: 'manifest-escrow',
    legacyMeta: 'legacy-meta',
} as const;

function severity(value: string | undefined): vscode.DiagnosticSeverity | null {
    switch (value) {
        case 'error': return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'information': return vscode.DiagnosticSeverity.Information;
        default: return null;
    }
}

const NATIVE_SHAPE = new RegExp(
    '^(get|set|is|has|can|create|destroy|add|remove|output|trigger|attach|detach|dx|gui|engine'
    + '|db|fx|svg|nui|dui|utf|bit|call|exec|play|stop|start|kick|ban|give|take|fade|show|hide'
    + '|toggle|reset|restore|bind|unbind|redirect|refresh|spawn|warp|kill|load|save)[A-Z]',
);

function looksLikeNative(name: string): boolean {
    return name.length >= 6 && NATIVE_SHAPE.test(name);
}

export class MtaxDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('mtax');
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly api: Api, private readonly resources: ResourceIndex) {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
            vscode.workspace.onDidOpenTextDocument((doc) => this.refresh(doc)),
            vscode.workspace.onDidCloseTextDocument((doc) => this.collection.delete(doc.uri)),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('mtax')) this.refreshAll();
            }),
            this.resources.onDidChange(() => { clearSymbolCache(); this.refreshAll(); }),
        );
        this.refreshAll();
    }

    dispose(): void {
        for (const t of this.timers.values()) clearTimeout(t);
        for (const d of this.disposables) d.dispose();
        this.collection.dispose();
    }

    refreshAll(): void {
        this.collection.clear();
        for (const doc of vscode.workspace.textDocuments) this.refresh(doc);
    }

    private schedule(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const existing = this.timers.get(key);
        if (existing) clearTimeout(existing);
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            this.refresh(document);
        }, 300));
    }

    refresh(document: vscode.TextDocument): void {
        if (document.languageId !== 'lua') return;
        const config = vscode.workspace.getConfiguration('mtax');
        if (!config.get<boolean>('enable', true) || !config.get<boolean>('diagnostics.enable', true)) {
            this.collection.delete(document.uri);
            return;
        }

        const diagnostics = isManifest(document)
            ? this.checkManifest(document, config)
            : this.checkScript(document, config);
        this.collection.set(document.uri, diagnostics);
    }

    private checkScript(
        document: vscode.TextDocument,
        config: vscode.WorkspaceConfiguration,
    ): vscode.Diagnostic[] {
        const out: vscode.Diagnostic[] = [];
        const text = document.getText();
        const scan = scanLua(text);
        const masked = scan.masked;
        const { side, certain, reason } = this.resources.resolveSide(document.uri.fsPath);
        const range = (start: number, end: number) =>
            new vscode.Range(document.positionAt(start), document.positionAt(end));

        const sandboxSeverity = severity(config.get<string>('diagnostics.sandbox'));
        const typoSeverity = severity(config.get<string>('diagnostics.typos'));
        const unknownSeverity = severity(config.get<string>('diagnostics.unknownNative'));
        const sideSeverity = severity(config.get<string>(
            side === 'shared' ? 'diagnostics.sharedSideCalls' : 'diagnostics.wrongSide',
        ));

        const declared = declaredNames(masked);
        const symbols = this.symbolsFor(document.uri.fsPath);
        const calls = findCalls(masked);

        for (const call of calls) {
            if (call.accessor) continue;
            const fn = this.api.fn(call.name);

            if (fn) {
                if (sideSeverity !== null && !this.api.isCallableFrom(fn, side)) {
                    const where = side === 'shared'
                        ? `This script is shared, so it also runs on the ${fn.side === 'client' ? 'server' : 'client'}`
                        : `This script runs on the ${side}`;
                    const d = new vscode.Diagnostic(
                        range(call.start, call.end),
                        `${where} (${reason}${certain ? '' : ', guessed'}), and ${fn.name} only exists on the ${fn.side}.`,
                        sideSeverity,
                    );
                    d.source = SOURCE;
                    d.code = CODE.wrongSide;
                    out.push(d);
                }
                continue;
            }

            if (sandboxSeverity !== null && this.removedGlobals().has(call.name)) {
                const d = new vscode.Diagnostic(
                    range(call.start, call.end),
                    `${call.name} does not exist: the MTAX sandbox removes it. ${this.sandboxAdvice(call.name)}`,
                    sandboxSeverity,
                );
                d.source = SOURCE;
                d.code = CODE.sandboxGlobal;
                out.push(d);
                continue;
            }

            const resolvable = declared.has(call.name) || LUA_STDLIB.has(call.name)
                || symbols?.names.has(call.name) || this.api.global(call.name)
                || this.api.class(call.name) || this.api.staticClass(call.name);
            if (resolvable) continue;

            const suggestion = typoSeverity !== null || unknownSeverity !== null
                ? this.nearestNative(call.name)
                : undefined;

            if (typoSeverity !== null && suggestion) {
                const d = new vscode.Diagnostic(
                    range(call.start, call.end),
                    `${call.name} is not an MTAX native. Did you mean ${suggestion}?`,
                    typoSeverity,
                );
                d.source = SOURCE;
                d.code = CODE.typo;
                out.push(d);
                continue;
            }

            if (unknownSeverity !== null && !suggestion && !symbols?.borrows && looksLikeNative(call.name)) {
                const d = new vscode.Diagnostic(
                    range(call.start, call.end),
                    `${call.name} does not exist in MTAX and nothing in this resource defines it.`,
                    unknownSeverity,
                );
                d.source = SOURCE;
                d.code = CODE.unknownNative;
                out.push(d);
            }
        }

        if (sandboxSeverity !== null) {
            for (const ident of findIdentifiers(masked)) {
                if (ident.accessor !== '.') continue;
                if (ident.receiver === 'io' || ident.receiver === 'package' || ident.receiver === 'debug') {
                    const start = ident.start - ident.receiver.length - 1;
                    const d = new vscode.Diagnostic(
                        range(Math.max(0, start), ident.end),
                        `The ${ident.receiver} library does not exist in MTAX scripts.`
                        + (ident.receiver === 'io' ? ' Use the MTAX file functions (fileOpen, fileRead, fileWrite).' : ''),
                        sandboxSeverity,
                    );
                    d.source = SOURCE;
                    d.code = CODE.sandboxLibrary;
                    out.push(d);
                    continue;
                }
                if (ident.receiver === 'os' && this.restrictedOsFields().has(ident.name)) {
                    const start = ident.start - 3;
                    const d = new vscode.Diagnostic(
                        range(Math.max(0, start), ident.end),
                        `os.${ident.name} is removed by the MTAX sandbox. `
                        + 'Only os.time, os.date, os.clock and os.difftime are available.',
                        sandboxSeverity,
                    );
                    d.source = SOURCE;
                    d.code = CODE.sandboxOsField;
                    out.push(d);
                }
            }
        }

        for (const literal of scan.strings) {
            const before = masked.slice(Math.max(0, literal.start - 200), literal.start);
            const call = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/);
            if (!call) continue;
            const fn = this.api.fn(call[1]);
            if (!fn) continue;
            const params = fn.variants?.[0]?.params ?? [];
            if (!params.length || !/^eventName$/i.test(params[0].name)) continue;

            const literalRange = range(literal.contentStart, literal.contentEnd);
            const event = this.api.event(literal.value);

            if (event) {
                if (sideSeverity !== null && side !== 'shared' && event.side !== side) {
                    const d = new vscode.Diagnostic(
                        literalRange,
                        `${event.name} is a ${event.side} event and this script runs on the ${side}.`,
                        sideSeverity,
                    );
                    d.source = SOURCE;
                    d.code = CODE.eventSide;
                    out.push(d);
                }
                continue;
            }

            if (typoSeverity !== null && /^on[A-Z]/.test(literal.value) && !symbols?.events.has(literal.value)) {
                const suggestion = this.nearestEvent(literal.value);
                if (suggestion) {
                    const d = new vscode.Diagnostic(
                        literalRange,
                        `No MTAX event is called ${literal.value}. Did you mean ${suggestion}?`,
                        typoSeverity,
                    );
                    d.source = SOURCE;
                    d.code = CODE.eventTypo;
                    out.push(d);
                }
            }
        }

        if (config.get<boolean>('diagnostics.manifest', true) && this.resources.isUndeclared(document.uri.fsPath)) {
            const resource = this.resources.resourceFor(document.uri.fsPath);
            const d = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, Math.max(1, document.lineAt(0).text.length)),
                `This script is not listed in ${resource?.name ?? 'the resource'}'s ${MANIFEST_NAME}, so it never runs.`,
                vscode.DiagnosticSeverity.Information,
            );
            d.source = SOURCE;
            d.code = CODE.undeclaredFile;
            out.push(d);
        }

        return out;
    }

    private checkManifest(
        document: vscode.TextDocument,
        config: vscode.WorkspaceConfiguration,
    ): vscode.Diagnostic[] {
        if (!config.get<boolean>('diagnostics.manifest', true)) return [];

        const out: vscode.Diagnostic[] = [];
        const text = document.getText();
        const parsed = parseManifest(text);
        const root = path.dirname(document.uri.fsPath);
        const range = (start: number, end: number) =>
            new vscode.Range(document.positionAt(start), document.positionAt(end));
        const push = (r: vscode.Range, message: string, code: string, sev = vscode.DiagnosticSeverity.Error) => {
            const d = new vscode.Diagnostic(r, message, sev);
            d.source = SOURCE;
            d.code = code;
            out.push(d);
        };

        const known = new Set(this.api.manifestKeys.map((k) => k.name));
        const declaredPaths = new Map<string, string[]>(); // path -> keys that list it

        for (const a of parsed.assignments) {
            if (!known.has(a.key)) {
                push(
                    range(a.keyStart, a.keyEnd),
                    `${a.key} is not read by the server. Known keys: ${[...known].join(', ')}.`,
                    CODE.manifestUnknownKey,
                    vscode.DiagnosticSeverity.Warning,
                );
                continue;
            }

            if (FILE_LIST_KEY_NAMES.includes(a.key)) {
                const scripts = SCRIPT_LIST_KEYS.includes(a.key);
                for (const entry of a.list ?? []) {
                    const r = range(entry.contentStart, entry.contentEnd);
                    const value = entry.value;

                    if (isCrossResourceEntry(value)) {
                        const split = splitCrossResourceEntry(value);
                        if (!split) {
                            push(r, `${a.key}: malformed cross-resource entry, want ":resource/path".`, CODE.manifestBadPath);
                            continue;
                        }
                        if (a.key === 'map_files') {
                            push(r, 'map_files cannot borrow from another resource.', CODE.manifestBadPath);
                            continue;
                        }
                        const luaLike = isLuaPath(split.path) || hasGlob(split.path);
                        if (scripts && !luaLike) {
                            push(r, `${a.key} accepts only .lua scripts.`, CODE.manifestScriptSplit);
                        }
                        if (!scripts && isLuaPath(split.path)) {
                            push(r, `${a.key} is for assets; scripts go in server_files, client_files or shared_files.`, CODE.manifestScriptSplit);
                        }
                        continue;
                    }

                    if (!isSafeRelativePath(value)) {
                        push(
                            r,
                            `${a.key}: unsafe path. Use a relative path with "/" separators, no leading "/", no ".." and no ":".`,
                            CODE.manifestBadPath,
                        );
                        continue;
                    }

                    if (scripts && !isLuaPath(value) && !hasGlob(value)) {
                        push(r, `${a.key} accepts only .lua scripts (assets go in files = {}).`, CODE.manifestScriptSplit);
                        continue;
                    }
                    if (!scripts && isLuaPath(value)) {
                        push(
                            r,
                            `${a.key} is for downloadable assets; scripts go in server_files, client_files or shared_files.`,
                            CODE.manifestScriptSplit,
                        );
                        continue;
                    }

                    if (!hasGlob(value)) {
                        const abs = path.join(root, ...value.split('/'));
                        if (!fs.existsSync(abs)) {
                            push(
                                r,
                                `${value} does not exist in this resource folder.`,
                                CODE.manifestMissingFile,
                                vscode.DiagnosticSeverity.Warning,
                            );
                        }
                        const keys = declaredPaths.get(value.toLowerCase()) ?? [];
                        keys.push(a.key);
                        declaredPaths.set(value.toLowerCase(), keys);
                    }
                }
            }

            if (a.key === 'escrow_files') {
                const protectable = this.api.snapshot.protectableExtensions ?? ['.lua'];
                const declaredElsewhere = new Set<string>();
                for (const key of FILE_LIST_KEY_NAMES) {
                    for (const e of parsed.byKey.get(key)?.list ?? []) declaredElsewhere.add(e.value.toLowerCase());
                }
                for (const entry of a.list ?? []) {
                    const r = range(entry.contentStart, entry.contentEnd);
                    const value = entry.value;
                    if (!isSafeRelativePath(value)) {
                        push(r, 'escrow_files: unsafe path (relative, "/" separators, no "..").', CODE.manifestEscrow);
                        continue;
                    }
                    if (hasGlob(value)) continue;
                    if (!protectable.some((ext) => value.toLowerCase().endsWith(ext))) {
                        push(
                            r,
                            `escrow_files only opens what the build protects (${protectable.join(', ')}); `
                            + 'everything else already ships open.',
                            CODE.manifestEscrow,
                        );
                        continue;
                    }
                    const covered = declaredElsewhere.has(value.toLowerCase())
                        || [...declaredElsewhere].some((d) => hasGlob(d) && globMatches(d, value));
                    if (!covered) {
                        push(
                            r,
                            'escrow_files points at a file that is not declared in '
                            + 'server_files, client_files, shared_files, files or map_files.',
                            CODE.manifestEscrow,
                        );
                    }
                }
            }

            if (a.key === 'exports') {
                for (const entry of a.list ?? []) {
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.value)) {
                        push(
                            range(entry.contentStart, entry.contentEnd),
                            'exports accepts plain function names only.',
                            CODE.manifestExport,
                        );
                    }
                }
            }

            if ((a.key === 'loadscreen' || a.key === 'loadscreen_manual_shutdown') && a.kind !== 'boolean') {
                push(
                    range(a.valueStart, a.valueEnd),
                    `${a.key} is a flag: true or false.`
                    + (a.key === 'loadscreen' ? ' The html entry point goes in ui_page.' : ''),
                    CODE.manifestFlag,
                );
            }
        }

        for (const [value, keys] of declaredPaths) {
            const scriptKeys = keys.filter((k) => SCRIPT_LIST_KEYS.includes(k));
            if (new Set(scriptKeys).size < 2) continue;
            const a = parsed.assignments.find((x) => x.key === scriptKeys[1]);
            const entry = a?.list?.find((e) => e.value.toLowerCase() === value);
            if (a && entry) {
                push(
                    range(entry.contentStart, entry.contentEnd),
                    `This script is also in ${scriptKeys[0]}. The server collapses it into a single shared script.`,
                    CODE.manifestDuplicate,
                    vscode.DiagnosticSeverity.Information,
                );
            }
        }

        const uiPage = parsed.byKey.get('ui_page');
        if (uiPage?.string) {
            const value = uiPage.string.value;
            const r = range(uiPage.string.contentStart, uiPage.string.contentEnd);
            if (!isSafeRelativePath(value) || isLuaPath(value)) {
                push(r, 'ui_page must be a clean relative path to a page, not a script.', CODE.manifestUiPage);
            } else {
                const files = parsed.byKey.get('files')?.list?.map((e) => e.value) ?? [];
                const listed = files.some((f) => (hasGlob(f) ? globMatches(f, value) : f === value));
                if (!listed) push(r, 'ui_page must also be listed in files = {}.', CODE.manifestUiPage);
            }
        }

        const manual = parsed.byKey.get('loadscreen_manual_shutdown');
        if (manual?.boolean && parsed.byKey.get('loadscreen')?.boolean !== true) {
            push(
                range(manual.keyStart, manual.keyEnd),
                'loadscreen_manual_shutdown does nothing without loadscreen = true.',
                CODE.manifestFlag,
                vscode.DiagnosticSeverity.Warning,
            );
        }

        const forbidden = new Set([
            'dofile', 'loadfile', 'load', 'loadstring', 'require', 'collectgarbage',
            'os', 'io', 'package', 'debug', 'print', 'getmetatable', 'setmetatable',
        ]);
        for (const ident of findIdentifiers(parsed.scan.masked)) {
            if (ident.accessor) continue;
            if (!forbidden.has(ident.name)) continue;
            push(
                range(ident.start, ident.end),
                `${ident.name} does not exist in the manifest sandbox. `
                + 'The manifest declares the resource; it does not run logic.',
                CODE.manifestSandbox,
            );
        }

        return out;
    }

    private symbolsFor(fsPath: string): ResourceSymbols | null {
        const resource = this.resources.resourceFor(fsPath);
        if (!resource) return null;
        try {
            return symbolsOf(resource.root, resource.lists);
        } catch {
            return null;
        }
    }

    private removedGlobalsCache: Set<string> | null = null;
    private removedGlobals(): Set<string> {
        if (!this.removedGlobalsCache) {
            const policy = this.api.snapshot.policy;
            const names = policy?.removedGlobals ?? [];
            this.removedGlobalsCache = new Set(names.filter((n) => !this.api.has(n)));
        }
        return this.removedGlobalsCache;
    }

    private restrictedOsFieldsCache: Set<string> | null = null;
    private restrictedOsFields(): Set<string> {
        if (!this.restrictedOsFieldsCache) {
            this.restrictedOsFieldsCache = new Set(this.api.snapshot.policy?.restrictedOsFields ?? []);
        }
        return this.restrictedOsFieldsCache;
    }

    private sandboxAdvice(name: string): string {
        switch (name) {
            case 'require':
            case 'dofile':
                return 'List every script in the manifest instead.';
            case 'getfenv':
            case 'setfenv':
                return 'Lua 5.4 uses _ENV.';
            default:
                return '';
        }
    }

    nearestNative(name: string): string | undefined {
        if (name.length < 5) return undefined;
        const max = name.length <= 8 ? 1 : 2;
        let best: string | undefined;
        let bestScore = max + 1;
        for (const fn of this.api.functions) {
            if (Math.abs(fn.name.length - name.length) > max) continue;
            const d = editDistance(name, fn.name, max);
            if (d < bestScore) { bestScore = d; best = fn.name; }
            if (bestScore === 1) break;
        }
        return bestScore <= max ? best : undefined;
    }

    nearestEvent(name: string): string | undefined {
        const max = 1;
        let best: string | undefined;
        let bestScore = max + 1;
        for (const ev of this.api.events) {
            if (Math.abs(ev.name.length - name.length) > max) continue;
            const d = editDistance(name, ev.name, max);
            if (d < bestScore) { bestScore = d; best = ev.name; }
            if (bestScore === 1) break;
        }
        return bestScore <= max ? best : undefined;
    }

    sideOf(document: vscode.TextDocument): Side {
        return this.resources.resolveSide(document.uri.fsPath).side;
    }
}
