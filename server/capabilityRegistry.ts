import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { CampusPrincipal, JsonObject } from './security.ts';
import {
  validateSkillManifest,
  type SkillManifest,
} from './skillContract.ts';

export type CapabilityAccessMode = 'read' | 'write';
export type CapabilityConfirmation = 'none' | 'explicit-before-write';

export interface CampusCapability {
  id: string;
  version: string;
  name: string;
  description: string;
  skill: string;
  demo: true;
  examples: string[];
  access: SkillManifest['access'];
  execution: SkillManifest['execution'];
  resultCards: SkillManifest['resultCards'];
  contract: SkillManifest['contract'];
  operations: SkillManifest['operations'];
  orchestration?: SkillManifest['orchestration'];
}

interface RegisteredCapability extends CampusCapability {
  displayOrder: number;
  routePatterns: RegExp[];
  manifestPath: string;
  entrypointPath: string;
}

function workspacePath() {
  return (
    process.env.CAMPUS_WORKSPACE ||
    join(process.env.USERPROFILE || '', '.openclaw', 'workspace-campus')
  );
}

export function discoverCapabilityManifests(
  workspace = workspacePath(),
): RegisteredCapability[] {
  const skillsDirectory = join(workspace, 'skills');
  const registered: RegisteredCapability[] = [];
  const ids = new Set<string>();
  const skillNames = new Set<string>();
  for (const directory of readdirSync(skillsDirectory, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const manifestPath = join(skillsDirectory, directory.name, 'capability.json');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`${manifestPath} 不是有效 JSON`, { cause: error });
    }
    const manifest = validateSkillManifest(raw);
    if (!manifest.enabled) continue;
    if (manifest.skill !== directory.name) {
      throw new Error(`${manifestPath} 的 skill 必须与目录名一致`);
    }
    if (ids.has(manifest.id)) throw new Error(`能力 ID 重复：${manifest.id}`);
    if (skillNames.has(manifest.skill)) throw new Error(`Skill 名称重复：${manifest.skill}`);
    ids.add(manifest.id);
    skillNames.add(manifest.skill);
    const entrypointPath = resolve(skillsDirectory, directory.name, manifest.entrypoint.path);
    const skillRoot = `${resolve(skillsDirectory, directory.name)}\\`;
    if (isAbsolute(manifest.entrypoint.path) || !normalize(entrypointPath).startsWith(skillRoot)) {
      throw new Error(`${manifestPath} 的入口不能离开 Skill 目录`);
    }
    registered.push({
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      description: manifest.description,
      skill: manifest.skill,
      displayOrder: manifest.displayOrder,
      demo: true,
      examples: manifest.examples,
      access: manifest.access,
      execution: manifest.execution,
      resultCards: manifest.resultCards,
      contract: manifest.contract,
      operations: manifest.operations,
      orchestration: manifest.orchestration,
      routePatterns: manifest.routing.patterns.map(
        (pattern) => new RegExp(pattern, manifest.routing.flags),
      ),
      manifestPath,
      entrypointPath,
    });
  }
  const enabledIds = new Set(registered.map((capability) => capability.id));
  for (const capability of registered) {
    for (const dependency of capability.orchestration?.dependencies || []) {
      if (!enabledIds.has(dependency)) {
        throw new Error(`${capability.id} 依赖未启用能力：${dependency}`);
      }
    }
  }
  return registered.sort(
    (left, right) =>
      left.displayOrder - right.displayOrder || left.id.localeCompare(right.id),
  );
}

const CAPABILITIES = discoverCapabilityManifests();

function publicDescriptor(capability: RegisteredCapability): CampusCapability {
  const {
    routePatterns: _routePatterns,
    manifestPath: _manifestPath,
    entrypointPath: _entrypointPath,
    displayOrder: _displayOrder,
    ...descriptor
  } = capability;
  return descriptor;
}

function canUse(capability: RegisteredCapability, principal: CampusPrincipal) {
  return capability.access.roles.some((role) => principal.roles.includes(role));
}

export function listCapabilities(principal: CampusPrincipal): CampusCapability[] {
  return CAPABILITIES.filter((capability) => canUse(capability, principal)).map(
    publicDescriptor,
  );
}

export function routeCapability(
  message: string,
  principal: CampusPrincipal,
): CampusCapability | null {
  const capability = CAPABILITIES.find(
    (candidate) =>
      canUse(candidate, principal) &&
      candidate.routePatterns.some((pattern) => pattern.test(message)),
  );
  return capability ? publicDescriptor(capability) : null;
}

export function capabilityRegistrySummary(): JsonObject {
  return {
    registryVersion: '2.0.0',
    total: CAPABILITIES.length,
    demo: true,
    source: 'skill-manifests',
  };
}
