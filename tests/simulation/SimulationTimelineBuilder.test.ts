import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSimulationTimeline } from '../../src/simulation/SimulationTimelineBuilder';
import type { SimFlow, SimModel, SimNode } from '../../src/types/bpmn';
import type { CaseTrace, SimulationLogEntry } from '../../src/types/simulation';

test('SimulationTimelineBuilder places untimed warnings at the first real simulation event', () => {
  const log: SimulationLogEntry[] = [
    {
      level: 'warning',
      message: 'Untimed model warning'
    },
    {
      level: 'info',
      eventType: 'CASE_ARRIVAL',
      caseId: 1,
      elementId: 'start',
      message: 'CASE_ARRIVAL',
      time: 8
    }
  ];
  const timeline = buildSimulationTimeline(createModel(), log, [caseTrace()]);

  assert.equal(Math.min(...timeline.map((event) => event.simulationTime)), 8);
  assert.equal(timeline.find((event) => event.type === 'WARNING')?.simulationTime, 8);
});

test('SimulationTimelineBuilder sequences movement into and out of an XOR gateway', () => {
  const model = createGatewayModel('exclusiveGateway', [
    flow('flow-in', 'task', 'gateway'),
    flow('flow-out', 'gateway', 'target')
  ]);
  const timeline = buildSimulationTimeline(
    model,
    movementLog(['task', 'gateway', 'target']),
    [caseTrace(['task', 'flow-in', 'gateway', 'flow-out', 'target'])]
  );
  const incomingEnd = movementEventTime(timeline, 'flow-in', 'TOKEN_MOVE_END');
  const outgoingStart = movementEventTime(timeline, 'flow-out', 'TOKEN_MOVE_START');

  assert.ok(Math.abs(incomingEnd - 5.02) < 1e-9);
  assert.ok(Math.abs(outgoingStart - incomingEnd) < 1e-9);
});

test('SimulationTimelineBuilder starts parallel outgoing movements together after gateway entry', () => {
  const model = createGatewayModel('parallelGateway', [
    flow('flow-in', 'task', 'gateway'),
    flow('flow-b', 'gateway', 'task-b'),
    flow('flow-c', 'gateway', 'task-c')
  ]);
  const timeline = buildSimulationTimeline(
    model,
    movementLog(['task', 'gateway', 'task-b', 'task-c']),
    [caseTrace(['task', 'flow-in', 'gateway', 'flow-b', 'flow-c', 'task-b', 'task-c'])]
  );
  const incomingEnd = movementEventTime(timeline, 'flow-in', 'TOKEN_MOVE_END');
  const startB = movementEventTime(timeline, 'flow-b', 'TOKEN_MOVE_START');
  const startC = movementEventTime(timeline, 'flow-c', 'TOKEN_MOVE_START');

  assert.ok(Math.abs(startB - incomingEnd) < 1e-9);
  assert.ok(Math.abs(startC - incomingEnd) < 1e-9);
});

test('SimulationTimelineBuilder handles more than 100,000 movement events without overflowing the call stack', () => {
  const movementFlow = flow('flow', 'task', 'target');
  const model = createGatewayModel('exclusiveGateway', [movementFlow]);
  const cases = Array.from({ length: 55_000 }, (_, index): CaseTrace => ({
    ...caseTrace(['task', 'flow', 'target']),
    id: index + 1
  }));
  const timeline = buildSimulationTimeline(model, [], cases);

  assert.equal(timeline.length, 110_000);
  assert.equal(timeline[0]?.type, 'TOKEN_MOVE_START');
  assert.equal(timeline.at(-1)?.type, 'TOKEN_MOVE_END');
});

function createModel(): SimModel {
  return {
    id: 'process',
    name: 'Process',
    resources: new Map(),
    nodes: new Map([
      [
        'start',
        {
          id: 'start',
          name: 'Start',
          type: 'bpmn:StartEvent',
          kind: 'startEvent',
          incoming: [],
          outgoing: [],
          params: {},
          supported: true
        }
      ]
    ]),
    flows: new Map(),
    startNodeIds: ['start'],
    unsupportedElementIds: []
  };
}

function createGatewayModel(gatewayKind: SimNode['kind'], flows: SimFlow[]): SimModel {
  const nodes = [
    node('task', 'task'),
    node('gateway', gatewayKind),
    node('target', 'task'),
    node('task-b', 'task'),
    node('task-c', 'task')
  ];

  return {
    id: 'process',
    name: 'Process',
    resources: new Map(),
    nodes: new Map(nodes.map((item) => [item.id, item])),
    flows: new Map(flows.map((item) => [item.id, item])),
    startNodeIds: [],
    unsupportedElementIds: []
  };
}

function node(id: string, kind: SimNode['kind']): SimNode {
  return {
    id,
    name: id,
    type: kind.endsWith('Gateway') ? `bpmn:${kind}` : 'bpmn:Task',
    kind,
    incoming: [],
    outgoing: [],
    params: {},
    supported: true
  };
}

function flow(id: string, sourceId: string, targetId: string): SimFlow {
  return {
    id,
    name: id,
    sourceId,
    targetId,
    hasCondition: false,
    params: {}
  };
}

function movementLog(elementIds: string[]): SimulationLogEntry[] {
  return elementIds.flatMap((elementId) => [
    {
      level: 'info' as const,
      eventType: 'TOKEN_ENTER_ELEMENT' as const,
      caseId: 1,
      tokenId: `enter-${elementId}`,
      elementId,
      message: 'TOKEN_ENTER_ELEMENT',
      time: 5
    },
    {
      level: 'info' as const,
      eventType: 'TOKEN_LEAVE_ELEMENT' as const,
      caseId: 1,
      tokenId: `leave-${elementId}`,
      elementId,
      message: 'TOKEN_LEAVE_ELEMENT',
      time: 5
    }
  ]);
}

function movementEventTime(
  timeline: ReturnType<typeof buildSimulationTimeline>,
  flowId: string,
  type: 'TOKEN_MOVE_START' | 'TOKEN_MOVE_END'
): number {
  const event = timeline.find((candidate) => candidate.type === type && candidate.sequenceFlowId === flowId);

  assert.ok(event);

  return event.simulationTime;
}

function caseTrace(path = ['start']): CaseTrace {
  return {
    id: 1,
    startTime: 8,
    endTime: 8,
    cycleTime: 0,
    status: 'completed',
    retries: 0,
    activeTokens: 0,
    path,
    outputs: {},
    errors: []
  };
}
