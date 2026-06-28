import type { SimFlow, SimModel, SimNode } from '../types/bpmn';
import type {
  CaseOutputValue,
  CaseTrace,
  ElementMetrics,
  FlowMetrics,
  ProcessMetrics,
  ResourceMetrics,
  SimulationConfig,
  SimulationEventType,
  SimulationExports,
  SimulationLogEntry,
  SimulationResult
} from '../types/simulation';
import { workingTimeBetween } from './ResourceCalendar';
import { buildSimulationTimeline } from './SimulationTimelineBuilder';

export class StatisticsCollector {
  private readonly elementMetrics = new Map<string, ElementMetrics>();
  private readonly resourceMetrics = new Map<string, ResourceMetrics>();
  private readonly flowMetrics = new Map<string, FlowMetrics>();
  private readonly logEntries: SimulationLogEntry[] = [];

  recordVisit(node: SimNode): void {
    this.getElementMetrics(node).visits += 1;
  }

  recordService(
    node: SimNode,
    timing: {
      waitTime: number;
      waitTimeExcludingOffTimetable: number;
      serviceTime: number;
      serviceTimeExcludingOffTimetable: number;
      startTime?: number;
      endTime?: number;
      countTask?: boolean;
    }
  ): void {
    const metrics = this.getElementMetrics(node);
    const wait = Math.max(0, timing.waitTime);
    const workingWait = Math.max(0, timing.waitTimeExcludingOffTimetable);
    const service = Math.max(0, timing.serviceTime);
    const workingService = Math.max(0, timing.serviceTimeExcludingOffTimetable);

    metrics.waitTime += wait;
    metrics.waitTimeSamples?.push(wait);
    metrics.waitTimeExcludingOffTimetable += workingWait;
    metrics.waitTimeSamplesExcludingOffTimetable?.push(workingWait);
    metrics.serviceTime += service;
    metrics.serviceTimeSamples?.push(service);
    metrics.serviceTimeExcludingOffTimetable += workingService;
    metrics.serviceTimeSamplesExcludingOffTimetable?.push(workingService);

    const resource = this.getResourceMetrics(node);

    if (resource) {
      if (timing.countTask ?? true) {
        resource.taskCount += 1;
      }

      resource.waitTime += wait;
      resource.waitTimeSamples?.push(wait);
      resource.waitTimeExcludingOffTimetable += workingWait;
      resource.waitTimeSamplesExcludingOffTimetable?.push(workingWait);
      resource.serviceTime += service;
      resource.serviceTimeSamples?.push(service);
      resource.serviceTimeExcludingOffTimetable += workingService;
      resource.serviceTimeSamplesExcludingOffTimetable?.push(workingService);

      if (timing.startTime !== undefined && Number.isFinite(timing.startTime)) {
        resource.firstTaskStartTime = resource.firstTaskStartTime === undefined
          ? timing.startTime
          : Math.min(resource.firstTaskStartTime, timing.startTime);
      }

      if (timing.endTime !== undefined && Number.isFinite(timing.endTime)) {
        resource.lastTaskEndTime = resource.lastTaskEndTime === undefined
          ? timing.endTime
          : Math.max(resource.lastTaskEndTime, timing.endTime);
      }
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
      sourceCaseId?: number;
      sourceElementId?: string;
      tokenId?: string;
      attempt?: number;
      time?: number;
      level?: SimulationLogEntry['level'];
      resourceId?: string;
      resourceInstanceId?: string;
      waitTime?: number;
      waitTimeExcludingOffTimetable?: number;
      serviceTime?: number;
      serviceTimeExcludingOffTimetable?: number;
      variables?: Record<string, CaseOutputValue>;
    } = {}
  ): SimulationLogEntry {
    const entry = {
      level: options.level ?? 'info',
      eventType,
      caseId: options.caseId,
      sourceCaseId: options.sourceCaseId,
      sourceElementId: options.sourceElementId,
      tokenId: options.tokenId,
      attempt: options.attempt,
      message,
      elementId: options.elementId,
      elementName: options.elementName,
      resourceId: options.resourceId,
      resourceInstanceId: options.resourceInstanceId,
      waitTime: options.waitTime,
      waitTimeExcludingOffTimetable: options.waitTimeExcludingOffTimetable,
      serviceTime: options.serviceTime,
      serviceTimeExcludingOffTimetable: options.serviceTimeExcludingOffTimetable,
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

    const rootCases = cases.filter((caseTrace) => caseTrace.trigger !== 'subProcess');
    const finishedCycleTimes = rootCases
      .filter((caseTrace) => caseTrace.status !== 'running')
      .map((caseTrace) => caseTrace.cycleTime)
      .sort((a, b) => a - b);
    const completedCases = rootCases.filter((caseTrace) => caseTrace.status === 'completed').length;
    const failedCases = rootCases.filter((caseTrace) => caseTrace.status === 'failed').length;
    const deadlockSuspicions = rootCases.filter((caseTrace) => caseTrace.status === 'running').length;
    const unconsumedTokens = cases.reduce((sum, caseTrace) => sum + caseTrace.activeTokens, 0);
    const maxTime = cases.reduce(
      (latest, caseTrace) => Math.max(latest, caseTrace.endTime),
      Math.max(currentTime, 0)
    );
    const elapsedTime = Math.max(0, maxTime - (options.startTime ?? 0));
    const warnings = this.logEntries
      .filter((entry) => entry.level === 'warning')
      .map((entry) => entry.message);
    const elementMetrics = [...this.elementMetrics.values()]
      .map((metric) => ({
        ...metric,
        waitTimeStddev: standardDeviation(metric.waitTimeSamples ?? []),
        waitTimeStddevExcludingOffTimetable: standardDeviation(
          metric.waitTimeSamplesExcludingOffTimetable ?? []
        )
      }))
      .sort((a, b) => b.visits - a.visits);
    const resourceNames = new Map([...model.resources.values()].map((resource) => [resource.id, resource.name || resource.id]));
    const resourceMetrics = [...this.resourceMetrics.values()]
      .map((metric) => ({
        ...metric,
        name: resourceNames.get(metric.resourceId) ?? metric.name,
        utilization: calculateResourceUtilization(metric)
      }))
      .sort((a, b) => b.taskCount - a.taskCount);
    const processMetrics = buildProcessMetrics(model, cases, this.logEntries, resourceMetrics);
    const flowMetrics = [...this.flowMetrics.values()].sort((a, b) => b.count - a.count);
    const pathProbabilities = calculatePathProbabilities(flowMetrics);
    const activityUtilization = elementMetrics.map((metric) => {
      return {
        elementId: metric.elementId,
        name: metric.name,
        utilization: elapsedTime > 0
          ? (metric.serviceTimeExcludingOffTimetable / 60) / elapsedTime
          : 0,
        averageWaitTime: metric.visits ? metric.waitTime / metric.visits : 0,
        averageServiceTime: metric.completions ? metric.serviceTime / metric.completions : 0,
        tokenCount: metric.visits
      };
    });
    const timeline = buildSimulationTimeline(model, this.logEntries, cases);

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
      processMetrics,
      resourceMetrics,
      flowMetrics,
      timeline,
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
      exports: createLazyExports(baseResult)
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
      waitTimeExcludingOffTimetable: 0,
      waitTimeStddevExcludingOffTimetable: 0,
      waitTimeSamplesExcludingOffTimetable: [],
      serviceTime: 0,
      serviceTimeSamples: [],
      serviceTimeExcludingOffTimetable: 0,
      serviceTimeSamplesExcludingOffTimetable: [],
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
      waitTimeExcludingOffTimetable: 0,
      waitTimeSamplesExcludingOffTimetable: [],
      serviceTime: 0,
      serviceTimeSamples: [],
      serviceTimeExcludingOffTimetable: 0,
      serviceTimeSamplesExcludingOffTimetable: [],
      capacity: node.params.resource?.capacity,
      weekdays: node.params.resource?.weekdays,
      hourRanges: node.params.resource?.hourRanges,
      utilization: 0
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

}

type ExportBase = Omit<SimulationResult, 'exports'>;
const CSV_DELIMITER = ';';

function createLazyExports(result: ExportBase): SimulationExports {
  let json: string | undefined;
  let simulationResultsCsv: string | undefined;
  let eventLogCsv: string | undefined;

  return {
    get json() {
      json ??= JSON.stringify(result, null, 2);

      return json;
    },
    get csv() {
      simulationResultsCsv ??= createSimulationResultsCsv(result);

      return simulationResultsCsv;
    },
    get simulationResultsCsv() {
      simulationResultsCsv ??= createSimulationResultsCsv(result);

      return simulationResultsCsv;
    },
    get eventLogCsv() {
      eventLogCsv ??= createEventLogCsv(result);

      return eventLogCsv;
    }
  };
}

function buildProcessMetrics(
  model: SimModel,
  cases: CaseTrace[],
  log: SimulationLogEntry[],
  resources: ResourceMetrics[]
): ProcessMetrics[] {
  const metrics = new Map<string, ProcessMetrics>();
  const caseScopes = new Map<number, string>();
  const resourcesById = new Map(resources.map((resource) => [resource.resourceId, resource]));
  const samples = collectProcessTimeSamples(log, resourcesById);

  for (const caseTrace of cases) {
    const scope = describeCaseProcessScope(model, caseTrace);
    const metric = metrics.get(scope.id) ?? createProcessMetric(scope.id, scope.name);

    metric.instanceCount += 1;
    metric.completedInstances += caseTrace.status === 'completed' ? 1 : 0;
    metric.failedInstances += caseTrace.status === 'failed' ? 1 : 0;
    caseScopes.set(caseTrace.id, scope.id);
    metrics.set(scope.id, metric);
  }

  for (const [caseId, processId] of caseScopes) {
    const metric = metrics.get(processId);

    if (!metric) {
      continue;
    }

    metric.serviceTimeSamples?.push(samples.serviceByCase.get(caseId) ?? 0);
    metric.serviceTimeSamplesExcludingOffTimetable?.push(samples.workingServiceByCase.get(caseId) ?? 0);
    metric.waitTimeSamples?.push(samples.waitByCase.get(caseId) ?? 0);
    metric.waitTimeSamplesExcludingOffTimetable?.push(samples.workingWaitByCase.get(caseId) ?? 0);
  }

  return [...metrics.values()].sort((left, right) => {
    const countDiff = right.instanceCount - left.instanceCount;

    return countDiff || left.name.localeCompare(right.name);
  });
}

function collectProcessTimeSamples(
  log: SimulationLogEntry[],
  resources: Map<string, ResourceMetrics>
): {
  serviceByCase: Map<number, number>;
  workingServiceByCase: Map<number, number>;
  waitByCase: Map<number, number>;
  workingWaitByCase: Map<number, number>;
} {
  const serviceByCase = new Map<number, number>();
  const workingServiceByCase = new Map<number, number>();
  const waitByCase = new Map<number, number>();
  const workingWaitByCase = new Map<number, number>();
  const enterQueues = new Map<string, number[]>();
  const startQueues = new Map<string, number[]>();

  for (const entry of log) {
    if (entry.caseId === undefined || !entry.elementId) {
      continue;
    }

    const key = `${entry.caseId}:${entry.elementId}`;
    const time = entry.time ?? 0;

    if (entry.eventType === 'TOKEN_ENTER_ELEMENT') {
      pushQueue(enterQueues, key, time);
      continue;
    }

    if (entry.eventType === 'TASK_START') {
      const enterTime = shiftQueue(enterQueues, key) ?? time;
      const resource = entry.resourceId ? resources.get(entry.resourceId) : undefined;
      const wait = entry.waitTime ?? Math.max(0, time - enterTime) * 60;
      const workingWait = entry.waitTimeExcludingOffTimetable ??
        workingTimeBetween(enterTime, time, resource) * 60;

      addCaseSample(waitByCase, entry.caseId, wait);
      addCaseSample(workingWaitByCase, entry.caseId, workingWait);
      pushQueue(startQueues, key, time);
      continue;
    }

    if (entry.eventType === 'TASK_COMPLETE') {
      const startTime = shiftQueue(startQueues, key) ?? time;
      const resource = entry.resourceId ? resources.get(entry.resourceId) : undefined;
      const service = entry.serviceTime ?? Math.max(0, time - startTime) * 60;
      const workingService = entry.serviceTimeExcludingOffTimetable ??
        workingTimeBetween(startTime, time, resource) * 60;

      addCaseSample(serviceByCase, entry.caseId, service);
      addCaseSample(workingServiceByCase, entry.caseId, workingService);
    }
  }

  return {
    serviceByCase,
    workingServiceByCase,
    waitByCase,
    workingWaitByCase
  };
}

function describeCaseProcessScope(model: SimModel, caseTrace: CaseTrace): { id: string; name: string } {
  if (caseTrace.trigger === 'subProcess' && caseTrace.triggerElementId) {
    const subProcess = model.nodes.get(caseTrace.triggerElementId);

    return {
      id: caseTrace.triggerElementId,
      name: subProcess?.name || subProcess?.id || caseTrace.triggerElementId
    };
  }

  const processId = caseTrace.processId ?? model.id ?? 'process';
  const process = model.processes?.get(processId);

  return {
    id: processId,
    name: process?.name || model.name || processId
  };
}

function createProcessMetric(processId: string, name: string): ProcessMetrics {
  return {
    processId,
    name,
    instanceCount: 0,
    completedInstances: 0,
    failedInstances: 0,
    serviceTimeSamples: [],
    serviceTimeSamplesExcludingOffTimetable: [],
    waitTimeSamples: [],
    waitTimeSamplesExcludingOffTimetable: []
  };
}

function addCaseSample(map: Map<number, number>, caseId: number, value: number): void {
  map.set(caseId, (map.get(caseId) ?? 0) + Math.max(0, value));
}

function pushQueue(map: Map<string, number[]>, key: string, value: number): void {
  const values = map.get(key) ?? [];

  values.push(value);
  map.set(key, values);
}

function shiftQueue(map: Map<string, number[]>, key: string): number | undefined {
  return map.get(key)?.shift();
}

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
  const processMetrics = result.processMetrics?.length
    ? result.processMetrics
    : [{
        processId: 'process',
        name: result.processName,
        instanceCount: result.cases.length,
        failedInstances: result.failedCases,
        serviceTimeSamples: result.cases.map((caseTrace) => caseTrace.cycleTime * 60),
        waitTimeSamples: []
      }];
  const processRows = processMetrics.map((metric) => resultCsvLine(
    'Process',
    metric.processId,
    metric.name,
    metric.instanceCount,
    metric.failedInstances,
    metric.serviceTimeSamples ?? [],
    metric.waitTimeSamples ?? [],
    undefined
  ));
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
    metric.waitTimeSamples ?? [],
    metric.utilization
  ));
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
      'Median Wartezeit',
      'Auslastung'
    ].map(csvCell).join(CSV_DELIMITER),
    ...processRows,
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
      .join(CSV_DELIMITER)
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
        entry.resourceInstanceId ?? entry.resourceId ?? '',
        variablesJson(entry.variables ?? caseOutputs.get(caseId))
      ].map(csvCell).join(CSV_DELIMITER));
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
      ].map(csvCell).join(CSV_DELIMITER));
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
  waitSamples: number[],
  utilization?: number
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
    wait.median,
    utilization === undefined ? '' : formatNumber(utilization)
  ].map(csvCell).join(CSV_DELIMITER);
}

function csvCell(value: string | number): string {
  const text = String(value);

  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

function calculateResourceUtilization(metric: ResourceMetrics): number {
  const workingHours = workingTimeBetween(metric.firstTaskStartTime, metric.lastTaskEndTime, metric);
  const capacity = Math.max(1, Math.floor(metric.capacity ?? 1));
  const availableCapacityHours = workingHours * capacity;

  return availableCapacityHours > 0
    ? Math.min(
        1,
        Math.max(0, (metric.serviceTimeExcludingOffTimetable / 60) / availableCapacityHours)
      )
    : 0;
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
