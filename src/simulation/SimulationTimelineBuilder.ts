import type { SimModel, SimNode } from '../types/bpmn';
import type { CaseTrace, SimulationLogEntry } from '../types/simulation';
import type { SimulationEvent as TimelineEvent, TimelineEventType } from '../types/timeline';

const VISUAL_MOVE_DURATION = 0.02;

export function buildSimulationTimeline(
  model: SimModel,
  log: SimulationLogEntry[],
  cases: CaseTrace[]
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const firstTimelineTime = findFirstTimelineTime(log);
  const seenTokenIds = new Set<string>();

  for (const [index, entry] of log.entries()) {
    const mapped = mapLogEntryToTimelineEvent(model, entry, index * 10, firstTimelineTime);

    if (mapped) {
      events.push(mapped);
    }

    if (entry.eventType === 'TOKEN_LEAVE_ELEMENT' && entry.elementId && isGateway(model.nodes.get(entry.elementId))) {
      events.push({
        id: `timeline:gateway-decision:${entry.elementId}:${index}`,
        simulationTime: entryTime(entry, firstTimelineTime),
        sequence: index * 10 + 1,
        type: 'GATEWAY_DECISION',
        processInstanceId: String(entry.caseId ?? 'global'),
        tokenId: entry.tokenId,
        elementId: entry.elementId,
        payload: {
          message: entry.message
        }
      });
    }

    if (entry.resourceId && entry.eventType === 'TASK_START') {
      events.push({
        id: `timeline:resource-acquired:${entry.resourceId}:${index}`,
        simulationTime: entryTime(entry, firstTimelineTime),
        sequence: index * 10 + 1,
        type: 'RESOURCE_ACQUIRED',
        processInstanceId: String(entry.caseId ?? 'global'),
        tokenId: entry.tokenId,
        elementId: entry.elementId,
        payload: {
          resourceId: entry.resourceId
        }
      });
    }

    if (entry.resourceId && entry.eventType === 'TASK_COMPLETE') {
      events.push({
        id: `timeline:resource-released:${entry.resourceId}:${index}`,
        simulationTime: entryTime(entry, firstTimelineTime),
        sequence: index * 10 + 1,
        type: 'RESOURCE_RELEASED',
        processInstanceId: String(entry.caseId ?? 'global'),
        tokenId: entry.tokenId,
        elementId: entry.elementId,
        payload: {
          resourceId: entry.resourceId
        }
      });
    }

    if (entry.eventType === 'CASE_ARRIVAL' && entry.caseId !== undefined) {
      events.push({
        id: `timeline:case-created:${entry.caseId}:${index}`,
        simulationTime: entryTime(entry, firstTimelineTime),
        sequence: index * 10 - 2,
        type: 'CASE_CREATED',
        processInstanceId: String(entry.caseId),
        elementId: entry.elementId,
        payload: {
          trigger: entry.message,
          variables: entry.variables
        }
      });
    }

    if (entry.tokenId && !seenTokenIds.has(entry.tokenId)) {
      seenTokenIds.add(entry.tokenId);
      events.push({
        id: `timeline:token-created:${entry.tokenId}`,
        simulationTime: entryTime(entry, firstTimelineTime),
        sequence: index * 10 - 1,
        type: 'TOKEN_CREATED',
        processInstanceId: String(entry.caseId ?? 'global'),
        tokenId: entry.tokenId,
        elementId: entry.elementId
      });
    }
  }

  appendMovementEvents(model, log, cases, events, events.length * 10);
  applyCrossProcessEventCausality(events, log);

  return events.sort((left, right) => {
    const timeDiff = left.simulationTime - right.simulationTime;

    if (timeDiff !== 0) {
      return timeDiff;
    }

    return left.sequence - right.sequence;
  });
}

