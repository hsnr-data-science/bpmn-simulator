import type { SimulationEvent, TimelineEventType } from '../types/timeline';

const EVENT_TYPES = new Set<TimelineEventType>([
  'CASE_CREATED',
  'TOKEN_CREATED',
  'TOKEN_ENTER_ELEMENT',
  'TOKEN_LEAVE_ELEMENT',
  'TOKEN_MOVE_START',
  'TOKEN_MOVE_END',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'GATEWAY_ENTERED',
  'GATEWAY_DECISION',
  'TOKEN_WAITING',
  'RESOURCE_ACQUIRED',
  'RESOURCE_RELEASED',
  'PROCESS_INSTANCE_COMPLETED',
  'PROCESS_INSTANCE_TERMINATED',
  'WARNING'
]);

export class EventLogImporter {
  parseJson(input: unknown): SimulationEvent[] {
    const rawEvents = Array.isArray(input)
      ? input
      : isRecord(input) && Array.isArray(input.timeline)
        ? input.timeline
        : undefined;

    if (!rawEvents) {
      throw new Error('Event log JSON must be an array of SimulationEvent objects or an object with a timeline array.');
    }

    const warnings: SimulationEvent[] = [];
    const imported = rawEvents.map((raw, index) => {
      const event = parseEvent(raw, index);

      if (!event.tokenId && requiresTokenId(event.type)) {
        warnings.push({
          id: `import-warning-token-${index}`,
          simulationTime: event.simulationTime,
          sequence: event.sequence + 0.1,
          type: 'WARNING',
          processInstanceId: event.processInstanceId,
          elementId: event.elementId,
          payload: {
            message: `Imported event ${event.id} has no tokenId. Playback will use aggregate state only.`
          }
        });
      }

      return event;
    });

    return [...imported, ...warnings].sort((left, right) => {
      const timeDiff = left.simulationTime - right.simulationTime;

      if (timeDiff !== 0) {
        return timeDiff;
      }

      return left.sequence - right.sequence;
    });
  }
}

function parseEvent(raw: unknown, index: number): SimulationEvent {
  if (!isRecord(raw)) {
    throw new Error(`Event at index ${index} must be an object.`);
  }

  const type = String(raw.type ?? '');

  if (!EVENT_TYPES.has(type as TimelineEventType)) {
    throw new Error(`Event at index ${index} has unsupported type "${type}".`);
  }

  const simulationTime = Number(raw.simulationTime);

  if (!Number.isFinite(simulationTime)) {
    throw new Error(`Event at index ${index} has no finite simulationTime.`);
  }

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `imported-${index}`,
    simulationTime,
    sequence: Number.isFinite(Number(raw.sequence)) ? Number(raw.sequence) : index,
    type: type as TimelineEventType,
    processInstanceId: typeof raw.processInstanceId === 'string'
      ? raw.processInstanceId
      : String(raw.processInstanceId ?? 'imported'),
    tokenId: typeof raw.tokenId === 'string' ? raw.tokenId : undefined,
    elementId: typeof raw.elementId === 'string' ? raw.elementId : undefined,
    sourceElementId: typeof raw.sourceElementId === 'string' ? raw.sourceElementId : undefined,
    targetElementId: typeof raw.targetElementId === 'string' ? raw.targetElementId : undefined,
    sequenceFlowId: typeof raw.sequenceFlowId === 'string' ? raw.sequenceFlowId : undefined,
    payload: isRecord(raw.payload) ? raw.payload : undefined
  };
}

function requiresTokenId(type: TimelineEventType): boolean {
  return type.startsWith('TOKEN_') || type === 'TASK_STARTED' || type === 'TASK_COMPLETED' || type === 'GATEWAY_ENTERED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
