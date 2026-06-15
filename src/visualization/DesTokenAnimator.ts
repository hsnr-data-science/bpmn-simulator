import { PlaybackController, type PlaybackSnapshot } from '../playback/PlaybackController';
import { TimelineFrameBuilder } from '../playback/TimelineFrameBuilder';
import { VisualStateStore } from '../playback/VisualStateStore';
import { workingTimeBetween } from '../simulation/ResourceCalendar';
import type { ResourceMetrics, SimulationLogEntry, SimulationResult } from '../types/simulation';
import type { TimelineFrame } from '../types/timeline';
import { TimelineOverlayRenderer } from './TimelineOverlayRenderer';

type Canvas = ConstructorParameters<typeof TimelineOverlayRenderer>[0];
type ElementRegistry = ConstructorParameters<typeof TimelineOverlayRenderer>[1];
type ProgressCallback = (result: SimulationResult) => void;

type PlaybackRun = {
  result: SimulationResult;
  frames: TimelineFrame[];
  store: VisualStateStore;
  onProgress?: ProgressCallback;
  resolve: () => void;
  lastProgressEmit: number;
  lastProgressFrameIndex: number;
  flowActivations: FlowActivation[];
};

type FlowActivation = {
  flowId: string;
  time: number;
};

const PROGRESS_INTERVAL_MS = 250;
const PLAYBACK_BASE_SPEED_FACTOR = 0.01;

export class DesTokenAnimator {
  private readonly renderer: TimelineOverlayRenderer;
  private readonly frameBuilder = new TimelineFrameBuilder();
  private readonly controller = new PlaybackController();
  private unsubscribe?: () => void;
  private currentRun?: PlaybackRun;
  private speed = 1;

  constructor(canvas: Canvas, elementRegistry: ElementRegistry) {
    this.renderer = new TimelineOverlayRenderer(canvas, elementRegistry);
  }

  isRunning(): boolean {
    return Boolean(this.currentRun);
  }

  isPlaying(): boolean {
    return this.controller.isPlaying();
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(1, speed);
    this.controller.setSpeedFactor(this.speed * PLAYBACK_BASE_SPEED_FACTOR);
  }

  pause(): void {
    this.controller.pause();
  }

  resume(): void {
    this.controller.play();
  }

  stepForward(): void {
    this.controller.stepForward();
  }

  stepBackward(): void {
    this.controller.stepBackward();
  }

  seekToSimulationTime(time: number): void {
    this.controller.seekToSimulationTime(time);
  }

  stop(): void {
    const run = this.currentRun;

    this.controller.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.currentRun = undefined;
    this.renderer.clear();
    run?.resolve();
  }

  async play(result: SimulationResult, speed: number, onProgress?: ProgressCallback): Promise<void> {
    this.stop();
    this.setSpeed(speed);

    const frames = this.frameBuilder.buildFrames(result.timeline);
    const store = new VisualStateStore(frames);

    if (!frames.length) {
      onProgress?.(result);
      return;
    }

    this.controller.loadTimeline(frames);
    this.renderSnapshot({
      simulationTime: frames[0].simulationTime,
      frameIndex: 0,
      frameCount: frames.length,
      frame: frames[0],
      playing: false
    }, {
      result,
      frames,
      store,
      onProgress,
      resolve: () => undefined,
      lastProgressEmit: 0,
      lastProgressFrameIndex: -1,
      flowActivations: createFlowActivations(result)
    }, true);

    return new Promise((resolve) => {
      const run: PlaybackRun = {
        result,
        frames,
        store,
        onProgress,
        resolve,
        lastProgressEmit: 0,
        lastProgressFrameIndex: -1,
        flowActivations: createFlowActivations(result)
      };

      this.currentRun = run;
      this.unsubscribe = this.controller.onUpdate((snapshot) => this.renderSnapshot(snapshot, run));
      this.controller.play();
    });
  }

  private renderSnapshot(snapshot: PlaybackSnapshot, run: PlaybackRun, forceProgress = false): void {
    const state = run.store.rebuildUntil(snapshot.simulationTime);

    this.renderer.render(state);

    if (run.onProgress && shouldEmitProgress(snapshot, run, forceProgress)) {
      run.lastProgressEmit = performance.now();
      run.lastProgressFrameIndex = snapshot.frameIndex;
      run.onProgress(createProgressResult(run.result, snapshot.simulationTime, run.flowActivations));
    }

    if (!snapshot.playing && snapshot.frameCount > 0 && snapshot.frameIndex >= snapshot.frameCount - 1) {
      this.finishRun(run);
    }
  }

  private finishRun(run: PlaybackRun): void {
    if (this.currentRun !== run) {
      return;
    }

    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.currentRun = undefined;
    run.onProgress?.(run.result);
    run.resolve();
  }
}

