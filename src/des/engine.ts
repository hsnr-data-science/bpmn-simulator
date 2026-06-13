import { EventQueue } from './eventQueue';
import { bernoulli, clampProbability, sampleDuration, SeededRandom } from './random';
import type {
  CaseResult,
  ElementMetrics,
  FlowMetrics,
  SimFlow,
  SimModel,
  SimNode,
  SimulationOptions,
  SimulationResult,
  TokenPayload
} from './types';

type QueuePayload =
  | {
      type: 'enter';
      token: TokenPayload;
    }
  | {
      type: 'completeActivity';
      token: TokenPayload;
      elementId: string;
      serviceTime: number;
      resourceKey?: string;
    };

type CaseState = {
  id: number;
  startTime: number;
  endTime?: number;
  activeTokens: number;
  failed: boolean;
  retries: number;
  path: string[];
  outputs: Record<string, string>;
  joinCounts: Map<string, number>;
};

type ResourceState = {
  key: string;
  capacity: number;
  busy: number;
  queue: Array<{
    token: TokenPayload;
    node: SimNode;
    arrivedAt: number;
  }>;
};

export class DiscreteEventSimulator {
  private readonly model: SimModel;
  private readonly options: SimulationOptions;
  private readonly random: SeededRandom;
  private readonly queue = new EventQueue<QueuePayload>();
  private readonly cases = new Map<number, CaseState>();
  private readonly elementMetrics = new Map<string, ElementMetrics>();
  private readonly flowMetrics = new Map<string, FlowMetrics>();
  private readonly resources = new Map<string, ResourceState>();
  private readonly warnings: string[] = [];
  private currentTime = 0;

  constructor(model: SimModel, options: SimulationOptions) {
    this.model = model;
    this.options = {
      ...options,
      cases: Math.max(1, Math.floor(options.cases)),
      seed: options.seed || 1
    };
    this.random = new SeededRandom(this.options.seed);
  }

  run(): SimulationResult {
    const startedAt = new Date();

    this.scheduleCases();

    const maxEvents = Math.max(10000, this.options.cases * 2000);
    let processedEvents = 0;

    while (this.queue.length) {
      const event = this.queue.pop();

      if (!event) {
        break;
      }

      if (this.options.untilTime !== undefined && event.time > this.options.untilTime) {
        this.currentTime = this.options.untilTime;
        this.warnings.push(`Simulation bei Zeithorizont ${this.options.untilTime} gestoppt.`);
        break;
      }

      this.currentTime = event.time;
      processedEvents += 1;

      if (processedEvents > maxEvents) {
        this.warnings.push('Simulation gestoppt: Ereignislimit erreicht. Das Modell enthaelt vermutlich eine Endlosschleife.');
        break;
      }

      if (event.payload.type === 'enter') {
        this.enterNode(event.time, event.payload.token);
      } else {
        this.completeActivity(event.time, event.payload);
      }
    }

    const completedAt = new Date();
    const cases = this.collectCases();
    const finishedCycleTimes = cases
      .filter((caseResult) => caseResult.status !== 'running')
      .map((caseResult) => caseResult.cycleTime)
      .sort((a, b) => a - b);

    const completedCases = cases.filter((caseResult) => caseResult.status === 'completed').length;
    const failedCases = cases.filter((caseResult) => caseResult.status === 'failed').length;
    const maxTime = Math.max(...cases.map((caseResult) => caseResult.endTime), this.currentTime, 0);

    return {
      startedAt,
      completedAt,
      options: this.options,
      processName: this.model.name,
      cases,
      completedCases,
      failedCases,
      cycleTimeAverage: average(finishedCycleTimes),
      cycleTimeP50: percentile(finishedCycleTimes, 0.5),
      cycleTimeP90: percentile(finishedCycleTimes, 0.9),
      cycleTimeMax: finishedCycleTimes[finishedCycleTimes.length - 1] ?? 0,
      throughputPerTimeUnit: maxTime > 0 ? completedCases / maxTime : completedCases,
      elementMetrics: [...this.elementMetrics.values()].sort((a, b) => b.visits - a.visits),
      flowMetrics: [...this.flowMetrics.values()].sort((a, b) => b.count - a.count),
      warnings: this.warnings
    };
  }

