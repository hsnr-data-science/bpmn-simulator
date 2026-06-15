import type { CaseTrace, ResourceMetrics, SimulationLogEntry, SimulationResult } from '../types/simulation';
import { workingTimeBetween } from '../simulation/ResourceCalendar';

type Canvas = {
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
  getContainer(): HTMLElement;
};

type DiagramElement = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  waypoints?: Array<{ x: number; y: number }>;
};

type ElementRegistry = {
  get(elementId: string): DiagramElement | undefined;
};

type DesAnimationScope = {
  primary: string;
  auxiliary: string;
};

type TimelineStep = {
  nodeId: string;
  time: number;
  outgoingFlowId?: string;
};

type PolylineSegment = {
  start: {
    x: number;
    y: number;
  };
  end: {
    x: number;
    y: number;
  };
  length: number;
  startLength: number;
};

type PolylinePath = {
  segments: PolylineSegment[];
  totalLength: number;
};

type ProgressCallback = (result: SimulationResult) => void;

type FlowActivation = {
  flowId: string;
  time: number;
};

type ProgressState = {
  result: SimulationResult;
  flowActivations: FlowActivation[];
  timelineTimes: Map<number, number>;
  activeTimelineIds: Set<number>;
  currentTime: number;
  lastEmit: number;
  onProgress: ProgressCallback;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_MARKER = 'des-token-current';
const TASK_MARKER = 'des-current-task';
const SIMULATION_UNIT_MS = 1000;
const ZERO_TIME_STEP = 0.12;
const END_HOLD = 0.35;
const FLOW_ANIMATION_BASE_MS = 250;
const PROGRESS_INTERVAL_MS = 300;

export class DesTokenAnimator {
  private readonly canvas: Canvas;
  private readonly elementRegistry: ElementRegistry;
  private nodeTokenLayer?: SVGGElement;
  private flowTokenLayer?: SVGGElement;
  private tokenCounts = new Map<string, number>();
  private flowTokens = new Set<SVGGElement>();
  private markedElements = new Map<string, Set<string>>();
  private frameIds = new Set<number>();
  private timeoutIds = new Set<number>();
  private cancelHandlers = new Set<() => void>();
  private progressState?: ProgressState;
  private nodeTokenRenderFrame = 0;
  private runId = 0;
  private speed = 1;

  constructor(canvas: Canvas, elementRegistry: ElementRegistry) {
    this.canvas = canvas;
    this.elementRegistry = elementRegistry;
  }

  isRunning(): boolean {
    return this.frameIds.size > 0 || this.tokenCounts.size > 0;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(1, speed);
  }

  stop(): void {
    this.runId += 1;

    for (const cancel of [...this.cancelHandlers]) {
      cancel();
    }

    this.cancelHandlers.clear();
    this.frameIds.clear();
    for (const timeoutId of this.timeoutIds) {
      window.clearTimeout(timeoutId);
    }
    this.timeoutIds.clear();
    if (this.nodeTokenRenderFrame) {
      cancelAnimationFrame(this.nodeTokenRenderFrame);
      this.nodeTokenRenderFrame = 0;
    }
    this.clearFlowTokens();
    this.clearNodeTokens();
    this.clearMarkers();
    this.progressState = undefined;
  }

  async play(result: SimulationResult, speed: number, onProgress?: ProgressCallback): Promise<void> {
    this.stop();
    const runId = this.runId;

    const enterTimeQueuesByCase = createEnterTimeQueuesByCase(result.log);
    const timelines = result.cases
      .map((caseTrace) => buildTimeline(caseTrace, enterTimeQueuesByCase.get(caseTrace.id), this.elementRegistry))
      .filter((timeline) => timeline.length > 0);
    this.setSpeed(speed);
    this.progressState = onProgress
      ? {
          result,
          flowActivations: createFlowActivations(timelines),
          timelineTimes: new Map(timelines.map((_, index) => [index, 0] as const)),
          activeTimelineIds: new Set(timelines.map((_, index) => index)),
          currentTime: 0,
          lastEmit: 0,
          onProgress
        }
      : undefined;

    this.emitProgress(0, true);
    await Promise.all(timelines.map((timeline, index) => this.playTimeline(timeline, index, runId)));

    if (this.isCurrentRun(runId)) {
      await this.waitSimulationUnits(END_HOLD, runId);
      this.emitProgress(Number.POSITIVE_INFINITY, true);
      this.clearNodeTokens();
      this.clearMarkers();
    }
  }

  private async playTimeline(timeline: TimelineStep[], index: number, runId: number): Promise<void> {
    const color = colorForCase(index);

    if (timeline[0].time > 0) {
      await this.waitSimulationUnits(timeline[0].time, runId, {
        from: 0,
        to: timeline[0].time,
        timelineIndex: index
      });
    }

    for (let stepIndex = 0; stepIndex < timeline.length; stepIndex += 1) {
      if (!this.isCurrentRun(runId)) {
        return;
      }

      const step = timeline[stepIndex];
      const next = timeline[stepIndex + 1];

      this.enterNode(step.nodeId);
      this.emitProgress(step.time, false, index);

      if (!next) {
        await this.waitSimulationUnits(END_HOLD, runId);
        this.leaveNode(step.nodeId);
        this.completeTimeline(index);
        continue;
      }

      if (!step.outgoingFlowId) {
        await this.waitSimulationUnits(ZERO_TIME_STEP, runId);
        this.leaveNode(step.nodeId);
        continue;
      }

      const dwell = Math.max(0, next.time - step.time);

      await this.waitSimulationUnits(dwell > 0 ? dwell : ZERO_TIME_STEP, runId, {
        from: step.time,
        to: next.time,
        timelineIndex: index
      });

      if (!this.isCurrentRun(runId)) {
        return;
      }

      this.leaveNode(step.nodeId);
      await this.animateFlow(step.outgoingFlowId, color, runId, index);
      this.recordFlow(step.outgoingFlowId, next.time, index);
    }
  }

  private animateFlow(
    flowId: string,
    color: DesAnimationScope,
    runId: number,
    caseIndex: number
  ): Promise<void> {
    if (!this.isCurrentRun(runId)) {
      return Promise.resolve();
    }

    const connection = this.elementRegistry.get(flowId);

    if (!connection?.waypoints?.length) {
      return this.waitSimulationUnits(ZERO_TIME_STEP, runId).then(() => undefined);
    }

    return new Promise((resolve) => {
      const token = this.createFlowToken(connection, color, caseIndex);
      const path = createPolylinePath(connection.waypoints ?? []);
      const baseDuration = Math.max(120, Math.log(Math.max(path.totalLength, 2)) * FLOW_ANIMATION_BASE_MS);
      let progress = 0;
      let lastTime = performance.now();
      let frameId = 0;
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) {
          return;
        }

        settled = true;
        cancelAnimationFrame(frameId);
        this.frameIds.delete(frameId);
        this.cancelHandlers.delete(cancel);
        this.removeFlowToken(token);
        if (completed && this.isCurrentRun(runId)) {
          this.unmark(flowId, 'des-active-path');
        }
        resolve();
      };
      const cancel = () => finish(false);
      const tick = (now: number) => {
        this.frameIds.delete(frameId);

        if (!this.isCurrentRun(runId)) {
          finish(false);
          return;
        }

        const elapsed = Math.max(0, now - lastTime);
        lastTime = now;
        progress = Math.min(1, progress + (elapsed * this.speed) / baseDuration);

        const point = pointAt(path, progress);
        token.setAttribute('transform', `translate(${point.x}, ${point.y})`);

        if (progress >= 1) {
          finish(true);
          return;
        }

        frameId = requestAnimationFrame(tick);
        this.frameIds.add(frameId);
      };

      this.mark(flowId, 'des-active-path');
      this.cancelHandlers.add(cancel);
      frameId = requestAnimationFrame(tick);
      this.frameIds.add(frameId);
    });
  }

  private enterNode(elementId: string): void {
    this.tokenCounts.set(elementId, (this.tokenCounts.get(elementId) ?? 0) + 1);
    this.mark(elementId, NODE_MARKER);

    const element = this.elementRegistry.get(elementId);

    if (isTaskLike(element)) {
      this.mark(elementId, TASK_MARKER);
    }

    this.renderNodeTokens();
  }

  private leaveNode(elementId: string): void {
    const nextCount = Math.max(0, (this.tokenCounts.get(elementId) ?? 0) - 1);

    if (nextCount > 0) {
      this.tokenCounts.set(elementId, nextCount);
    } else {
      this.tokenCounts.delete(elementId);
      this.unmark(elementId, NODE_MARKER);
      this.unmark(elementId, TASK_MARKER);
    }

    this.renderNodeTokens();
  }

  private renderNodeTokens(): void {
    if (this.nodeTokenRenderFrame) {
      return;
    }

    this.nodeTokenRenderFrame = requestAnimationFrame(() => {
      this.nodeTokenRenderFrame = 0;
      this.renderNodeTokensNow();
    });
  }

  private renderNodeTokensNow(): void {
    const layer = this.getNodeTokenLayer();

    if (!layer) {
      return;
    }

    layer.replaceChildren();

    for (const [elementId, count] of this.tokenCounts.entries()) {
      const element = this.elementRegistry.get(elementId);

      if (!element || element.x === undefined || element.y === undefined || !element.width || !element.height) {
        continue;
      }

      const x = element.x + element.width / 2;
      const y = element.y + element.height / 2;
      const group = document.createElementNS(SVG_NS, 'g');
      const circle = document.createElementNS(SVG_NS, 'circle');
      const text = document.createElementNS(SVG_NS, 'text');

      group.setAttribute('class', 'des-node-token');
      group.setAttribute('transform', `translate(${x}, ${y})`);
      circle.setAttribute('r', '11');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.textContent = String(count);

      group.append(circle, text);
      layer.appendChild(group);
    }
  }

  private createFlowToken(connection: DiagramElement, colors: DesAnimationScope, caseIndex: number): SVGGElement {
    const layer = this.getFlowTokenLayer();
    const group = document.createElementNS(SVG_NS, 'g');
    const circle = document.createElementNS(SVG_NS, 'circle');
    const text = document.createElementNS(SVG_NS, 'text');
    const first = connection.waypoints?.[0] ?? { x: 0, y: 0 };

    group.setAttribute('class', 'des-flow-token');
    group.setAttribute('transform', `translate(${first.x}, ${first.y})`);
    circle.setAttribute('r', '10');
    circle.setAttribute('fill', colors.primary);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('fill', colors.auxiliary);
    text.textContent = String((caseIndex % 9) + 1);

    group.append(circle, text);
    layer?.appendChild(group);
    this.flowTokens.add(group);

    return group;
  }

  private getFlowTokenLayer(): SVGGElement | undefined {
    if (this.flowTokenLayer?.isConnected) {
      return this.flowTokenLayer;
    }

    const viewport = this.canvas.getContainer().querySelector<SVGGElement>('svg .viewport');

    if (!viewport) {
      return undefined;
    }

    this.flowTokenLayer = document.createElementNS(SVG_NS, 'g');
    this.flowTokenLayer.setAttribute('class', 'des-flow-tokens');
    viewport.appendChild(this.flowTokenLayer);

    return this.flowTokenLayer;
  }

  private removeFlowToken(token: SVGGElement): void {
    token.remove();
    this.flowTokens.delete(token);
  }

  private clearFlowTokens(): void {
    for (const token of this.flowTokens) {
      token.remove();
    }

    this.flowTokens.clear();
    this.flowTokenLayer?.replaceChildren();
  }

  private getNodeTokenLayer(): SVGGElement | undefined {
    if (this.nodeTokenLayer?.isConnected) {
      return this.nodeTokenLayer;
    }

    const viewport = this.canvas.getContainer().querySelector<SVGGElement>('svg .viewport');

    if (!viewport) {
      return undefined;
    }

    this.nodeTokenLayer = document.createElementNS(SVG_NS, 'g');
    this.nodeTokenLayer.setAttribute('class', 'des-node-tokens');
    viewport.appendChild(this.nodeTokenLayer);

    return this.nodeTokenLayer;
  }

  private clearNodeTokens(): void {
    this.tokenCounts.clear();
    if (this.nodeTokenRenderFrame) {
      cancelAnimationFrame(this.nodeTokenRenderFrame);
      this.nodeTokenRenderFrame = 0;
    }
    this.nodeTokenLayer?.replaceChildren();
  }

  private mark(elementId: string, marker: string): void {
    try {
      this.canvas.addMarker(elementId, marker);
      const markers = this.markedElements.get(elementId) ?? new Set<string>();
      markers.add(marker);
      this.markedElements.set(elementId, markers);
    } catch {
      // Some semantic BPMN elements have no rendered diagram shape.
    }
  }

  private unmark(elementId: string, marker: string): void {
    try {
      this.canvas.removeMarker(elementId, marker);
      const markers = this.markedElements.get(elementId);
      markers?.delete(marker);

      if (markers?.size === 0) {
        this.markedElements.delete(elementId);
      }
    } catch {
      // Some semantic BPMN elements have no rendered diagram shape.
    }
  }

  private clearMarkers(): void {
    for (const [elementId, markers] of this.markedElements.entries()) {
      for (const marker of markers) {
        try {
          this.canvas.removeMarker(elementId, marker);
        } catch {
          // Ignore non-rendered semantic elements.
        }
      }
    }

    this.markedElements.clear();
  }

  private recordFlow(flowId: string, time: number, timelineIndex: number): void {
    const state = this.progressState;

    if (!state) {
      return;
    }

    this.emitProgress(time, false, timelineIndex);
  }

  private waitSimulationUnits(
    units: number,
    runId: number,
    progress?: {
      from: number;
      to: number;
      timelineIndex?: number;
    }
  ): Promise<boolean> {
    const targetUnits = Math.max(0, units);

    if (targetUnits === 0 || !this.isCurrentRun(runId)) {
      return Promise.resolve(this.isCurrentRun(runId));
    }

    let remainingMs = targetUnits * SIMULATION_UNIT_MS;
    let lastTime = performance.now();

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = 0;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }

        settled = true;
        this.cancelHandlers.delete(cancel);
        if (timeoutId) {
          window.clearTimeout(timeoutId);
          this.timeoutIds.delete(timeoutId);
        }
        resolve(value);
      };
      const cancel = () => {
        finish(false);
      };
      const tick = (now: number) => {
        if (timeoutId) {
          this.timeoutIds.delete(timeoutId);
          timeoutId = 0;
        }

        if (!this.isCurrentRun(runId)) {
          finish(false);
          return;
        }

        const elapsed = Math.max(0, now - lastTime);
        lastTime = now;
        remainingMs -= elapsed * this.speed;

        if (progress) {
          const consumedMs = targetUnits * SIMULATION_UNIT_MS - Math.max(0, remainingMs);
          const fraction = targetUnits > 0 ? Math.min(1, consumedMs / (targetUnits * SIMULATION_UNIT_MS)) : 1;
          this.emitProgress(progress.from + (progress.to - progress.from) * fraction, false, progress.timelineIndex);
        }

        if (remainingMs <= 0) {
          finish(true);
          return;
        }

        scheduleTick();
      };
      const scheduleTick = () => {
        const delay = Math.max(16, Math.min(PROGRESS_INTERVAL_MS, remainingMs / this.speed));

        timeoutId = window.setTimeout(() => tick(performance.now()), delay);
        this.timeoutIds.add(timeoutId);
      };

      this.cancelHandlers.add(cancel);
      scheduleTick();
    });
  }

  private isCurrentRun(runId: number): boolean {
    return this.runId === runId;
  }

  private emitProgress(time: number, force = false, timelineIndex?: number): void {
    const state = this.progressState;

    if (!state) {
      return;
    }

    if (timelineIndex !== undefined && Number.isFinite(time)) {
      state.timelineTimes.set(
        timelineIndex,
        Math.max(state.timelineTimes.get(timelineIndex) ?? 0, time)
      );
    }

    const now = performance.now();
    const nextTime = calculateSynchronizedProgressTime(state, time);

    if (!force && now - state.lastEmit < PROGRESS_INTERVAL_MS) {
      return;
    }

    state.currentTime = nextTime;
    state.lastEmit = now;
    state.onProgress(createProgressResult(state.result, state.currentTime, state.flowActivations));
  }

  private completeTimeline(timelineIndex: number): void {
    const state = this.progressState;

    if (!state) {
      return;
    }

    state.activeTimelineIds.delete(timelineIndex);
    this.emitProgress(state.timelineTimes.get(timelineIndex) ?? state.currentTime, true);
  }
}

