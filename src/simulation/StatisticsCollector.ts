import type { SimFlow, SimModel, SimNode } from '../types/bpmn';
import type {
  CaseOutputValue,
  CaseTrace,
  ElementMetrics,
  FlowMetrics,
  ResourceMetrics,
  SimulationConfig,
  SimulationEventType,
  SimulationLogEntry,
  SimulationResult
} from '../types/simulation';

export class StatisticsCollector {
  private readonly elementMetrics = new Map<string, ElementMetrics>();
  private readonly resourceMetrics = new Map<string, ResourceMetrics>();
  private readonly waitTimeSamples = new Map<string, number[]>();
  private readonly flowMetrics = new Map<string, FlowMetrics>();
  private readonly logEntries: SimulationLogEntry[] = [];

  recordVisit(node: SimNode): void {
    this.getElementMetrics(node).visits += 1;
  }

  recordService(node: SimNode, waitTime: number, serviceTime: number): void {
    const metrics = this.getElementMetrics(node);
    const wait = Math.max(0, waitTime);
    const service = Math.max(0, serviceTime);

    metrics.waitTime += wait;
    metrics.waitTimeSamples?.push(wait);
    this.recordWaitTimeSample(node.id, wait);
    metrics.serviceTime += service;
    metrics.serviceTimeSamples?.push(service);

    const resource = this.getResourceMetrics(node);

    if (resource) {
      resource.taskCount += 1;
      resource.waitTime += wait;
      resource.waitTimeSamples?.push(wait);
      resource.serviceTime += service;
      resource.serviceTimeSamples?.push(service);
    }
  }

  recordCompletion(node: SimNode): void {
    this.getElementMetrics(node).completions += 1;
  }

  recordError(node: SimNode): void {
    this.getElementMetrics(node).errors += 1;

    const resource = this.getResourceMetrics(node);

    if (resource) {
      resource.errors += 1;
    }
  }

  recordRetry(node: SimNode): void {
    this.getElementMetrics(node).retries += 1;
  }

  recordFlow(flow: SimFlow): void {
    const metrics = this.flowMetrics.get(flow.id) ?? {
      flowId: flow.id,
      name: flow.name,
      sourceId: flow.sourceId,
      targetId: flow.targetId,
      count: 0
    };

    metrics.count += 1;
    this.flowMetrics.set(flow.id, metrics);
  }

  info(message: string, elementId?: string, time?: number): void {
    this.log('info', message, elementId, time);
  }

  warn(message: string, elementId?: string, time?: number): void {
    this.log('warning', message, elementId, time);
  }

  error(message: string, elementId?: string, time?: number): void {
    this.log('error', message, elementId, time);
  }

  event(
    eventType: SimulationEventType,
    message: string,
    options: {
      elementId?: string;
      elementName?: string;
      caseId?: number;
      time?: number;
      level?: SimulationLogEntry['level'];
      resourceId?: string;
      variables?: Record<string, CaseOutputValue>;
    } = {}
  ): SimulationLogEntry {
    const entry = {
      level: options.level ?? 'info',
      eventType,
      caseId: options.caseId,
      message,
      elementId: options.elementId,
      elementName: options.elementName,
      resourceId: options.resourceId,
      variables: cloneVariables(options.variables),
      time: options.time
    };

    this.logEntries.push({
      ...entry
    });

    return entry;
  }

  updateLastEventVariables(
    caseId: number,
    elementId: string,
    eventType: SimulationEventType,
    variables: Record<string, CaseOutputValue> | undefined
  ): void {
    for (let index = this.logEntries.length - 1; index >= 0; index -= 1) {
      const entry = this.logEntries[index];

      if (entry.caseId === caseId && entry.elementId === elementId && entry.eventType === eventType) {
        entry.variables = cloneVariables(variables);
        return;
      }
    }
  }

