import { DOMParser } from '@xmldom/xmldom';
import type {
  EventLogDataset,
  EventLogImportOptions,
  EventLogImportMapping,
  EventLogImportPreparation,
  EventLogImportPreview,
  EventLogRecord,
  EventLogTimestampFormat
} from '../types/eventLog';
import type { CaseOutputValue, SimulationLogEntry, SimulationResult } from '../types/simulation';

type CsvRow = Record<string, string>;

type TaskStart = {
  entry: SimulationLogEntry;
  sequence: number;
};

type XmlNode = {
  nodeType: number;
  nodeName: string;
  localName?: string | null;
  textContent?: string | null;
  parentNode?: XmlNode | null;
  childNodes: ArrayLike<XmlNode>;
};

type XmlElement = XmlNode & {
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
};

type XmlDocument = {
  documentElement: XmlElement | null;
};

const DEFAULT_SOURCE_NAME = 'Uploaded event log';
const NOMINAL_ACTIVITY_DURATION_MS = 60_000;

const DEFAULT_IMPORT_OPTIONS: Required<EventLogImportOptions> = {
  timestampFormat: 'auto',
  instantRecordHandling: 'activity'
};

export function eventLogDatasetFromSimulationResult(result: SimulationResult): EventLogDataset {
  const taskStarts = new Map<string, TaskStart[]>();
  const elementTypes = new Map(result.elementMetrics.map((metric) => [metric.elementId, metric.type]));
  const cases = new Map(result.cases.map((caseTrace) => [caseTrace.id, caseTrace]));
  const records: EventLogRecord[] = [];
  const warnings: string[] = [];

  for (const [sequence, entry] of result.log.entries()) {
    const caseId = entry.caseId;
    const elementId = entry.elementId;

    if (caseId === undefined || !elementId) {
      continue;
    }

    if (entry.eventType === 'TASK_START') {
      pushTaskStart(taskStarts, simulationRecordKey(caseId, elementId), { entry, sequence });
      continue;
    }

    if (entry.eventType === 'TASK_COMPLETE') {
      const start = shiftTaskStart(taskStarts, simulationRecordKey(caseId, elementId));
      const startEntry = start?.entry ?? entry;
      const caseTrace = cases.get(caseId);

      records.push({
        caseId: String(caseId),
        activityId: elementId,
        activityName: entry.elementName ?? elementNameFromMetrics(result, elementId) ?? elementId,
        startTime: simulationDate(result, startEntry.time),
        endTime: simulationDate(result, entry.time),
        resource: entry.resourceId,
        resourceInstance: entry.resourceInstanceId,
        variables: normalizeVariables(entry.variables ?? caseTrace?.outputs),
        processId: caseTrace?.processId,
        sequence: start?.sequence ?? sequence
      });
      continue;
    }

    if (entry.eventType === 'TOKEN_ENTER_ELEMENT' && isEventType(elementTypes.get(elementId) ?? '')) {
      const caseTrace = cases.get(caseId);

      records.push({
        caseId: String(caseId),
        activityId: elementId,
        activityName: entry.elementName ?? elementNameFromMetrics(result, elementId) ?? elementId,
        startTime: simulationDate(result, entry.time),
        resource: entry.resourceId,
        resourceInstance: entry.resourceInstanceId,
        variables: normalizeVariables(entry.variables ?? caseTrace?.outputs),
        processId: caseTrace?.processId,
        sequence
      });
    }
  }

  const orphanedStarts = [...taskStarts.values()].reduce((count, entries) => count + entries.length, 0);

  if (orphanedStarts) {
    warnings.push(`${orphanedStarts} task start events had no matching completion and were omitted.`);
  }

  return {
    sourceName: result.processName || 'Simulation result',
    sourceKind: 'simulation',
    importedAt: new Date(),
    records: sortRecords(records),
    warnings
  };
}

export function parseEventLogText(
  text: string,
  sourceName = DEFAULT_SOURCE_NAME,
  options: EventLogImportOptions = {}
): EventLogDataset {
  const preparation = prepareEventLogImport(text, sourceName);

  if (preparation.kind === 'dataset') {
    return preparation.dataset;
  }

  return eventLogDatasetFromImportPreview(preparation.preview, preparation.preview.suggestedMapping, options);
}