function mapLogEntryToTimelineEvent(
  model: SimModel,
  entry: SimulationLogEntry,
  sequence: number,
  firstTimelineTime: number
): TimelineEvent | undefined {
  const time = entryTime(entry, firstTimelineTime);
  const processInstanceId = String(entry.caseId ?? entry.sourceCaseId ?? 'global');

  if (!entry.eventType) {
    if (entry.level === 'warning' || entry.level === 'error') {
      return {
        id: `timeline:warning:${sequence}`,
        simulationTime: time,
        sequence,
        type: 'WARNING',
        processInstanceId,
        elementId: entry.elementId,
        payload: {
          level: entry.level,
          message: entry.message
        }
      };
    }

    if (entry.caseId !== undefined && entry.elementId && entry.message.includes('wartet auf')) {
      return {
        id: `timeline:waiting:${sequence}`,
        simulationTime: time,
        sequence,
        type: 'TOKEN_WAITING',
        processInstanceId,
        tokenId: entry.tokenId ?? fallbackTokenId(entry),
        elementId: entry.elementId,
        payload: {
          message: entry.message
        }
      };
    }

    return undefined;
  }

  const node = entry.elementId ? model.nodes.get(entry.elementId) : undefined;
  const type = mapEventType(entry.eventType, node);

  if (!type) {
    return undefined;
  }

  return {
    id: `timeline:${entry.eventType}:${sequence}`,
    simulationTime: time,
    sequence,
    type,
    processInstanceId,
    tokenId: entry.tokenId ?? fallbackTokenId(entry),
    elementId: entry.elementId,
    payload: {
      level: entry.level,
      message: entry.message,
      attempt: entry.attempt,
      sourceCaseId: entry.sourceCaseId,
      sourceElementId: entry.sourceElementId,
      resourceId: entry.resourceId,
      variables: entry.variables
    }
  };
}

function mapEventType(
  type: SimulationLogEntry['eventType'],
  node: SimNode | undefined
): TimelineEventType | undefined {
  switch (type) {
    case 'CASE_ARRIVAL':
      return undefined;
    case 'EXTERNAL_EVENT_OCCURRED':
      return 'CASE_CREATED';
    case 'TOKEN_ENTER_ELEMENT':
      return node && isGateway(node) ? 'GATEWAY_ENTERED' : 'TOKEN_ENTER_ELEMENT';
    case 'TASK_START':
      return 'TASK_STARTED';
    case 'TASK_COMPLETE':
      return 'TASK_COMPLETED';
    case 'TOKEN_LEAVE_ELEMENT':
      return 'TOKEN_LEAVE_ELEMENT';
    case 'PROCESS_INSTANCE_COMPLETE':
      return 'PROCESS_INSTANCE_COMPLETED';
    case 'MESSAGE_RECEIVED':
    case 'SIGNAL_RECEIVED':
    case 'TIMER_FIRED':
      return 'TOKEN_ENTER_ELEMENT';
    case 'TASK_FAILED':
      return 'WARNING';
    case 'RETRY_TASK':
      return 'TOKEN_WAITING';
    default:
      return undefined;
  }
}

