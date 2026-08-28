import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { hasGlob, isCrossResourceEntry, splitCrossResourceEntry, parseManifest } from '../manifest/parse';
import { FILE_LIST_KEY_NAMES } from '../manifest/parse';
import { isManifest } from './completion';

export class ManifestLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        if (!isManifest(document)) return [];

        const root = path.dirname(document.uri.fsPath);
        const parsed = parseManifest(document.getText());
        const links: vscode.DocumentLink[] = [];

        const linkTo = (target: string, start: number, end: number, tooltip: string) => {
            if (!fs.existsSync(target)) return;
            const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
            const link = new vscode.DocumentLink(range, vscode.Uri.file(target));
            link.tooltip = tooltip;
            links.push(link);
        };

        for (const a of parsed.assignments) {
            const isList = FILE_LIST_KEY_NAMES.includes(a.key);
            const entries = isList ? a.list ?? [] : a.key === 'ui_page' && a.string ? [a.string] : [];

            for (const entry of entries) {
                if (hasGlob(entry.value)) continue;

                if (isCrossResourceEntry(entry.value)) {
                    const split = splitCrossResourceEntry(entry.value);
                    if (!split) continue;
                    const other = this.findResourceByName(split.resource, root);
                    if (!other) continue;
                    linkTo(
                        path.join(other, ...split.path.split('/')),
                        entry.contentStart,
                        entry.contentEnd,
                        `borrowed from ${split.resource}`,
                    );
                    continue;
                }

                linkTo(
                    path.join(root, ...entry.value.split('/')),
                    entry.contentStart,
                    entry.contentEnd,
                    `open ${entry.value}`,
                );
            }
        }

        return links;
    }

    private findResourceByName(name: string, from: string): string | null {
        let dir = path.dirname(from);
        for (let depth = 0; depth < 4; depth++) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(path.join(candidate, 'mtaxmanifest.lua'))) return candidate;
            try {
                for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (!child.isDirectory()) continue;
                    const nested = path.join(dir, child.name, name);
                    if (fs.existsSync(path.join(nested, 'mtaxmanifest.lua'))) return nested;
                }
            } catch { /* unreadable folder, keep walking up */ }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return null;
    }
}