export function prepareEventLogImport(
  text: string,
  sourceName = DEFAULT_SOURCE_NAME
): EventLogImportPreparation {
  const trimmed = text.trim();

  if (!trimmed) {
    return {
      kind: 'dataset',
      dataset: {
        sourceName,
        sourceKind: 'upload',
        importedAt: new Date(),
        records: [],
        warnings: ['The uploaded event log is empty.']
      }
    };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return prepareJsonEventLog(trimmed, sourceName);
  }

  if (looksLikeXml(trimmed)) {
    return {
      kind: 'dataset',
      dataset: parseXmlEventLog(trimmed, sourceName)
    };
  }

  return prepareCsvEventLog(trimmed, sourceName);
}

export function eventLogDatasetFromImportPreview(
  preview: EventLogImportPreview,
  mapping: EventLogImportMapping,
  options: EventLogImportOptions = {}
): EventLogDataset {
  const warnings: string[] = [];
  const importOptions = normalizeImportOptions(options);
  const records = mapping.lifecycleTransition
    ? normalizeMappedLifecycleRows(preview.rows, mapping, warnings, importOptions)
    : preview.rows.flatMap((row, index) => {
        const record = normalizeMappedRow(row, mapping, index, warnings, importOptions);

        return record ? [record] : [];
      });

  return {
    sourceName: preview.sourceName,
    sourceKind: 'upload',
    importedAt: new Date(),
    records: sortRecords(records),
    warnings: [...preview.warnings, ...warnings]
  };
}

function prepareJsonEventLog(text: string, sourceName: string): EventLogImportPreparation {
  const warnings: string[] = [];

  try {
    const parsed = JSON.parse(text) as unknown;

    if (isSimulationResultLike(parsed)) {
      const dataset = eventLogDatasetFromSimulationResult(parsed);

      return {
        kind: 'dataset',
        dataset: {
          ...dataset,
          sourceName,
          sourceKind: 'upload',
          warnings: [...dataset.warnings, 'Imported a full SimulationResult JSON and extracted its event log.']
        }
      };
    }

    const rows = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.records)
        ? parsed.records
        : undefined;

    if (!rows) {
      return {
        kind: 'dataset',
        dataset: {
          sourceName,
          sourceKind: 'upload',
          importedAt: new Date(),
          records: [],
          warnings: ['JSON event logs must be an array, a { records: [...] } object, or a SimulationResult JSON export.']
        }
      };
    }

    const flatRows = rows.flatMap((row, index) => {
      if (!isRecord(row)) {
        warnings.push(`JSON row ${index + 1} is not an object and was skipped.`);
        return [];
      }

      return [flattenRecord(row)];
    });
    const fields = collectFields(flatRows);

    return {
      kind: 'mapped',
      preview: {
        sourceName,
        sourceFormat: 'json',
        fields,
        rows: flatRows,
        suggestedMapping: suggestMapping(fields),
        warnings
      }
    };
  } catch (error) {
    return {
      kind: 'dataset',
      dataset: {
        sourceName,
        sourceKind: 'upload',
        importedAt: new Date(),
        records: [],
        warnings: [`JSON event log could not be parsed: ${error instanceof Error ? error.message : String(error)}`]
      }
    };
  }
}

function prepareCsvEventLog(text: string, sourceName: string): EventLogImportPreparation {
  const delimiter = detectDelimiter(text);
  const table = parseDelimitedText(text, delimiter);
  const warnings: string[] = [];

  if (table.length < 2) {
    return {
      kind: 'dataset',
      dataset: {
        sourceName,
        sourceKind: 'upload',
        importedAt: new Date(),
        records: [],
        warnings: ['CSV event logs need a header row and at least one data row.']
      }
    };
  }

  const fields = table[0].map((cell, index) => cell.trim() || `Column ${index + 1}`);
  const rows: Array<Record<string, unknown>> = [];

  for (let rowIndex = 1; rowIndex < table.length; rowIndex += 1) {
    const values = table[rowIndex];

    if (values.every((cell) => !cell.trim())) {
      continue;
    }

    const row: Record<string, unknown> = {};

    for (let index = 0; index < fields.length; index += 1) {
      row[fields[index]] = values[index] ?? '';
    }

    rows.push(row);
  }

  return {
    kind: 'mapped',
    preview: {
      sourceName,
      sourceFormat: 'csv',
      fields,
      rows,
      suggestedMapping: suggestMapping(fields),
      warnings
    }
  };
}