function shouldEmitProgress(snapshot: PlaybackSnapshot, run: PlaybackRun, force: boolean): boolean {
  if (force || !snapshot.playing || snapshot.frameIndex !== run.lastProgressFrameIndex) {
    return true;
  }

  return performance.now() - run.lastProgressEmit >= PROGRESS_INTERVAL_MS;
}

function createProgressResult(
  result: SimulationResult,
  currentTime: number,
  flowActivations: FlowActivation[]
): SimulationResult {
  if (!Number.isFinite(currentTime)) {
    return result;
  }

  const elementMetrics = result.elementMetrics.map((metric) => ({ ...metric }));
  const resourceMetrics = result.resourceMetrics.map((metric) => resetResourceMetric({ ...metric }));
  const metricsById = new Map(elementMetrics.map((metric) => {
    metric.visits = 0;
    metric.completions = 0;
    metric.errors = 0;
    metric.retries = 0;
    metric.waitTime = 0;
    metric.waitTimeStddev = 0;
    metric.waitTimeSamples = [];
    metric.serviceTime = 0;
    metric.serviceTimeSamples = [];

    return [metric.elementId, metric] as const;
  }));
  const resourceMetricsById = new Map(resourceMetrics.map((metric) => [metric.resourceId, metric] as const));
  const enterQueues = new Map<string, number[]>();
  const startQueues = new Map<string, number[]>();
  const waitQueues = new Map<string, number[]>();
  const visibleLog: SimulationLogEntry[] = [];

  for (const entry of result.log) {
    if ((entry.time ?? 0) > currentTime) {
      break;
    }

    visibleLog.push(entry);
  }

  for (const entry of visibleLog) {
    if (!entry.elementId) {
      continue;
    }

    const metric = metricsById.get(entry.elementId);

    if (!metric) {
      continue;
    }

    const time = entry.time ?? 0;
    const key = metricKey(entry.caseId, entry.elementId);

    switch (entry.eventType) {
      case 'TOKEN_ENTER_ELEMENT':
        metric.visits += 1;
        pushQueue(enterQueues, key, time);
        break;
      case 'TASK_START': {
        const enterTime = shiftQueue(enterQueues, key) ?? time;
        const waitTime = hoursToMinutes(time - enterTime);

        metric.waitTime += waitTime;
        metric.waitTimeSamples?.push(waitTime);
        pushQueue(waitQueues, key, waitTime);
        pushQueue(startQueues, key, time);
        break;
      }
      case 'TASK_COMPLETE': {
        const startTime = shiftQueue(startQueues, key) ?? time;

        metric.completions += 1;
        const serviceTime = hoursToMinutes(time - startTime);

        metric.serviceTime += serviceTime;
        metric.serviceTimeSamples?.push(serviceTime);

        if (entry.resourceId) {
          const resource = resourceMetricsById.get(entry.resourceId);
          const waitTime = shiftQueue(waitQueues, key) ?? 0;

          if (resource) {
            if ((entry.attempt ?? 0) === 0) {
              resource.taskCount += 1;
            }

            resource.waitTime += waitTime;
            resource.waitTimeSamples?.push(waitTime);
            resource.serviceTime += serviceTime;
            resource.serviceTimeSamples?.push(serviceTime);
            resource.firstTaskStartTime = resource.firstTaskStartTime === undefined
              ? startTime
              : Math.min(resource.firstTaskStartTime, startTime);
            resource.lastTaskEndTime = resource.lastTaskEndTime === undefined
              ? time
              : Math.max(resource.lastTaskEndTime, time);
          }
        }
        break;
      }
      case 'PROCESS_INSTANCE_COMPLETE':
        metric.completions += 1;
        break;
      case 'TASK_FAILED':
        metric.errors += 1;
        if (entry.resourceId) {
          const resource = resourceMetricsById.get(entry.resourceId);

          if (resource) {
            resource.errors += 1;
          }
        }
        break;
      case 'RETRY_TASK':
        metric.retries += 1;
        break;
    }
  }

  addOpenWaitAndServiceSamples(currentTime, metricsById, enterQueues, startQueues);

  for (const metric of elementMetrics) {
    metric.waitTimeStddev = standardDeviation(metric.waitTimeSamples ?? []);
  }

  const flowCounts = countFlowsUntil(flowActivations, currentTime);
  const flowMetrics = result.flowMetrics.map((metric) => ({
    ...metric,
    count: flowCounts.get(metric.flowId) ?? 0
  }));
  const finishedCases = result.cases.filter((caseTrace) => {
    return caseTrace.endTime <= currentTime && caseTrace.status !== 'running';
  });
  const completedCases = finishedCases.filter((caseTrace) => caseTrace.status === 'completed').length;
  const failedCases = finishedCases.filter((caseTrace) => caseTrace.status === 'failed').length;
  const finishedCycleTimes = finishedCases
    .map((caseTrace) => caseTrace.cycleTime)
    .sort((a, b) => a - b);
  const pathProbabilities = calculatePathProbabilities(flowMetrics);
  const elapsedTime = Math.max(0, currentTime - (result.options.startTime ?? 0));
  const resourceMetricsWithUtilization = resourceMetrics.map((metric) => ({
    ...metric,
    utilization: calculateResourceUtilization(metric)
  }));

  return {
    ...result,
    currentTime,
    completedCases,
    failedCases,
    cycleTimeAverage: average(finishedCycleTimes),
    cycleTimeP50: percentile(finishedCycleTimes, 0.5),
    cycleTimeP90: percentile(finishedCycleTimes, 0.9),
    cycleTimeMax: finishedCycleTimes[finishedCycleTimes.length - 1] ?? 0,
    throughputPerTimeUnit: elapsedTime > 0 ? completedCases / elapsedTime : completedCases,
    elementMetrics,
    resourceMetrics: resourceMetricsWithUtilization,
    flowMetrics,
    log: visibleLog,
    warnings: visibleLog.filter((entry) => entry.level === 'warning').map((entry) => entry.message),
    activityUtilization: elementMetrics.map((metric) => ({
      elementId: metric.elementId,
      name: metric.name,
      utilization: elapsedTime > 0 ? (metric.serviceTime / 60) / elapsedTime : 0,
      averageWaitTime: metric.visits ? metric.waitTime / metric.visits : 0,
      averageServiceTime: metric.completions ? metric.serviceTime / metric.completions : 0,
      tokenCount: metric.visits
    })),
    pathProbabilities
  };
}

