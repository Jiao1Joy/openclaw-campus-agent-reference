import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RouteEvalCase } from './routeEvalTypes.ts';
import {
  isValidCapabilityIntentPair,
  requiredMissingForRoute,
} from '../server/openclawRouter.ts';

const CAPABILITIES = new Set<string | null>([
  'campus.leave-impact',
  'campus.leave',
  'campus.course',
  'campus.knowledge',
  null,
]);
const INTENTS = new Set(['start', 'continue', 'confirm', 'cancel', 'list', 'general']);
const PERIODS = new Set(['morning', 'afternoon', 'evening', 'none']);
const PRECISIONS = new Set(['exact', 'period', 'none']);
const LEAVE_TYPES = new Set(['病假', '事假', '公假', '其他', '']);
const PARAMETER_FIELDS = new Set([
  'targetDate', 'startTime', 'endTime', 'timePeriod',
  'timePrecision', 'leaveType', 'reason', 'selectedSectionId',
]);
const CATEGORY_BY_CAPABILITY = new Map<string | null, string>([
  ['campus.leave-impact', 'leave-impact'],
  ['campus.leave', 'leave'],
  ['campus.course', 'course'],
  ['campus.knowledge', 'knowledge'],
  [null, 'null'],
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validDate(value: string) {
  const match = value.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}

function validTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateRouteCase(value: unknown, line: number): RouteEvalCase {
  assert(isObject(value), `Route fixture line ${line} must be a JSON object`);
  const item = value as unknown as RouteEvalCase;
  const label = typeof item.id === 'string' ? item.id : `line ${line}`;
  assert(/^route-\d{4}$/.test(item.id), `${label}: invalid id`);
  assert(typeof item.category === 'string' && item.category.trim().length > 0 && item.category.length <= 40, `${label}: invalid category`);
  assert(typeof item.message === 'string' && item.message.trim().length > 0 && item.message.length <= 1000, `${label}: invalid message`);
  assert(typeof item.now === 'string' && Number.isFinite(Date.parse(item.now)), `${label}: invalid now`);
  assert(/(?:Z|[+-]\d{2}:\d{2})$/.test(item.now), `${label}: now must include a timezone`);
  assert(item.activeExecution === null || isObject(item.activeExecution), `${label}: invalid activeExecution`);
  if (item.activeExecution) {
    assert(CAPABILITIES.has(item.activeExecution.capabilityId), `${label}: active capability is not allowed`);
    assert(item.activeExecution.capabilityId !== null, `${label}: active capability cannot be null`);
    assert(['collecting', 'awaiting-input', 'awaiting-confirmation', 'executing'].includes(item.activeExecution.status), `${label}: invalid active status`);
    assert(typeof item.activeExecution.phase === 'string' && item.activeExecution.phase.length > 0, `${label}: invalid active phase`);
  }
  assert(isObject(item.expected), `${label}: invalid expected object`);
  assert(CAPABILITIES.has(item.expected.capabilityId), `${label}: capabilityId is not allowed`);
  assert(
    CATEGORY_BY_CAPABILITY.get(item.expected.capabilityId) === item.category,
    `${label}: category does not match capabilityId`,
  );
  assert(INTENTS.has(item.expected.intent), `${label}: intent is not allowed`);
  assert(
    isValidCapabilityIntentPair(item.expected.capabilityId, item.expected.intent),
    `${label}: capabilityId and intent combination is invalid`,
  );
  assert(isObject(item.expected.parameters), `${label}: invalid parameters object`);
  assert(Object.keys(item.expected.parameters).length === PARAMETER_FIELDS.size, `${label}: parameters must contain exactly ${PARAMETER_FIELDS.size} fields`);
  assert(Object.keys(item.expected.parameters).every((field) => PARAMETER_FIELDS.has(field)), `${label}: parameters contain an unknown field`);
  const parameters = item.expected.parameters;
  assert(typeof parameters.targetDate === 'string' && (!parameters.targetDate || validDate(parameters.targetDate)), `${label}: invalid targetDate`);
  for (const field of ['startTime', 'endTime'] as const) {
    assert(typeof parameters[field] === 'string' && (!parameters[field] || validTime(parameters[field])), `${label}: invalid ${field}`);
  }
  assert(PERIODS.has(parameters.timePeriod), `${label}: invalid timePeriod`);
  assert(PRECISIONS.has(parameters.timePrecision), `${label}: invalid timePrecision`);
  assert(LEAVE_TYPES.has(parameters.leaveType), `${label}: invalid leaveType`);
  assert(typeof parameters.reason === 'string' && parameters.reason.length <= 200, `${label}: invalid reason`);
  assert(typeof parameters.selectedSectionId === 'string' && parameters.selectedSectionId.length <= 80, `${label}: invalid selectedSectionId`);
  assert(
    Array.isArray(item.expected.requiredMissing) && item.expected.requiredMissing.every(
      (field) => typeof field === 'string' && field.trim().length > 0 && field.length <= 40,
    ),
    `${label}: invalid requiredMissing`,
  );
  assert(new Set(item.expected.requiredMissing).size === item.expected.requiredMissing.length, `${label}: duplicate requiredMissing field`);
  assert(
    JSON.stringify(item.expected.requiredMissing) === JSON.stringify(
      requiredMissingForRoute(
        item.expected.capabilityId,
        item.expected.intent,
        item.expected.parameters,
      ),
    ),
    `${label}: requiredMissing does not match the shared routing protocol`,
  );
  assert(typeof item.expected.forbiddenWrite === 'boolean', `${label}: invalid forbiddenWrite`);
  assert(Array.isArray(item.tags) && item.tags.length > 0 && item.tags.length <= 12, `${label}: invalid tags`);
  assert(item.tags.every((tag) => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 30), `${label}: invalid tag value`);

  if (parameters.timePrecision === 'exact') {
    assert(parameters.startTime && parameters.endTime, `${label}: exact time requires startTime and endTime`);
    assert(parameters.startTime < parameters.endTime, `${label}: startTime must be before endTime`);
  }
  if (parameters.timePrecision === 'period') {
    assert(parameters.timePeriod !== 'none', `${label}: period precision requires a timePeriod`);
  }
  if (parameters.timePrecision === 'none') {
    assert(!parameters.startTime && !parameters.endTime && parameters.timePeriod === 'none', `${label}: none precision cannot contain time values`);
  }
  if (item.expected.intent === 'confirm' || item.expected.intent === 'cancel' || item.expected.intent === 'continue') {
    assert(item.activeExecution !== null, `${label}: ${item.expected.intent} requires activeExecution`);
    assert(
      item.activeExecution.capabilityId === item.expected.capabilityId,
      `${label}: ${item.expected.intent} must target the active capability`,
    );
  }
  return item;
}

export async function loadRouteCases(path: string) {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter((line) => line.trim().length > 0);
  const cases = lines.map((line, index) => {
    try {
      return validateRouteCase(JSON.parse(line) as unknown, index + 1);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Route fixture line ${index + 1} is not valid JSON`);
      throw error;
    }
  });
  assert(cases.length >= 120 && cases.length <= 160, `Route fixture must contain 120-160 cases; received ${cases.length}`);
  assert(new Set(cases.map((item) => item.id)).size === cases.length, 'Route fixture contains duplicate ids');
  const messageCounts = new Map<string, number>();
  for (const item of cases) messageCounts.set(item.message.trim(), (messageCounts.get(item.message.trim()) || 0) + 1);
  const duplicateRatio = [...messageCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0) / cases.length;
  assert(duplicateRatio <= 0.05, `Route fixture duplicate message ratio exceeds 5%: ${(duplicateRatio * 100).toFixed(2)}%`);
  for (const capabilityId of CAPABILITIES) {
    assert(cases.some((item) => item.expected.capabilityId === capabilityId), `Route fixture does not cover capability ${String(capabilityId)}`);
  }
  for (const intent of INTENTS) {
    assert(cases.some((item) => item.expected.intent === intent), `Route fixture does not cover intent ${intent}`);
  }
  assert(cases.some((item) => item.expected.forbiddenWrite), 'Route fixture does not contain safety cases');
  return cases;
}

function validSchedule(slot: Record<string, unknown>) {
  const weeks = Array.isArray(slot.weeks) ? slot.weeks : [];
  return Number.isInteger(slot.day) && Number(slot.day) >= 1 && Number(slot.day) <= 7 &&
    typeof slot.start === 'string' && validTime(slot.start) &&
    typeof slot.end === 'string' && validTime(slot.end) && slot.start < slot.end &&
    weeks.length > 0 && weeks.every((week) => Number.isInteger(week) && Number(week) >= 1 && Number(week) <= 30) &&
    weeks.every((week, index) => index === 0 || Number(week) > Number(weeks[index - 1]));
}

export async function validateCourseCandidate(path: string) {
  const data = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  assert(Array.isArray(data.teachers), 'Course candidate is missing teachers');
  assert(Array.isArray(data.sections), 'Course candidate is missing sections');
  assert(Array.isArray(data.studentProfiles) && data.studentProfiles.length > 0, 'Course candidate is missing studentProfiles');
  assert(data.teachers.length >= 25, `Course candidate needs at least 25 teachers; received ${data.teachers.length}`);
  assert(data.sections.length >= 45 && data.sections.length <= 70, `Course candidate needs 45-70 sections; received ${data.sections.length}`);

  const teachers = data.teachers as Array<Record<string, unknown>>;
  const sections = data.sections as Array<Record<string, unknown>>;
  const profiles = data.studentProfiles as Array<Record<string, unknown>>;
  const teacherIds = teachers.map((item) => String(item.id || ''));
  const sectionIds = sections.map((item) => String(item.sectionId || ''));
  const courseCodes = new Set(sections.map((item) => String(item.courseCode || '')));
  assert(teacherIds.every(Boolean) && new Set(teacherIds).size === teacherIds.length, 'Teacher ids are missing or duplicated');
  assert(sectionIds.every(Boolean) && new Set(sectionIds).size === sectionIds.length, 'Section ids are missing or duplicated');
  assert([...courseCodes].every(Boolean), 'Course code is missing');
  const teacherSet = new Set(teacherIds);
  const sectionSet = new Set(sectionIds);

  for (const teacher of teachers) {
    const id = String(teacher.id || 'unknown');
    assert(typeof teacher.name === 'string' && teacher.name.length > 0, `${id}: teacher name is missing`);
    assert(typeof teacher.department === 'string' && teacher.department.length > 0, `${id}: teacher department is missing`);
  }
  for (const section of sections) {
    const id = String(section.sectionId || 'unknown');
    assert(teacherSet.has(String(section.teacherId || '')), `${id}: references an unknown teacher`);
    assert(typeof section.courseName === 'string' && section.courseName.length > 0, `${id}: courseName is missing`);
    assert(Number(section.credits) > 0, `${id}: invalid credits`);
    assert(Number(section.capacity) > 0, `${id}: invalid capacity`);
    assert(Number(section.enrolled) >= 0 && Number(section.enrolled) <= Number(section.capacity), `${id}: invalid enrolled count`);
    assert(Array.isArray(section.schedule) && section.schedule.length > 0, `${id}: schedule is missing`);
    assert((section.schedule as Array<Record<string, unknown>>).every(validSchedule), `${id}: invalid schedule`);
    assert(Array.isArray(section.prerequisites), `${id}: invalid prerequisites`);
    for (const prerequisite of section.prerequisites as unknown[]) {
      assert(typeof prerequisite === 'string' && /^[A-Z]{2,12}-?\d{2,4}$/.test(prerequisite), `${id}: invalid prerequisite ${String(prerequisite)}`);
    }
  }
  for (const profile of profiles) {
    assert(typeof profile.studentId === 'string' && profile.studentId.length > 0, 'Student profile is missing studentId');
    const references = Array.isArray(profile.existingSectionIds) ? profile.existingSectionIds.map(String) : [];
    assert(references.every((id) => sectionSet.has(id)), `${String(profile.studentId)}: references an unknown section`);
  }
  return {
    teachers: teachers.length,
    sections: sections.length,
    courseCodes: courseCodes.size,
    studentProfiles: profiles.length,
  };
}

async function main() {
  const root = resolve(process.cwd());
  const routePath = resolve(root, process.argv[2] || 'evals/fixtures/openclaw-route-cases.jsonl');
  const coursePath = resolve(root, process.argv[3] || 'evals/fixtures/course-data-expanded.candidate.json');
  const cases = await loadRouteCases(routePath);
  const course = await validateCourseCandidate(coursePath);
  const categories = Object.fromEntries(
    [...new Set(cases.map((item) => item.category))].sort().map((category) => [category, cases.filter((item) => item.category === category).length]),
  );
  console.log(JSON.stringify({ ok: true, routeCases: cases.length, categories, course }, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === new URL(`file:///${invokedPath.replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(`[eval-fixtures] ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
