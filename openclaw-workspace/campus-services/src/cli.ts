/**
 * Shared CLI plumbing: single-line JSON on stdout, exit 0/2/1 — the contract
 * school-web's execFile integrations parse (legacy-compatible).
 */
import { CampusServiceError } from './errors.ts';

export function emit(payload: Record<string, unknown>, exitCode = 0): never {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(exitCode);
}

export function runCli(handler: () => Record<string, unknown>): never {
  try {
    emit(handler());
  } catch (error) {
    if (error instanceof CampusServiceError) {
      emit({ ok: false, error: error.message, code: error.code }, 2);
    }
    emit({ ok: false, error: '校园服务发生内部错误', code: 'INTERNAL' }, 1);
  }
}

/** Minimal `--flag value` parser matching the legacy python argparse shape. */
export function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, '');
    }
  }
  return flags;
}