  private scheduleCases(): void {
    const startNodeId = this.model.startNodeIds[0];
    const startNode = this.model.nodes.get(startNodeId);
    let startTime = 0;

    for (let caseId = 1; caseId <= this.options.cases; caseId += 1) {
      if (caseId > 1 && startNode?.params.arrivalIntervalMean) {
        startTime += sampleInterArrival(startNode.params.arrivalIntervalMean, this.random);
      }

      this.cases.set(caseId, {
        id: caseId,
        startTime,
        activeTokens: 0,
        failed: false,
        retries: 0,
        path: [],
        outputs: {},
        joinCounts: new Map()
      });

      this.scheduleEnter(startTime, {
        caseId,
        elementId: startNodeId,
        attempt: 0
      });
    }

    if (this.model.startNodeIds.length > 1) {
      this.warnings.push('Mehrere Start Events gefunden. Fuer diese Simulation wird das erste Start Event verwendet.');
    }
  }

  private enterNode(time: number, token: TokenPayload): void {
    const node = this.model.nodes.get(token.elementId);
    const caseState = this.cases.get(token.caseId);

    if (!caseState || !node) {
      this.consumeToken(token.caseId, time);
      return;
    }

    caseState.path.push(node.id);
    const metrics = this.getElementMetrics(node);
    metrics.visits += 1;

    if (node.params.enabled === false) {
      this.routeFromNode(time, token, node, node.outgoing);
      return;
    }

    if (this.isJoiningGateway(node)) {
      const required = Math.max(2, node.incoming.length);
      const arrived = (caseState.joinCounts.get(node.id) ?? 0) + 1;

      if (arrived < required) {
        caseState.joinCounts.set(node.id, arrived);
        return;
      }

      caseState.joinCounts.set(node.id, 0);
      this.routeFromGatewayJoin(time, caseState, token, node, required);
      return;
    }

    if (node.kind === 'activity') {
      this.enterActivity(time, token, node);
      return;
    }

    if (node.kind === 'endEvent') {
      metrics.completions += 1;
      this.consumeToken(token.caseId, time);
      return;
    }

    const selectedOutgoing = this.selectOutgoingFlows(node);
    this.routeFromNode(time, token, node, selectedOutgoing);
  }

  private enterActivity(time: number, token: TokenPayload, node: SimNode): void {
    const resource = this.getResource(node);

    if (!resource) {
      this.startActivity(time, token, node, time);
      return;
    }

    if (resource.busy < resource.capacity) {
      resource.busy += 1;
      this.startActivity(time, token, node, time, resource.key);
      return;
    }

    resource.queue.push({
      token,
      node,
      arrivedAt: time
    });
  }

  private startActivity(
    time: number,
    token: TokenPayload,
    node: SimNode,
    arrivedAt: number,
    resourceKey?: string
  ): void {
    const metrics = this.getElementMetrics(node);
    const serviceTime = sampleDuration(node.params, this.random);

    metrics.waitTime += Math.max(0, time - arrivedAt);
    metrics.serviceTime += serviceTime;

    this.queue.push(time + serviceTime, {
      type: 'completeActivity',
      token,
      elementId: node.id,
      serviceTime,
      resourceKey
    });
  }

