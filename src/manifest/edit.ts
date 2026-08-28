import * as vscode from 'vscode';

import { parseManifest, ManifestAssignment } from './parse';

const KEY_ORDER = [
    'resource_name', 'resource_version', 'resource_author', 'resource_info',
    'server_files', 'client_files', 'shared_files', 'files', 'map_files',
    'ui_page', 'loadscreen', 'loadscreen_manual_shutdown', 'exports',
];

export function addEntryToList(
    document: vscode.TextDocument,
    key: string,
    value: string,
): vscode.TextEdit | null {
    const text = document.getText();
    const parsed = parseManifest(text);
    const assignment = parsed.byKey.get(key);

    if (assignment && assignment.kind === 'list') {
        if (assignment.list?.some((e) => e.value === value)) return null;
        return insertIntoList(document, text, assignment, value);
    }

    const indent = '    ';
    const block = `${key} = {\n${indent}"${value}",\n}\n`;
    return new vscode.TextEdit(insertionRange(document, parsed.assignments, key), `${block}\n`);
}

function insertIntoList(
    document: vscode.TextDocument,
    text: string,
    assignment: ManifestAssignment,
    value: string,
): vscode.TextEdit {
    const last = assignment.list?.[assignment.list.length - 1];

    if (last) {
        const lineNumber = document.positionAt(last.start).line;
        const line = document.lineAt(lineNumber);
        const indent = line.text.match(/^\s*/)?.[0] ?? '    ';
        const hasComma = /,\s*$/.test(line.text);
        const prefix = hasComma ? '' : ',';
        return new vscode.TextEdit(
            new vscode.Range(line.range.end, line.range.end),
            `${prefix}\n${indent}"${value}",`,
        );
    }

    const open = text.indexOf('{', assignment.valueStart);
    const close = assignment.valueEnd - 1;
    const position = document.positionAt(open + 1);
    const closingLine = document.positionAt(close).line;
    const sameLine = document.positionAt(open).line === closingLine;
    return new vscode.TextEdit(
        new vscode.Range(position, position),
        sameLine ? `\n    "${value}",\n` : `\n    "${value}",`,
    );
}

function insertionRange(
    document: vscode.TextDocument,
    assignments: ManifestAssignment[],
    key: string,
): vscode.Range {
    const rank = KEY_ORDER.indexOf(key);
    let after: ManifestAssignment | null = null;
    for (const a of assignments) {
        const r = KEY_ORDER.indexOf(a.key);
        if (r === -1 || rank === -1) continue;
        if (r < rank) after = a;
    }

    if (after) {
        const line = document.positionAt(after.valueEnd).line;
        const position = new vscode.Position(Math.min(line + 1, document.lineCount - 1), 0);
        return new vscode.Range(position, position);
    }

    const end = document.lineCount ? new vscode.Position(document.lineCount, 0) : new vscode.Position(0, 0);
    return new vscode.Range(end, end);
}

export function moveEntry(
    document: vscode.TextDocument,
    fromKey: string,
    value: string,
    toKey: string,
): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    const parsed = parseManifest(document.getText());
    const from = parsed.byKey.get(fromKey);
    const entry = from?.list?.find((e) => e.value === value);
    if (entry) {
        const line = document.lineAt(document.positionAt(entry.start).line);
        const onlyThing = line.text.trim().replace(/,$/, '') === `"${value}"`;
        edits.push(new vscode.TextEdit(
            onlyThing ? line.rangeIncludingLineBreak : new vscode.Range(
                document.positionAt(entry.start),
                document.positionAt(entry.end),
            ),
            '',
        ));
    }
    const add = addEntryToList(document, toKey, value);
    if (add) edits.push(add);
    return edits;
}
