#!/usr/bin/env node
/**
 * campus-leave skill entrypoint (node runtime).
 *
 * Thin launcher: keeps the skill's entrypoint contract self-contained while
 * the implementation lives in campus-services (SQLite + approval engine).
 */
import { runLeaveManagerCli } from '../../../campus-services/src/bin/leaveManagerCli.ts';

runLeaveManagerCli();
