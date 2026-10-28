# Homebridge development audit — October 2026

Audited for [issue #42](https://github.com/tinkerologie/homebridge-actronair-neo/issues/42)
against the installed Homebridge **2.4.0**, `@homebridge/hap-nodejs` **2.2.2**,
and TypeScript **6.0.3**. Findings were checked against dependency source,
official documentation, and Context7, Exa, and Tavily results. This document
records the audit and remediation scope; actual test, CI, review, coverage, and
deployment results belong in the pull request.

## Confirmed findings addressed by this change

| Finding | Evidence and remediation |
| --- | --- |
| HAP state listeners outlive their wrappers | `NeoState.onChange()` returns an unsubscribe closure, but accessory wrappers discarded it. Wrappers now own disposal; the platform releases them before replacement, on removal, and on shutdown, and releases its own subscription. HAP `onGet`/`onSet` replace their previous handlers, so the retained listeners were the separate `NeoState` subscriptions. |
| Discovery can resume after shutdown | Clearing the poll timer cannot cancel an awaited discovery. Check the existing shutdown flag after discovery awaits and before creating resources or synchronizing accessories. Homebridge documents shutdown as occurring after accessory unpublication and cache persistence. |
| Matter bookkeeping precedes API results | Preserve tracked accessories/bindings when unregister rejects; discard bindings for rejected new registrations. This handles API-level rejection, with the dispatch limitation below. |
| UI/runtime interval validation differs | Runtime requires a positive integer; add `minimum: 1` to `config.schema.json` and test alignment. |
| Transient session refresh failures look like revoked credentials | Only OAuth HTTP 400/401 responses should show re-linking; 429, server errors, and unexpected statuses should retain credentials and show the existing retry path. |
| Warnings and coverage are not enforced by CI | Use `eslint . --max-warnings=0`, explicit `tsc --noEmit`, LCOV output, and CI coverage upload. ESLint stylistic rules provide the formatting check. See the [official plugin template](https://github.com/homebridge/homebridge-plugin-template/blob/latest/package.json). |
| One deprecated dependency type remains | `src/neo/schemas.ts` used `z.ZodTypeAny`. Replace it with `z.ZodType`; the installed Zod compatibility declaration explicitly marks the alias deprecated. This corrects the plan's overly broad claim that there were no deprecated APIs. See [Zod's compatibility source](https://github.com/colinhacks/zod/blob/main/packages/zod/src/v4/classic/compat.ts). |

Lifecycle contracts were checked in installed `homebridge/dist/api.d.ts` and
HAP `dist/lib/Characteristic.js`. The corresponding versioned sources are
[Homebridge's API](https://github.com/homebridge/homebridge/blob/v2.4.0/src/api.ts)
and [HAP Characteristic](https://github.com/homebridge/HAP-NodeJS/blob/v2.2.2/src/lib/Characteristic.ts).

## Refuted allegations and practices already followed

- No removed Homebridge/HAP API usage was found. The plugin uses ESM, public
  `homebridge` imports, a dynamic platform, injected `api.hap` classes,
  `onGet`/`onSet`, stable cache restoration, and guarded optional Matter access.
  Checks covered the [Homebridge v2 removal list](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0).
  A compiler-symbol/JSDoc scan of 29 source files found only the Zod alias above.
- Two-argument `registerPlatform` and string lifecycle event overloads remain
  supported. Changing to `APIEvent` constants is optional.
- The branch based on current `main` already identifies `tinkerologie` in
  `AGENTS.md`; the earlier owner mismatch is not present there.
- Broad Node major ranges are not themselves a demonstrated defect. Supported
  runtime evidence should determine the declared matrix.
- HAP `setProps()` revalidates an existing value using **`debug-message`**,
  explicitly to clamp it without a warning. Such diagnostics are not lint
  warnings or evidence requiring speculative characteristic changes.

The [developer guidance](https://developers.homebridge.io/) recommends following
verification criteria and declaring supported transports. Both `supports-hap`
and `supports-matter` are appropriate because this plugin registers accessories
for both protocols. Older verification pages contain obsolete Node lists; use
the [current Node support guidance](https://github.com/homebridge/homebridge/wiki/How-To-Update-Node.js).

## Runtime and compiler compatibility

Homebridge 2.4.0 declares Node **22, 24, and 26**. Node's official schedule places
26's LTS transition on **28 October 2026**, although retrieved status labels
were inconsistent around that transition. Add 26 to CI/release validation and
declare support only with passing evidence. See the
[Homebridge manifest](https://github.com/homebridge/homebridge/blob/v2.4.0/package.json)
and [Node release schedule](https://github.com/nodejs/Release).

TypeScript **7.0.2** is stable, not merely a native preview. An isolated 7.0.2
installation outside the repository successfully ran `tsc --noEmit --project
tsconfig.json` with zero diagnostics against this plugin. Homebridge loads the
compiled JavaScript, while its current core and plugin template still use
TypeScript 6. This check does not migrate the repository toolchain. Microsoft
documents keeping a TypeScript 6 API alias alongside the TS7 native compiler;
`typescript-eslint` still supports `<6.1.0`, so a direct replacement is not a
safe lint-tooling upgrade. Sources: [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/),
[typescript-eslint dependency support](https://typescript-eslint.io/users/dependency-versions).

## Matter evidence and remaining uncertainty

Inspection of Homebridge 2.4.0 settled part of the earlier contract uncertainty:

- Matter register/update/unregister APIs return promises, but normal bridged
  operations dispatch events. Manager handlers catch and log later bridge
  failures; awaiting the public promise is not a transaction-completion
  guarantee. Regression tests for API rejection must not be described as proof
  of all downstream failure recovery.
- `server/StateManager` rejects a supplied `partId` when that part or its endpoint
  is absent. Public state updates also dispatch events, so the manager can log
  this error after the plugin's promise has resolved. Avoid claiming the
  plugin's `.catch()` observes every such error.
- Server metadata updates merge plugin fields while preserving runtime
  endpoints. Whether all desired metadata reaches an existing controller, and
  whether mutated cached objects need rollback after rejection, still need
  integration evidence. No speculative rollback or metadata rewrite is included.

Primary source: [Matter API implementation](https://github.com/homebridge/homebridge/blob/v2.4.0/src/matter/MatterAPIImpl.ts),
[bridge manager](https://github.com/homebridge/homebridge/blob/v2.4.0/src/matter/MatterBridgeManager.ts),
[state manager](https://github.com/homebridge/homebridge/blob/v2.4.0/src/matter/server/StateManager.ts),
[server metadata update](https://github.com/homebridge/homebridge/blob/v2.4.0/src/matter/server.ts).
The [public Matter API](https://developers.homebridge.io/homebridge/interfaces/MatterAPI.html)
documents optional guards and cache updates, but does not replace live evidence.

## Deferred scope and coverage prerequisites

Test-file type checking, UI coverage inclusion, packaged-artifact smoke tests,
transport/device identity changes, cross-system zone-ID reuse, and changes to
the existing constructor-failure registration policy remain separate work.
Cross-system identity semantics require a product decision; this change preserves
UUID derivation and legacy zone adoption. Codecov therefore measures the
configured source coverage, not the UI or every possible integration path.

Codecov's project status uses the base report with `target: auto`; `threshold:
0%` permits no drop. Upload failures must fail CI, but upload success alone does
not establish a coverage comparison. Two owner prerequisites remain:

1. Supply an initial coverage baseline from `main`. A first PR without a base
   report cannot prove regression enforcement.
2. Make the emitted `codecov/project` status required in branch protection
   (use the exact status context GitHub receives).

These are configuration and account-state prerequisites, not claims that this
first pull request has already enforced them. See
[Codecov status checks](https://docs.codecov.com/docs/commit-status) and
[Codecov YAML configuration](https://docs.codecov.com/docs/codecov-yaml).
