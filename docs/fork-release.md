# CrossStar fork release 0.24.0

This fork is distributed from https://github.com/CrossStar/pi-subagents. Its package identity is `@crossstar/pi-subagents`; `private: true` prevents npm publication. The upstream author and MIT license remain credited. Upstream npm releases are independent of this fork.

## Release summary

- Introduces the native `subagents:execution-backend:v1` provider contract: synchronous capture, asynchronous tool preparation, session-owned cleanup, and capability validation.
- Preserves captured bindings across queue admission, workflow children and live resumes. External execution is tools-only; model calls, authentication and session storage remain local.
- Refuses unsupported external capabilities and external session recovery after restart. Local sessions reopen using their saved cwd without rediscovery.
- Includes the pending nested concurrency limit: default 10, configurable to 0 for unlimited nesting. Excess nested spawns fail rather than queue behind their parent.

See [the backend contract](execution-backends.md) and [the changelog](../CHANGELOG.md).

## Validation checklist

Run `npm run lint`, `npm run typecheck`, `npm run build`, the backend test files, `npm test`, `npm run test:e2e`, and `npm pack --dry-run`. Live model e2e is a separate optional smoke check using `PI_E2E_LIVE=1`; scripted tests do not establish live provider compatibility.

Inspect the package manifest for `src/`, built `dist/`, documentation and LICENSE, and exclude runtime logs, sessions and credentials. `.pi/agents/` and shared `.pi/settings.json` remain trackable in Git; local runtime state is ignored.

No publish, tag, push or commit is part of this preparation. Install the fork with `pi install git:github.com/CrossStar/pi-subagents` after the intended revision is available in that repository.
