import type { SimModel, SimNode } from '../types/bpmn';
import type { SimulationConfig, SimulationEvent, Token } from '../types/simulation';
import { BpmnSimulationInterpreter } from './BpmnSimulationInterpreter';
import { EventQueue } from './EventQueue';
import { sampleOutputObject } from './OutputObjects';
import { bernoulli, pickWeighted, sampleDuration, sampleInterarrival, SeededRandom } from './RandomDistributions';
import { addWorkingTime } from './ResourceCalendar';
import { ResourceManager, type QueuedTask } from './ResourceManager';
import { SimulationClock } from './SimulationClock';
import { StatisticsCollector } from './StatisticsCollector';
import { TokenStore } from './TokenStore';

type CaseArrivalPayload = {
  caseId: number;
  startNodeId: string;
};

type TokenPayload = {
  token: Token;
};

type ElementTokenPayload = TokenPayload & {
  elementId: string;
};

type TaskStartPayload = ElementTokenPayload & {
  arrivedAt: number;
};

type TaskCompletePayload = ElementTokenPayload & {
  serviceTime: number;
  resourceId?: string;
};

type TaskFailedPayload = ElementTokenPayload & {
  errorCode?: string;
  serviceError?: boolean;
};

type TaskFailureOutcome =
  | 'retry'
  | {
      errorCode: string;
      serviceError: boolean;
    }
  | undefined;

export class DesEngine {
  private readonly model: SimModel;
  private readonly options: SimulationConfig;
  private readonly queue = new EventQueue();
  private readonly clock = new SimulationClock();
  private readonly random: SeededRandom;
  private readonly tokens = new TokenStore();
  private readonly resources = new ResourceManager();
  private readonly statistics = new StatisticsCollector();
  private readonly interpreter: BpmnSimulationInterpreter;

  constructor(model: SimModel, options: SimulationConfig) {
    this.model = model;
    this.options = normalizeConfig(options);
    this.random = new SeededRandom(this.options.randomSeed);
    this.interpreter = new BpmnSimulationInterpreter(model);
  }

  run() {
    const startedAt = new Date();

    this.logUnsupportedElements();
    this.scheduleCaseArrivals();

    const maxEvents = Math.max(10000, this.options.numberOfRuns * 2500);
    let processedEvents = 0;

    while (this.queue.length) {
      const event = this.queue.pop();

      if (!event) {
        break;
      }

      if (this.options.maxSimulationTime !== undefined && event.time > this.options.maxSimulationTime) {
        this.clock.advanceTo(this.options.maxSimulationTime);
        this.statistics.warn(`Simulation bei Zeithorizont ${this.options.maxSimulationTime} gestoppt.`);
        break;
      }

      this.clock.advanceTo(event.time);
      processedEvents += 1;

      if (processedEvents > maxEvents) {
        this.statistics.warn('Simulation gestoppt: Ereignislimit erreicht. Das Modell enthaelt vermutlich eine Endlosschleife.');
        break;
      }

      this.dispatch(event);
    }

    const completedAt = new Date();
    const cases = this.tokens.toTraces(this.clock.now);

    return this.statistics.buildResult(
      this.model,
      this.options,
      startedAt,
      completedAt,
      cases,
      this.clock.now
    );
  }

  private dispatch(event: SimulationEvent): void {
    this.recordEvent(event);

    switch (event.type) {
      case 'CASE_ARRIVAL':
        this.handleCaseArrival(event.payload as CaseArrivalPayload, event.time);
        break;
      case 'TOKEN_ENTER_ELEMENT':
        this.enterElement((event.payload as TokenPayload).token, event.time);
        break;
      case 'TASK_START':
        this.startTask(event.payload as TaskStartPayload, event.time);
        break;
      case 'TASK_COMPLETE':
        this.completeTask(event.payload as TaskCompletePayload, event.time);
        break;
      case 'TIMER_FIRED':
        this.leaveElement(event.payload as ElementTokenPayload, event.time);
        break;
      case 'TOKEN_LEAVE_ELEMENT':
        this.leaveElement(event.payload as ElementTokenPayload, event.time);
        break;
      case 'PROCESS_INSTANCE_COMPLETE':
        this.completeProcessInstance(event.payload as ElementTokenPayload, event.time);
        break;
      case 'TASK_FAILED':
        this.failTask(event.payload as TaskFailedPayload, event.time);
        break;
      case 'RETRY_TASK':
        this.enterElement((event.payload as TokenPayload).token, event.time);
        break;
      case 'MESSAGE_RECEIVED':
        this.statistics.warn('MESSAGE_RECEIVED ist als Eventtyp vorbereitet, aber Message Events sind noch nicht implementiert.', undefined, event.time);
        break;
    }
  }