function normalizeObjectRow(
  row: Record<string, unknown>,
  index: number,
  warnings: string[]
): EventLogRecord | undefined {
  const caseId = stringValue(firstDefined(row, ['caseId', 'CaseID', 'case', 'case:concept:name']));
  const activityName = stringValue(firstDefined(row, [
    'activityName',
    'activity',
    'TaskName / Event Name',
    'taskName',
    'eventName',
    'concept:name'
  ]));
  const activityId = stringValue(firstDefined(row, [
    'activityId',
    'elementId',
    'TaskID / EventID',
    'taskId',
    'eventId'
  ])) || activityName;
  const start = firstDefined(row, ['startTime', 'Startzeit', 'start', 'time:timestamp', 'timestamp']);
  const end = firstDefined(row, ['endTime', 'Endzeit', 'completeTime', 'end']);
  const startTime = parseDateLike(start);
  const endTime = parseDateLike(end);

  if (!caseId || !activityName || !startTime) {
    warnings.push(`JSON row ${index + 1} was skipped because CaseID, activity name or start time is missing.`);
    return undefined;
  }

  return {
    caseId,
    activityId: activityId || activityName,
    activityName,
    startTime,
    endTime,
    resource: stringValue(firstDefined(row, ['resource', 'Resource', 'org:resource'])),
    resourceInstance: stringValue(firstDefined(row, ['resourceInstance', 'ResourceInstance', 'org:resource'])),
    variables: parseVariables(firstDefined(row, ['variables', 'Variables'])),
    processId: stringValue(firstDefined(row, ['processId', 'process'])),
    sequence: index
  };
}

function normalizeCsvRow(row: CsvRow, rowIndex: number, warnings: string[]): EventLogRecord | undefined {
  const caseId = firstCsvValue(row, ['caseid', 'case_id', 'case', 'caseconceptname']);
  const activityName = firstCsvValue(row, [
    'tasknameeventname',
    'activityname',
    'activity',
    'taskname',
    'eventname',
    'conceptname'
  ]);
  const activityId = firstCsvValue(row, [
    'taskideventid',
    'activityid',
    'elementid',
    'taskid',
    'eventid'
  ]) || activityName;
  const startTime = parseDateLike(firstCsvValue(row, [
    'startzeit',
    'starttime',
    'start',
    'timetimestamp',
    'timestamp'
  ]));
  const endTime = parseDateLike(firstCsvValue(row, [
    'endzeit',
    'endtime',
    'complete_time',
    'completetime',
    'end'
  ]));

  if (!caseId || !activityName || !startTime) {
    warnings.push(`CSV row ${rowIndex + 1} was skipped because CaseID, activity name or start time is missing.`);
    return undefined;
  }

  return {
    caseId,
    activityId: activityId || activityName,
    activityName,
    startTime,
    endTime,
    resource: firstCsvValue(row, ['resource', 'orgresource']),
    resourceInstance: firstCsvValue(row, ['resourceinstance', 'resource_instance', 'orgresource']),
    variables: parseVariables(firstCsvValue(row, ['variables'])),
    processId: firstCsvValue(row, ['processid', 'process']),
    sequence: rowIndex
  };
}

function normalizeMappedRow(
  row: Record<string, unknown>,
  mapping: EventLogImportMapping,
  index: number,
  warnings: string[],
  options: Required<EventLogImportOptions>
): EventLogRecord | undefined {
  const caseId = stringValue(mappedValue(row, mapping.caseId));
  const activityName = stringValue(mappedValue(row, mapping.activityName));
  const activityId = stringValue(mappedValue(row, mapping.activityId)) || activityName;
  const startTime = parseDateLike(mappedValue(row, mapping.startTime), options.timestampFormat);
  const endTime = parseDateLike(mappedValue(row, mapping.endTime), options.timestampFormat);

  if (!caseId || !activityName || !startTime) {
    warnings.push(`Mapped row ${index + 1} was skipped because Case ID, activity name or start time is missing.`);
    return undefined;
  }

  return normalizeImportedRecord({
    caseId,
    activityId: activityId || activityName,
    activityName,
    startTime,
    endTime,
    resource: stringValue(mappedValue(row, mapping.resource)),
    resourceInstance: stringValue(mappedValue(row, mapping.resource)),
    variables: parseVariables(mappedValue(row, mapping.variables)),
    processId: stringValue(mappedValue(row, mapping.processId)),
    sequence: index
  }, options);
}

