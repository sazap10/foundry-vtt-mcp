# Module Integration Architecture (Plan)

Status: **proposal / not yet implemented**
Scope: how to add MCP support for optional Foundry **modules** (Simple Calendar,
Campaign Codex, ComfyUI, …) without editing core dispatch every time.

---

## 1. Why this exists

Foundry has two extension axes, and this repo treats them very differently:

- **Systems** (game rulesets: dnd5e, pf2e, dsa5, cosmere-rpg) already have a clean
  plugin architecture — `SystemAdapter` + `SystemRegistry`
  (`packages/mcp-server/src/systems/`). A new system self-registers; no core files
  are touched.
- **Modules** (optional add-ons) are wired by hand. The Simple Calendar integration
  (currently uncommitted) had to touch **three** places:
  1. `tools/simple-calendar.ts` — the tool class
  2. `backend.ts` — import, instantiate, spread into `allTools`, **and** add a
     `case` to the ~1700-line dispatch `switch`
  3. `foundry-module/src/queries.ts` — register + implement the bridge query

That ad-hoc path also leaked campaign-specific logic (Stormlight "Vorin" calendar
math) into a generically-named bridge handler. It does not scale to a module like
Campaign Codex, which wants many tools plus a relationship graph.

**Goal:** a module-provider/registry pattern that mirrors the systems layer, so
adding a module is one self-contained unit + one `register()` line.

---

## 2. Design

### 2.1 `ToolProvider` interface (server side)

Every tool group implements one interface. Tool *definition* and *dispatch* live
together, killing the central `switch`.

```typescript
interface ToolProvider {
  /** MCP tool definitions this provider contributes. */
  getToolDefinitions(): ToolDefinition[];
  /** Does this provider own the named tool? */
  canHandle(toolName: string): boolean;
  /** Execute one of this provider's tools. */
  handleToolCall(name: string, args: unknown): Promise<unknown>;
  /** Optional: the Foundry module id this provider depends on (undefined = always on). */
  readonly requiresModuleId?: string;
}
```

### 2.2 `ToolRegistry` (server side)

A near-copy of `SystemRegistry` (`systems/system-registry.ts`). Responsibilities:

- aggregate `getToolDefinitions()` from all providers → replaces the manual
  `allTools` array
- route an incoming call to the first provider whose `canHandle(name)` is true →
  **deletes the dispatch `switch` entirely**
- (optional) filter advertised tools by **active module availability** (see §2.4)

`backend.ts` then collapses to:

```typescript
toolRegistry.register(new CampaignCodexTools({ foundryClient, logger }));
// …register every provider once…

const allTools = toolRegistry.getAllToolDefinitions();      // was: big spread
// dispatch:
result = await toolRegistry.handleToolCall(name, args);     // was: giant switch
```

### 2.3 Co-locate the Foundry (bridge) half

Today bridge handlers are appended into the shared
`foundry-module/src/queries.ts`. Instead, each integration owns both halves:

```
packages/mcp-server/src/modules/<module-id>/
  provider.ts      # ToolProvider: definitions + dispatch
  types.ts         # module-specific types
  index.ts
packages/foundry-module/src/modules/<module-id>/
  queries.ts       # bridge handlers + registerQueries(CONFIG)
```

`queries.ts` exposes a small `registerQueries(CONFIG)` hook per integration so the
shared file stops being a dumping ground and a module is one logical unit across
both packages.

### 2.4 Availability gating (modules are optional — systems aren't)

Unlike systems, a module may simply not be installed. Decision: the bridge reports
the set of **active module ids**, and the registry **only advertises** tools whose
`requiresModuleId` is active. Cleaner than today's "call it, get an error back."

Standard "module not active" response shape for any provider that is called anyway:

```json
{ "success": false, "error": "<module> is not active in this world" }
```

### 2.5 Resources vs. tools

Some modules are better modelled as MCP **resources** (browsable context Claude can
pull) than as imperative tools. A campaign knowledge graph (Campaign Codex) is the
textbook case. The provider contract should allow a module to contribute resources
in addition to / instead of tools. Tools = actions; resources = readable context.

### 2.6 Per-module read/write strategy (the dimension Simple Calendar hid)

Module public APIs are often thin. Each provider must declare how it reads and how
it writes, and **prefer official paths over hand-written flags**:

- **Reads:** usually via Foundry documents + module flags (no API needed).
- **Writes:** via the module's **official** API/import path when one exists. Never
  hand-write a module's internal flag structure — it rots when the module changes
  its schema (this is exactly what made the Vorin ad-hoc change brittle).

When in doubt, ship **read-only v1** and add writes once the official path is
confirmed.

---

## 3. Worked example — Campaign Codex

Module id `campaign-codex` (repo `xthesaintx/cc13`, schema confirmed against
**v3.8.1**). Extends Foundry journals with linked sheet types and a relationship
graph — a strong fit for this architecture and a good stress test (many tools,
optional, graph-shaped, resource-friendly).

