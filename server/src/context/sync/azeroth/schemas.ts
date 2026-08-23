import { z } from 'zod';

import type { AzerothEntity } from './types.js';

const text = z.string().min(1);
const nullableText = z.string().nullable().optional();
const nullableNumber = z.number().finite().nullable().optional();
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'invalid date');
const nullableTimestamp = timestamp.nullable().optional();
const audit = {
  createdAt: nullableTimestamp,
  updatedAt: nullableTimestamp,
  deletedAt: nullableTimestamp,
  version: z.number().int().nonnegative().nullable().optional(),
};
const member = z.object({
  employeeId: nullableText,
  isActive: z.boolean().nullable().optional(),
}).passthrough();

const customer = z.object({
  id: text,
  serialNumber: text,
  customerName: text,
  shortName: nullableText,
  industry: nullableText,
  customerLevel: nullableText,
  customerSource: nullableText,
  customerRelationship: nullableText,
  customerTags: z.array(z.string()).nullable().optional(),
  status: text,
  chargerId: nullableText,
  collaboratorIds: z.array(z.string()).nullable().optional(),
  ...audit,
}).passthrough();

const contact = z.object({
  id: text,
  contactName: text,
  customerId: text,
  customerName: nullableText,
  position: nullableText,
  department: nullableText,
  isKp: z.boolean().nullable().optional(),
  kpRole: nullableText,
  status: text,
  ...audit,
}).passthrough();

const employee = z.object({
  id: text,
  name: text,
  serialNumber: text,
  position: nullableText,
  status: text,
  isAdmin: z.boolean().nullable().optional(),
  isBoss: z.boolean().nullable().optional(),
  isLeader: z.boolean().nullable().optional(),
  dingtalkActive: z.boolean().nullable().optional(),
  departmentName: nullableText,
  ...audit,
}).passthrough();

const opportunity = z.object({
  id: text,
  serialNumber: text,
  opportunityName: text,
  customerId: text,
  customerName: nullableText,
  opportunityStage: nullableText,
  opportunityAmount: nullableNumber,
  winRate: nullableNumber,
  expectedDealDate: nullableTimestamp,
  realDealDate: nullableTimestamp,
  chargerId: nullableText,
  collaboratorIds: z.array(z.string()).nullable().optional(),
  ...audit,
}).passthrough();

const keepRecord = z.object({
  id: text,
  customerId: text,
  contactId: nullableText,
  keepRecordType: nullableText,
  keepRecordTime: nullableTimestamp,
  keepRecordContent: nullableText,
  keepRecordStatus: nullableText,
  chargerId: nullableText,
  source: nullableText,
  sourceActionItemId: nullableText,
  ...audit,
}).passthrough();

const project = z.object({
  id: text,
  name: text,
  description: nullableText,
  status: text,
  logicalStatus: nullableText,
  category: nullableText,
  customerId: nullableText,
  opportunityId: nullableText,
  startDate: nullableTimestamp,
  endDate: nullableTimestamp,
  ownerId: nullableText,
  totalHours: nullableNumber,
  members: z.array(member).nullable().optional(),
  ...audit,
}).passthrough();

const projectTicket = z.object({
  id: text,
  ticketNo: text,
  projectId: text,
  title: text,
  description: text,
  ticketType: text,
  priority: text,
  status: text,
  dispatcherId: text,
  assigneeId: text,
  dueDate: nullableTimestamp,
  startedAt: nullableTimestamp,
  completedAt: nullableTimestamp,
  closedAt: nullableTimestamp,
  cancelledAt: nullableTimestamp,
  completionNote: nullableText,
  closeNote: nullableText,
  cancelReason: nullableText,
  ...audit,
}).passthrough();

const effortRecord = z.object({
  id: text,
  projectId: text,
  projectName: nullableText,
  actualTime: z.union([z.number().finite(), z.string().min(1)]),
  description: nullableText,
  workType: nullableText,
  workDate: nullableTimestamp,
  recordType: nullableText,
  ownerId: nullableText,
  startDate: nullableTimestamp,
  endDate: nullableTimestamp,
  ...audit,
}).passthrough();

const dingtalkLog = z.object({
  reportId: text,
  templateName: nullableText,
  creatorId: nullableText,
  deptName: nullableText,
  contents: nullableText,
  contentsJson: z.array(z.object({ key: text, value: z.string() }).passthrough()).nullable().optional(),
  createTime: nullableTimestamp,
  syncedAt: nullableTimestamp,
  source: z.enum(['dingtalk', 'local']).nullable().optional(),
  isLocallyEdited: z.boolean().nullable().optional(),
  updatedAt: nullableTimestamp,
}).passthrough();

const calendarEvent = z.object({
  eventId: text,
  title: nullableText,
  description: nullableText,
  startTime: nullableTimestamp,
  endTime: nullableTimestamp,
  location: nullableText,
  creator: nullableText,
  attendees: z.array(z.string()).nullable().optional(),
  syncedAt: nullableTimestamp,
}).passthrough();