  buildResult(
    model: SimModel,
    options: SimulationConfig,
    startedAt: Date,
    completedAt: Date,
    cases: CaseTrace[],
    currentTime: number
  ): SimulationResult {
    for (const caseTrace of cases) {
      if (caseTrace.status === 'running') {
        this.warn(`Case ${caseTrace.id} ist am Simulationsende noch aktiv.`);
      }
    }

    const finishedCycleTimes = cases
      .filter((caseTrace) => caseTrace.status !== 'running')
      .map((caseTrace) => caseTrace.cycleTime)
      .sort((a, b) => a - b);
    const completedCases = cases.filter((caseTrace) => caseTrace.status === 'completed').length;
    const failedCases = cases.filter((caseTrace) => caseTrace.status === 'failed').length;
    const deadlockSuspicions = cases.filter((caseTrace) => caseTrace.status === 'running').length;
    const unconsumedTokens = cases.reduce((sum, caseTrace) => sum + caseTrace.activeTokens, 0);
    const maxTime = Math.max(...cases.map((caseTrace) => caseTrace.endTime), currentTime, 0);
    const elapsedTime = Math.max(0, maxTime - (options.startTime ?? 0));
    const warnings = this.logEntries
      .filter((entry) => entry.level === 'warning')
      .map((entry) => entry.message);
    const elementMetrics = [...this.elementMetrics.values()]
      .map((metric) => ({
        ...metric,
        waitTimeStddev: standardDeviation(this.waitTimeSamples.get(metric.elementId) ?? [])
      }))
      .sort((a, b) => b.visits - a.visits);
    const resourceNames = new Map([...model.resources.values()].map((resource) => [resource.id, resource.name || resource.id]));
    const resourceMetrics = [...this.resourceMetrics.values()]
      .map((metric) => ({
        ...metric,
        name: resourceNames.get(metric.resourceId) ?? metric.name
      }))
      .sort((a, b) => b.taskCount - a.taskCount);
    const flowMetrics = [...this.flowMetrics.values()].sort((a, b) => b.count - a.count);
    const pathProbabilities = calculatePathProbabilities(flowMetrics);
    const activityUtilization = elementMetrics.map((metric) => {
      return {
        elementId: metric.elementId,
        name: metric.name,
        utilization: elapsedTime > 0 ? (metric.serviceTime / 60) / elapsedTime : 0,
        averageWaitTime: metric.visits ? metric.waitTime / metric.visits : 0,
        averageServiceTime: metric.completions ? metric.serviceTime / metric.completions : 0,
        tokenCount: metric.visits
      };
    });

    const baseResult = {
      startedAt,
      completedAt,
      currentTime,
      options,
      processName: model.name,
      cases,
      completedCases,
      failedCases,
      cycleTimeAverage: average(finishedCycleTimes),
      cycleTimeP50: percentile(finishedCycleTimes, 0.5),
      cycleTimeP90: percentile(finishedCycleTimes, 0.9),
      cycleTimeMax: finishedCycleTimes[finishedCycleTimes.length - 1] ?? 0,
      throughputPerTimeUnit: elapsedTime > 0 ? completedCases / elapsedTime : completedCases,
      elementMetrics,
      resourceMetrics,
      flowMetrics,
      log: this.logEntries,
      warnings,
      unsupportedElementIds: model.unsupportedElementIds,
      activityUtilization,
      pathProbabilities,
      deadlockSuspicions,
      unconsumedTokens
    };

    return {
      ...baseResult,
      exports: {
        json: JSON.stringify(baseResult, null, 2),
        csv: createSimulationResultsCsv(baseResult),
        simulationResultsCsv: createSimulationResultsCsv(baseResult),
        eventLogCsv: createEventLogCsv(baseResult)
      }
    };
  }

  private getElementMetrics(node: SimNode): ElementMetrics {
    const existing = this.elementMetrics.get(node.id);

    if (existing) {
      return existing;
    }

    const metrics = {
      elementId: node.id,
      name: node.name,
      type: node.type,
      visits: 0,
      completions: 0,
      errors: 0,
      retries: 0,
      waitTime: 0,
      waitTimeStddev: 0,
      waitTimeSamples: [],
      serviceTime: 0,
      serviceTimeSamples: [],
      unsupported: !node.supported
    };

    this.elementMetrics.set(node.id, metrics);

    return metrics;
  }