type MappedLifecycleRow = {
  record: EventLogRecord;
  transition: 'start' | 'complete' | 'other';
};

function normalizeMappedLifecycleRows(
  rows: Array<Record<string, unknown>>,
  mapping: EventLogImportMapping,
  warnings: string[],
  options: Required<EventLogImportOptions>
): EventLogRecord[] {
  const records: EventLogRecord[] = [];
  const pendingStarts = new Map<string, MappedLifecycleRow[]>();

  for (const [index, row] of rows.entries()) {
    const parsed = normalizeMappedLifecycleRow(row, mapping, index, warnings, options);

    if (!parsed) {
      continue;
    }

    if (parsed.transition === 'start') {
      const key = lifecyclePairKey(parsed.record);
      const queue = pendingStarts.get(key) ?? [];

      queue.push(parsed);
      pendingStarts.set(key, queue);
      continue;
    }

    if (parsed.transition === 'complete') {
      const key = lifecyclePairKey(parsed.record);
      const start = pendingStarts.get(key)?.shift();

      if (start) {
        records.push(normalizeImportedRecord({
          ...start.record,
          endTime: parsed.record.startTime,
          resource: parsed.record.resource ?? start.record.resource,
          resourceInstance: parsed.record.resourceInstance ?? start.record.resourceInstance,
          processId: parsed.record.processId ?? start.record.processId,
          variables: {
            ...(start.record.variables ?? {}),
            ...(parsed.record.variables ?? {})
          }
        }, options));
        continue;
      }

      warnings.push(
        `Mapped row ${index + 1} is a complete lifecycle event without a matching start and was imported as a single record.`
      );
    }

    records.push(normalizeImportedRecord(parsed.record, options));
  }

  for (const entries of pendingStarts.values()) {
    for (const entry of entries) {
      warnings.push(
        `Start lifecycle event for "${entry.record.activityName}" in case "${entry.record.caseId}" has no matching complete event and was imported as a single record.`
      );
      records.push(normalizeImportedRecord(entry.record, options));
    }
  }

  return records;
}

function normalizeMappedLifecycleRow(
  row: Record<string, unknown>,
  mapping: EventLogImportMapping,
  index: number,
  warnings: string[],
  options: Required<EventLogImportOptions>
): MappedLifecycleRow | undefined {
  const record = normalizeMappedRow(row, mapping, index, warnings, {
    ...options,
    instantRecordHandling: 'event'
  });

  if (!record) {
    return undefined;
  }

  const rawTransition = stringValue(mappedValue(row, mapping.lifecycleTransition));

  return {
    record,
    transition: normalizeLifecycleTransition(rawTransition?.toLowerCase())
  };
}

function lifecyclePairKey(record: EventLogRecord): string {
  return [
    record.caseId,
    record.activityId || record.activityName,
    record.resource ?? ''
  ].join('\u0000');
}

function mappedValue(row: Record<string, unknown>, field: string | undefined): unknown {
  if (!field) {
    return undefined;
  }

  return row[field];
}

function normalizeImportOptions(options: EventLogImportOptions): Required<EventLogImportOptions> {
  return {
    timestampFormat: options.timestampFormat ?? DEFAULT_IMPORT_OPTIONS.timestampFormat,
    instantRecordHandling: options.instantRecordHandling ?? DEFAULT_IMPORT_OPTIONS.instantRecordHandling
  };
}

function normalizeImportedRecord(
  record: EventLogRecord,
  options: Required<EventLogImportOptions>
): EventLogRecord {
  if (options.instantRecordHandling !== 'activity') {
    return record;
  }

  if (!record.endTime || record.endTime.getTime() === record.startTime.getTime()) {
    return {
      ...record,
      endTime: new Date(record.startTime.getTime() + NOMINAL_ACTIVITY_DURATION_MS)
    };
  }

  return record;
}

function flattenRecord(row: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isRecord(value)) {
      Object.assign(flat, flattenRecord(value, path));
      continue;
    }

    flat[path] = value;
  }

  return flat;
}

function collectFields(rows: Array<Record<string, unknown>>): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))];
}

