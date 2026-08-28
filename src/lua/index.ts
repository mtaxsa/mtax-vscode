import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Analysis, Binding, analyze } from './analyze';
import { ResourceIndex, ResourceInfo } from '../manifest/resource';
import { resolveScripts } from '../manifest/symbols';

export interface DefinitionSite {
    fsPath: string;
    binding: Binding;
}

export interface ResourceScope {
    root: string;
    name: string;
    files: string[];
    globals: Map<string, DefinitionSite[]>;
    fields: Map<string, DefinitionSite[]>;
    events: Set<string>;
}

interface FileEntry {
    analysis: Analysis;
    stamp: string;
}

const MAX_FILE_BYTES = 4_000_000;

export class LuaIndex implements vscode.Disposable {
    private readonly files = new Map<string, FileEntry>();
    private readonly scopes = new Map<string, { scope: ResourceScope; stamp: string }>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly resources: ResourceIndex) {
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument((doc) => this.files.delete(key(doc.uri.fsPath))),
            this.resources.onDidChange(() => this.scopes.clear()),
        );
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.files.clear();
        this.scopes.clear();
    }

    forDocument(document: vscode.TextDocument): Analysis {
        const id = key(document.uri.fsPath);
        const stamp = `v${document.version}`;
        const cached = this.files.get(id);
        if (cached && cached.stamp === stamp) return cached.analysis;

        const analysis = analyze(document.getText());
        this.files.set(id, { analysis, stamp });
        return analysis;
    }

    forPath(fsPath: string): Analysis | null {
        const open = vscode.workspace.textDocuments.find(
            (d) => d.uri.scheme === 'file' && key(d.uri.fsPath) === key(fsPath),
        );
        if (open) return this.forDocument(open);

        const id = key(fsPath);
        let stamp: string;
        try {
            const stat = fs.statSync(fsPath);
            if (stat.size > MAX_FILE_BYTES) return null;
            stamp = `m${stat.mtimeMs}`;
        } catch {
            this.files.delete(id);
            return null;
        }

        const cached = this.files.get(id);
        if (cached && cached.stamp === stamp) return cached.analysis;

        let text: string;
        try {
            text = fs.readFileSync(fsPath, 'utf8');
        } catch {
            return null;
        }

        const analysis = analyze(text);
        this.files.set(id, { analysis, stamp });
        return analysis;
    }

    scopeFor(fsPath: string): ResourceScope | null {
        const resource = this.resources.resourceFor(fsPath);
        if (!resource) return null;
        return this.scopeOf(resource);
    }

    scopeOf(resource: ResourceInfo): ResourceScope {
        const files = this.filesOf(resource);
        const stamps: string[] = [];
        const analyses: { fsPath: string; analysis: Analysis }[] = [];
        for (const fsPath of files) {
            const analysis = this.forPath(fsPath);
            if (!analysis) continue;
            analyses.push({ fsPath, analysis });
            stamps.push(this.files.get(key(fsPath))?.stamp ?? '');
        }
        const stamp = `${files.length}:${stamps.join('|')}`;

        const cached = this.scopes.get(resource.root);
        if (cached && cached.stamp === stamp) return cached.scope;

        const globals = new Map<string, DefinitionSite[]>();
        const fields = new Map<string, DefinitionSite[]>();
        const events = new Set<string>();

        for (const { fsPath, analysis } of analyses) {
            for (const [name, binding] of analysis.globals) {
                const list = globals.get(name) ?? [];
                list.push({ fsPath, binding });
                globals.set(name, list);
            }
            for (const [pathName, binding] of analysis.fields) {
                const list = fields.get(pathName) ?? [];
                list.push({ fsPath, binding });
                fields.set(pathName, list);
            }
            for (const literal of analysis.strings) {
                if (literal.call === 'addEvent' && literal.argIndex === 0) events.add(literal.value);
            }
        }

        const scope: ResourceScope = {
            root: resource.root,
            name: resource.name,
            files,
            globals,
            fields,
            events,
        };
        this.scopes.set(resource.root, { scope, stamp });
        return scope;
    }

    private filesOf(resource: ResourceInfo): string[] {
        const declared = resolveScripts(resource.root, resource.lists);
        const all = new Set(declared.map((p) => path.normalize(p)));
        for (const extra of walkLua(resource.root)) all.add(path.normalize(extra));
        return [...all];
    }

    allResourceRoots(): string[] {
        const roots = new Set<string>();
        for (const document of vscode.workspace.textDocuments) {
            if (document.languageId !== 'lua') continue;
            const root = this.resources.findResourceRoot(document.uri.fsPath);
            if (root) roots.add(root);
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            for (const root of findResourceRoots(folder.uri.fsPath)) roots.add(root);
        }
        return [...roots];
    }
}

function key(fsPath: string): string {
    return path.normalize(fsPath).toLowerCase();
}

function walkLua(dir: string, out: string[] = [], depth = 0): string[] {
    if (depth > 8) return out;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkLua(full, out, depth + 1);
        else if (entry.name.toLowerCase().endsWith('.lua')) out.push(full);
    }
    return out;
}

function findResourceRoots(dir: string, out: string[] = [], depth = 0): string[] {
    if (depth > 6) return out;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'mtaxmanifest.lua')) {
        out.push(dir);
        return out;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        findResourceRoots(path.join(dir, entry.name), out, depth + 1);
    }
    return out;
}
