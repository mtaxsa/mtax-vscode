import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Side } from '../api/model';
import { ParsedManifest, parseManifest } from './parse';
import { sideFromLists, guessSideFromPath, isUndeclared, parseMetaXml, MetaXml } from './side';

export { guessSideFromPath, parseMetaXml };
export type { MetaXml };

export const MANIFEST_NAME = 'mtaxmanifest.lua';

export interface ResourceInfo {
    root: string;
    manifestPath: string | null;
    metaXmlPath: string | null;
    manifest: ParsedManifest | null;
    name: string;
    exports: string[];
    lists: Record<string, string[]>;
}

export interface SideResolution {
    side: Side;
    reason: string;
    certain: boolean;
    resource: ResourceInfo | null;
}

interface CacheEntry {
    info: ResourceInfo;
    mtimeMs: number;
}

export class ResourceIndex implements vscode.Disposable {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly rootCache = new Map<string, string | null>();
    private readonly overrides = new Map<string, Side>();
    private readonly watcher: vscode.FileSystemWatcher;
    private readonly emitter = new vscode.EventEmitter<void>();

    readonly onDidChange = this.emitter.event;

    constructor() {
        this.watcher = vscode.workspace.createFileSystemWatcher('**/{mtaxmanifest.lua,meta.xml}');
        const invalidate = () => { this.cache.clear(); this.rootCache.clear(); this.emitter.fire(); };
        this.watcher.onDidChange(invalidate);
        this.watcher.onDidCreate(invalidate);
        this.watcher.onDidDelete(invalidate);
    }

    dispose(): void {
        this.watcher.dispose();
        this.emitter.dispose();
    }

    setOverride(fsPath: string, side: Side | null): void {
        if (side) this.overrides.set(path.normalize(fsPath), side);
        else this.overrides.delete(path.normalize(fsPath));
        this.emitter.fire();
    }

    getOverride(fsPath: string): Side | undefined {
        return this.overrides.get(path.normalize(fsPath));
    }

    findResourceRoot(fsPath: string): string | null {
        const startDir = fs.existsSync(fsPath) && fs.statSync(fsPath).isDirectory() ? fsPath : path.dirname(fsPath);
        const cached = this.rootCache.get(startDir);
        if (cached !== undefined) return cached;

        const workspaceRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath))?.uri.fsPath;
        let dir = startDir;
        for (let i = 0; i < 40; i++) {
            if (fs.existsSync(path.join(dir, MANIFEST_NAME)) || fs.existsSync(path.join(dir, 'meta.xml'))) {
                this.rootCache.set(startDir, dir);
                return dir;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            if (workspaceRoot && !isInside(parent, workspaceRoot) && parent !== workspaceRoot) break;
            dir = parent;
        }
        this.rootCache.set(startDir, null);
        return null;
    }

    resourceFor(fsPath: string): ResourceInfo | null {
        const root = this.findResourceRoot(fsPath);
        if (!root) return null;
        return this.load(root);
    }

    load(root: string): ResourceInfo | null {
        const manifestPath = path.join(root, MANIFEST_NAME);
        const metaXmlPath = path.join(root, 'meta.xml');
        const hasManifest = fs.existsSync(manifestPath);
        const hasMeta = fs.existsSync(metaXmlPath);
        if (!hasManifest && !hasMeta) return null;

        const stampFile = hasManifest ? manifestPath : metaXmlPath;
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(stampFile).mtimeMs; } catch { /* raced with a delete */ }

        const cached = this.cache.get(root);
        if (cached && cached.mtimeMs === mtimeMs) return cached.info;

        let manifest: ParsedManifest | null = null;
        const lists: Record<string, string[]> = {};
        let name = path.basename(root);
        let exports: string[] = [];

        if (hasManifest) {
            try {
                manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
                for (const key of ['server_files', 'client_files', 'shared_files', 'files', 'map_files']) {
                    const a = manifest.byKey.get(key);
                    lists[key] = a?.list?.map((e) => e.value) ?? [];
                }
                name = manifest.byKey.get('resource_name')?.string?.value || name;
                exports = manifest.byKey.get('exports')?.list?.map((e) => e.value) ?? [];
            } catch {
                manifest = null;
            }
        } else if (hasMeta) {
            const meta = parseMetaXml(fs.readFileSync(metaXmlPath, 'utf8'));
            lists['server_files'] = meta.server;
            lists['client_files'] = meta.client;
            lists['shared_files'] = meta.shared;
            lists['files'] = meta.files;
            exports = meta.exports;
        }

        const info: ResourceInfo = {
            root,
            manifestPath: hasManifest ? manifestPath : null,
            metaXmlPath: hasMeta ? metaXmlPath : null,
            manifest,
            name,
            exports,
            lists,
        };
        this.cache.set(root, { info, mtimeMs });
        return info;
    }

    resolveSide(fsPath: string): SideResolution {
        const override = this.getOverride(fsPath);
        const resource = this.resourceFor(fsPath);

        if (override) {
            return { side: override, reason: 'set by hand for this file', certain: true, resource };
        }

        if (resource) {
            const rel = path.relative(resource.root, fsPath).split(path.sep).join('/');
            const source = resource.manifestPath ? MANIFEST_NAME : 'meta.xml';
            const verdict = sideFromLists(resource.lists, rel, source);
            if (verdict) return { ...verdict, resource };
        }

        return { ...guessSideFromPath(fsPath), resource };
    }

    isUndeclared(fsPath: string): boolean {
        const resource = this.resourceFor(fsPath);
        if (!resource || !resource.manifestPath) return false;
        const rel = path.relative(resource.root, fsPath).split(path.sep).join('/');
        if (rel === MANIFEST_NAME) return false;
        return isUndeclared(resource.lists, rel);
    }
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