function calculateSynchronizedProgressTime(state: ProgressState, requestedTime: number): number {
  if (!Number.isFinite(requestedTime)) {
    return Number.POSITIVE_INFINITY;
  }

  if (!state.activeTimelineIds.size) {
    return Math.max(state.currentTime, requestedTime);
  }

  const activeTimes = [...state.activeTimelineIds]
    .map((timelineIndex) => state.timelineTimes.get(timelineIndex) ?? state.currentTime);
  const synchronizedTime = Math.min(...activeTimes);

  return Math.max(state.currentTime, synchronizedTime);
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

  for (const metric of elementMetrics) {
    metric.waitTimeStddev = standardDeviation(metric.waitTimeSamples ?? []);
  }

  const flowCounts = countFlowsUntil(flowActivations, currentTime);
  const flowMetrics = result.flowMetrics.map((metric) => ({
    ...metric,
    count: flowCounts.get(metric.flowId) ?? 0
  }));

  const finishedCases = result.cases.filter((caseTrace) => caseTrace.endTime <= currentTime && caseTrace.status !== 'running');
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

function buildTimeline(
  caseTrace: CaseTrace,
  enterTimes: Map<string, number[]> | undefined,
  elementRegistry: ElementRegistry
): TimelineStep[] {
  const timeline: TimelineStep[] = [];
  let previousTime = caseTrace.startTime;

  for (const elementId of caseTrace.path) {
    const element = elementRegistry.get(elementId);

    if (element?.waypoints?.length) {
      const current = timeline.at(-1);

      if (current) {
        current.outgoingFlowId = elementId;
      }

      continue;
    }

    const queuedTimes = enterTimes?.get(elementId) ?? [];
    const time = queuedTimes.shift() ?? previousTime;

    timeline.push({
      nodeId: elementId,
      time
    });
    previousTime = time;
  }

  return timeline;
}

function createEnterTimeQueuesByCase(log: SimulationLogEntry[]): Map<number, Map<string, number[]>> {
  const timesByCase = new Map<number, Map<string, number[]>>();

  for (const entry of log) {
    if (entry.caseId === undefined || entry.eventType !== 'TOKEN_ENTER_ELEMENT' || !entry.elementId) {
      continue;
    }

    const times = timesByCase.get(entry.caseId) ?? new Map<string, number[]>();
    const elementTimes = times.get(entry.elementId) ?? [];

    elementTimes.push(entry.time ?? 0);
    times.set(entry.elementId, elementTimes);
    timesByCase.set(entry.caseId, times);
  }

  return timesByCase;
}

function metricKey(caseId: number | undefined, elementId: string): string {
  return `${caseId ?? 'global'}:${elementId}`;
}

function elementIdFromMetricKey(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

function createFlowActivations(timelines: TimelineStep[][]): FlowActivation[] {
  return timelines
    .flatMap((timeline) => {
      return timeline.flatMap((step, index) => {
        if (!step.outgoingFlowId) {
          return [];
        }

        return [{
          flowId: step.outgoingFlowId,
          time: timeline[index + 1]?.time ?? step.time
        }];
      });
    })
    .sort((a, b) => a.time - b.time);
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

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
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

function createPolylinePath(waypoints: Array<{ x: number; y: number }>): PolylinePath {
  const segments: PolylineSegment[] = [];
  let totalLength = 0;

  for (let index = 1; index < waypoints.length; index += 1) {
    const start = waypoints[index - 1];
    const end = waypoints[index];
    const length = Math.hypot(end.x - start.x, end.y - start.y);

    segments.push({
      start,
      end,
      length,
      startLength: totalLength
    });
    totalLength += length;
  }

  return {
    segments,
    totalLength
  };
}

function pointAt(path: PolylinePath, progress: number): { x: number; y: number } {
  const targetLength = path.totalLength * Math.max(0, Math.min(1, progress));
  const segment = path.segments.find((candidate) => {
    return candidate.startLength + candidate.length >= targetLength;
  }) ?? path.segments.at(-1);

  if (!segment || segment.length === 0) {
    return {
      x: 0,
      y: 0
    };
  }

  const localProgress = Math.max(0, Math.min(1, (targetLength - segment.startLength) / segment.length));

  return {
    x: segment.start.x + (segment.end.x - segment.start.x) * localProgress,
    y: segment.start.y + (segment.end.y - segment.start.y) * localProgress
  };
}

function colorForCase(index: number): DesAnimationScope {
  const hue = (index * 47) % 360;

  return {
    primary: `hsl(${hue} 70% 42%)`,
    auxiliary: '#ffffff'
  };
}

function isTaskLike(element: DiagramElement | undefined): boolean {
  return Boolean(element && element.width && element.height && element.width >= 80 && element.height >= 50);
}