function appendMovementEvents(
  model: SimModel,
  log: SimulationLogEntry[],
  cases: CaseTrace[],
  events: TimelineEvent[],
  initialSequence: number
): void {
  const enterTimes = createElementEnterTimeQueues(log);
  const leaveTimes = createEventTimeQueues(log, 'TOKEN_LEAVE_ELEMENT');
  let sequence = initialSequence;

  for (const caseTrace of cases) {
    const caseEnterTimes = cloneCaseQueues(enterTimes.get(caseTrace.id));
    const caseLeaveTimes = cloneCaseQueues(leaveTimes.get(caseTrace.id));
    const visualReadyAt = new Map<string, number>();

    for (const [pathIndex, elementId] of caseTrace.path.entries()) {
      const flow = model.flows.get(elementId);

      if (!flow) {
        continue;
      }

      const sourceTime = shiftCaseTime(caseLeaveTimes, flow.sourceId) ??
        peekCaseTime(caseEnterTimes, flow.sourceId) ??
        caseTrace.startTime;
      const targetTime = peekCaseTime(caseEnterTimes, flow.targetId) ?? sourceTime;
      const semanticStartTime = Math.min(sourceTime, targetTime);
      const sourceNode = model.nodes.get(flow.sourceId);
      const startsWhenEventOccurs = sourceNode?.kind === 'eventBasedGateway';
      const earliestStartTime = startsWhenEventOccurs ? targetTime : semanticStartTime;
      const startTime = Math.max(earliestStartTime, visualReadyAt.get(flow.sourceId) ?? earliestStartTime);
      const endTime = Math.max(startTime + VISUAL_MOVE_DURATION, targetTime);
      const tokenId = `move:${caseTrace.id}:${elementId}:${pathIndex}`;

      visualReadyAt.set(
        flow.targetId,
        Math.max(visualReadyAt.get(flow.targetId) ?? Number.NEGATIVE_INFINITY, endTime)
      );

      events.push({
        id: `timeline:move-start:${caseTrace.id}:${elementId}:${pathIndex}`,
        simulationTime: startTime,
        sequence: sequence++,
        type: 'TOKEN_MOVE_START',
        processInstanceId: String(caseTrace.id),
        tokenId,
        sourceElementId: flow.sourceId,
        targetElementId: flow.targetId,
        sequenceFlowId: flow.id,
        payload: {
          visualDuration: VISUAL_MOVE_DURATION,
          endTime
        }
      });
      events.push({
        id: `timeline:move-end:${caseTrace.id}:${elementId}:${pathIndex}`,
        simulationTime: endTime,
        sequence: sequence++,
        type: 'TOKEN_MOVE_END',
        processInstanceId: String(caseTrace.id),
        tokenId,
        sourceElementId: flow.sourceId,
        targetElementId: flow.targetId,
        sequenceFlowId: flow.id,
        payload: {
          terminateOnEnd: true
        }
      });
    }
  }
}

function applyCrossProcessEventCausality(
  events: TimelineEvent[],
  log: SimulationLogEntry[]
): void {
  const receivedEvents = log
    .filter((entry) => {
      return (entry.eventType === 'MESSAGE_RECEIVED' || entry.eventType === 'SIGNAL_RECEIVED') &&
        entry.caseId !== undefined &&
        entry.sourceCaseId !== undefined &&
        entry.sourceElementId &&
        entry.tokenId &&
        entry.elementId &&
        entry.time !== undefined;
    })
    .sort((left, right) => (left.time ?? 0) - (right.time ?? 0));

  if (!receivedEvents.length) {
    return;
  }

  const eventsByCase = new Map<string, TimelineEvent[]>();
  const senderArrivals = new Map<string, TimelineEvent[]>();

  for (const event of events) {
    const caseEvents = eventsByCase.get(event.processInstanceId) ?? [];

    caseEvents.push(event);
    eventsByCase.set(event.processInstanceId, caseEvents);

    if (event.type === 'TOKEN_MOVE_END' && event.targetElementId) {
      const key = caseElementKey(event.processInstanceId, event.targetElementId);
      const arrivals = senderArrivals.get(key) ?? [];

      arrivals.push(event);
      senderArrivals.set(key, arrivals);
    }
  }

  for (const received of receivedEvents) {
    const sourceCaseId = String(received.sourceCaseId);
    const receiverCaseId = String(received.caseId);
    const receiverEvents = eventsByCase.get(receiverCaseId) ?? [];
    const receiveEvent = receiverEvents.find((event) => {
      return event.processInstanceId === receiverCaseId &&
        event.tokenId === received.tokenId &&
        event.elementId === received.elementId &&
        event.payload?.message === received.eventType;
    });

    if (!receiveEvent) {
      continue;
    }

    const receiveTime = receiveEvent.simulationTime;
    const receiveSequence = receiveEvent.sequence;
    const senderArrivalTime = (senderArrivals.get(caseElementKey(sourceCaseId, received.sourceElementId ?? '')) ?? [])
      .reduce<number | undefined>((earliest, event) => {
        if (event.simulationTime < receiveTime) {
          return earliest;
        }

        return earliest === undefined
          ? event.simulationTime
          : Math.min(earliest, event.simulationTime);
      }, undefined);

    if (senderArrivalTime === undefined || senderArrivalTime <= receiveTime) {
      continue;
    }

    const delay = senderArrivalTime - receiveTime;

    for (const event of receiverEvents) {
      if (
        event.simulationTime < receiveTime ||
        (
          event.simulationTime === receiveTime &&
          event.sequence < receiveSequence
        )
      ) {
        continue;
      }

      event.simulationTime += delay;

      if (event.payload?.endTime !== undefined) {
        event.payload.endTime = Number(event.payload.endTime) + delay;
      }
    }
  }
}