  private scheduleCaseArrivals(): void {
    const startNode = this.interpreter.getStartNode();
    const arrival = startNode.params.arrival;
    const numberOfCases = Math.max(1, Math.floor(this.options.numberOfRuns || arrival?.numberOfCases || 1));
    let time = this.options.startTime ?? 0;

    for (let caseId = 1; caseId <= numberOfCases; caseId += 1) {
      if (caseId > 1) {
        if (arrival?.type === 'fixedInterval') {
          time += arrival.interval ?? arrival.mean ?? 1;
        } else if (arrival?.type === 'schedule') {
          this.statistics.warn(
            'arrivalDistribution "schedule" ist vorbereitet. Bis zur Kalenderauswertung wird fixedInterval als Fallback genutzt.',
            startNode.id
          );
          time += arrival.interval ?? 1;
        } else {
          time += sampleInterarrival(arrival?.mean ?? arrival?.interval ?? 1, this.random);
        }
      }

      this.queue.schedule('CASE_ARRIVAL', time, {
        caseId,
        startNodeId: startNode.id
      });
    }

    if (this.model.startNodeIds.length > 1) {
      this.statistics.warn('Mehrere Start Events gefunden. Fuer diese Simulation wird das erste Start Event verwendet.');
    }
  }

  private handleCaseArrival(payload: CaseArrivalPayload, time: number): void {
    this.tokens.createCase(payload.caseId, time);
    this.scheduleEnter(
      this.tokens.createToken(payload.caseId, payload.startNodeId),
      time,
      true
    );
  }

  private enterElement(token: Token, time: number): void {
    const node = this.interpreter.getNode(token.elementId);

    if (!node) {
      this.tokens.consume(token.caseId, time);
      return;
    }

    this.tokens.recordPath(token.caseId, node.id, this.options.collectTraces);
    this.statistics.recordVisit(node);

    if (!node.supported) {
      this.statistics.warn(`Element "${node.name}" wird noch nicht unterstuetzt und als transparenter Durchlauf behandelt.`, node.id, time);
      this.queue.schedule('TOKEN_LEAVE_ELEMENT', time, {
        token,
        elementId: node.id
      });
      return;
    }

    if (node.params.enabled === false) {
      this.queue.schedule('TOKEN_LEAVE_ELEMENT', time, {
        token,
        elementId: node.id
      });
      return;
    }

    if (this.interpreter.isJoiningGateway(node)) {
      this.enterJoinGateway(token, node, time);
      return;
    }

    const subProcessStartIds = this.interpreter.getSubProcessStarts(node);

    if (subProcessStartIds.length) {
      for (const startId of subProcessStartIds) {
        this.scheduleEnter(this.tokens.createToken(token.caseId, startId), time, true);
      }

      this.statistics.recordCompletion(node);
      this.tokens.consume(token.caseId, time);
      return;
    }

    if (this.interpreter.isTask(node)) {
      this.queue.schedule('TASK_START', time, {
        token,
        elementId: node.id,
        arrivedAt: time
      });
      return;
    }

    if (this.interpreter.isTimer(node)) {
      this.queue.schedule('TIMER_FIRED', time + minutesToHours(sampleDuration(node.params.duration, this.random)), {
        token,
        elementId: node.id
      });
      return;
    }

    if (this.interpreter.isRootEndEvent(node)) {
      this.queue.schedule('PROCESS_INSTANCE_COMPLETE', time, {
        token,
        elementId: node.id
      });
      return;
    }

    this.queue.schedule('TOKEN_LEAVE_ELEMENT', time, {
      token,
      elementId: node.id
    });
  }

  private enterJoinGateway(token: Token, node: SimNode, time: number): void {
    const caseState = this.tokens.getCase(token.caseId);

    if (!caseState) {
      return;
    }

    const required = Math.max(2, node.incoming.length);
    const arrived = (caseState.joinCounts.get(node.id) ?? 0) + 1;

    if (arrived < required) {
      caseState.joinCounts.set(node.id, arrived);
      return;
    }

    caseState.joinCounts.set(node.id, 0);
    this.routeOutgoing(token, node, time);
    this.tokens.consume(token.caseId, time, required);
  }