  private completeActivity(time: number, event: Extract<QueuePayload, { type: 'completeActivity' }>): void {
    const node = this.model.nodes.get(event.elementId);
    const caseState = this.cases.get(event.token.caseId);

    if (!node || !caseState) {
      this.consumeToken(event.token.caseId, time);
      return;
    }

    if (event.resourceKey) {
      this.releaseResource(time, event.resourceKey);
    }

    const metrics = this.getElementMetrics(node);
    const outcome = this.sampleActivityOutcome(node, event.token.attempt);

    if (outcome === 'retry') {
      caseState.retries += 1;
      metrics.retries += 1;
      this.queue.push(time + Math.max(0, node.params.retryDelay ?? 0), {
        type: 'enter',
        token: {
          ...event.token,
          attempt: event.token.attempt + 1
        }
      });
      return;
    }

    if (outcome === 'error') {
      metrics.errors += 1;
      caseState.failed = true;
      this.consumeToken(event.token.caseId, time);
      return;
    }

    metrics.completions += 1;
    this.captureOutput(caseState, node);
    this.routeFromNode(time, event.token, node, node.outgoing);
  }

  private releaseResource(time: number, key: string): void {
    const resource = this.resources.get(key);

    if (!resource) {
      return;
    }

    resource.busy = Math.max(0, resource.busy - 1);

    while (resource.queue.length && resource.busy < resource.capacity) {
      const next = resource.queue.shift();

      if (!next) {
        break;
      }

      resource.busy += 1;
      this.startActivity(time, next.token, next.node, next.arrivedAt, key);
    }
  }

  private routeFromGatewayJoin(
    time: number,
    caseState: CaseState,
    token: TokenPayload,
    node: SimNode,
    consumedTokens: number
  ): void {
    const selectedOutgoing = this.selectOutgoingFlows(node);

    for (const flowId of selectedOutgoing) {
      this.takeFlow(time, token.caseId, flowId);
    }

    caseState.activeTokens = Math.max(0, caseState.activeTokens - consumedTokens);
    this.finishCaseIfDone(caseState, time);
  }

  private routeFromNode(time: number, token: TokenPayload, node: SimNode, outgoingFlowIds: string[]): void {
    const selectedOutgoing =
      node.outgoing.length > 1 && !['exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway'].includes(node.kind)
        ? this.selectWeightedFlow(node.outgoing)
        : outgoingFlowIds;

    if (node.outgoing.length > 1 && node.kind === 'activity') {
      this.warnings.push(`Activity "${node.name}" hat mehrere ausgehende Flows. Die DES-Engine waehlt stochastisch genau einen davon.`);
    }

    for (const flowId of selectedOutgoing) {
      this.takeFlow(time, token.caseId, flowId);
    }

    if (!selectedOutgoing.length && node.kind !== 'endEvent') {
      this.warnings.push(`Element "${node.name}" hat keinen ausgehenden Pfad. Case ${token.caseId} endet dort.`);
    }

    this.consumeToken(token.caseId, time);
  }

  private takeFlow(time: number, caseId: number, flowId: string): void {
    const flow = this.model.flows.get(flowId);
    const caseState = this.cases.get(caseId);

    if (!flow || !caseState) {
      return;
    }

    caseState.path.push(flow.id);
    const metrics = this.getFlowMetrics(flow);
    metrics.count += 1;

    this.scheduleEnter(time, {
      caseId,
      elementId: flow.targetId,
      attempt: 0
    });
  }

  private scheduleEnter(time: number, token: TokenPayload): void {
    const caseState = this.cases.get(token.caseId);

    if (caseState) {
      caseState.activeTokens += 1;
    }

    this.queue.push(time, {
      type: 'enter',
      token
    });
  }

  private consumeToken(caseId: number, time: number): void {
    const caseState = this.cases.get(caseId);

    if (!caseState) {
      return;
    }

    caseState.activeTokens = Math.max(0, caseState.activeTokens - 1);
    this.finishCaseIfDone(caseState, time);
  }

  private finishCaseIfDone(caseState: CaseState, time: number): void {
    if (caseState.activeTokens === 0 && caseState.endTime === undefined) {
      caseState.endTime = time;
    }
  }

  private isJoiningGateway(node: SimNode): boolean {
    return ['parallelGateway', 'inclusiveGateway'].includes(node.kind) && node.incoming.length > 1;
  }