function caseElementKey(caseId: string, elementId: string): string {
  return `${caseId}\u0000${elementId}`;
}

function createElementEnterTimeQueues(
  log: SimulationLogEntry[]
): Map<number, Map<string, number[]>> {
  const enterEventTypes = new Set<NonNullable<SimulationLogEntry['eventType']>>([
    'TOKEN_ENTER_ELEMENT',
    'MESSAGE_RECEIVED',
    'SIGNAL_RECEIVED',
    'TIMER_FIRED'
  ]);
  const timesByCase = new Map<number, Map<string, number[]>>();

  for (const entry of log) {
    if (
      entry.caseId === undefined ||
      !entry.eventType ||
      !enterEventTypes.has(entry.eventType) ||
      !entry.elementId
    ) {
      continue;
    }

    const caseTimes = timesByCase.get(entry.caseId) ?? new Map<string, number[]>();
    const elementTimes = caseTimes.get(entry.elementId) ?? [];

    elementTimes.push(entry.time ?? 0);
    caseTimes.set(entry.elementId, elementTimes);
    timesByCase.set(entry.caseId, caseTimes);
  }

  return timesByCase;
}

function createEventTimeQueues(
  log: SimulationLogEntry[],
  type: NonNullable<SimulationLogEntry['eventType']>
): Map<number, Map<string, number[]>> {
  const timesByCase = new Map<number, Map<string, number[]>>();

  for (const entry of log) {
    if (entry.caseId === undefined || entry.eventType !== type || !entry.elementId) {
      continue;
    }

    const caseTimes = timesByCase.get(entry.caseId) ?? new Map<string, number[]>();
    const elementTimes = caseTimes.get(entry.elementId) ?? [];

    elementTimes.push(entry.time ?? 0);
    caseTimes.set(entry.elementId, elementTimes);
    timesByCase.set(entry.caseId, caseTimes);
  }

  return timesByCase;
}

function findFirstTimelineTime(log: SimulationLogEntry[]): number {
  let earliest = Number.POSITIVE_INFINITY;

  for (const entry of log) {
    if (Number.isFinite(entry.time)) {
      earliest = Math.min(earliest, entry.time ?? earliest);
    }
  }

  return Number.isFinite(earliest) ? earliest : 0;
}

function entryTime(entry: SimulationLogEntry, fallback: number): number {
  return Number.isFinite(entry.time) ? entry.time ?? fallback : fallback;
}

function cloneCaseQueues(
  queues: Map<string, number[]> | undefined
): Map<string, number[]> {
  const entries = queues ? [...queues.entries()] : [];

  return new Map(entries.map(([key, values]) => [key, [...values]]));
}

function peekCaseTime(queues: Map<string, number[]>, elementId: string): number | undefined {
  return queues.get(elementId)?.[0];
}

function shiftCaseTime(queues: Map<string, number[]>, elementId: string): number | undefined {
  return queues.get(elementId)?.shift();
}

function fallbackTokenId(entry: SimulationLogEntry): string | undefined {
  if (entry.caseId === undefined) {
    return undefined;
  }

  return `${entry.caseId}:${entry.elementId ?? entry.eventType ?? 'event'}`;
}

function isGateway(node: SimNode | undefined): boolean {
  return node?.kind === 'exclusiveGateway' ||
    node?.kind === 'parallelGateway' ||
    node?.kind === 'eventBasedGateway';
}