function suggestMapping(fields: string[]): EventLogImportMapping {
  return {
    caseId: findField(fields, ['caseid', 'case_id', 'case', 'caseconceptname', 'caseconceptname']),
    activityId: findField(fields, ['taskideventid', 'activityid', 'elementid', 'taskid', 'eventid']),
    activityName: findField(fields, [
      'tasknameeventname',
      'activityname',
      'activity',
      'taskname',
      'eventname',
      'conceptname',
      'workflowmodelelement'
    ]),
    startTime: findField(fields, ['startzeit', 'starttime', 'start', 'timetimestamp', 'timestamp']),
    endTime: findField(fields, ['endzeit', 'endtime', 'complete_time', 'completetime', 'end']),
    lifecycleTransition: findField(fields, ['lifecycletransition', 'transition', 'eventtype']),
    resource: findField(fields, ['resource', 'orgresource', 'originator']),
    processId: findField(fields, ['processid', 'process']),
    variables: findField(fields, ['variables', 'data', 'attributes'])
  };
}

function findField(fields: string[], candidates: string[]): string | undefined {
  const normalizedCandidates = new Set(candidates.map(normalizeColumnName));

  return fields.find((field) => normalizedCandidates.has(normalizeColumnName(field)));
}

function looksLikeXml(text: string): boolean {
  return text.startsWith('<');
}

function parseXmlEventLog(text: string, sourceName: string): EventLogDataset {
  const document = new DOMParser().parseFromString(text, 'text/xml') as unknown as XmlDocument;
  const root = document.documentElement;

  if (!root) {
    return emptyXmlDataset(sourceName, 'XML event log could not be parsed.');
  }

  if (root.getElementsByTagName('parsererror').length) {
    return emptyXmlDataset(sourceName, 'XML event log contains parser errors.');
  }

  const rootName = localName(root).toLowerCase();

  if (rootName === 'log') {
    return parseXesLog(document, sourceName);
  }

  if (rootName === 'workflowlog' || rootName === 'process') {
    return parseMxmlLog(document, sourceName);
  }

  return emptyXmlDataset(sourceName, `Unsupported XML event log root element "${root.nodeName}".`);
}

function parseXesLog(document: XmlDocument, sourceName: string): EventLogDataset {
  const warnings: string[] = [];
  const records: EventLogRecord[] = [];
  let sequence = 0;
  const root = document.documentElement;

  if (!root) {
    return emptyXmlDataset(sourceName, 'XES log has no document element.');
  }

  for (const trace of elementChildren(root, 'trace')) {
    const caseId = xesAttributeValue(trace, 'concept:name') ?? `Trace_${records.length + 1}`;
    const processId = xesAttributeValue(trace, 'process:id') ?? xesAttributeValue(trace, 'process');
    const pending = new Map<string, ParsedXmlEvent[]>();

    for (const event of elementChildren(trace, 'event')) {
      const parsed = parsedXesEvent(event, caseId, processId, sequence);

      sequence += 1;

      if (!parsed.activityName || !parsed.timestamp) {
        warnings.push(`XES event ${sequence} was skipped because concept:name or time:timestamp is missing.`);
        continue;
      }

      appendLifecycleRecord(records, pending, parsed);
    }

    flushPendingStarts(records, pending, warnings);
  }

  return {
    sourceName,
    sourceKind: 'upload',
    importedAt: new Date(),
    records: sortRecords(records),
    warnings
  };
}

function parseMxmlLog(document: XmlDocument, sourceName: string): EventLogDataset {
  const warnings: string[] = [];
  const records: EventLogRecord[] = [];
  let sequence = 0;
  const root = document.documentElement;

  if (!root) {
    return emptyXmlDataset(sourceName, 'MXML log has no document element.');
  }

  for (const instance of elementsByLocalName(root, 'ProcessInstance')) {
    const caseId = instance.getAttribute('id') ?? instance.getAttribute('name') ?? `Instance_${records.length + 1}`;
    const process = nearestAncestorAttribute(instance, 'Process', 'id');
    const pending = new Map<string, ParsedXmlEvent[]>();

    for (const entry of elementChildren(instance, 'AuditTrailEntry')) {
      const parsed = parsedMxmlEvent(entry, caseId, process, sequence);

      sequence += 1;

      if (!parsed.activityName || !parsed.timestamp) {
        warnings.push(`MXML AuditTrailEntry ${sequence} was skipped because WorkflowModelElement or Timestamp is missing.`);
        continue;
      }

      appendLifecycleRecord(records, pending, parsed);
    }

    flushPendingStarts(records, pending, warnings);
  }

  return {
    sourceName,
    sourceKind: 'upload',
    importedAt: new Date(),
    records: sortRecords(records),
    warnings
  };
}