  private getResourceMetrics(node: SimNode): ResourceMetrics | undefined {
    const resourceId = node.params.resource?.resourceId?.trim();

    if (!resourceId) {
      return undefined;
    }

    const existing = this.resourceMetrics.get(resourceId);

    if (existing) {
      return existing;
    }

    const metrics = {
      resourceId,
      name: resourceId,
      taskCount: 0,
      errors: 0,
      waitTime: 0,
      waitTimeSamples: [],
      serviceTime: 0,
      serviceTimeSamples: []
    };

    this.resourceMetrics.set(resourceId, metrics);

    return metrics;
  }

  private log(level: SimulationLogEntry['level'], message: string, elementId?: string, time?: number): void {
    this.logEntries.push({
      level,
      message,
      elementId,
      time
    });
  }

  private recordWaitTimeSample(elementId: string, waitTime: number): void {
    const samples = this.waitTimeSamples.get(elementId) ?? [];

    samples.push(waitTime);
    this.waitTimeSamples.set(elementId, samples);
  }
}

type ExportBase = Omit<SimulationResult, 'exports'>;

function calculatePathProbabilities(flowMetrics: FlowMetrics[]) {
  const totalsBySource = new Map<string, number>();

  for (const metric of flowMetrics) {
    totalsBySource.set(metric.sourceId, (totalsBySource.get(metric.sourceId) ?? 0) + metric.count);
  }

  return flowMetrics.map((metric) => {
    const total = totalsBySource.get(metric.sourceId) ?? 0;

    return {
      flowId: metric.flowId,
      name: metric.name,
      count: metric.count,
      probability: total > 0 ? metric.count / total : 0
    };
  });
}

function createSimulationResultsCsv(result: ExportBase): string {
  const taskRows = result.elementMetrics
    .filter((metric) => isActivityMetric(metric.type))
    .map((metric) => resultCsvLine(
      'Task',
      metric.elementId,
      metric.name,
      metric.visits,
      metric.errors,
      metric.serviceTimeSamples ?? [],
      metric.waitTimeSamples ?? []
    ));
  const resourceRows = result.resourceMetrics.map((metric) => resultCsvLine(
    'Resource',
    metric.resourceId,
    metric.name,
    metric.taskCount,
    metric.errors,
    metric.serviceTimeSamples ?? [],
    metric.waitTimeSamples ?? []
  ));
  const processWaitSamples = result.elementMetrics
    .filter((metric) => isActivityMetric(metric.type))
    .flatMap((metric) => metric.waitTimeSamples ?? []);
  const processServiceSamples = result.cases
    .filter((caseTrace) => caseTrace.status !== 'running')
    .map((caseTrace) => caseTrace.cycleTime * 60);
  const lines = [
    [
      'Type',
      'ID',
      'Name',
      'Anzahl Ausfuehrungen',
      'Anzahl Fehler',
      'Min Bearbeitungszeit',
      'Max Bearbeitungszeit',
      'Avg Bearbeitungszeit',
      'Median Bearbeitungszeit',
      'Min Wartezeit',
      'Max Wartezeit',
      'Avg Wartezeit',
      'Median Wartezeit'
    ].map(csvCell).join(','),
    resultCsvLine(
      'Process',
      'process',
      result.processName,
      result.cases.length,
      result.failedCases,
      processServiceSamples,
      processWaitSamples
    ),
    ...taskRows,
    ...resourceRows
  ];

  return lines.join('\n');
}

