import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  validateSkillInput,
  validateSkillManifest,
  validateSkillOutput,
  type SkillInputEnvelope,
  type SkillManifest,
  type SkillOutputEnvelope,
} from './skillContract.ts';

export function authorizeSkillInvocation(
  manifestValue: unknown,
  inputValue: unknown,
) {
  const manifest = validateSkillManifest(manifestValue);
  const input = validateSkillInput(inputValue);
  if (!manifest.enabled) throw new Error('Skill 尚未启用');
  if (manifest.id !== input.capabilityId) throw new Error('能力 ID 与输入不一致');
  const operation = manifest.operations.find(
    (candidate) => candidate.name === input.operation,
  );
  if (!operation) throw new Error('Skill 未声明该 operation');
  if (!input.actor.roles.some((role) => manifest.access.roles.includes(role))) {
    throw new Error('当前角色无权调用该 Skill');
  }
  if (operation.sideEffect && !input.authorization.confirmed) {
    throw new Error('有副作用的 operation 尚未获得明确确认');
  }
  if (operation.sideEffect && manifest.execution.idempotent && !input.idempotencyKey) {
    throw new Error('幂等写操作必须提供幂等键');
  }
  return { manifest, input, operation };
}

export function validateSkillInvocationResult(
  input: SkillInputEnvelope,
  outputValue: unknown,
  manifest?: SkillManifest,
) {
  const output = validateSkillOutput(outputValue);
  if (output.invocationId !== input.invocationId) {
    throw new Error('Skill 输出 invocationId 与输入不一致');
  }
  if (output.operation !== input.operation) {
    throw new Error('Skill 输出 operation 与输入不一致');
  }
  if (
    manifest &&
    output.cards?.some((card) => !manifest.resultCards.includes(card.type))
  ) {
    throw new Error('Skill 返回了 manifest 未声明的卡片类型');
  }
  return output;
}

export async function runJsonStdioSkill(
  skillRoot: string,
  manifestValue: unknown,
  inputValue: unknown,
): Promise<SkillOutputEnvelope> {
  const { manifest, input } = authorizeSkillInvocation(manifestValue, inputValue);
  if (manifest.contract.transport !== 'json-stdio') {
    throw new Error('该 Skill 仍使用兼容适配器，不能通过 JSON-stdio 运行时执行');
  }
  const entrypoint = resolve(skillRoot, manifest.entrypoint.path);
  const timeoutMs = manifest.execution.timeoutMs;
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(process.env.PYTHON || 'python', [entrypoint], {
      cwd: skillRoot,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Skill 执行超时'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > 64 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Skill 进程失败：${stderr.slice(0, 500) || code}`));
      } else {
        resolveOutput(stdout);
      }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`, 'utf8');
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Skill 输出不是单个有效 JSON 对象');
  }
  return validateSkillInvocationResult(input, parsed, manifest);
}

export type { SkillInputEnvelope, SkillManifest, SkillOutputEnvelope };