type ParsedXmlEvent = {
  caseId: string;
  activityId: string;
  activityName: string;
  timestamp: Date | undefined;
  transition?: string;
  resource?: string;
  processId?: string;
  variables?: Record<string, unknown>;
  sequence: number;
};

function parsedXesEvent(
  event: XmlElement,
  caseId: string,
  processId: string | undefined,
  sequence: number
): ParsedXmlEvent {
  const attributes = xesAttributes(event);
  const activityName = stringValue(attributes['concept:name']);
  const transition = stringValue(attributes['lifecycle:transition'])?.toLowerCase();

  return {
    caseId,
    activityId: stringValue(attributes['activity:id']) ?? activityName ?? '',
    activityName: activityName ?? '',
    timestamp: parseDateLike(attributes['time:timestamp']),
    transition,
    resource: stringValue(attributes['org:resource']),
    processId,
    variables: knownVariableSubset(attributes, [
      'activity:id',
      'concept:name',
      'lifecycle:transition',
      'org:resource',
      'time:timestamp'
    ]),
    sequence
  };
}

function parsedMxmlEvent(
  entry: XmlElement,
  caseId: string,
  processId: string | undefined,
  sequence: number
): ParsedXmlEvent {
  const activityName = childText(entry, 'WorkflowModelElement');
  const transition = childText(entry, 'EventType')?.toLowerCase();
  const variables = mxmlDataAttributes(entry);

  return {
    caseId,
    activityId: activityName ?? '',
    activityName: activityName ?? '',
    timestamp: parseDateLike(childText(entry, 'Timestamp')),
    transition,
    resource: childText(entry, 'Originator'),
    processId,
    variables: Object.keys(variables).length ? variables : undefined,
    sequence
  };
}

function appendLifecycleRecord(
  records: EventLogRecord[],
  pending: Map<string, ParsedXmlEvent[]>,
  event: ParsedXmlEvent
): void {
  const transition = normalizeLifecycleTransition(event.transition);
  const key = `${event.activityId}:${event.resource ?? ''}`;

  if (transition === 'start') {
    const entries = pending.get(key) ?? [];

    entries.push(event);
    pending.set(key, entries);
    return;
  }

  if (transition === 'complete') {
    const start = pending.get(key)?.shift();

    records.push(xmlRecordFromEvent(event, start));
    return;
  }

  records.push(xmlRecordFromEvent(event));
}

function xmlRecordFromEvent(event: ParsedXmlEvent, start?: ParsedXmlEvent): EventLogRecord {
  return {
    caseId: event.caseId,
    activityId: event.activityId || event.activityName,
    activityName: event.activityName || event.activityId,
    startTime: start?.timestamp ?? event.timestamp ?? new Date(0),
    endTime: start ? event.timestamp : undefined,
    resource: event.resource ?? start?.resource,
    resourceInstance: event.resource ?? start?.resource,
    variables: {
      ...(start?.variables ?? {}),
      ...(event.variables ?? {})
    },
    processId: event.processId ?? start?.processId,
    sequence: start?.sequence ?? event.sequence
  };
}

function flushPendingStarts(
  records: EventLogRecord[],
  pending: Map<string, ParsedXmlEvent[]>,
  warnings: string[]
): void {
  for (const entries of pending.values()) {
    for (const entry of entries) {
      warnings.push(`Start event for "${entry.activityName}" has no matching complete event and was imported as instant event.`);
      records.push(xmlRecordFromEvent(entry));
    }
  }
}

function normalizeLifecycleTransition(value: string | undefined): 'start' | 'complete' | 'other' {
  if (value === 'start' || value === 'assign' || value === 'resume') {
    return 'start';
  }

  if (value === 'complete' || value === 'completed' || value === 'ate_complete') {
    return 'complete';
  }

  return 'other';
}

function xesAttributes(element: XmlElement): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  for (const child of elementChildren(element)) {
    const key = child.getAttribute('key');

    if (!key) {
      continue;
    }

    attributes[key] = child.getAttribute('value') ?? child.textContent ?? '';
  }

  return attributes;
}

function xesAttributeValue(element: XmlElement, key: string): string | undefined {
  return stringValue(xesAttributes(element)[key]);
}

