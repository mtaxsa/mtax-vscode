import * as vscode from 'vscode';

import { ResourceIndex } from '../manifest/resource';
import { Side } from '../api/model';

const ICON: Record<Side, string> = {
    client: '$(device-desktop)',
    server: '$(server)',
    shared: '$(link)',
};

export class MtaxStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly resources: ResourceIndex) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        this.item.command = 'mtax.pickSide';

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.update()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('mtax')) this.update();
            }),
            this.resources.onDidChange(() => this.update()),
        );
        this.update();
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.item.dispose();
    }

    update(): void {
        const config = vscode.workspace.getConfiguration('mtax');
        const editor = vscode.window.activeTextEditor;

        if (!config.get<boolean>('enable', true) || !config.get<boolean>('statusBar', true)
            || !editor || editor.document.languageId !== 'lua') {
            this.item.hide();
            return;
        }

        const { side, reason, certain, resource } = this.resources.resolveSide(editor.document.uri.fsPath);
        this.item.text = `${ICON[side]} MTAX ${side}${certain ? '' : '?'}`;

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**Runs on the ${side}** — ${reason}.\n\n`);
        if (resource) tooltip.appendMarkdown(`Resource: \`${resource.name}\`\n\n`);
        if (!certain) tooltip.appendMarkdown('Guessed from the path. Click to set it by hand.\n\n');
        else tooltip.appendMarkdown('Click to override it for this file.\n\n');
        this.item.tooltip = tooltip;

        this.item.backgroundColor = certain
            ? undefined
            : new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.show();
    }
}
