import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../out/lua/parser.js';
import { analyze, occurrenceAt, stringAt } from '../out/lua/analyze.js';

const clean = (src) => {
    const result = parse(src);
    assert.deepEqual(result.errors, [], `unexpected errors in:\n${src}`);
    return result;
};

test('parses the whole of Lua 5.4', () => {
    clean(`
local a <const> = 1
local b <close> = setmetatable({}, {})
local i = 7 // 2
local m = 3 % 2
local bits = (1 << 4) | (255 >> 2) & 0xFF ~ 0b0 or 0
local hex, float, exp = 0xA5, 3.14, 1.5e-3
local s = [==[long
string]==]
local t = { 1, 2, [3] = "three", name = "value", nested = { deep = true }; trailing = 1, }

function t.method(self, ...) return ... end
function t:colon(a, b) return self, a, b end
local function rec(n) if n <= 1 then return 1 end return n * rec(n - 1) end

for i = 1, 10, 2 do goto continue; ::continue:: end
for k, v in pairs(t) do print(k, v) end
while true do break end
repeat local x = 1 until x == 1
do local scoped = 1 end

if a then elseif b then else end

local chained = t.a.b.c[1]("call")"string call"{ table = "call" }
local concat = "a" .. "b" .. tostring(a)
local unary = -a ^ 2
local cmp = a ~= b and a >= b or not a
`.replace('0b0', '0'));
});

test('operator precedence and associativity', () => {
    const { chunk } = clean('local x = 1 + 2 * 3 ^ 2 ^ 3 .. "s"');
    const init = chunk.body[0].init[0];
    assert.equal(init.type, 'BinaryExpression');
    assert.equal(init.operator, '..');
    const sum = init.left;
    assert.equal(sum.operator, '+');
    assert.equal(sum.right.operator, '*');
    const power = sum.right.right;
    assert.equal(power.operator, '^');
    assert.equal(power.right.operator, '^');
});

test('recovers from a syntax error and keeps the rest of the file', () => {
    const source = [
        'local good = 1',
        'if then',              // broken
        'local alsoGood = 2',
        'function stillParsed() end',
    ].join('\n');
    const result = parse(source);
    assert.ok(result.errors.length > 0, 'the broken line should be reported');
    const names = [];
    const collect = (statements) => {
        for (const s of statements ?? []) {
            if (s.type === 'LocalStatement') names.push(...s.variables.map((v) => v.name));
            if (s.type === 'FunctionDeclaration' && s.identifier?.name) names.push(s.identifier.name);
            if (s.clauses) for (const c of s.clauses) collect(c.body);
            if (s.body) collect(s.body);
        }
    };
    collect(result.chunk.body);
    assert.ok(names.includes('good'));
    assert.ok(names.includes('alsoGood'), 'parsing must continue past the error');
    assert.ok(names.includes('stillParsed'));
});

test('an unterminated function does not hang or lose the file', () => {
    const result = parse('function broken(\nlocal a = 1\n');
    assert.ok(result.errors.length > 0);
    assert.ok(result.chunk.body.length > 0);
});

test('a byte-order mark and a shebang are not errors', () => {
    clean('﻿local a = 1');
    clean('#!/usr/bin/env lua\nlocal a = 1');
});

test('scopes: a local shadows an outer one, and the initialiser sees the outer', () => {
    const source = [
        'local x = 1',
        'do',
        '    local x = x + 1',
        '    print(x)',
        'end',
        'print(x)',
    ].join('\n');
    const analysis = analyze(source);

    const outer = analysis.locals.find((b) => b.declaration.start === source.indexOf('local x = 1') + 6);
    const inner = analysis.locals.find((b) => b.declaration.start === source.indexOf('local x = x + 1') + 6);
    assert.ok(outer && inner && outer !== inner);

    assert.equal(outer.references.length, 3, 'declaration + initialiser read + last print');
    assert.equal(inner.references.length, 2, 'declaration + the print inside the block');
});

test('parameters, self and varargs are bound', () => {
    const source = 'local t = {}\nfunction t:go(a, ...)\n    return self, a, select("#", ...)\nend';
    const analysis = analyze(source);
    const a = analysis.locals.find((b) => b.name === 'a');
    assert.equal(a.kind, 'param');
    assert.equal(a.references.length, 2);

    const self = analysis.occurrences.find((o) => o.name === 'self' && !o.declaration);
    assert.equal(self.kind, 'self');
});

test('globals are collected with their declaration', () => {
    const source = 'myGlobal = 1\nlocal read = myGlobal + 1\nmyGlobal = 2';
    const analysis = analyze(source);
    const binding = analysis.globals.get('myGlobal');
    assert.ok(binding);
    assert.equal(binding.declaration.start, 0);
    assert.equal(binding.references.length, 3);
    assert.equal(binding.references.filter((r) => r.write).length, 2);
});