### 3.1 Confirmed flag schema

All data lives on `JournalEntry` documents under the `"campaign-codex"` flag scope.
Constants (from `campaign-codex-exporter.js` / `-importer.js`):

```
FLAG_SCOPE = "campaign-codex"
FLAG_TYPE  = "type"   // string sheet type
FLAG_DATA  = "data"   // content + relationship graph
```

```js
const type = journal.getFlag("campaign-codex", "type");
const data = journal.getFlag("campaign-codex", "data") || {};
const isCodex = !!type;   // the module's own filter for codex journals
```

Sheet `type` ∈ `npc | location | shop | region | group | tag | quest`.
Other flag keys are UI-only (`image`, `tab-overrides`, `icon-override`,
`sheet-widgets`, `markerid`, `widgets-position`) — ignored by MCP.

**Per-type `data` shape** (from the module's creation defaults):

| `type`     | `data` fields |
|------------|---------------|
| `npc`      | `linkedActor` (Actor uuid), `description`, `linkedLocations[]`, `linkedShops[]` |
| `location` | `description`, `linkedNPCs[]`, `linkedShops[]`, `linkedScene` (Scene uuid), `parentRegion` |
| `shop`     | `description`, `linkedNPCs[]`, `linkedLocation`, `inventory[]`, `inventoryCash`, `linkedScene`, `markup` (number) |
| `region`   | `description`, `linkedLocations[]`, `linkedScene`, `parentRegions[]` |
| `group`    | `description`, `members[]`, `linkedNPCs[]` |
| `quest`    | `description`, `quests[]` |

Cross-cutting link fields also seen: `linkedRegions[]`, `linkedGroups[]`,
`linkedQuests[]`, `linkedStandardJournal(s)`, `directNPCs[]`,
`linkedNPCsWithoutTaggedNPCs[]`, `tagMode`, `sheetTypeLabelOverride`.

**Relationship semantics:** every link is a Foundry **uuid string** (or array).
`linkedActor` → Actor; `linkedScene` → Scene; everything else → other Campaign
Codex journals. Graph = { nodes: flagged journals, edges: these uuid arrays }.
Resolve with `fromUuid()`.

### 3.2 Reuse targets in the module source

- `CampaignCodexLinkers` (`sheets/linkers.js`) — exported static utility that
  fetches/cleans/prunes linked data with caching. Reference for graph traversal
  that matches the module's own dereferencing behavior.
- `campaign-codex-importer.js` / `campaign-codex-exporter.js` — full JSON
  import/export of codex journals (the documented `exportToObsidian` is one
  consumer). **This is the schema-safe write path.**

### 3.3 Proposed surface

Read tools (no module API needed — pure flag reads via the bridge):

- `list-codex-sheets` — `args: { type? }` → flagged journals (uuid, name, type)
- `get-codex-sheet` — `args: { uuid }` → type + data + resolved link names
- `get-codex-relationships` — `args: { uuid }` → the graph around an entity

Resources:

- expose codex journals as browsable resources with relationship edges (§2.5),
  so the campaign graph is pullable context rather than only query tools.

Writes (later, via the official import path — §2.6):

- `create-codex-sheet` / `populate-codex` → generate importer JSON and run it
  through `campaign-codex-importer`, **not** raw `data.linked*` flag writes.

### 3.4 Bridge sketch (Foundry side)

```js
// list-codex-sheets
const sheets = game.journal
  .filter(j => j.getFlag("campaign-codex", "type"))
  .filter(j => !type || j.getFlag("campaign-codex", "type") === type)
  .map(j => ({ uuid: j.uuid, name: j.name, type: j.getFlag("campaign-codex", "type") }));
```

---

## 4. Migration / build order

1. Add `ToolProvider` + `ToolRegistry` (mirror `SystemRegistry`).
2. Add `registerQueries(CONFIG)` convention on the Foundry side.
3. Migrate existing tool classes onto the registry; **delete the `switch`** in
   `backend.ts`.
4. Add availability gating (bridge reports active module ids).
5. First-class modules:
   - **Simple Calendar** redone as a clean provider (Vorin math removed / made a
     separate campaign-calendar concern).
   - **Campaign Codex** read tools + resources (writes via importer, later).

## 5. Open decisions

1. Advertise-only-if-active (preferred) vs. always-advertise-and-error.
2. Migrate **all** existing tools to the registry at once, or only new modules use
   the registry while legacy tools keep the switch until later.
3. Where campaign-specific mapping (e.g. Vorin calendar formatting) lives — out of
   module bridges, into a configurable per-campaign layer.

## 6. Don'ts

- ❌ Hand-write a module's internal flags for persistence — use its official
  API/import path.
- ❌ Put campaign-specific logic inside a generic module handler.
- ❌ Grow the central `switch` / `allTools` array for new tools — register a
  provider instead.
