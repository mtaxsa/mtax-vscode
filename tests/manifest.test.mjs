import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseManifest, isSafeRelativePath, isLuaPath, globMatches,
    splitCrossResourceEntry, hasGlob,
} from '../out/manifest/parse.js';

const MANIFEST = `resource_name    = "my-resource"
resource_version = "1.2.0"
resource_author  = "My Team"

resource_info = {
    description = "Full resource example",
}

server_files = {
    "server/config.lua",
    "server/main.lua",
}

client_files = {
    "client/**/*.lua",
}

files = {
    "ui/index.html",
    ":brand/assets/**/*.png",
}

ui_page = "ui/index.html"

loadscreen = false

exports = {
    "getSomething",
}
`;

test('reads strings, lists, tables and flags', () => {
    const parsed = parseManifest(MANIFEST);

    assert.equal(parsed.byKey.get('resource_name').string.value, 'my-resource');
    assert.equal(parsed.byKey.get('resource_name').kind, 'string');

    const server = parsed.byKey.get('server_files');
    assert.equal(server.kind, 'list');
    assert.deepEqual(server.list.map((e) => e.value), ['server/config.lua', 'server/main.lua']);

    const info = parsed.byKey.get('resource_info');
    assert.equal(info.kind, 'table');
    assert.deepEqual(info.table.map((p) => p.key), ['description']);

    const loadscreen = parsed.byKey.get('loadscreen');
    assert.equal(loadscreen.kind, 'boolean');
    assert.equal(loadscreen.boolean, false);

    assert.deepEqual(parsed.byKey.get('exports').list.map((e) => e.value), ['getSomething']);
});

test('entry offsets point at the literal in the source', () => {
    const parsed = parseManifest(MANIFEST);
    const entry = parsed.byKey.get('server_files').list[1];
    assert.equal(MANIFEST.slice(entry.contentStart, entry.contentEnd), 'server/main.lua');
    assert.equal(MANIFEST.slice(entry.start, entry.end), '"server/main.lua"');
});

test('a commented-out entry is not read', () => {
    const parsed = parseManifest(`server_files = {\n    -- "server/old.lua",\n    "server/main.lua",\n}\n`);
    assert.deepEqual(parsed.byKey.get('server_files').list.map((e) => e.value), ['server/main.lua']);
});

test('path rules match the server', () => {
    assert.ok(isSafeRelativePath('server/main.lua'));
    assert.ok(!isSafeRelativePath('/server/main.lua'));
    assert.ok(!isSafeRelativePath('server\\main.lua'));
    assert.ok(!isSafeRelativePath('../other/main.lua'));
    assert.ok(!isSafeRelativePath('./main.lua'));
    assert.ok(!isSafeRelativePath('C:/main.lua'));
    assert.ok(isLuaPath('a/b/C.LUA'));
    assert.ok(!isLuaPath('a/b/c.html'));
});

test('globs stay inside a segment unless doubled', () => {
    assert.ok(globMatches('client/*.lua', 'client/main.lua'));
    assert.ok(!globMatches('client/*.lua', 'client/ui/main.lua'));
    assert.ok(globMatches('client/**/*.lua', 'client/ui/main.lua'));
    assert.ok(globMatches('client/**/*.lua', 'client/main.lua'));
    assert.ok(globMatches('assets/**/*.png', 'assets/a/b/c.png'));
    assert.ok(globMatches('CLIENT/*.LUA', 'client/main.lua'), 'matching is case-insensitive');
    assert.ok(!globMatches('client/*.lua', 'server/main.lua'));
    assert.ok(hasGlob('client/**/*.lua'));
    assert.ok(!hasGlob('client/main.lua'));
});

test('cross-resource entries split into resource and path', () => {
    assert.deepEqual(splitCrossResourceEntry(':core/lib/class.lua'), { resource: 'core', path: 'lib/class.lua' });
    assert.equal(splitCrossResourceEntry(':core'), null);
    assert.equal(splitCrossResourceEntry(':/lib.lua'), null);
    assert.equal(splitCrossResourceEntry('core/lib.lua'), null);
});
