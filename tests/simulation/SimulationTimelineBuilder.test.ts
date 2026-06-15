import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSimulationTimeline } from '../../src/simulation/SimulationTimelineBuilder';
import type { SimModel } from '../../src/types/bpmn';
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

function caseTrace(): CaseTrace {
  return {
    id: 1,
    startTime: 8,
    endTime: 8,
    cycleTime: 0,
    status: 'completed',
    retries: 0,
    activeTokens: 0,
    path: ['start'],
    outputs: {},
    errors: []
  };
}