const salesActionItem = z.object({
  id: text,
  employeeId: text,
  category: text,
  priority: z.number().finite(),
  refType: nullableText,
  refId: nullableText,
  title: text,
  customerName: nullableText,
  reason: text,
  suggestedAction: nullableText,
  confidence: text,
  dedupKey: text,
  status: text,
  resolveNote: nullableText,
  doneType: nullableText,
  snoozeUntil: nullableTimestamp,
  remindCount: z.number().int().nonnegative().nullable().optional(),
  resultType: nullableText,
  resultId: nullableText,
  sourceRunId: nullableText,
  createdVia: nullableText,
  creatorEmployeeId: nullableText,
  updaterEmployeeId: nullableText,
  resolvedAt: nullableTimestamp,
  resolvedById: nullableText,
  customer: z.object({ id: text, customerName: text }).passthrough().nullable().optional(),
  ...audit,
}).passthrough();

const webEvent = z.object({
  id: text,
  receivedAt: timestamp,
  clientTs: nullableTimestamp,
  site: nullableText,
  event: text,
  path: nullableText,
  pageType: nullableText,
  title: nullableText,
  utmSource: nullableText,
  utmMedium: nullableText,
  utmCampaign: nullableText,
  utmTerm: nullableText,
  utmContent: nullableText,
  placement: nullableText,
  channel: nullableText,
  label: nullableText,
  country: nullableText,
  region: nullableText,
  city: nullableText,
  isBot: z.boolean().nullable().optional(),
}).passthrough();

export const azerothEntitySchemas = {
  customers: customer,
  contacts: contact,
  employees: employee,
  opportunities: opportunity,
  'keep-records': keepRecord,
  projects: project,
  'project-tickets': projectTicket,
  'effort-records': effortRecord,
  'dingtalk-logs': dingtalkLog,
  'dingtalk-calendar-events': calendarEvent,
  'sales-action-items': salesActionItem,
  'web-events': webEvent,
} satisfies Record<AzerothEntity, z.ZodType<Record<string, unknown>>>;

export type AzerothRow = z.infer<(typeof azerothEntitySchemas)[AzerothEntity]>;

export interface ParsedAzerothPage {
  items: Record<string, unknown>[];
  hasMore: boolean;
}

/** Validates both the pagination envelope and every typed entity row. */
export function parseAzerothPage(
  entity: AzerothEntity,
  value: unknown,
  page: number,
  pageSize: number,
): ParsedAzerothPage {
  const envelope = extractEnvelope(value);
  const items = envelope.items.map((item, index) => {
    const parsed = azerothEntitySchemas[entity].safeParse(item);
    if (!parsed.success) {
      throw new Error(`Invalid Azeroth ${entity} response row ${index}: ${parsed.error.message}`);
    }
    return parsed.data;
  });
  const pagination = envelope.pagination;
  const hasMore = pagination.hasNext !== undefined
    ? pagination.hasNext
    : pagination.nextPage !== undefined
      ? pagination.nextPage !== null
      : pagination.totalPages !== undefined
        ? page < pagination.totalPages
        : pagination.total !== undefined
          ? page * pageSize < pagination.total
          : items.length === pageSize;
  return { items, hasMore };
}

interface PaginationFacts {
  hasNext?: boolean;
  nextPage?: number | null;
  totalPages?: number;
  total?: number;
}

function extractEnvelope(value: unknown): { items: unknown[]; pagination: PaginationFacts } {
  if (Array.isArray(value)) return { items: value, pagination: {} };
  const root = object(value, 'response');
  let container = root;
  let items: unknown;
  if (Array.isArray(root.items)) items = root.items;
  else if (Array.isArray(root.rows)) items = root.rows;
  else if (Array.isArray(root.list)) items = root.list;
  else if (Array.isArray(root.data)) items = root.data;
  else if (root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data)) {
    container = object(root.data, 'response.data');
    items = container.items ?? container.rows ?? container.list ?? container.data;
  }
  if (!Array.isArray(items)) throw new Error('Invalid Azeroth page response: item array is missing');
  const paginationObject = firstObject(container.pagination, container.meta, root.pagination, root.meta);
  const facts = { ...root, ...container, ...(paginationObject ?? {}) };
  return {
    items,
    pagination: {
      hasNext: optionalBoolean(facts.hasNext, 'hasNext'),
      nextPage: optionalNullableInteger(facts.nextPage, 'nextPage'),
      totalPages: optionalInteger(facts.totalPages ?? facts.pages, 'totalPages'),
      total: optionalInteger(facts.total ?? facts.totalCount, 'total'),
    },
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Azeroth ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function firstObject(...values: unknown[]): Record<string, unknown> | undefined {
  const found = values.find(value => value !== null && typeof value === 'object' && !Array.isArray(value));
  return found as Record<string, unknown> | undefined;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Invalid Azeroth pagination ${label}`);
  return value;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid Azeroth pagination ${label}`);
  return Number(value);
}

function optionalNullableInteger(value: unknown, label: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  return optionalInteger(value, label)!;
}