function knownVariableSubset(
  attributes: Record<string, unknown>,
  ignoredKeys: string[]
): Record<string, unknown> | undefined {
  const ignored = new Set(ignoredKeys);
  const variables: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!ignored.has(key)) {
      variables[key] = value;
    }
  }

  return Object.keys(variables).length ? variables : undefined;
}

function mxmlDataAttributes(entry: XmlElement): Record<string, unknown> {
  const variables: Record<string, unknown> = {};

  for (const data of elementChildren(entry, 'Data')) {
    for (const attribute of elementChildren(data, 'Attribute')) {
      const name = attribute.getAttribute('name');

      if (name) {
        variables[name] = attribute.textContent ?? '';
      }
    }
  }

  return variables;
}

function elementChildren(element: XmlElement | XmlDocument, expectedLocalName?: string): XmlElement[] {
  const childNodes = 'childNodes' in element ? element.childNodes : element.documentElement?.childNodes ?? [];
  const children = Array.from(childNodes).filter((child): child is XmlElement => child.nodeType === 1);

  if (!expectedLocalName) {
    return children;
  }

  return children.filter((child) => localName(child) === expectedLocalName);
}

function elementsByLocalName(element: XmlElement, expectedLocalName: string): XmlElement[] {
  const matches: XmlElement[] = [];
  const visit = (current: XmlElement): void => {
    if (localName(current) === expectedLocalName) {
      matches.push(current);
    }

    for (const child of elementChildren(current)) {
      visit(child);
    }
  };

  visit(element);

  return matches;
}

function childText(element: XmlElement, expectedLocalName: string): string | undefined {
  const child = elementChildren(element, expectedLocalName)[0];
  const text = child?.textContent?.trim();

  return text || undefined;
}

function nearestAncestorAttribute(element: XmlElement, ancestorName: string, attributeName: string): string | undefined {
  let current = element.parentNode;

  while (current && current.nodeType === 1) {
    const currentElement = current as XmlElement;

    if (localName(currentElement) === ancestorName) {
      return currentElement.getAttribute(attributeName) ?? undefined;
    }

    current = current.parentNode;
  }

  return undefined;
}

function localName(element: XmlElement): string {
  return element.localName || element.nodeName.split(':').pop() || element.nodeName;
}

function emptyXmlDataset(sourceName: string, warning: string): EventLogDataset {
  return {
    sourceName,
    sourceKind: 'upload',
    importedAt: new Date(),
    records: [],
    warnings: [warning]
  };
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [';', ',', '\t'];

  return candidates
    .map((delimiter) => ({
      delimiter,
      count: countDelimiter(firstLine, delimiter)
    }))
    .sort((left, right) => right.count - left.count)[0]?.delimiter ?? ';';
}

function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (!quoted && char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);

  return rows;
}

function countDelimiter(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (!quoted && char === delimiter) {
      count += 1;
    }
  }

  return count;
}

function normalizeColumnName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

function firstCsvValue(row: CsvRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];

    if (value !== undefined && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function firstDefined(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }

  return undefined;
}

function parseDateLike(
  value: unknown,
  format: EventLogTimestampFormat = 'auto'
): Date | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (format === 'epochSeconds') {
      return new Date(value * 1000);
    }

    return new Date(value);
  }

  const text = String(value).trim();

  if (!text) {
    return undefined;
  }

  const explicit = parseDateWithFormat(text, format);

  if (explicit) {
    return explicit;
  }

  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const direct = new Date(normalized);

  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const european = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);

  if (european) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = european;
    const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year);
    const date = new Date(
      fullYear,
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );

    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  return undefined;
}

