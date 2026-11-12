# dsh-better-ptc

Shared host service for DeepSeek Harness PTC run_code deadline exemptions.
Version 0.2.1 targets DSH 0.2.2-rc.2 only, Node >=24.9.0 and Cordis ~4.1.0.

## What it does

The Node PTC runtime owns the run_code elapsed deadline. This package is a
singleton host row that patches the mounted runtime prototype's run once and
exposes ctx.betterPtc.register(toolName). While a registered tool's binding is
in flight the wall clock pauses; when it returns the remaining budget resumes.
`exit_plan_mode` is registered by the BetterPtc service itself, even without
ask-user or subagent plugins. Pending decisions have no deadline and are never
automatically approved or assigned a default choice. External cancellation and
service unloading still abort active waits.

Other bindings still consume the program budget. The wrapper reports its own
expiry as the runtime's normal timeout failure and preserves outer aborts.

## Stable row

The row id and name are both dsh-better-ptc. Every plugin that needs an
exemption inserts the same row in its bundle patch; the DSH Loader deduplicates
by row id, so installing several plugins (or the shared bundle itself) still
activates exactly one row and one service. Plugins call the service through
ctx.inject(['betterPtc'], ...); they do not import private copies.

## API

ctx.betterPtc.register(toolName) returns an idempotent unregister disposer.
The call is refcounted per tool name. If the mounted runtime has no numeric
timeout (for example the experimental Python provider), registration is a
no-op. The service never edits DSH core.

## Install

The package is a host-only bundle. Install it directly to mount the service, or
let a plugin's bundle patch insert the stable row:

~~~sh
dsh plugin --profile <profile> add dsh-better-ptc
~~~

## Development

~~~sh
npm install
npm test
~~~

The unit tests exercise the registry and service lifecycle with a fake runtime.
The runtime tests mount the actual installed NodePtcRuntime and Cordis plugin,
launch real Node workers in all four configurations (per-call, persistent REPL,
and vm-script with/without persistence), and exercise waits, plan decisions,
remaining budgets, cancellation, unload, owners, release and policy events.
These binding-level plan tests are not the full plan-mode/userQuestions flow.
Without DSH_PACKAGE_ROOT the real runtime tests are explicitly skipped.

~~~sh
DSH_PACKAGE_ROOT=/path/to/host/node_modules/@deepseek-ai/dsh \
APOLLO_PLUGIN_SOURCE_ROOT=/path/to/plugin-worktrees npm test
~~~
