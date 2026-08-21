import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverCapabilityManifests } from './capabilityRegistry.ts';
import { validateSkillManifest } from './skillContract.ts';

const workspace =
  process.env.CAMPUS_WORKSPACE ||
  join(process.env.USERPROFILE || '', '.openclaw', 'workspace-campus');
const skillsDirectory = join(workspace, 'skills');
const capabilities = discoverCapabilityManifests(workspace);
const errors: string[] = [];

for (const directory of readdirSync(skillsDirectory, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const root = join(skillsDirectory, directory.name);
  const skillDocument = join(root, 'SKILL.md');
  const manifestPath = join(root, 'capability.json');
  if (!existsSync(skillDocument)) errors.push(`${directory.name}: 缺少 SKILL.md`);
  if (!existsSync(manifestPath)) {
    errors.push(`${directory.name}: 缺少 capability.json`);
    continue;
  }
  try {
    const manifest = validateSkillManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
    );
    const entrypoint = resolve(root, manifest.entrypoint.path);
    if (!existsSync(entrypoint)) errors.push(`${directory.name}: 入口不存在`);
    const document = readFileSync(skillDocument, 'utf8');
    if (!/^---\r?\n/.test(document) || !document.includes(`name: ${directory.name}`)) {
      errors.push(`${directory.name}: SKILL.md frontmatter 名称与目录不一致`);
    }
  } catch (error) {
    errors.push(`${directory.name}: ${error instanceof Error ? error.message : error}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`[skill-contract] ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `[skill-contract] ${capabilities.length} 个已启用 Skill 通过 manifest、入口、权限和执行契约校验`,
  );
}