function parseDateWithFormat(text: string, format: EventLogTimestampFormat): Date | undefined {
  if (format === 'auto') {
    return parseCompactTimestamp(text) ??
      parseTimestampWithOffset(text) ??
      parseSlashTimestamp(text);
  }

  if (format === 'epochMillis' || format === 'epochSeconds') {
    const numeric = Number(text);

    if (!Number.isFinite(numeric)) {
      return undefined;
    }

    return new Date(format === 'epochSeconds' ? numeric * 1000 : numeric);
  }

  if (format === 'yyyyMMddTHHmm') {
    return parseCompactTimestamp(text);
  }

  if (format === 'yyyy-MM-dd HH:mm:ss.SSSSSSXXX') {
    return parseTimestampWithOffset(text);
  }

  if (format === 'iso') {
    const date = new Date(text.includes('T') ? text : text.replace(' ', 'T'));

    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  if (format === 'yyyy-MM-dd HH:mm:ss') {
    return parseYearFirstTimestamp(text);
  }

  if (format === 'dd.MM.yyyy HH:mm:ss') {
    return parseDayFirstTimestamp(text, '.');
  }

  if (format === 'dd/MM/yyyy HH:mm:ss') {
    return parseDayFirstTimestamp(text, '/');
  }

  if (format === 'MM/dd/yyyy HH:mm:ss') {
    return parseMonthFirstTimestamp(text);
  }

  return undefined;
}

function parseCompactTimestamp(text: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(?:(\d{2}))?$/.exec(text);

  if (!match) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second = '0'] = match;

  return validLocalDate(
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function parseYearFirstTimestamp(text: string): Date | undefined {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(text);

  if (!match) {
    return undefined;
  }

  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;

  return validLocalDate(
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function parseTimestampWithOffset(text: string): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-]\d{2}:?\d{2}|Z)?$/.exec(text);

  if (!match) {
    return undefined;
  }

  const [, date, time, fraction = '', offset = ''] = match;
  const milliseconds = fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : '';
  const normalizedOffset = offset && offset !== 'Z' && !offset.includes(':')
    ? `${offset.slice(0, 3)}:${offset.slice(3)}`
    : offset;
  const parsed = new Date(`${date}T${time}${milliseconds}${normalizedOffset}`);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseSlashTimestamp(text: string): Date | undefined {
  return parseDayFirstTimestamp(text, '/') ?? parseMonthFirstTimestamp(text);
}

function parseDayFirstTimestamp(text: string, separator: '.' | '/'): Date | undefined {
  const escaped = separator === '.' ? '\\.' : '/';
  const match = new RegExp(`^(\\d{1,2})${escaped}(\\d{1,2})${escaped}(\\d{2,4})(?:[,\\s]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?$`).exec(text);

  if (!match) {
    return undefined;
  }

  const [, day, month, year, hour = '0', minute = '0', second = '0'] = match;
  const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year);

  return validLocalDate(
    fullYear,
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function parseMonthFirstTimestamp(text: string): Date | undefined {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);

  if (!match) {
    return undefined;
  }

  const [, month, day, year, hour = '0', minute = '0', second = '0'] = match;
  const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year);

  return validLocalDate(
    fullYear,
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function validLocalDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): Date | undefined {
  const date = new Date(year, month - 1, day, hour, minute, second);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }

  return date;
}

function parseVariables(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (isRecord(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(String(value));

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function simulationDate(result: SimulationResult, time: number | undefined): Date {
  const startDate = parseDateLike(result.options.startDateTime) ?? result.startedAt;
  const startTime = result.options.startTime ?? 0;
  const hours = Math.max(0, (time ?? startTime) - startTime);

  return new Date(startDate.getTime() + hours * 60 * 60 * 1000);
}

function elementNameFromMetrics(result: SimulationResult, elementId: string): string | undefined {
  return result.elementMetrics.find((metric) => metric.elementId === elementId)?.name;
}

function normalizeVariables(
  variables: Record<string, CaseOutputValue> | undefined
): Record<string, unknown> | undefined {
  return variables ? { ...variables } : undefined;
}

function sortRecords(records: EventLogRecord[]): EventLogRecord[] {
  return [...records].sort((left, right) => {
    const timeDifference = left.startTime.getTime() - right.startTime.getTime();

    if (timeDifference) {
      return timeDifference;
    }

    return left.sequence - right.sequence;
  });
}

function pushTaskStart(map: Map<string, TaskStart[]>, key: string, entry: TaskStart): void {
  const entries = map.get(key) ?? [];

  entries.push(entry);
  map.set(key, entries);
}

function shiftTaskStart(map: Map<string, TaskStart[]>, key: string): TaskStart | undefined {
  return map.get(key)?.shift();
}

function simulationRecordKey(caseId: number, elementId: string): string {
  return `${caseId}:${elementId}`;
}

function isEventType(type: string): boolean {
  return /Event$/.test(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSimulationResultLike(value: unknown): value is SimulationResult {
  return isRecord(value) && Array.isArray(value.log) && Array.isArray(value.cases);
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return String(value);
}
