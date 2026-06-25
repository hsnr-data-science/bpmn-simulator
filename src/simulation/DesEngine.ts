import type { SimEventDefinition, SimMessageFlow, SimModel, SimNode } from '../types/bpmn';
import type {
  CaseOutputValue,
  CaseTrigger,
  SimulationConfig,
  SimulationEvent,
  Token
} from '../types/simulation';
import { BpmnSimulationInterpreter } from './BpmnSimulationInterpreter';
import { EventQueue } from './EventQueue';
import { sampleOutputObject } from './OutputObjects';
import { bernoulli, pickWeighted, sampleDuration, SeededRandom } from './RandomDistributions';
import { addWorkingTime, nextResourceAvailability, normalizeResourceSchedule } from './ResourceCalendar';
import { ResourceManager, type QueuedTask } from './ResourceManager';
import { SimulationClock } from './SimulationClock';
import { StatisticsCollector } from './StatisticsCollector';
import { TokenStore } from './TokenStore';

type CaseArrivalPayload = {
  caseId: number;
  startNodeId: string;
  processId?: string;
  trigger?: CaseTrigger;
  sourceCaseId?: number;
  triggerElementId?: string;
  triggerEventKey?: string;
  variables?: Record<string, CaseOutputValue>;
};

type ExternalEventPayload = {
  startNodeId: string;
  eventKey?: string;
};

type TokenPayload = {
  token: Token;
};

