import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Api, ApiFunction, Side } from '../api/model';
import { ResourceIndex, MANIFEST_NAME, parseMetaXml } from '../manifest/resource';
import { addEntryToList } from '../manifest/edit';
import { TEMPLATES, renderTemplate } from './scaffold';
import { docsLanguage, sideLabel } from './docs';
import { signatureLine } from './completion';
import { scanLua, identifierAt, stringAt } from '../util/lua';
import { configureLuaLs } from './luals';

export function registerCommands(
    context: vscode.ExtensionContext,
    api: Api,
    resources: ResourceIndex,
): void {
    const register = (id: string, handler: (...args: any[]) => any) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));

    register('mtax.newResource', (uri?: vscode.Uri) => newResource(uri, resources));
    register('mtax.newScript', () => newScript(resources));
    register('mtax.searchApi', () => searchApi(api, resources));
    register('mtax.openDocs', () => openDocs(api));
    register('mtax.setupLuaLs', () => configureLuaLs(context, { force: true }));
    register('mtax.convertMetaXml', (uri?: vscode.Uri) => convertMetaXml(uri));
    register('mtax.regenerateApi', () => regenerateApi(context));
    register('mtax.pickSide', () => pickSide(resources));

    register('mtax.internal.addToManifest', async (manifestPath: string, key: string, value: string) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(manifestPath));
        const edit = addEntryToList(document, key, value);
        if (!edit) return;
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(document.uri, [edit]);
        await vscode.workspace.applyEdit(workspaceEdit);
        await document.save();
    });

    register('mtax.internal.setSide', (fsPath: string, side: Side) => {
        resources.setOverride(fsPath, side);
        vscode.window.setStatusBarMessage(`MTAX: this file is now treated as ${side}`, 4000);
    });

    register('mtax.internal.createFile', async (fsPath: string) => {
        const uri = vscode.Uri.file(fsPath);
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        }
        await vscode.window.showTextDocument(uri);
    });
}

async function newResource(uri: vscode.Uri | undefined, resources: ResourceIndex): Promise<void> {
    const parent = await pickParentFolder(uri);
    if (!parent) return;

    const name = await vscode.window.showInputBox({
        title: 'New MTAX resource',
        prompt: 'Folder name, and the name the server starts it by',
        validateInput: (value) => {
            if (!value.trim()) return 'Give the resource a name.';
            if (!/^[\w.-]+$/.test(value)) return 'Use letters, digits, "_", "-" or "." only.';
            if (fs.existsSync(path.join(parent, value))) return 'A folder with that name already exists here.';
            return null;
        },
    });
    if (!name) return;

    const picked = await vscode.window.showQuickPick(
        TEMPLATES.map((t) => ({ label: t.label, description: t.description, template: t })),
        { title: 'Layout' },
    );
    if (!picked) return;

    const author = vscode.workspace.getConfiguration('mtax').get<string>('author')
        || process.env.USERNAME || process.env.USER || 'unknown';

    const root = path.join(parent, name);
    for (const file of renderTemplate(picked.template, name, author)) {
        const target = vscode.Uri.file(path.join(root, ...file.path.split('/')));
        await vscode.workspace.fs.writeFile(target, Buffer.from(file.content, 'utf8'));
    }

    const manifestUri = vscode.Uri.file(path.join(root, MANIFEST_NAME));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifestUri));
    vscode.window.showInformationMessage(`Resource "${name}" created.`);
    resources.setOverride(root, null);
}

async function pickParentFolder(uri: vscode.Uri | undefined): Promise<string | undefined> {
    if (uri && fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory()) return uri.fsPath;

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false });
        return picked?.[0]?.fsPath;
    }

    const candidates: { label: string; description: string; fsPath: string }[] = [];
    for (const folder of folders) {
        const resourcesDir = path.join(folder.uri.fsPath, 'resources');
        if (fs.existsSync(resourcesDir)) {
            candidates.push({ label: 'resources/', description: folder.name, fsPath: resourcesDir });
        }
        candidates.push({ label: folder.name, description: folder.uri.fsPath, fsPath: folder.uri.fsPath });
    }
    if (candidates.length === 1) return candidates[0].fsPath;

    const picked = await vscode.window.showQuickPick(candidates, { title: 'Where should the resource go?' });
    return picked?.fsPath;
}

