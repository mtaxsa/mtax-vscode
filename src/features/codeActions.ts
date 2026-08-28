import * as path from 'path';
import * as vscode from 'vscode';

import { Api } from '../api/model';
import { ResourceIndex, MANIFEST_NAME } from '../manifest/resource';
import { addEntryToList, moveEntry } from '../manifest/edit';
import { parseManifest, isLuaPath } from '../manifest/parse';
import { CODE, SOURCE } from './diagnostics';
import { isManifest, enclosingListKey } from './completion';
import { scanLua } from '../util/lua';

export class MtaxCodeActionProvider implements vscode.CodeActionProvider {
    static readonly kinds = [vscode.CodeActionKind.QuickFix];

    constructor(private readonly api: Api, private readonly resources: ResourceIndex) {}

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source !== SOURCE) continue;

            switch (diagnostic.code) {
                case CODE.typo:
                case CODE.eventTypo: {
                    const suggestion = diagnostic.message.match(/Did you mean ([A-Za-z0-9_]+)\?/)?.[1];
                    if (!suggestion) break;
                    const fix = new vscode.CodeAction(`Replace with ${suggestion}`, vscode.CodeActionKind.QuickFix);
                    fix.edit = new vscode.WorkspaceEdit();
                    fix.edit.replace(document.uri, diagnostic.range, suggestion);
                    fix.diagnostics = [diagnostic];
                    fix.isPreferred = true;
                    actions.push(fix);
                    break;
                }

                case CODE.undeclaredFile:
                    actions.push(...this.declareFileActions(document, diagnostic));
                    break;

                case CODE.wrongSide:
                    actions.push(...this.wrongSideActions(document, diagnostic));
                    break;

                case CODE.manifestMissingFile:
                    actions.push(...this.createMissingFileAction(document, diagnostic));
                    break;

                case CODE.manifestScriptSplit:
                    actions.push(...this.moveEntryActions(document, diagnostic));
                    break;

                case CODE.manifestUiPage:
                    actions.push(...this.uiPageActions(document, diagnostic));
                    break;

                case CODE.sandboxGlobal: {
                    const name = document.getText(diagnostic.range);
                    if (name === 'require' || name === 'dofile') {
                        const fix = new vscode.CodeAction(
                            `List the script in ${MANIFEST_NAME} instead`,
                            vscode.CodeActionKind.QuickFix,
                        );
                        const resource = this.resources.resourceFor(document.uri.fsPath);
                        if (resource?.manifestPath) {
                            fix.command = {
                                command: 'vscode.open',
                                title: 'open manifest',
                                arguments: [vscode.Uri.file(resource.manifestPath)],
                            };
                        }
                        fix.diagnostics = [diagnostic];
                        actions.push(fix);
                    }
                    break;
                }
            }
        }

        return actions;
    }

    private declareFileActions(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction[] {
        const resource = this.resources.resourceFor(document.uri.fsPath);
        if (!resource?.manifestPath) return [];

        const rel = path.relative(resource.root, document.uri.fsPath).split(path.sep).join('/');
        const guessed = this.resources.resolveSide(document.uri.fsPath);
        const keys = ['server_files', 'client_files', 'shared_files'];
        const preferred = `${guessed.side}_files`;

        return keys.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0)).map((key) => {
            const action = new vscode.CodeAction(`Add to ${key}`, vscode.CodeActionKind.QuickFix);
            action.diagnostics = [diagnostic];
            action.isPreferred = key === preferred;
            action.command = {
                command: 'mtax.internal.addToManifest',
                title: 'add to manifest',
                arguments: [resource.manifestPath, key, rel],
            };
            return action;
        });
    }

    private wrongSideActions(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction[] {
        const out: vscode.CodeAction[] = [];
        const name = document.getText(diagnostic.range);
        const fn = this.api.fn(name);
        if (fn?.url) {
            const docs = new vscode.CodeAction(`Open the docs for ${name}`, vscode.CodeActionKind.QuickFix);
            docs.command = { command: 'vscode.open', title: 'open docs', arguments: [vscode.Uri.parse(fn.url)] };
            docs.diagnostics = [diagnostic];
            out.push(docs);
        }

        const resolution = this.resources.resolveSide(document.uri.fsPath);
        if (fn && !resolution.certain) {
            const fix = new vscode.CodeAction(
                `This file actually runs on the ${fn.side} — remember that`,
                vscode.CodeActionKind.QuickFix,
            );
            fix.command = {
                command: 'mtax.internal.setSide',
                title: 'set side',
                arguments: [document.uri.fsPath, fn.side],
            };
            fix.diagnostics = [diagnostic];
            out.push(fix);
        }
        return out;
    }

    private createMissingFileAction(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction[] {
        if (!isManifest(document)) return [];
        const value = document.getText(diagnostic.range);
        const target = vscode.Uri.joinPath(
            vscode.Uri.file(path.dirname(document.uri.fsPath)),
            ...value.split('/'),
        );
        const action = new vscode.CodeAction(`Create ${value}`, vscode.CodeActionKind.QuickFix);
        action.command = {
            command: 'mtax.internal.createFile',
            title: 'create file',
            arguments: [target.fsPath],
        };
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        return [action];
    }

    private moveEntryActions(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction[] {
        if (!isManifest(document)) return [];
        const value = document.getText(diagnostic.range);
        const scan = scanLua(document.getText());
        const offset = document.offsetAt(diagnostic.range.start);
        const fromKey = enclosingListKey(scan.masked, offset);
        if (!fromKey) return [];

        const targets = isLuaPath(value)
            ? ['server_files', 'client_files', 'shared_files']
            : ['files'];

        return targets.filter((k) => k !== fromKey).map((toKey) => {
            const action = new vscode.CodeAction(`Move to ${toKey}`, vscode.CodeActionKind.QuickFix);
            action.edit = new vscode.WorkspaceEdit();
            action.edit.set(document.uri, moveEntry(document, fromKey, value, toKey));
            action.diagnostics = [diagnostic];
            return action;
        });
    }

    private uiPageActions(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction[] {
        if (!isManifest(document)) return [];
        const value = document.getText(diagnostic.range);
        if (isLuaPath(value)) return [];
        const parsed = parseManifest(document.getText());
        if (parsed.byKey.get('files')?.list?.some((e) => e.value === value)) return [];

        const edit = addEntryToList(document, 'files', value);
        if (!edit) return [];
        const action = new vscode.CodeAction(`Add ${value} to files`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.set(document.uri, [edit]);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        return [action];
    }
}
