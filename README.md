<h1 align="center">MTAX — Lua Modding</h1>

<p align="center">
  <img src="images/icon.png" alt="MTAX" width="128">
</p>

<p align="center">
  <strong>Write Lua 5.4 mods for MTAX without leaving the editor.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC?logo=visualstudiocode&logoColor=white" alt="VS Code ^1.85.0">
  <img src="https://img.shields.io/badge/Lua-5.4-2C2D72?logo=lua&logoColor=white" alt="Lua 5.4">
  <img src="https://img.shields.io/badge/natives-1059-success" alt="1059 natives">
  <img src="https://img.shields.io/badge/events-172-success" alt="172 events">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>

---

Two layers sit behind everything here.

A **Lua 5.4 parser with scope resolution**, written for this extension, drives navigation,
the outline, rename and semantic highlighting — so clicking a name finds the *binding*, not
other text that happens to match.

An **API snapshot** knows the **1,059 native functions**, the **172 events**, the **OOP API**
(26 classes plus 14 static classes), the **sandbox** and the `mtaxmanifest.lua` format — all
extracted straight from the engine source and the wiki, never typed by hand.

## Table of contents

- [Features](#features)
  - [Language support](#language-support)
  - [The MTAX API](#the-mtax-api)
- [Commands](#commands)
- [lua-language-server](#lua-language-server-optional)
- [Configuration](#configuration)
- [Where the data comes from](#where-the-data-comes-from)
- [Developing the extension](#developing-the-extension)
- [License](#license)

---

## Features

### Language support

Everything a Lua editor is expected to do, answered from the syntax tree:

| | |
| --- | --- |
| **Go to definition** `F12` | A local jumps to its own declaration — the one actually in scope, so `local x = x` resolves the two `x` apart. A global or a table field jumps to wherever the resource assigns it, in any of its files. A native jumps to its signature in the generated definitions. |
| **Find all references** `Shift+F12` | Every use across the resource. Works on locals, globals, table fields, natives and event names. |
| **Rename** `F2` | Locals within their scope, globals and fields across the resource. Renaming the MTAX API is refused. |
| **Outline / breadcrumbs** `Ctrl+Shift+O` | Functions, methods, tables and their fields — including what sits inside a top-level `if ... then`, which is where half of a typical resource lives. |
| **Workspace symbols** `Ctrl+T` | Search across every resource in the folder. |
| **Highlight occurrences** | Every read and write of the name under the cursor, writes marked apart. |
| **Syntax errors** | Reported as you type, with recovery: an unfinished `if` at the bottom of the file does not cost you the outline of everything above it. |

**Scope stops at the resource.** Each MTAX resource runs in its own Lua VM, so a global
defined in resource A genuinely does not exist in resource B — and navigation refuses to
jump across that line, unlike a general-purpose Lua server that would treat the whole folder
as one scope.

### Colour

Names are coloured for what they are — native, event, OOP class, local, parameter, property,
method, label — rather than all alike. A native called from the wrong side is marked
`deprecated`, so the theme strikes it through before you even read the warning.

Two layers share the work, and they do not overlap. A **TextMate injection grammar** generated
from the API owns the MTAX identity — natives, engine globals, OOP classes and event names get
their own `support.*.mtax.lua` scopes, which every theme already styles and which keep working
with semantic highlighting switched off. **Semantic tokens** own what only scope analysis knows:
local, parameter, property, method, label, and which occurrence is the declaration.

The split matters, because a semantic token silently replaces the scope underneath it: claiming
`self` would trade the Lua grammar's `variable.language` blue for a plain variable colour, and
claiming a native would trade its MTAX scope for a generic function. So neither is claimed. The
one deliberate override is a native called from the wrong side, emitted as `deprecated` so the
theme strikes it through.

### The MTAX API

#### Completion that knows which side the file runs on

As you type in a script, natives show up with their signature, description and example.
The ones that **do not exist** on that side are still offered — flagged with
`⚠ server only` and sorted last — instead of being hidden, because knowing the function
exists on the other side is usually the missing piece of information.

The side comes from the manifest: a file listed in `server_files` is server code, full stop.
With no manifest, the extension infers it from the folder (`server/`, `client/`) and from the
file name (`main_s.lua`, `_c.lua`), and the status bar reads `MTAX server?` — the question mark
telling you it was a guess. Clicking the status bar pins the side by hand.

#### Event names where event names belong

Inside the `eventName` argument of `addEventHandler`, `triggerClientEvent`, `triggerServerEvent`
and friends, completion swaps the natives for **events** — along with the parameters the handler
will receive, the `source` element and whether the event can be cancelled. Events the resource
registers itself with `addEvent("...")` join the list.

#### Hover and signature help

Hovering shows the signature, parameters with type and default, the return value, the OOP
equivalent and a link to the wiki. While you type the arguments, the current parameter is
highlighted — and when a native has both a server and a client variant (`createVehicle`), the
variant for the current side is the one already selected.

All of it in **English or Portuguese**, following the VS Code display language or the
`mtax.docsLanguage` setting.

#### Problems the server would reject

| Problem | Example |
| --- | --- |
| Native from the wrong side | `bindKey` (client) called from a server script |
| Function that does not exist in MTAX | `outputChatBox`, `guiGetText`, `getPlayerMoney` — MTA natives MTAX does not have |
| Typo | `setElemenPosition` → *did you mean `setElementPosition`?* |
| Event from the wrong side | `onClientRender` registered in a server script |
| Sandbox | `require`, `dofile`, `io.open`, `package`, `debug`, `os.execute` |
| Syntax error | anything the parser cannot read, at the exact token |
| Script missing from the manifest | a `.lua` in the folder that no list declares — it will never run |

Every rule carries its own severity and can be turned off. The ones worth fixing
automatically offer a quick fix (`Ctrl+.`).

> Run over 140,000 lines of real server resources, this rule set flagged 38 wrong-side calls,
> 90 non-existent functions, 2 typos and 3 sandbox uses — **without a single false positive**.
> One-sided calls inside a `shared` script are off by default, because a shared script tends to
> branch on `localPlayer` and call both sides on purpose.

#### A real `mtaxmanifest.lua`

The manifest is validated with the **same rules the server uses**
(`Server/src/modules/resources/manifest.cpp`):

- relative path, with `/`, no `..`, no `\`, no `:`;
- `.lua` only in `server_files` / `client_files` / `shared_files`, assets only in `files`;
- declared file that does not exist in the folder;
- `ui_page` that is not a page, or that is not listed in `files`;
- `map_files` trying to borrow from another resource;
- `exports` that is not a function name;
- `loadscreen_manual_shutdown` without `loadscreen`;
- `escrow_files` (read by the portal) pointing at a file the build does not protect;
- globals the manifest sandbox does not have (`print`, `os`, `require`…).

On top of that: completion for the keys, **path** completion inside the lists (only `.lua` in a
script list, only assets in `files`), and `Ctrl+click` on a path opens the file — including
cross-resource borrows such as `":other-resource/file.lua"`.

## Commands

| Command | Shortcut | What it does |
| --- | --- | --- |
| `MTAX: New Resource…` | — | Creates the folder with a manifest and scripts. Five layouts: server + client, server only, client only, with NUI, loading screen |
| `MTAX: New Script…` | — | Creates the script **and** declares it in the right manifest list |
| `MTAX: Search the API…` | `Ctrl+Alt+M` | Searches the 1,059 natives; inserts the call or opens the documentation |
| `MTAX: Open documentation…` | `Ctrl+Alt+D` | Opens the wiki page for the symbol under the cursor |
| `MTAX: Convert meta.xml…` | — | Converts a legacy MTA resource to `mtaxmanifest.lua` |
| `MTAX: Set up lua-language-server` | — | Points sumneko at the MTAX definitions |
| `MTAX: Set the side of the current file` | — | Pins client / server / shared when inference gets it wrong |
| `MTAX: Regenerate the API…` | — | Regenerates everything from the local `MTAX-Purple/` and `wiki/` |

On macOS the shortcuts are `Cmd+Alt+M` and `Cmd+Alt+D`.

## lua-language-server (optional)

The extension ships generated **LuaCATS** files (`definitions/`) with the 1,059 natives
annotated, the OOP classes with their inheritance, and `Vector2/3/4` and `Matrix`. If
[sumneko.lua](https://marketplace.visualstudio.com/items?itemName=sumneko.lua) is installed, the
extension offers to point it at those definitions — giving you real type inference layered on top
of everything described above. It also disables `io`, `package` and `debug` in sumneko's
completion, since the MTAX sandbox does not have those libraries.

None of this is required: without sumneko, the extension works on its own.

## Configuration

| Key | Default | What it controls |
| --- | --- | --- |
| `mtax.enable` | `true` | Turns the whole language layer on or off |
| `mtax.docsLanguage` | `auto` | `auto`, `en` or `pt` in hovers and completion |
| `mtax.semanticHighlighting` | `true` | Colour names for what they are, not all alike |
| `mtax.diagnostics.enable` | `true` | Turns problem reporting on |
| `mtax.diagnostics.syntax` | `error` | Lua syntax errors from the built-in parser |
| `mtax.diagnostics.wrongSide` | `warning` | Native from one side called from the other |
| `mtax.diagnostics.sharedSideCalls` | `off` | The same, but inside a `shared` script |
| `mtax.diagnostics.unknownNative` | `warning` | Function shaped like a native that does not exist in MTAX |
| `mtax.diagnostics.typos` | `warning` | Name one or two characters away from a real native |
| `mtax.diagnostics.sandbox` | `error` | `require`, `io`, `package`, `os.execute`… |
| `mtax.diagnostics.manifest` | `true` | Validation of `mtaxmanifest.lua` |
| `mtax.diagnostics.deprecatedMeta` | `true` | Points out `meta.xml` files and offers to convert them |
| `mtax.completion.oop` | `true` | Suggest the OOP API alongside the plain natives |
| `mtax.completion.snippets` | `true` | Expand a native into a call with its arguments as tab stops |
| `mtax.luals.autoConfigure` | `ask` | `ask`, `always` or `never` for configuring sumneko |
| `mtax.statusBar` | `true` | Show the file side in the status bar |
| `mtax.author` | `""` | Name written to `resource_author` when scaffolding a resource |
| `mtax.sourceRoot` | `""` | Folder holding `MTAX-Purple/` and `wiki/`, used to regenerate the API |

## Where the data comes from

`data/api.json`, `definitions/*.lua` and `syntaxes/*.json` are **generated**, never edited by hand:

| Source | What comes out of it |
| --- | --- |
| `Shared/src/lua_api/catalog/functions.h` | the 1,059 natives, with side and confidence level |
| `Shared/src/lua_api/oop/oopclasses.h` | OOP classes, methods, properties, inheritance |
| `Shared/src/lua_api/sandbox/policy.h` | open libraries, removed globals, restricted `os` fields |
| `Shared/src/lua_api/prelude/prelude.h` | pure-Lua helpers (`bit*`, `utf*`, `split`, `inspect`, `ref`…) |
| `Server/src/modules/resources/manifest.cpp` | the manifest keys and the validation rules |
| `wiki/src/content/docs/{en,pt}` | descriptions, signatures, parameters, returns, examples and events |

Out of those come the API snapshot the extension reads at runtime, the LuaCATS definition
files, and the TextMate injection grammars that colour the API.

To regenerate after changing the engine or the wiki:

```bash
npm run generate          # searches upwards for MTAX-Purple/ and wiki/
npm run generate -- --root "D:/Projetos MTAX"
```

Or, from inside VS Code, run `MTAX: Regenerate the API from local MTAX sources`.

Current coverage: **1,059 / 1,059** signatures and **1,058 / 1,059** descriptions.

## Developing the extension

```bash
npm install
npm run generate     # data/api.json + definitions/
npm run compile      # bundle into dist/
npm run watch        # rebuild on save
npm test             # 67 tests: parser, scopes, manifest, API, grammar and end-to-end activation
npm run package      # produces the .vsix
```

`F5` in VS Code opens a window with the extension loaded.

The tests run against the real bundle with a stub of the VS Code API, so a hang on activation or a
broken provider shows up before packaging. The colouring is checked against the actual TextMate
engine layered over VS Code's own Lua grammar, because an injection selector is easy to get
subtly wrong and impossible to eyeball.

### Project layout

```
tools/generate-api.mjs     reads engine + wiki, writes data/, definitions/ and syntaxes/
src/lua/lexer.ts           Lua 5.4 tokens, long brackets, escapes, BOM and shebang
src/lua/parser.ts          error-tolerant recursive descent -> syntax tree
src/lua/analyze.ts         scopes, bindings, references, dotted paths, the outline
src/lua/index.ts           per-file and per-resource caches
src/api/model.ts           loads and indexes the API snapshot
src/manifest/              parsing, path rules, globs, side resolution
src/features/              completion, hover, signature help, diagnostics, quick fixes,
                           navigation, semantic tokens, links, status bar, commands,
                           scaffolding, luals
```

The parser never throws. A file is re-read on every keystroke, so half-typed code is the normal
case: what it cannot understand is recorded, the token is skipped, and the walk continues — an
unfinished `if` at the bottom of a file does not cost you the outline of everything above it.

It is checked against the real thing: 618 Lua files from the server's own `resources/` folder,
6.6 MB, parse with **zero** errors — the only three failures are MTXA-protected script
containers, which are not Lua at all.

## License

Property of CMR Services — see [LICENSE](LICENSE). Copyright (c) 2026 CMR Services.