function createEventLogCsv(result: ExportBase): string {
  const elementTypes = new Map(result.elementMetrics.map((metric) => [metric.elementId, metric.type]));
  const caseOutputs = new Map(result.cases.map((caseTrace) => [caseTrace.id, caseTrace.outputs]));
  const taskStarts = new Map<string, SimulationLogEntry[]>();
  const lines = [
    ['CaseID', 'TaskID / EventID', 'TaskName / Event Name', 'Startzeit', 'Endzeit', 'Resource', 'Variables']
      .map(csvCell)
      .join(',')
  ];

  for (const entry of result.log) {
    const caseId = entry.caseId;
    const elementId = entry.elementId;

    if (caseId === undefined || !elementId) {
      continue;
    }

    if (entry.eventType === 'TASK_START') {
      pushEntry(taskStarts, eventKey(caseId, elementId), entry);
      continue;
    }

    if (entry.eventType === 'TASK_COMPLETE') {
      const start = shiftEntry(taskStarts, eventKey(caseId, elementId)) ?? entry;
      lines.push([
        caseId,
        elementId,
        entry.elementName ?? elementId,
        formatSimulationDateTime(result, start.time),
        formatSimulationDateTime(result, entry.time),
        entry.resourceId ?? '',
        variablesJson(entry.variables ?? caseOutputs.get(caseId))
      ].map(csvCell).join(','));
      continue;
    }

    if (entry.eventType === 'TOKEN_ENTER_ELEMENT' && isEventMetric(elementTypes.get(elementId) ?? '')) {
      lines.push([
        caseId,
        elementId,
        entry.elementName ?? elementId,
        formatSimulationDateTime(result, entry.time),
        '',
        '',
        variablesJson(entry.variables ?? caseOutputs.get(caseId))
      ].map(csvCell).join(','));
    }
  }

  return lines.join('\n');
}

function resultCsvLine(
  type: string,
  id: string,
  name: string,
  executions: number,
  errors: number,
  serviceSamples: number[],
  waitSamples: number[]
): string {
  const service = sampleStats(serviceSamples);
  const wait = sampleStats(waitSamples);

  return [
    type,
    id,
    name,
    executions,
    errors,
    service.min,
    service.max,
    service.avg,
    service.median,
    wait.min,
    wait.max,
    wait.avg,
    wait.median
  ].map(csvCell).join(',');
}

function csvCell(value: string | number): string {
  const text = String(value);

  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sampleStats(values: number[]): Record<'min' | 'max' | 'avg' | 'median', string> {
  if (!values.length) {
    return {
      min: '',
      max: '',
      avg: '',
      median: ''
    };
  }

  const sorted = [...values].sort((a, b) => a - b);

  return {
    min: formatNumber(sorted[0]),
    max: formatNumber(sorted[sorted.length - 1]),
    avg: formatNumber(average(sorted)),
    median: formatNumber(median(sorted))
  };
}

function median(sortedValues: number[]): number {
  if (!sortedValues.length) {
    return 0;
  }

  const middle = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2) {
    return sortedValues[middle];
  }

  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '';
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function pushEntry(map: Map<string, SimulationLogEntry[]>, key: string, entry: SimulationLogEntry): void {
  const entries = map.get(key) ?? [];

  entries.push(entry);
  map.set(key, entries);
}

function shiftEntry(map: Map<string, SimulationLogEntry[]>, key: string): SimulationLogEntry | undefined {
  const entries = map.get(key);

  if (!entries?.length) {
    return undefined;
  }

  return entries.shift();
}

function eventKey(caseId: number, elementId: string): string {
  return `${caseId}:${elementId}`;
}

function variablesJson(variables: Record<string, CaseOutputValue> | undefined): string {
  return JSON.stringify(variables ?? {});
}

function formatSimulationDateTime(result: ExportBase, time: number | undefined): string {
  if (time === undefined || !Number.isFinite(time)) {
    return '';
  }

  const startDate = parseDateTimeLocal(result.options.startDateTime);

  if (!startDate) {
    return formatNumber(time);
  }

  const startTime = result.options.startTime ?? 0;
  const date = addHours(startDate, Math.max(0, time - startTime));

  return formatDateTimeLocal(date);
}

function parseDateTimeLocal(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function formatDateTimeLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function isActivityMetric(type: string): boolean {
  return /Task$/.test(type) || ['bpmn:SubProcess', 'bpmn:CallActivity', 'bpmn:Transaction'].includes(type);
}

function isEventMetric(type: string): boolean {
  return /Event$/.test(type);
}

function cloneVariables(
  variables: Record<string, CaseOutputValue> | undefined
): Record<string, CaseOutputValue> | undefined {
  if (!variables) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(variables)) as Record<string, CaseOutputValue>;
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return Math.sqrt(variance);
}

function percentile(values: number[], p: number): number {
  if (!values.length) {
    return 0;
  }

  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));

  return values[index];
}
