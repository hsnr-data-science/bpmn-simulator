import type { SimFlow, SimModel, SimNode } from '../types/bpmn';
import type {
  CaseTrace,
  ElementMetrics,
  FlowMetrics,
  SimulationConfig,
  SimulationEventType,
  SimulationLogEntry,
  SimulationResult
} from '../types/simulation';

export class StatisticsCollector {
  private readonly elementMetrics = new Map<string, ElementMetrics>();
  private readonly flowMetrics = new Map<string, FlowMetrics>();
  private readonly logEntries: SimulationLogEntry[] = [];

  recordVisit(node: SimNode): void {
    this.getElementMetrics(node).visits += 1;
  }

  recordService(node: SimNode, waitTime: number, serviceTime: number): void {
    const metrics = this.getElementMetrics(node);

    metrics.waitTime += Math.max(0, waitTime);
    metrics.serviceTime += Math.max(0, serviceTime);
  }

  recordCompletion(node: SimNode): void {
    this.getElementMetrics(node).completions += 1;
  }

  recordError(node: SimNode): void {
    this.getElementMetrics(node).errors += 1;
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
    } = {}
  ): void {
    this.logEntries.push({
      level: options.level ?? 'info',
      eventType,
      caseId: options.caseId,
      message,
      elementId: options.elementId,
      elementName: options.elementName,
      time: options.time
    });
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
    const warnings = this.logEntries
      .filter((entry) => entry.level === 'warning')
      .map((entry) => entry.message);
    const elementMetrics = [...this.elementMetrics.values()].sort((a, b) => b.visits - a.visits);
    const flowMetrics = [...this.flowMetrics.values()].sort((a, b) => b.count - a.count);
    const pathProbabilities = calculatePathProbabilities(flowMetrics);
    const activityUtilization = elementMetrics.map((metric) => {
      return {
        elementId: metric.elementId,
        name: metric.name,
        utilization: maxTime > 0 ? metric.serviceTime / maxTime : 0,
        averageWaitTime: metric.visits ? metric.waitTime / metric.visits : 0,
        averageServiceTime: metric.completions ? metric.serviceTime / metric.completions : 0,
        tokenCount: metric.visits
      };
    });

    const baseResult = {
      startedAt,
      completedAt,
      options,
      processName: model.name,
      cases,
      completedCases,
      failedCases,
      cycleTimeAverage: average(finishedCycleTimes),
      cycleTimeP50: percentile(finishedCycleTimes, 0.5),
      cycleTimeP90: percentile(finishedCycleTimes, 0.9),
      cycleTimeMax: finishedCycleTimes[finishedCycleTimes.length - 1] ?? 0,
      throughputPerTimeUnit: maxTime > 0 ? completedCases / maxTime : completedCases,
      elementMetrics,
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
        csv: createCsv(baseResult),
        xesLike: createXesLikeLog(baseResult.log)
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
      serviceTime: 0,
      unsupported: !node.supported
    };

    this.elementMetrics.set(node.id, metrics);

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

function createCsv(result: ExportBase): string {
  const lines = [
    'metric,id,name,value',
    ...result.elementMetrics.flatMap((metric) => [
      csvLine('element_visits', metric.elementId, metric.name, metric.visits),
      csvLine('element_errors', metric.elementId, metric.name, metric.errors),
      csvLine('element_wait_time', metric.elementId, metric.name, metric.waitTime),
      csvLine('element_service_time', metric.elementId, metric.name, metric.serviceTime)
    ]),
    ...result.pathProbabilities.map((path) => {
      return csvLine('path_probability', path.flowId, path.name, path.probability);
    }),
    csvLine('completed_cases', 'process', result.processName, result.completedCases),
    csvLine('failed_cases', 'process', result.processName, result.failedCases),
    csvLine('deadlock_suspicions', 'process', result.processName, result.deadlockSuspicions),
    csvLine('unconsumed_tokens', 'process', result.processName, result.unconsumedTokens)
  ];

  return lines.join('\n');
}

function createXesLikeLog(entries: SimulationLogEntry[]): string {
  const events = entries.map((entry) => {
    return {
      time: entry.time,
      conceptName: entry.eventType ?? entry.level,
      caseId: entry.caseId,
      elementId: entry.elementId,
      elementName: entry.elementName,
      message: entry.message
    };
  });

  return JSON.stringify({ events }, null, 2);
}

function csvLine(metric: string, id: string, name: string, value: string | number): string {
  return [metric, id, name, value].map(csvCell).join(',');
}

function csvCell(value: string | number): string {
  const text = String(value);

  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (!values.length) {
    return 0;
  }

  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));

  return values[index];
}
