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

    if (entry.tokenId && firstTokenOccurrence(log, index, entry.tokenId)) {
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

  events.push(...buildMovementEvents(model, log, cases, events.length * 10));

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

function buildMovementEvents(
  model: SimModel,
  log: SimulationLogEntry[],
  cases: CaseTrace[],
  initialSequence: number
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const enterTimes = createEventTimeQueues(log, 'TOKEN_ENTER_ELEMENT');
  const leaveTimes = createEventTimeQueues(log, 'TOKEN_LEAVE_ELEMENT');
  let sequence = initialSequence;

  for (const caseTrace of cases) {
    const caseEnterTimes = cloneCaseQueues(enterTimes.get(caseTrace.id));
    const caseLeaveTimes = cloneCaseQueues(leaveTimes.get(caseTrace.id));

    for (const [pathIndex, elementId] of caseTrace.path.entries()) {
      const flow = model.flows.get(elementId);

      if (!flow) {
        continue;
      }

      const sourceTime = shiftCaseTime(caseLeaveTimes, flow.sourceId) ??
        peekCaseTime(caseEnterTimes, flow.sourceId) ??
        caseTrace.startTime;
      const targetTime = peekCaseTime(caseEnterTimes, flow.targetId) ?? sourceTime;
      const startTime = Math.min(sourceTime, targetTime);
      const endTime = Math.max(startTime + VISUAL_MOVE_DURATION, targetTime);
      const tokenId = `move:${caseTrace.id}:${elementId}:${pathIndex}`;

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

  return events;
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
  const times = log
    .map((entry) => entry.time)
    .filter((time): time is number => Number.isFinite(time));

  return times.length ? Math.min(...times) : 0;
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

function firstTokenOccurrence(log: SimulationLogEntry[], index: number, tokenId: string): boolean {
  for (let candidateIndex = 0; candidateIndex < index; candidateIndex += 1) {
    if (log[candidateIndex].tokenId === tokenId) {
      return false;
    }
  }

  return true;
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