async function newScript(resources: ResourceIndex): Promise<void> {
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const resource = active ? resources.resourceFor(active) : null;
    if (!resource?.manifestPath) {
        vscode.window.showWarningMessage(`Open a file inside a resource with a ${MANIFEST_NAME} first.`);
        return;
    }

    const side = await vscode.window.showQuickPick(
        [
            { label: 'server', description: 'runs on the server, never sent to clients' },
            { label: 'client', description: 'downloaded and run on the player machine' },
            { label: 'shared', description: 'runs on both sides' },
        ],
        { title: 'Which side?' },
    );
    if (!side) return;

    const suggestion = `${side.label}/main.lua`;
    const relative = await vscode.window.showInputBox({
        title: 'New script',
        prompt: `Path inside ${resource.name}`,
        value: suggestion,
        valueSelection: [side.label.length + 1, suggestion.length - 4],
        validateInput: (value) => {
            if (!value.toLowerCase().endsWith('.lua')) return 'A script has to end in .lua.';
            if (value.startsWith('/') || value.includes('..') || value.includes('\\')) {
                return 'Use a relative path with "/" separators.';
            }
            return null;
        },
    });
    if (!relative) return;

    const target = vscode.Uri.file(path.join(resource.root, ...relative.split('/')));
    try {
        await vscode.workspace.fs.stat(target);
    } catch {
        await vscode.workspace.fs.writeFile(target, Buffer.from('', 'utf8'));
    }

    const manifest = await vscode.workspace.openTextDocument(vscode.Uri.file(resource.manifestPath));
    const edit = addEntryToList(manifest, `${side.label}_files`, relative);
    if (edit) {
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(manifest.uri, [edit]);
        await vscode.workspace.applyEdit(workspaceEdit);
        await manifest.save();
    }

    await vscode.window.showTextDocument(target);
}

interface ApiPick extends vscode.QuickPickItem {
    fn: ApiFunction;
}

async function searchApi(api: Api, resources: ResourceIndex): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const lang = docsLanguage();
    const side: Side = editor ? resources.resolveSide(editor.document.uri.fsPath).side : 'shared';

    const items: ApiPick[] = api.functions.map((fn) => ({
        label: fn.name,
        description: signatureLine(fn),
        detail: `${sideLabel(fn.side, lang)}${fn.description ? ` — ${firstLine(fn.description)}` : ''}`,
        fn,
    }));
    items.sort((a, b) => {
        const callable = (f: ApiFunction) => (api.isCallableFrom(f, side) ? 0 : 1);
        return callable(a.fn) - callable(b.fn) || a.label.localeCompare(b.label);
    });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'MTAX API',
        placeHolder: `${items.length} natives — pick one to insert it, or open its docs`,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked) return;

    if (!editor) {
        if (picked.fn.url) await vscode.env.openExternal(vscode.Uri.parse(picked.fn.url));
        return;
    }

    const action = await vscode.window.showQuickPick(
        [
            { label: '$(edit) Insert a call', id: 'insert' },
            { label: '$(book) Open the documentation', id: 'docs' },
        ],
        { title: picked.fn.name },
    );
    if (!action) return;

    if (action.id === 'docs') {
        if (picked.fn.url) await vscode.env.openExternal(vscode.Uri.parse(picked.fn.url));
        else vscode.window.showInformationMessage(`${picked.fn.name} has no documentation page yet.`);
        return;
    }

    const params = picked.fn.variants?.[0]?.params.filter((p) => !p.optional) ?? [];
    const snippet = new vscode.SnippetString(
        `${picked.fn.name}(${params.map((p, i) => `\${${i + 1}:${p.name}}`).join(', ')})`,
    );
    await editor.insertSnippet(snippet);
}

function firstLine(text: string): string {
    return text.split('\n')[0].replace(/\s+/g, ' ').slice(0, 120);
}

async function openDocs(api: Api): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const scan = scanLua(editor.document.getText());
    const offset = editor.document.offsetAt(editor.selection.active);

    const literal = stringAt(scan, offset);
    if (literal) {
        const event = api.event(literal.value);
        if (event?.url) {
            await vscode.env.openExternal(vscode.Uri.parse(event.url));
            return;
        }
    }

    const ident = identifierAt(scan.masked, offset);
    if (!ident) {
        vscode.window.showInformationMessage('Put the cursor on a native, an event name or a class first.');
        return;
    }

    const fn = api.fn(ident.name);
    if (fn?.url) {
        await vscode.env.openExternal(vscode.Uri.parse(fn.url));
        return;
    }

    const method = api.methodsNamed(ident.name)[0];
    const wrapped = method ? api.fn(method.native) : undefined;
    if (wrapped?.url) {
        await vscode.env.openExternal(vscode.Uri.parse(wrapped.url));
        return;
    }

    vscode.window.showInformationMessage(`No documentation page is linked for "${ident.name}".`);
}

