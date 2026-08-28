import test from 'node:test';
import assert from 'node:assert/strict';

import { scanLua, callContextAt, identifierAt, findCalls, declaredNames, editDistance } from '../out/util/lua.js';

test('masks line comments, long comments and strings', () => {
    const src = [
        'local a = "hello -- not a comment"',
        '-- a real comment with a "string" in it',
        'local b = [[long',
        'string]]',
        '--[==[ long comment ]==]',
        'local c = 1',
    ].join('\n');
    const scan = scanLua(src);

    assert.equal(scan.masked.length, src.length);
    assert.equal(scan.masked.split('\n').length, src.split('\n').length);
    assert.ok(scan.masked.includes('local a = '));
    assert.ok(!scan.masked.includes('hello'));
    assert.ok(!scan.masked.includes('real comment'));
    assert.ok(scan.masked.includes('local c = 1'));

    const values = scan.strings.map((s) => s.value);
    assert.deepEqual(values, ['hello -- not a comment', 'long\nstring']);
});

test('an escaped quote does not end a string', () => {
    const src = 'outputChatBox("say \\"hi\\" now")';
    const scan = scanLua(src);
    assert.equal(scan.strings.length, 1);
    assert.equal(scan.strings[0].value, 'say \\"hi\\" now');
});

test('an unterminated string stops at the line end', () => {
    const scan = scanLua('local a = "oops\nlocal b = 2');
    assert.equal(scan.strings.length, 1);
    assert.equal(scan.strings[0].unterminated, true);
    assert.ok(scan.masked.includes('local b = 2'));
});

test('identifierAt reports the accessor and receiver', () => {
    const src = 'local name = vehicle:getName()';
    const scan = scanLua(src);
    const hit = identifierAt(scan.masked, src.indexOf('getName') + 2);
    assert.equal(hit.name, 'getName');
    assert.equal(hit.accessor, ':');
    assert.equal(hit.receiver, 'vehicle');
});

test('callContextAt finds the call and the argument index', () => {
    const src = 'setElementPosition(veh, 10, 20, ';
    const scan = scanLua(src);
    const ctx = callContextAt(scan.masked, src.length);
    assert.equal(ctx.name, 'setElementPosition');
    assert.equal(ctx.argIndex, 3);
});

test('callContextAt ignores commas inside nested calls and strings', () => {
    const src = 'outputChatBox(getPlayerName(p, 1), player, ';
    const scan = scanLua(src);
    const ctx = callContextAt(scan.masked, src.length);
    assert.equal(ctx.name, 'outputChatBox');
    assert.equal(ctx.argIndex, 2);
});

test('callContextAt returns null inside a table constructor', () => {
    const src = 'local t = { a, b, ';
    const scan = scanLua(src);
    assert.equal(callContextAt(scan.masked, src.length), null);
});

test('findCalls skips names that only look like calls in comments', () => {
    const src = '-- createVehicle(411)\ncreatePed(0, 1, 2, 3)';
    const names = findCalls(scanLua(src).masked).map((c) => c.name);
    assert.deepEqual(names, ['createPed']);
});

test('declaredNames collects locals, functions and parameters', () => {
    const src = [
        'local a, b = 1, 2',
        'local function helper(x, y) end',
        'function globalFn(z) end',
        'for i, v in ipairs(t) do end',
        'myGlobal = 5',
    ].join('\n');
    const names = declaredNames(scanLua(src).masked);
    for (const n of ['a', 'b', 'helper', 'x', 'y', 'globalFn', 'z', 'i', 'v', 'myGlobal']) {
        assert.ok(names.has(n), `expected ${n} to be declared`);
    }
});

test('editDistance bails out past the limit', () => {
    assert.equal(editDistance('setElementPosition', 'setElementPosition', 2), 0);
    assert.equal(editDistance('setElemenPosition', 'setElementPosition', 2), 1);
    assert.ok(editDistance('createVehicle', 'destroyElement', 2) > 2);
});
