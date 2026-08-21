# OpenClaw Campus Workspace

This directory contains the sanitized reusable OpenClaw campus Agent workspace published with the reference repository.

Included:

- Agent workspace instructions;
- isolated `campus-admin` Agent workspace and automatic-approval Skill;
- isolated `campus-router` Agent workspace instructions;
- campus Skills and capability manifests;
- local Demo campus knowledge base;
- Skill development template;
- isolated Python tests;
- baseline Demo course data.

Excluded:

- OpenClaw global configuration and credentials;
- sessions and runtime workspace state;
- leave requests and course submission state;
- execution state, idempotency records, traces and audit logs;
- lock files, transaction journals and caches.

The web application and Node.js integration are stored at the root of this public reference repository.

Restore `router-workspace/` as the OpenClaw `workspace-campus-router` directory when rebuilding the local Agent setup.

## campus-services (deterministic leave engine)

`campus-services/` is a zero-dependency TypeScript package (Node.js 22.13+, built-in `node:sqlite`, no build step). It owns the leave auto-approval domain: schema migrations, the 9-rule approval engine, the leave state machine, the SQLite hash-chain audit, manual approval commands, school-data CRUD, dashboards and demo tooling.

```powershell
cd campus-services
node --test src/test/*.test.ts      # 39 tests
node src/bin/initDemoDb.ts          # apply migrations + baseline seed (idempotent)
node src/bin/generateSeed.ts        # regenerate demo/auto-approval/seed (600 leaves, engine-verified)
node src/bin/migrateLeaveJson.ts    # one-shot import of legacy data/leave-requests.json
```

Student CLI (legacy-compatible `create/list/cancel/verify-audit`): `node campus-services/src/bin/leaveManagerCli.ts`.
Administrator Agent approval CLI (`next/process/status/fail`): `node campus-services/src/bin/approvalAgentCli.ts`.
Admin CLI (stdin JSON commands): `node campus-services/src/bin/campusAdminCli.ts <command>`.

The student `campus` Agent only creates an `evaluating` request and a durable queue job. The separate `campus-admin` Agent workspace owns `campus-auto-approval`; the server-side watcher detects queued jobs and starts that deterministic Skill. Rules: same input + same rule version always yields the same outcome; ALL enabled rules must pass for `approved_auto`, any failure or engine error degrades to `manual_review`; there is no automatic rejection path.

## Repeatable end-to-end demo

Run `demo/campus-e2e/run-demo.ps1` for an isolated demonstration of leave-impact preview and confirmation, idempotent replay, audit verification, course submission, transaction recovery, and operator rollback. The runner copies baseline course data into a system temporary directory and verifies that every existing file under `data/` has the same SHA-256 before and after the run.
