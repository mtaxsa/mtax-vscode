import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findLuaGrammar() {
    if (process.env.MTAX_LUA_GRAMMAR && fs.existsSync(process.env.MTAX_LUA_GRAMMAR)) {
        return process.env.MTAX_LUA_GRAMMAR;
    }
    const relative = path.join('resources', 'app', 'extensions', 'lua', 'syntaxes', 'lua.tmLanguage.json');
    const bases = [
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code'),
        'C:\\Program Files\\Microsoft VS Code',
        '/usr/share/code',
        '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/lua/syntaxes',
    ];
    for (const base of bases) {
        const direct = path.join(base, relative);
        if (fs.existsSync(direct)) return direct;
        const flat = path.join(base, 'lua.tmLanguage.json');
        if (fs.existsSync(flat)) return flat;
        try {
            for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const nested = path.join(base, entry.name, relative);
                if (fs.existsSync(nested)) return nested;
            }
        } catch { /* base does not exist here */ }
    }
    return null;
}

const grammarPath = findLuaGrammar();
let engine = null;
try {
    engine = { vsctm: require('vscode-textmate'), oniguruma: require('vscode-oniguruma') };
} catch {
    engine = null;
}

const SAMPLE = [
    'local veh = createVehicle(411, 0, 0, 5)',
    'addEventHandler("onPlayerJoin", root, function()',
    '    outputDebugString(getPlayerName(source))',
    'end)',
    'local pos = Vector3(1, 2, 3)',
    'Timer.create(function() end, 1000, 1)',
    '-- createVehicle in a comment must stay a comment',
    'local text = "createVehicle inside a string"',
    'local mine = myOwnFunction(1)',
    'local shadow = my_createVehicle()',
    'obj.createVehicle = 1',
].join('\n');

async function tokenize() {
    const { vsctm, oniguruma } = engine;
    const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

    const grammars = {
        'source.lua': JSON.parse(fs.readFileSync(grammarPath, 'utf8')),
        'mtax.lua.injection': JSON.parse(fs.readFileSync(path.join(ROOT, 'syntaxes/mtax-injection.json'), 'utf8')),
        'mtax.lua.events': JSON.parse(fs.readFileSync(path.join(ROOT, 'syntaxes/mtax-events.json'), 'utf8')),
    };

    const registry = new vsctm.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
            createOnigString: (s) => new oniguruma.OnigString(s),
        }),
        loadGrammar: async (scopeName) => grammars[scopeName] ?? null,
        getInjections: (scopeName) =>
            (scopeName === 'source.lua' ? ['mtax.lua.injection', 'mtax.lua.events'] : undefined),
    });

    const grammar = await registry.loadGrammar('source.lua');
    const claimed = [];
    let ruleState = vsctm.INITIAL;
    let line = -1;
    for (const text of SAMPLE.split('\n')) {
        line++;
        const result = grammar.tokenizeLine(text, ruleState);
        ruleState = result.ruleStack;
        for (const token of result.tokens) {
            const slice = text.slice(token.startIndex, token.endIndex);
            if (!slice.trim()) continue;
            const scopes = token.scopes.filter((s) => s.includes('mtax'));
            if (scopes.length) claimed.push({ text: slice, scope: scopes[scopes.length - 1], line });
        }
    }
    return claimed;
}

const skip = !grammarPath || !engine
    ? `needs VS Code's Lua grammar${engine ? '' : ' and vscode-textmate'}`
    : false;

test('the injection grammar colours the API and nothing else', { skip }, async () => {
    const claimed = await tokenize();
    const byText = new Map(claimed.map((c) => [c.text, c]));

    for (const [name, scope] of [
        ['createVehicle', 'support.function.mtax.lua'],
        ['getPlayerName', 'support.function.mtax.lua'],
        ['addEventHandler', 'support.function.mtax.lua'],
        ['root', 'support.constant.mtax.lua'],
        ['source', 'support.constant.mtax.lua'],
        ['Vector3', 'support.class.mtax.lua'],
        ['Timer', 'support.class.mtax.lua'],
        ['onPlayerJoin', 'support.constant.event.mtax.lua'],
    ]) {
        assert.equal(byText.get(name)?.scope, scope, `${name} should be ${scope}`);
    }

    assert.ok(!byText.has('myOwnFunction'), 'a user function must be left alone');
    assert.ok(!byText.has('my_createVehicle'), 'a name that merely contains a native must be left alone');

    const lines = SAMPLE.split('\n');
    for (const [needle, why] of [
        ['-- createVehicle', 'a native inside a comment stays a comment'],
        ['"createVehicle inside', 'a native named inside a string stays a string'],
        ['obj.createVehicle', 'a member access is not the native'],
    ]) {
        const line = lines.findIndex((l) => l.includes(needle));
        assert.ok(!claimed.some((c) => c.line === line), why);
    }
});