type ElementTokenPayload = TokenPayload & {
  elementId: string;
  eventBasedGatewayRaceId?: string;
  gatewayId?: string;
  incomingFlowId?: string;
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

type EventReceivedPayload = ElementTokenPayload & {
  eventKey?: string;
  sourceCaseId?: number;
  sourceElementId?: string;
  variables?: Record<string, CaseOutputValue>;
};

type EventDelivery = {
  eventKey: string;
  sourceCaseId?: number;
  correlationCaseId?: number;
  sourceElementId?: string;
  variables?: Record<string, CaseOutputValue>;
};

type EventBasedGatewayRace = {
  id: string;
  caseId: number;
  gatewayId: string;
  active: boolean;
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
  private readonly waitingEventTokens = new Map<string, ElementTokenPayload[]>();
  private readonly pendingMessagesByTarget = new Map<string, EventDelivery[]>();
  private readonly pendingMessagesByKey = new Map<string, EventDelivery[]>();
  private readonly eventBasedGatewayRaces = new Map<string, EventBasedGatewayRace>();
  private nextCaseId = 1;

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
    if (this.isInactiveEventBasedGatewayEvent(event)) {
      return;
    }

    if (event.type !== 'TASK_START') {
      this.recordEvent(event);
    }

    switch (event.type) {
      case 'CASE_ARRIVAL':
        this.handleCaseArrival(event.payload as CaseArrivalPayload, event.time);
        break;
      case 'EXTERNAL_EVENT_OCCURRED':
        this.handleExternalEvent(event.payload as ExternalEventPayload, event.time);
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
        this.fireTimer(event.payload as ElementTokenPayload, event.time);
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
        this.retryTask((event.payload as TokenPayload).token, event.time);
        break;
      case 'MESSAGE_RECEIVED':
        this.receiveMessage(event.payload as EventReceivedPayload, event.time);
        break;
      case 'SIGNAL_RECEIVED':
        this.receiveSignal(event.payload as EventReceivedPayload, event.time);
        break;
    }
  }

  private isInactiveEventBasedGatewayEvent(event: SimulationEvent): boolean {
    if (
      event.type !== 'MESSAGE_RECEIVED' &&
      event.type !== 'SIGNAL_RECEIVED' &&
      event.type !== 'TIMER_FIRED'
    ) {
      return false;
    }

    const raceId = (event.payload as Partial<ElementTokenPayload> | undefined)?.eventBasedGatewayRaceId;

    return Boolean(raceId && !this.eventBasedGatewayRaces.get(raceId)?.active);
  }

  private scheduleCaseArrivals(): void {
    let scheduledStarts = 0;

    for (const startNode of this.interpreter.getRootStartNodes()) {
      if (startNode.params.enabled === false) {
        continue;
      }

      if (this.interpreter.isEventTriggeredStart(startNode)) {
        if (this.isCorrelatedEventStart(startNode)) {
          continue;
        }

        if (this.hasExplicitScheduledArrival(startNode)) {
          scheduledStarts += this.scheduleExternalEventArrivals(startNode);
        }

        continue;
      }

      scheduledStarts += this.scheduleCaseArrivalsForStart(startNode, 'arrival');
    }

    if (!scheduledStarts) {
      this.statistics.warn(
        'Kein automatisch startendes Start Event geplant. Die Simulation wartet auf Message-/Signal-Starts oder explizite externe Ereignisse.'
      );
    }
  }

  private handleCaseArrival(payload: CaseArrivalPayload, time: number): void {
    const startNode = this.interpreter.getNode(payload.startNodeId);
    const variables = withParentCaseId(payload.variables, payload.sourceCaseId);

    this.tokens.createCase(payload.caseId, time, {
      processId: payload.processId ?? startNode?.processId,
      trigger: payload.trigger ?? 'arrival',
      parentCaseId: payload.sourceCaseId,
      triggerElementId: payload.triggerElementId ?? payload.startNodeId,
      triggerEventKey: payload.triggerEventKey,
      outputs: variables
    });
    this.scheduleEnter(
      this.tokens.createToken(payload.caseId, payload.startNodeId),
      time,
      true
    );
  }

  private handleExternalEvent(payload: ExternalEventPayload, time: number): void {
    const startNode = this.interpreter.getNode(payload.startNodeId);

    if (!startNode) {
      return;
    }

    const eventKey = payload.eventKey ?? this.getPrimaryEventKey(startNode);

    this.statistics.info(
      `Externes Ereignis "${eventKey ?? startNode.name}" startet Prozess "${this.getProcessName(startNode.processId)}".`,
      startNode.id,
      time
    );
    this.startCaseAtNode(startNode, time, {
      trigger: 'externalEvent',
      triggerElementId: startNode.id,
      triggerEventKey: eventKey
    });
  }

  private scheduleCaseArrivalsForStart(startNode: SimNode, trigger: CaseTrigger): number {
    const arrival = startNode.params.arrival;

    if (!this.hasScheduledArrival(startNode)) {
      return 0;
    }

    const numberOfCases = Math.max(1, Math.floor(arrival?.numberOfCases ?? this.options.numberOfRuns ?? 1));
    let time = this.nextArrivalAvailability(startNode, this.options.startTime ?? 0);

    for (let index = 0; index < numberOfCases; index += 1) {
      if (index > 0) {
        time = this.nextArrivalTime(time, startNode);
      }

      this.queue.schedule('CASE_ARRIVAL', time, {
        caseId: this.allocateCaseId(),
        startNodeId: startNode.id,
        processId: startNode.processId,
        trigger,
        triggerElementId: startNode.id
      });
    }

    return numberOfCases;
  }

  private scheduleExternalEventArrivals(startNode: SimNode): number {
    const arrival = startNode.params.arrival;

    if (!this.hasScheduledArrival(startNode)) {
      return 0;
    }

    const numberOfEvents = Math.max(1, Math.floor(arrival?.numberOfCases ?? this.options.numberOfRuns ?? 1));
    const eventKey = this.getPrimaryEventKey(startNode);
    let time = this.nextArrivalAvailability(startNode, this.options.startTime ?? 0);

    for (let index = 0; index < numberOfEvents; index += 1) {
      if (index > 0) {
        time = this.nextArrivalTime(time, startNode);
      }

      this.queue.schedule('EXTERNAL_EVENT_OCCURRED', time, {
        startNodeId: startNode.id,
        eventKey
      });
    }

    return numberOfEvents;
  }

  private nextArrivalTime(currentTime: number, startNode: SimNode): number {
    const arrival = startNode.params.arrival;
    const type = arrival?.type ?? 'fixed';

    if (type === 'none') {
      return Number.POSITIVE_INFINITY;
    }

    if (type === 'fixed') {
      return this.nextArrivalAvailability(startNode, currentTime + minutesToHours(arrival?.interval ?? arrival?.mean ?? 1));
    }

    return this.nextArrivalAvailability(startNode, currentTime + minutesToHours(sampleArrivalDelay(arrival, this.random)));
  }

  private nextArrivalAvailability(startNode: SimNode, time: number): number {
    const arrival = startNode.params.arrival;

    if (!arrival || arrival.type === 'none') {
      return time;
    }

    return nextResourceAvailability(normalizeResourceSchedule(arrival, 'businessHours'), time);
  }

  private hasScheduledArrival(startNode: SimNode): boolean {
    return startNode.params.enabled !== false && startNode.params.arrival?.type !== 'none';
  }

  private hasExplicitScheduledArrival(startNode: SimNode): boolean {
    return startNode.params.enabled !== false &&
      Boolean(startNode.params.arrival) &&
      startNode.params.arrival?.type !== 'none';
  }

  private isCorrelatedEventStart(startNode: SimNode): boolean {
    return this.interpreter.getEventDefinitions(startNode, 'message', 'signal').length > 0;
  }

  private startCaseAtNode(
    startNode: SimNode,
    time: number,
    options: {
      trigger: CaseTrigger;
      sourceCaseId?: number;
      triggerElementId?: string;
      triggerEventKey?: string;
      variables?: Record<string, CaseOutputValue>;
    }
  ): number {
    const caseId = this.allocateCaseId();

    this.queue.schedule('CASE_ARRIVAL', time, {
      caseId,
      startNodeId: startNode.id,
      processId: startNode.processId,
      ...options,
      variables: withParentCaseId(options.variables, options.sourceCaseId)
    });

    return caseId;
  }

  private allocateCaseId(): number {
    return this.nextCaseId++;
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

    if (this.interpreter.isEventBasedGateway(node)) {
      this.enterEventBasedGateway(token, node, time);
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

    if (this.interpreter.isCatchingMessageOrSignalEvent(node)) {
      this.waitForMessageOrSignal(token, node, time);
      return;
    }

    if (this.interpreter.isThrowingMessageOrSignalEvent(node)) {
      this.publishMessageAndSignalEvents(node, token, time);

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

  private enterEventBasedGateway(token: Token, gateway: SimNode, time: number): void {
    const raceId = `${token.id}:${gateway.id}:${time}`;
    let candidates = 0;

    this.eventBasedGatewayRaces.set(raceId, {
      id: raceId,
      caseId: token.caseId,
      gatewayId: gateway.id,
      active: true
    });

    for (const flowId of gateway.outgoing) {
      const flow = this.interpreter.getFlow(flowId);
      const target = flow ? this.interpreter.getNode(flow.targetId) : undefined;

      if (!flow || !target) {
        continue;
      }

      const candidatePayload: ElementTokenPayload = {
        token: {
          ...token,
          elementId: target.id
        },
        elementId: target.id,
        eventBasedGatewayRaceId: raceId,
        gatewayId: gateway.id,
        incomingFlowId: flow.id
      };

      if (this.interpreter.isCatchingMessageOrSignalEvent(target)) {
        this.waitForEventBasedMessageOrSignal(candidatePayload, target, time);
        candidates += 1;
        continue;
      }

      if (this.interpreter.isTimer(target)) {
        this.queue.schedule('TIMER_FIRED', time + minutesToHours(sampleDuration(target.params.duration, this.random)), candidatePayload);
        candidates += 1;
        continue;
      }

      this.statistics.warn(
        `Event-Based Gateway "${gateway.name}" ignoriert ausgehenden Flow "${flow.name}", weil das Ziel "${target.name}" kein Catch Event oder Timer Event ist.`,
        gateway.id,
        time
      );
    }

    if (!candidates) {
      this.statistics.warn(
        `Event-Based Gateway "${gateway.name}" hat keine unterstuetzten ausgehenden Event-Kandidaten. Case ${token.caseId} endet dort.`,
        gateway.id,
        time
      );
      this.eventBasedGatewayRaces.delete(raceId);
      this.tokens.consume(token.caseId, time);
      return;
    }

    this.statistics.info(
      `Case ${token.caseId} wartet an Event-Based Gateway "${gateway.name}" auf das naechste passende Event.`,
      gateway.id,
      time
    );
  }

  private waitForEventBasedMessageOrSignal(payload: ElementTokenPayload, node: SimNode, time: number): void {
    const messageDefinition = this.interpreter.getEventDefinitions(node, 'message')[0];

    if (messageDefinition) {
      const eventKey = this.interpreter.getEventKey(messageDefinition);
      const delivery = this.shiftPendingMessage(node.id, eventKey, payload.token.caseId);

      if (delivery) {
        this.scheduleEventReceived('MESSAGE_RECEIVED', payload.token, node, delivery, time, payload);
        return;
      }

      this.enqueueWaitingToken(node.id, payload);
      return;
    }

    const signalDefinition = this.interpreter.getEventDefinitions(node, 'signal')[0];

    if (signalDefinition) {
      this.enqueueWaitingToken(node.id, payload);
      return;
    }
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

    this.recordTaskStart(payload, node, time, resourceStart.resourceId);
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

  private retryTask(token: Token, time: number): void {
    this.queue.schedule('TASK_START', time, {
      token,
      elementId: token.elementId,
      arrivedAt: time
    });
  }

  private waitForMessageOrSignal(token: Token, node: SimNode, time: number): void {
    const messageDefinition = this.interpreter.getEventDefinitions(node, 'message')[0];

    if (messageDefinition) {
      this.waitForMessage(token, node, messageDefinition, time);
      return;
    }

    const signalDefinition = this.interpreter.getEventDefinitions(node, 'signal')[0];

    if (signalDefinition) {
      this.waitForSignal(token, node, signalDefinition, time);
      return;
    }

    this.queue.schedule('TOKEN_LEAVE_ELEMENT', time, {
      token,
      elementId: node.id
    });
  }

  private waitForMessage(token: Token, node: SimNode, definition: SimEventDefinition, time: number): void {
    const eventKey = this.interpreter.getEventKey(definition);
    const delivery = this.shiftPendingMessage(node.id, eventKey, token.caseId);

    if (delivery) {
      this.scheduleEventReceived('MESSAGE_RECEIVED', token, node, delivery, time);
      return;
    }

    this.enqueueWaitingToken(node.id, {
      token,
      elementId: node.id
    });
    this.statistics.info(
      `Case ${token.caseId} wartet auf Message "${eventKey}".`,
      node.id,
      time
    );
  }

  private waitForSignal(token: Token, node: SimNode, definition: SimEventDefinition, time: number): void {
    const eventKey = this.interpreter.getEventKey(definition);

    this.enqueueWaitingToken(node.id, {
      token,
      elementId: node.id
    });
    this.statistics.info(
      `Case ${token.caseId} wartet auf Signal "${eventKey}".`,
      node.id,
      time
    );
  }

  private receiveMessage(payload: EventReceivedPayload, time: number): void {
    if (!this.triggerEventBasedGatewayRace(payload, time)) {
      return;
    }

    this.tokens.mergeOutputs(payload.token.caseId, payload.variables);
    this.queue.schedule('TOKEN_LEAVE_ELEMENT', time, payload);
  }

  private receiveSignal(payload: EventReceivedPayload, time: number): void {
    if (!this.triggerEventBasedGatewayRace(payload, time)) {
      return;
    }

    this.tokens.mergeOutputs(payload.token.caseId, payload.variables);
    this.queue.schedule('TOKEN_LEAVE_ELEMENT', time, payload);
  }

  private fireTimer(payload: ElementTokenPayload, time: number): void {
    if (!this.triggerEventBasedGatewayRace(payload, time)) {
      return;
    }

    this.queue.schedule('TOKEN_LEAVE_ELEMENT', time, payload);
  }

  private triggerEventBasedGatewayRace(payload: ElementTokenPayload, time: number): boolean {
    const raceId = payload.eventBasedGatewayRaceId;

    if (!raceId) {
      return true;
    }

    const race = this.eventBasedGatewayRaces.get(raceId);

    if (!race?.active) {
      return false;
    }

    race.active = false;
    this.cancelEventBasedGatewayAlternatives(raceId);
    this.recordEventBasedGatewayWinner(payload, time);

    return true;
  }

  private recordEventBasedGatewayWinner(payload: ElementTokenPayload, time: number): void {
    const node = this.interpreter.getNode(payload.elementId);
    const flow = payload.incomingFlowId ? this.interpreter.getFlow(payload.incomingFlowId) : undefined;

    if (flow) {
      this.tokens.recordPath(payload.token.caseId, flow.id, this.options.collectTraces);
      this.statistics.recordFlow(flow);
    }

    if (node) {
      this.tokens.recordPath(payload.token.caseId, node.id, this.options.collectTraces);
      this.statistics.recordVisit(node);
    }

    this.statistics.info(
      `Event-Based Gateway "${payload.gatewayId ?? 'unknown'}" setzt Case ${payload.token.caseId} ueber "${node?.name ?? payload.elementId}" fort.`,
      payload.gatewayId ?? payload.elementId,
      time
    );
  }

  private cancelEventBasedGatewayAlternatives(raceId: string): void {
    for (const [elementId, waiting] of this.waitingEventTokens.entries()) {
      const remaining = waiting.filter((payload) => payload.eventBasedGatewayRaceId !== raceId);

      if (remaining.length) {
        this.waitingEventTokens.set(elementId, remaining);
      } else {
        this.waitingEventTokens.delete(elementId);
      }
    }
  }

  private publishMessageAndSignalEvents(node: SimNode, token: Token, time: number): void {
    for (const definition of this.interpreter.getEventDefinitions(node, 'message')) {
      this.publishMessage(node, definition, token, time);
    }

    for (const definition of this.interpreter.getEventDefinitions(node, 'signal')) {
      this.publishSignal(node, definition, token, time);
    }
  }

  private publishMessage(node: SimNode, definition: SimEventDefinition, token: Token, time: number): void {
    const eventKey = this.interpreter.getEventKey(definition);
    const delivery = this.createDelivery(eventKey, node, token);
    const sourceFlows = (this.model.messageFlows ?? []).filter((flow) => flow.sourceId === node.id);
    const matchingFlows = sourceFlows.filter((flow) => messageFlowMatches(flow, definition, eventKey));
    const flows = matchingFlows.length ? matchingFlows : sourceFlows;
    let delivered = false;

    for (const flow of flows) {
      delivered = this.deliverMessageToTarget(flow.targetId, {
        ...delivery,
        eventKey: flow.messageName ?? delivery.eventKey
      }, time) || delivered;
    }

    if (!flows.length) {
      delivered = this.deliverMessageByKey(eventKey, delivery, time);
    }

    this.statistics.info(
      `Message "${eventKey}" von "${node.name}" veroeffentlicht.`,
      node.id,
      time
    );

    if (!delivered) {
      this.statistics.warn(
        `Message "${eventKey}" hat aktuell keinen passenden Empfaenger. Sie wird fuer spaetere Catch Events gepuffert.`,
        node.id,
        time
      );
      this.enqueuePendingMessageByKey(eventKey, delivery);
    }
  }

  private publishSignal(node: SimNode, definition: SimEventDefinition, token: Token, time: number): void {
    const eventKey = this.interpreter.getEventKey(definition);
    const delivery = this.createDelivery(eventKey, node, token);
    let delivered = 0;

    for (const startNode of this.findMatchingStartNodes('signal', eventKey)) {
      this.startCaseAtNode(startNode, time, {
        trigger: 'signal',
        sourceCaseId: token.caseId,
        triggerElementId: node.id,
        triggerEventKey: eventKey,
        variables: delivery.variables
      });
      delivered += 1;
    }

    for (const catchNode of this.findMatchingCatchNodes('signal', eventKey)) {
      const waiting = this.waitingEventTokens.get(catchNode.id) ?? [];

      while (waiting.length) {
        const waitingToken = waiting.shift();

        if (!waitingToken) {
          break;
        }

        this.scheduleEventReceived('SIGNAL_RECEIVED', waitingToken.token, catchNode, delivery, time, waitingToken);
        delivered += 1;
      }

      this.waitingEventTokens.set(catchNode.id, waiting);
    }

    this.statistics.info(
      `Signal "${eventKey}" von "${node.name}" gesendet.`,
      node.id,
      time
    );

    if (!delivered) {
      this.statistics.warn(
        `Signal "${eventKey}" hatte zum Sendezeitpunkt keinen wartenden Empfaenger.`,
        node.id,
        time
      );
    }
  }

  private deliverMessageToTarget(targetId: string, delivery: EventDelivery, time: number): boolean {
    const targetNode = this.interpreter.getNode(targetId);

    if (!targetNode) {
      return false;
    }

    if (targetNode.kind === 'startEvent') {
      this.startCaseAtNode(targetNode, time, {
        trigger: 'message',
        sourceCaseId: delivery.sourceCaseId,
        triggerElementId: delivery.sourceElementId,
        triggerEventKey: delivery.eventKey,
        variables: delivery.variables
      });
      return true;
    }

    if (this.interpreter.isCatchingMessageOrSignalEvent(targetNode)) {
      const waiting = this.waitingEventTokens.get(targetNode.id) ?? [];
      const waitingPayload = shiftMatchingWaitingToken(waiting, delivery);

      this.waitingEventTokens.set(targetNode.id, waiting);

      if (waitingPayload) {
        this.scheduleEventReceived('MESSAGE_RECEIVED', waitingPayload.token, targetNode, delivery, time, waitingPayload);
        return true;
      }

      this.enqueuePendingMessageByTarget(targetNode.id, delivery);
      return true;
    }

    this.statistics.warn(
      `Message "${delivery.eventKey}" zielt auf "${targetNode.name}", das kein wartendes Message Event ist.`,
      targetNode.id,
      time
    );

    return false;
  }

  private deliverMessageByKey(eventKey: string, delivery: EventDelivery, time: number): boolean {
    let delivered = false;
    const matchingStarts = this.findMatchingStartNodes('message', eventKey);
    const matchingCatches = this.findMatchingCatchNodes('message', eventKey);

    for (const startNode of matchingStarts) {
      this.startCaseAtNode(startNode, time, {
        trigger: 'message',
        sourceCaseId: delivery.sourceCaseId,
        triggerElementId: delivery.sourceElementId,
        triggerEventKey: eventKey,
        variables: delivery.variables
      });
      delivered = true;
    }

    for (const catchNode of matchingCatches) {
      const waiting = this.waitingEventTokens.get(catchNode.id) ?? [];
      const waitingPayload = shiftMatchingWaitingToken(waiting, delivery);

      this.waitingEventTokens.set(catchNode.id, waiting);

      if (waitingPayload) {
        this.scheduleEventReceived('MESSAGE_RECEIVED', waitingPayload.token, catchNode, delivery, time, waitingPayload);
        return true;
      }
    }

    if (matchingCatches.length) {
      this.enqueuePendingMessageByKey(eventKey, delivery);
      delivered = true;
    }

    return delivered;
  }

  private scheduleEventReceived(
    type: 'MESSAGE_RECEIVED' | 'SIGNAL_RECEIVED',
    token: Token,
    node: SimNode,
    delivery: EventDelivery,
    time: number,
    eventBasedPayload?: ElementTokenPayload
  ): void {
    this.queue.schedule(type, time, {
      token,
      elementId: node.id,
      eventKey: delivery.eventKey,
      sourceCaseId: delivery.sourceCaseId,
      sourceElementId: delivery.sourceElementId,
      variables: delivery.variables,
      eventBasedGatewayRaceId: eventBasedPayload?.eventBasedGatewayRaceId,
      gatewayId: eventBasedPayload?.gatewayId,
      incomingFlowId: eventBasedPayload?.incomingFlowId
    });
  }

  private createDelivery(eventKey: string, node: SimNode, token: Token): EventDelivery {
    const caseState = this.tokens.getCase(token.caseId);

    return {
      eventKey,
      sourceCaseId: token.caseId,
      correlationCaseId: caseState?.parentCaseId ?? token.caseId,
      sourceElementId: node.id,
      variables: cloneVariables(caseState?.outputs)
    };
  }

  private enqueueWaitingToken(elementId: string, payload: ElementTokenPayload): void {
    const waiting = this.waitingEventTokens.get(elementId) ?? [];

    waiting.push(payload);
    this.waitingEventTokens.set(elementId, waiting);
  }

  private shiftPendingMessage(targetId: string, eventKey: string, targetCaseId: number): EventDelivery | undefined {
    const targeted = this.pendingMessagesByTarget.get(targetId);
    const targetedDelivery = shiftMatchingDelivery(targeted, targetCaseId);

    if (targetedDelivery) {
      return targetedDelivery;
    }

    const keyed = this.pendingMessagesByKey.get(eventKey);

    return shiftMatchingDelivery(keyed, targetCaseId);
  }

  private enqueuePendingMessageByTarget(targetId: string, delivery: EventDelivery): void {
    const pending = this.pendingMessagesByTarget.get(targetId) ?? [];

    pending.push(delivery);
    this.pendingMessagesByTarget.set(targetId, pending);
  }

  private enqueuePendingMessageByKey(eventKey: string, delivery: EventDelivery): void {
    const pending = this.pendingMessagesByKey.get(eventKey) ?? [];

    pending.push(delivery);
    this.pendingMessagesByKey.set(eventKey, pending);
  }

  private findMatchingStartNodes(type: SimEventDefinition['type'], eventKey: string): SimNode[] {
    return this.interpreter.getRootStartNodes().filter((node) => {
      return this.eventDefinitionsMatch(node, type, eventKey);
    });
  }

  private findMatchingCatchNodes(type: SimEventDefinition['type'], eventKey: string): SimNode[] {
    return [...this.model.nodes.values()].filter((node) => {
      return this.interpreter.isCatchingMessageOrSignalEvent(node) &&
        this.eventDefinitionsMatch(node, type, eventKey);
    });
  }

  private eventDefinitionsMatch(node: SimNode, type: SimEventDefinition['type'], eventKey: string): boolean {
    return this.interpreter.getEventDefinitions(node, type).some((definition) => {
      return eventDefinitionKeys(definition, this.interpreter.getEventKey(definition)).includes(eventKey);
    });
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

    this.statistics.recordService(
      node,
      hoursToMinutes(time - arrivedAt),
      serviceTime,
      time,
      completionTime,
      token.attempt === 0
    );
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

    this.recordTaskStart({
      token: queued.token,
      elementId: queued.node.id,
      arrivedAt: queued.arrivedAt
    }, queued.node, time, resourceStart.resourceId);
    this.scheduleTaskCompletion(queued.node, queued.token, queued.arrivedAt, time, resourceStart.resourceId);
  }

  private recordTaskStart(
    payload: TaskStartPayload,
    node: SimNode,
    time: number,
    resourceId?: string
  ): void {
    const caseState = this.tokens.getCase(payload.token.caseId);

    this.statistics.event('TASK_START', 'TASK_START', {
      time,
      caseId: payload.token.caseId,
      tokenId: payload.token.id,
      attempt: payload.token.attempt,
      elementId: node.id,
      elementName: node.name,
      resourceId: resourceId ?? node.params.resource?.resourceId,
      variables: caseState?.outputs
    });
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

  private getPrimaryEventKey(node: SimNode): string | undefined {
    const definition = this.interpreter.getEventDefinitions(node, 'message', 'signal', 'timer')[0];

    return definition ? this.interpreter.getEventKey(definition) : undefined;
  }

  private getProcessName(processId: string | undefined): string {
    if (!processId) {
      return this.model.name;
    }

    return this.model.processes?.get(processId)?.name ?? processId;
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
    const payload = event.payload as Partial<
      TokenPayload &
      ElementTokenPayload &
      CaseArrivalPayload &
      ExternalEventPayload &
      TaskCompletePayload &
      EventReceivedPayload
    >;
    const token = payload.token;
    const elementId = payload.elementId ?? token?.elementId ?? payload.startNodeId;
    const node = elementId ? this.interpreter.getNode(elementId) : undefined;
    const caseId = token?.caseId ?? payload.caseId;
    const caseState = caseId !== undefined ? this.tokens.getCase(caseId) : undefined;

    this.statistics.event(event.type, event.type, {
      time: event.time,
      caseId,
      sourceCaseId: payload.sourceCaseId,
      sourceElementId: payload.sourceElementId,
      tokenId: token?.id,
      attempt: token?.attempt,
      elementId,
      elementName: node?.name,
      resourceId: payload.resourceId ?? node?.params.resource?.resourceId,
      serviceTime: payload.serviceTime,
      variables: caseState?.outputs ?? payload.variables
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

function sampleArrivalDelay(
  arrival: SimNode['params']['arrival'],
  random: SeededRandom
): number {
  if (arrival?.type === 'normal') {
    return sampleDuration({
      type: 'normal',
      mean: arrival.mean ?? arrival.interval ?? 1,
      stddev: arrival.stddev ?? 1,
      min: arrival.min ?? 0,
      max: arrival.max
    }, random);
  }

  if (arrival?.type === 'exponential') {
    return sampleDuration({
      type: 'exponential',
      mean: arrival.mean ?? arrival.interval ?? 1,
      lambda: arrival.lambda
    }, random);
  }

  return Math.max(0, arrival?.interval ?? arrival?.mean ?? 1);
}

function shiftMatchingWaitingToken(
  waiting: ElementTokenPayload[],
  delivery: EventDelivery
): ElementTokenPayload | undefined {
  const index = waiting.findIndex((payload) => deliveryMatchesCase(delivery, payload.token.caseId));

  if (index < 0) {
    return undefined;
  }

  return waiting.splice(index, 1)[0];
}

function shiftMatchingDelivery(
  deliveries: EventDelivery[] | undefined,
  targetCaseId: number
): EventDelivery | undefined {
  if (!deliveries?.length) {
    return undefined;
  }

  const index = deliveries.findIndex((delivery) => deliveryMatchesCase(delivery, targetCaseId));

  if (index < 0) {
    return undefined;
  }

  return deliveries.splice(index, 1)[0];
}

function deliveryMatchesCase(delivery: EventDelivery, targetCaseId: number): boolean {
  return delivery.correlationCaseId === undefined ||
    delivery.correlationCaseId === targetCaseId ||
    delivery.sourceCaseId === targetCaseId;
}

function messageFlowMatches(flow: SimMessageFlow, definition: SimEventDefinition, eventKey: string): boolean {
  if (!flow.messageId && !flow.messageName) {
    return true;
  }

  return eventDefinitionKeys(definition, eventKey).some((key) => {
    return key === flow.messageId || key === flow.messageName;
  });
}

function eventDefinitionKeys(definition: SimEventDefinition, eventKey: string): string[] {
  return [eventKey, definition.name, definition.refId, definition.id]
    .filter((key): key is string => Boolean(key));
}

function cloneVariables(
  variables: Record<string, CaseOutputValue> | undefined
): Record<string, CaseOutputValue> | undefined {
  return variables
    ? JSON.parse(JSON.stringify(variables)) as Record<string, CaseOutputValue>
    : undefined;
}

function withParentCaseId(
  variables: Record<string, CaseOutputValue> | undefined,
  parentCaseId: number | undefined
): Record<string, CaseOutputValue> | undefined {
  if (parentCaseId === undefined) {
    return variables;
  }

  return {
    ...(cloneVariables(variables) ?? {}),
    parentCaseId
  };
}