  private selectOutgoingFlows(node: SimNode): string[] {
    switch (node.kind) {
      case 'parallelGateway':
        return [...node.outgoing];
      case 'inclusiveGateway': {
        const selected = node.outgoing.filter((flowId) => {
          const probability = this.model.flows.get(flowId)?.params.probability;

          return bernoulli(probability ?? 0.5, this.random);
        });

        return selected.length ? selected : this.selectWeightedFlow(node.outgoing);
      }
      case 'exclusiveGateway':
      case 'eventBasedGateway':
        return this.selectWeightedFlow(node.outgoing);
      default:
        return [...node.outgoing];
    }
  }

  private selectWeightedFlow(flowIds: string[]): string[] {
    if (!flowIds.length) {
      return [];
    }

    const weights = flowIds.map((flowId) => {
      return clampProbability(this.model.flows.get(flowId)?.params.probability ?? 0);
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);

    if (total <= 0) {
      return [flowIds[Math.floor(this.random.next() * flowIds.length)]];
    }

    let needle = this.random.next() * total;

    for (let index = 0; index < flowIds.length; index += 1) {
      needle -= weights[index];

      if (needle <= 0) {
        return [flowIds[index]];
      }
    }

    return [flowIds[flowIds.length - 1]];
  }

  private sampleActivityOutcome(node: SimNode, attempt: number): 'success' | 'retry' | 'error' {
    const maxRetries = Math.max(0, node.params.maxRetries ?? 0);
    const retryProbability = clampProbability(node.params.retryProbability ?? 0);
    const explicitErrorProbability = node.params.errorProbability;
    const errorProbability = clampProbability(
      explicitErrorProbability ?? Math.max(0, 1 - (node.params.successProbability ?? 1) - retryProbability)
    );
    const draw = this.random.next();

    if (draw < retryProbability) {
      return attempt < maxRetries ? 'retry' : 'error';
    }

    if (draw < retryProbability + errorProbability) {
      return 'error';
    }

    return 'success';
  }

  private captureOutput(caseState: CaseState, node: SimNode): void {
    if (!node.params.outputKey || !node.params.outputValues?.length) {
      return;
    }

    caseState.outputs[node.params.outputKey] = this.random.pick(node.params.outputValues);
  }

  private getResource(node: SimNode): ResourceState | undefined {
    const capacity = node.params.resourceCapacity;

    if (!capacity || capacity <= 0 || !Number.isFinite(capacity)) {
      return undefined;
    }

    const key = node.params.resourcePool?.trim() || node.id;
    const existing = this.resources.get(key);

    if (existing) {
      return existing;
    }

    const resource = {
      key,
      capacity,
      busy: 0,
      queue: []
    };

    this.resources.set(key, resource);

    return resource;
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
      serviceTime: 0
    };

    this.elementMetrics.set(node.id, metrics);

    return metrics;
  }

  private getFlowMetrics(flow: SimFlow): FlowMetrics {
    const existing = this.flowMetrics.get(flow.id);

    if (existing) {
      return existing;
    }

    const metrics = {
      flowId: flow.id,
      name: flow.name,
      count: 0
    };

    this.flowMetrics.set(flow.id, metrics);

    return metrics;
  }

  private collectCases(): CaseResult[] {
    return [...this.cases.values()].map((caseState) => {
      const endTime = caseState.endTime ?? this.currentTime;
      const status = caseState.endTime === undefined ? 'running' : caseState.failed ? 'failed' : 'completed';

      if (status === 'running') {
        this.warnings.push(`Case ${caseState.id} ist am Simulationsende noch aktiv.`);
      }

      return {
        id: caseState.id,
        startTime: caseState.startTime,
        endTime,
        cycleTime: Math.max(0, endTime - caseState.startTime),
        status,
        retries: caseState.retries,
        path: caseState.path,
        outputs: caseState.outputs
      };
    });
  }
}

function sampleInterArrival(mean: number, random: SeededRandom): number {
  const u = Math.max(random.next(), Number.EPSILON);

  return -Math.log(u) * Math.max(mean, Number.EPSILON);
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