async function convertMetaXml(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || path.basename(target.fsPath).toLowerCase() !== 'meta.xml') {
        vscode.window.showWarningMessage('Select a meta.xml file first.');
        return;
    }

    const root = path.dirname(target.fsPath);
    const manifestPath = path.join(root, MANIFEST_NAME);
    if (fs.existsSync(manifestPath)) {
        const answer = await vscode.window.showWarningMessage(
            `${MANIFEST_NAME} already exists in this folder. Overwrite it?`,
            { modal: true },
            'Overwrite',
        );
        if (answer !== 'Overwrite') return;
    }

    const meta = parseMetaXml(fs.readFileSync(target.fsPath, 'utf8'));
    const content = renderManifest(meta, path.basename(root));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(manifestPath), Buffer.from(content, 'utf8'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(manifestPath)));

    const notes: string[] = [];
    if (meta.oop) notes.push('<oop> has no equivalent: the OOP API is always available in MTAX.');
    if (meta.files.some((f) => f.toLowerCase().endsWith('.map'))) notes.push('Map files moved to map_files.');
    vscode.window.showInformationMessage(
        `${MANIFEST_NAME} written.${notes.length ? ` ${notes.join(' ')}` : ''}`,
    );
}

function renderManifest(meta: ReturnType<typeof parseMetaXml>, folderName: string): string {
    const list = (key: string, values: string[]) => {
        if (!values.length) return '';
        const body = values.map((v) => `    "${v}",`).join('\n');
        return `${key} = {\n${body}\n}\n\n`;
    };

    const maps = meta.files.filter((f) => f.toLowerCase().endsWith('.map'));
    const assets = meta.files.filter((f) => !f.toLowerCase().endsWith('.map') && !f.toLowerCase().endsWith('.lua'));

    let out = `resource_name    = "${meta.info.name || folderName}"\n`;
    out += `resource_version = "${meta.info.version || '1.0.0'}"\n`;
    out += `resource_author  = "${meta.info.author || 'unknown'}"\n\n`;

    const extraInfo = Object.entries(meta.info).filter(([k]) => !['name', 'version', 'author'].includes(k));
    if (extraInfo.length) {
        out += 'resource_info = {\n';
        for (const [k, v] of extraInfo) out += `    ${/^[A-Za-z_]\w*$/.test(k) ? k : `["${k}"]`} = "${v.replace(/"/g, '\\"')}",\n`;
        out += '}\n\n';
    }

    out += list('server_files', meta.server);
    out += list('client_files', meta.client);
    out += list('shared_files', meta.shared);
    out += list('files', assets);
    out += list('map_files', maps);
    out += list('exports', meta.exports);

    return out.trimEnd() + '\n';
}

async function regenerateApi(context: vscode.ExtensionContext): Promise<void> {
    const configured = vscode.workspace.getConfiguration('mtax').get<string>('sourceRoot', '').trim();
    const root = configured || findSourceRoot();
    if (!root) {
        vscode.window.showErrorMessage(
            'Could not find a folder holding both MTAX-Purple/ and wiki/. Set "mtax.sourceRoot".',
        );
        return;
    }

    const script = path.join(context.extensionPath, 'tools', 'generate-api.mjs');
    if (!fs.existsSync(script)) {
        vscode.window.showErrorMessage(
            'The generator is not part of the packaged extension. Run it from a clone of the extension repository.',
        );
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'MTAX: regenerating the API…' },
        () => new Promise<void>((resolve) => {
            cp.execFile(
                process.execPath,
                [script, '--root', root],
                { cwd: context.extensionPath },
                (error, stdout, stderr) => {
                    if (error) {
                        vscode.window.showErrorMessage(`Generator failed: ${stderr || error.message}`);
                    } else {
                        const summary = stdout.split('\n').filter((l) => l.includes('coverage')).join(' ');
                        vscode.window.showInformationMessage(
                            `API regenerated. ${summary} Reload the window to pick it up.`,
                            'Reload',
                        ).then((choice) => {
                            if (choice === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
                        });
                    }
                    resolve();
                },
            );
        }),
    );
}

function findSourceRoot(): string | null {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        let dir = folder.uri.fsPath;
        for (let i = 0; i < 6; i++) {
            if (fs.existsSync(path.join(dir, 'MTAX-Purple')) && fs.existsSync(path.join(dir, 'wiki'))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return null;
}

async function pickSide(resources: ResourceIndex): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'lua') return;

    const current = resources.resolveSide(editor.document.uri.fsPath);
    const picked = await vscode.window.showQuickPick(
        [
            { label: 'client', description: 'runs on the player machine' },
            { label: 'server', description: 'runs on the server' },
            { label: 'shared', description: 'runs on both' },
            { label: 'Clear the override', description: `back to: ${current.reason}` },
        ],
        { title: `Side for ${path.basename(editor.document.uri.fsPath)}`, placeHolder: `currently ${current.side}` },
    );
    if (!picked) return;

    if (picked.label.startsWith('Clear')) resources.setOverride(editor.document.uri.fsPath, null);
    else resources.setOverride(editor.document.uri.fsPath, picked.label as Side);
}
