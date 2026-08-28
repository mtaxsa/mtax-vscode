import * as vscode from 'vscode';

import { Api } from './api/model';
import { ResourceIndex } from './manifest/resource';
import { MtaxCompletionProvider, ManifestCompletionProvider } from './features/completion';
import { MtaxHoverProvider } from './features/hover';
import { MtaxSignatureHelpProvider } from './features/signature';
import { MtaxDiagnostics } from './features/diagnostics';
import { MtaxCodeActionProvider } from './features/codeActions';
import { ManifestLinkProvider } from './features/links';
import { MtaxStatusBar } from './features/statusBar';
import { registerCommands } from './features/commands';
import { configureLuaLs } from './features/luals';

const LUA: vscode.DocumentSelector = { language: 'lua', scheme: 'file' };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    let api: Api;
    try {
        api = Api.load(context.extensionPath);
    } catch (error) {
        vscode.window.showErrorMessage(
            `MTAX: could not read the bundled API snapshot (${error instanceof Error ? error.message : error}).`,
        );
        return;
    }

    const resources = new ResourceIndex();
    context.subscriptions.push(resources);

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            LUA,
            new MtaxCompletionProvider(api, resources),
            '.', ':', '"', "'",
        ),
        vscode.languages.registerCompletionItemProvider(
            LUA,
            new ManifestCompletionProvider(api, resources),
            '"', "'", '/',
        ),
        vscode.languages.registerHoverProvider(LUA, new MtaxHoverProvider(api, resources)),
        vscode.languages.registerSignatureHelpProvider(
            LUA,
            new MtaxSignatureHelpProvider(api, resources),
            '(', ',',
        ),
        vscode.languages.registerCodeActionsProvider(
            LUA,
            new MtaxCodeActionProvider(api, resources),
            { providedCodeActionKinds: MtaxCodeActionProvider.kinds },
        ),
        vscode.languages.registerDocumentLinkProvider(LUA, new ManifestLinkProvider()),
    );

    const diagnostics = new MtaxDiagnostics(api, resources);
    context.subscriptions.push(diagnostics);

    const statusBar = new MtaxStatusBar(resources);
    context.subscriptions.push(statusBar);

    registerCommands(context, api, resources);

    if (await hasResources()) {
        void configureLuaLs(context);
    }
}

async function hasResources(): Promise<boolean> {
    if (!vscode.workspace.workspaceFolders?.length) return false;
    const found = await vscode.workspace.findFiles('**/mtaxmanifest.lua', '**/node_modules/**', 1);
    return found.length > 0;
}

export function deactivate(): void {
    // Everything is registered through context.subscriptions.
}