function addOpenWaitAndServiceSamples(
  currentTime: number,
  metricsById: Map<string, SimulationResult['elementMetrics'][number]>,
  enterQueues: Map<string, number[]>,
  startQueues: Map<string, number[]>
): void {
  for (const [key, times] of enterQueues.entries()) {
    const metric = metricsById.get(elementIdFromMetricKey(key));

    if (!metric || !isTaskMetric(metric.type)) {
      continue;
    }

    for (const activeWait of times) {
      const waitTime = hoursToMinutes(currentTime - activeWait);

      metric.waitTime += waitTime;
      metric.waitTimeSamples?.push(waitTime);
    }
  }

  for (const [key, times] of startQueues.entries()) {
    const metric = metricsById.get(elementIdFromMetricKey(key));

    if (!metric || !isTaskMetric(metric.type)) {
      continue;
    }

    for (const activeService of times) {
      const serviceTime = hoursToMinutes(currentTime - activeService);

      metric.serviceTime += serviceTime;
      metric.serviceTimeSamples?.push(serviceTime);
    }
  }
}

function createFlowActivations(result: SimulationResult): FlowActivation[] {
  return result.timeline
    .filter((event) => event.type === 'TOKEN_MOVE_START' && event.sequenceFlowId)
    .map((event) => ({
      flowId: event.sequenceFlowId ?? '',
      time: event.simulationTime
    }))
    .sort((left, right) => left.time - right.time);
}

function countFlowsUntil(flowActivations: FlowActivation[], currentTime: number): Map<string, number> {
  const counts = new Map<string, number>();

  for (const activation of flowActivations) {
    if (activation.time > currentTime) {
      break;
    }

    counts.set(activation.flowId, (counts.get(activation.flowId) ?? 0) + 1);
  }

  return counts;
}

function hoursToMinutes(hours: number): number {
  return Math.max(0, hours) * 60;
}

function resetResourceMetric(metric: ResourceMetrics): ResourceMetrics {
  return {
    ...metric,
    taskCount: 0,
    errors: 0,
    waitTime: 0,
    waitTimeSamples: [],
    serviceTime: 0,
    serviceTimeSamples: [],
    firstTaskStartTime: undefined,
    lastTaskEndTime: undefined,
    utilization: 0
  };
}

function calculateResourceUtilization(metric: ResourceMetrics): number {
  const workingHours = workingTimeBetween(metric.firstTaskStartTime, metric.lastTaskEndTime, metric);
  const capacity = Math.max(1, Math.floor(metric.capacity ?? 1));
  const availableCapacityHours = workingHours * capacity;

  return availableCapacityHours > 0 ? (metric.serviceTime / 60) / availableCapacityHours : 0;
}

function metricKey(caseId: number | undefined, elementId: string): string {
  return `${caseId ?? 'global'}:${elementId}`;
}

function elementIdFromMetricKey(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

function isTaskMetric(type: string): boolean {
  return /Task$/.test(type) || ['bpmn:SubProcess', 'bpmn:CallActivity', 'bpmn:Transaction'].includes(type);
}

function pushQueue(map: Map<string, number[]>, key: string, value: number): void {
  const values = map.get(key) ?? [];

  values.push(value);
  map.set(key, values);
}

function shiftQueue(map: Map<string, number[]>, key: string): number | undefined {
  return map.get(key)?.shift();
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return Math.sqrt(variance);
}

function calculatePathProbabilities(flowMetrics: SimulationResult['flowMetrics']): SimulationResult['pathProbabilities'] {
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