  private startTask(payload: TaskStartPayload, time: number): void {
    const node = this.interpreter.getNode(payload.elementId);

    if (!node) {
      this.tokens.consume(payload.token.caseId, time);
      return;
    }

    const resourceStart = this.resources.request(node, payload.token, time);

    if (!resourceStart.started) {
      if (resourceStart.delayedUntil !== undefined && resourceStart.delayedUntil > time) {
        this.queue.schedule('TASK_START', resourceStart.delayedUntil, payload);
      }

      return;
    }

    this.scheduleTaskCompletion(node, payload.token, payload.arrivedAt, time, resourceStart.resourceId);
  }

  private completeTask(payload: TaskCompletePayload, time: number): void {
    const node = this.interpreter.getNode(payload.elementId);

    if (!node) {
      this.tokens.consume(payload.token.caseId, time);
      return;
    }

    for (const queued of this.resources.release(payload.resourceId)) {
      this.startQueuedTask(queued, time);
    }

    const failure = this.sampleFailure(node, payload.token);

    if (failure === 'retry') {
      const retryToken = {
        ...payload.token,
        attempt: payload.token.attempt + 1
      };
      const delay = minutesToHours(sampleDuration(node.params.failure?.retryDelay, this.random));

      this.tokens.incrementRetries(payload.token.caseId);
      this.statistics.recordRetry(node);
      this.queue.schedule('RETRY_TASK', time + delay, {
        token: retryToken
      });
      return;
    }

    if (failure) {
      if (failure.serviceError) {
        this.statistics.warn(
          `Service Task "${node.name}" erzeugte Fehler "${failure.errorCode}". Boundary Error Events sind noch nicht implementiert; der Task wird als fehlgeschlagen markiert.`,
          node.id,
          time
        );
      }

      this.queue.schedule('TASK_FAILED', time, {
        token: payload.token,
        elementId: node.id,
        errorCode: failure.errorCode,
        serviceError: failure.serviceError
      });
      return;
    }

    this.statistics.recordCompletion(node);
    this.captureOutput(payload.token.caseId, node);
    this.statistics.updateLastEventVariables(
      payload.token.caseId,
      node.id,
      'TASK_COMPLETE',
      this.tokens.getCase(payload.token.caseId)?.outputs
    );
    this.queue.schedule('TOKEN_LEAVE_ELEMENT', time, {
      token: payload.token,
      elementId: node.id
    });
  }

  private failTask(payload: TaskFailedPayload, time: number): void {
    const node = this.interpreter.getNode(payload.elementId);

    if (node) {
      this.statistics.recordError(node);
    }

    this.tokens.fail(payload.token.caseId, payload.errorCode, time);
  }

  private leaveElement(payload: ElementTokenPayload, time: number): void {
    const node = this.interpreter.getNode(payload.elementId);

    if (!node) {
      this.tokens.consume(payload.token.caseId, time);
      return;
    }

    this.routeOutgoing(payload.token, node, time);

    if (!node.outgoing.length && node.kind !== 'endEvent') {
      this.statistics.warn(`Element "${node.name}" hat keinen ausgehenden Pfad. Case ${payload.token.caseId} endet dort.`, node.id, time);
    }

    this.tokens.consume(payload.token.caseId, time);
  }

  private completeProcessInstance(payload: ElementTokenPayload, time: number): void {
    const node = this.interpreter.getNode(payload.elementId);

    if (node) {
      this.statistics.recordCompletion(node);
    }

    this.queue.schedule('TOKEN_LEAVE_ELEMENT', time, payload);
  }

  private routeOutgoing(token: Token, node: SimNode, time: number): void {
    const caseState = this.tokens.getCase(token.caseId);

    const flowIds = this.interpreter.getOutgoingFlowIds(node, this.random, (entry) => {
      if (entry.level === 'warning') {
        this.statistics.warn(entry.message, entry.elementId, entry.time ?? time);
      } else if (entry.level === 'error') {
        this.statistics.error(entry.message, entry.elementId, entry.time ?? time);
      } else {
        this.statistics.info(entry.message, entry.elementId, entry.time ?? time);
      }
    }, {
      caseId: token.caseId,
      outputs: caseState?.outputs
    });

    for (const flowId of flowIds) {
      const flow = this.interpreter.getFlow(flowId);

      if (!flow) {
        continue;
      }

      this.tokens.recordPath(token.caseId, flow.id, this.options.collectTraces);
      this.statistics.recordFlow(flow);
      this.scheduleEnter(this.tokens.createToken(token.caseId, flow.targetId), time, true);
    }
  }

