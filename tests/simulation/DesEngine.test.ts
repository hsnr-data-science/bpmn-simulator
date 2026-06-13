import test from 'node:test';
import assert from 'node:assert/strict';
import type { SimFlow, SimModel, SimNode } from '../../src/types/bpmn';
import { DesEngine } from '../../src/simulation/DesEngine';

test('DES draws fixed task duration and completes the process after that duration', () => {
  const result = new DesEngine(createLinearModel(), {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.equal(result.completedCases, 1);
  assert.equal(result.cases[0].cycleTime, 5);
  assert.equal(result.elementMetrics.find((metric) => metric.elementId === 'task')?.serviceTime, 5);
});

function createLinearModel(): SimModel {
  const nodes: SimNode[] = [
    node('start', 'Start', 'startEvent', ['flow_start_task']),
    {
      ...node('task', 'Task', 'task', ['flow_task_end'], ['flow_start_task']),
      params: {
        duration: {
          type: 'fixed',
          mean: 5
        }
      }
    },
    node('end', 'End', 'endEvent', [], ['flow_task_end'])
  ];
  const flows: SimFlow[] = [
    flow('flow_start_task', 'start', 'task'),
    flow('flow_task_end', 'task', 'end')
  ];

  return {
    id: 'process',
    name: 'Process',
    nodes: new Map(nodes.map((item) => [item.id, item])),
    flows: new Map(flows.map((item) => [item.id, item])),
    startNodeIds: ['start'],
    unsupportedElementIds: []
  };
}

function node(
  id: string,
  name: string,
  kind: SimNode['kind'],
  outgoing: string[],
  incoming: string[] = []
): SimNode {
  return {
    id,
    name,
    type: `bpmn:${name}`,
    kind,
    incoming,
    outgoing,
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