test('a function assigned to a global is marked as one', () => {
    const analysis = analyze('handler = function(a) return a end');
    const binding = analysis.globals.get('handler');
    assert.equal(binding.isFunction, true);
    assert.equal(binding.signature, 'function(a)');
});

test('dotted paths are tracked so table fields navigate', () => {
    const source = [
        'Config = {}',
        'Config.spawn = { x = 1 }',
        'function Config.reset() end',
        'print(Config.spawn, Config.reset)',
    ].join('\n');
    const analysis = analyze(source);

    const spawn = analysis.fields.get('Config.spawn');
    assert.ok(spawn, 'Config.spawn should be a tracked field');
    assert.equal(spawn.references.length, 2);
    assert.ok(spawn.declaration);
    assert.equal(spawn.isTable, true);

    const reset = analysis.fields.get('Config.reset');
    assert.equal(reset.isFunction, true);
});

test('self knows the table it belongs to', () => {
    const source = [
        'local Class = {}',
        'function Class:init()',
        '    self.value = 1',
        '    self:update()',
        'end',
        'function Class:update()',
        '    print(self.value)',
        'end',
    ].join('\n');
    const analysis = analyze(source);

    const value = analysis.fields.get('Class.value');
    assert.ok(value, 'self.value should resolve to Class.value');
    assert.equal(value.references.length, 2);
    assert.ok(!analysis.fields.has('self.value'), 'the raw self path must not survive');

    const update = analysis.fields.get('Class.update');
    assert.equal(update.references.length, 2);
    assert.ok(update.declaration, 'the declaration is the `function Class:update` name');

    const self = analysis.occurrences.find((o) => o.kind === 'self');
    assert.ok(self.binding.declaration, 'self should have somewhere to go');
    assert.equal(
        source.slice(self.binding.declaration.start, self.binding.declaration.end),
        'init',
    );
});

test('self with no known owner stays file-local', () => {
    const analysis = analyze('local t = {}\nt.go = function(self) return self.value end');
    assert.ok(analysis.fields.has('self.value'), 'the path stays unqualified');
});

test('two classes do not share their self fields', () => {
    const analysis = analyze([
        'local A, B = {}, {}',
        'function A:go() self.count = 1 end',
        'function B:go() self.count = 2 end',
    ].join('\n'));
    assert.equal(analysis.fields.get('A.count').references.length, 1);
    assert.equal(analysis.fields.get('B.count').references.length, 1);
});

test('occurrenceAt finds what the cursor is on', () => {
    const source = 'local vehicle = createVehicle(411, 0, 0, 5)';
    const analysis = analyze(source);

    const onNative = occurrenceAt(analysis, source.indexOf('createVehicle') + 3);
    assert.equal(onNative.name, 'createVehicle');
    assert.equal(onNative.kind, 'global');
    assert.equal(onNative.called, true);

    const onLocal = occurrenceAt(analysis, source.indexOf('vehicle') + 2);
    assert.equal(onLocal.name, 'vehicle');
    assert.equal(onLocal.kind, 'local');
    assert.equal(onLocal.declaration, true);
});

test('string arguments are recorded with their call and index', () => {
    const source = 'addEventHandler("onPlayerJoin", root, handler)';
    const analysis = analyze(source);
    const literal = stringAt(analysis, source.indexOf('onPlayerJoin') + 2);
    assert.equal(literal.value, 'onPlayerJoin');
    assert.equal(literal.call, 'addEventHandler');
    assert.equal(literal.argIndex, 0);
});

test('a name inside a comment or a string is not an occurrence', () => {
    const analysis = analyze('-- createVehicle(411)\nlocal s = "createVehicle"');
    assert.ok(!analysis.occurrences.some((o) => o.name === 'createVehicle'));
});

test('the outline lists functions, tables and their members', () => {
    const source = [
        'local M = {',
        '    name = "mod",',
        '    go = function() end,',
        '}',
        'function M.helper(a) end',
        'function M:method() end',
        'local function top() local function nested() end end',
    ].join('\n');
    const analysis = analyze(source);
    const names = analysis.symbols.map((s) => s.name);

    assert.ok(names.includes('M'));
    assert.ok(names.includes('M.helper'));
    assert.ok(names.includes('M:method'));
    assert.ok(names.includes('top'));

    const table = analysis.symbols.find((s) => s.name === 'M');
    assert.equal(table.kind, 'namespace');
    assert.deepEqual(table.children.map((c) => c.name), ['name', 'go']);

    const top = analysis.symbols.find((s) => s.name === 'top');
    assert.deepEqual(top.children.map((c) => c.name), ['nested']);
});

test('method declarations keep the colon in the outline', () => {
    const analysis = analyze('local M = {}\nfunction M:run(a, b) end');
    const method = analysis.symbols.find((s) => s.name === 'M:run');
    assert.equal(method.kind, 'method');
    assert.equal(method.detail, '(a, b)');
});