  private scheduleEnter(token: Token, time: number, activate: boolean): void {
    if (activate) {
      this.tokens.activate(token);
    }

    this.queue.schedule('TOKEN_ENTER_ELEMENT', time, {
      token
    });
  }

  private scheduleTaskCompletion(
    node: SimNode,
    token: Token,
    arrivedAt: number,
    time: number,
    resourceId?: string
  ): void {
    const serviceTime = sampleDuration(node.params.duration, this.random);
    const completionTime = addWorkingTime(time, minutesToHours(serviceTime), node.params.resource);

    this.statistics.recordService(node, hoursToMinutes(time - arrivedAt), serviceTime);
    this.queue.schedule('TASK_COMPLETE', completionTime, {
      token,
      elementId: node.id,
      serviceTime,
      resourceId
    });
  }

  private startQueuedTask(queued: QueuedTask, time: number): void {
    const resourceStart = this.resources.request(queued.node, queued.token, time);

    if (!resourceStart.started) {
      if (resourceStart.delayedUntil !== undefined && resourceStart.delayedUntil > time) {
        this.queue.schedule('TASK_START', resourceStart.delayedUntil, {
          token: queued.token,
          elementId: queued.node.id,
          arrivedAt: queued.arrivedAt
        });
      }

      return;
    }

    this.scheduleTaskCompletion(queued.node, queued.token, queued.arrivedAt, time, resourceStart.resourceId);
  }

  private sampleFailure(node: SimNode, token: Token): TaskFailureOutcome {
    if (node.kind === 'serviceTask' && bernoulli(node.params.error?.probability, this.random)) {
      const retryCount = Math.max(0, node.params.failure?.retryCount ?? 0);

      if (token.attempt < retryCount) {
        return 'retry';
      }

      return {
        errorCode: pickWeighted(node.params.error?.possibleErrors, this.random)?.errorCode ?? 'SERVICE_ERROR',
        serviceError: true
      };
    }

    if (!bernoulli(node.params.failure?.probability, this.random)) {
      return undefined;
    }

    const retryCount = Math.max(0, node.params.failure?.retryCount ?? 0);

    if (token.attempt < retryCount) {
      return 'retry';
    }

    return {
      errorCode: 'TASK_FAILED',
      serviceError: false
    };
  }

  private captureOutput(caseId: number, node: SimNode): void {
    const outputObject = sampleOutputObject(node.params.outputObject, this.random);

    if (Object.keys(outputObject).length) {
      this.tokens.setOutputObject(caseId, node.id, outputObject);
    }
  }

  private logUnsupportedElements(): void {
    for (const elementId of this.model.unsupportedElementIds) {
      const node = this.model.nodes.get(elementId);

      this.statistics.warn(
        `Element "${node?.name ?? elementId}" ist fuer spaetere Unterstuetzung vorbereitet, wird aktuell aber transparent behandelt.`,
        elementId
      );
    }
  }

  private recordEvent(event: SimulationEvent): void {
    const payload = event.payload as Partial<TokenPayload & ElementTokenPayload & CaseArrivalPayload & TaskCompletePayload>;
    const token = payload.token;
    const elementId = payload.elementId ?? token?.elementId ?? payload.startNodeId;
    const node = elementId ? this.interpreter.getNode(elementId) : undefined;
    const caseId = token?.caseId ?? payload.caseId;
    const caseState = caseId !== undefined ? this.tokens.getCase(caseId) : undefined;

    this.statistics.event(event.type, event.type, {
      time: event.time,
      caseId,
      elementId,
      elementName: node?.name,
      resourceId: payload.resourceId ?? node?.params.resource?.resourceId,
      variables: caseState?.outputs
    });
  }
}

function normalizeConfig(config: SimulationConfig): SimulationConfig {
  return {
    numberOfRuns: Math.max(1, Math.floor(config.numberOfRuns || 1)),
    maxSimulationTime: config.maxSimulationTime,
    startTime: Math.max(0, config.startTime ?? 0),
    startDateTime: config.startDateTime,
    endDateTime: config.endDateTime,
    randomSeed: config.randomSeed || 1,
    animationSpeed: config.animationSpeed || 1,
    collectTraces: config.collectTraces
  };
}

function minutesToHours(minutes: number): number {
  return Math.max(0, minutes) / 60;
}

function hoursToMinutes(hours: number): number {
  return Math.max(0, hours) * 60;
}
