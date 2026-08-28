import * as path from 'path';
import * as vscode from 'vscode';

const LUALS_EXTENSION = 'sumneko.lua';
const DISMISSED_KEY = 'mtax.luals.dismissed';

export function definitionsPath(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, 'definitions');
}

export async function configureLuaLs(
    context: vscode.ExtensionContext,
    options: { force?: boolean } = {},
): Promise<void> {
    const luals = vscode.extensions.getExtension(LUALS_EXTENSION);
    if (!luals) {
        if (options.force) {
            const answer = await vscode.window.showInformationMessage(
                'lua-language-server (sumneko.lua) is not installed. It adds type inference on top of the MTAX API.',
                'Install it',
            );
            if (answer === 'Install it') {
                await vscode.commands.executeCommand('workbench.extensions.search', LUALS_EXTENSION);
            }
        }
        return;
    }

    if (!options.force) {
        const mode = vscode.workspace.getConfiguration('mtax').get<string>('luals.autoConfigure', 'ask');
        if (mode === 'never') return;
        if (context.workspaceState.get<boolean>(DISMISSED_KEY)) return;
        if (mode === 'ask' && !(await askToConfigure(context))) return;
    }

    await applySettings(context);
}

async function askToConfigure(context: vscode.ExtensionContext): Promise<boolean> {
    const answer = await vscode.window.showInformationMessage(
        'Point lua-language-server at the MTAX definitions for this workspace? '
        + 'It gives typed completion for all 1059 natives.',
        'Set it up',
        'Not now',
        'Never for this workspace',
    );
    if (answer === 'Never for this workspace') {
        await context.workspaceState.update(DISMISSED_KEY, true);
        return false;
    }
    return answer === 'Set it up';
}

async function applySettings(context: vscode.ExtensionContext): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage('Open a folder first — the settings are written per workspace.');
        return;
    }

    const definitions = definitionsPath(context);
    const lua = vscode.workspace.getConfiguration('Lua');
    const target = vscode.ConfigurationTarget.Workspace;

    const current = lua.get<string[]>('workspace.library', []) ?? [];
    const cleaned = current.filter((entry) => !entry.replace(/\\/g, '/').includes('/mtax-lua'));
    if (!cleaned.includes(definitions)) cleaned.push(definitions);
    await lua.update('workspace.library', cleaned, target);

    await lua.update('runtime.version', 'Lua 5.4', target);
    await lua.update('workspace.checkThirdParty', false, target);

    const builtin = { ...(lua.get<Record<string, string>>('runtime.builtin', {}) ?? {}) };
    builtin.io = 'disable';
    builtin.package = 'disable';
    builtin.debug = 'disable';
    await lua.update('runtime.builtin', builtin, target);

    vscode.window.showInformationMessage('lua-language-server is now using the MTAX definitions.');
}
