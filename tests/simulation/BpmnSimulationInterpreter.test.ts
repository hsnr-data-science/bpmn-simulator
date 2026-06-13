import test from 'node:test';
import assert from 'node:assert/strict';
import type { SimFlow, SimModel, SimNode } from '../../src/types/bpmn';
import type { SimulationLogEntry } from '../../src/types/simulation';
import { BpmnSimulationInterpreter } from '../../src/simulation/BpmnSimulationInterpreter';
import { SeededRandom } from '../../src/simulation/RandomDistributions';

test('XOR gateway uses default flow when conditions are present and none evaluates true', () => {
  const model = createXorModel({
    defaultFlowId: 'flow_default',
    flows: [
      flow('flow_condition', 0.9, true),
      flow('flow_default', 0.1, false)
    ]
  });
  const logs: SimulationLogEntry[] = [];
  const interpreter = new BpmnSimulationInterpreter(model);

  const selected = interpreter.getOutgoingFlowIds(
    model.nodes.get('xor') as SimNode,
    new SeededRandom(3),
    (entry) => logs.push(entry)
  );

  assert.deepEqual(selected, ['flow_default']);
  assert.match(logs[0].message, /bedingte Sequence Flows/);
});

test('XOR gateway warns and returns no flow without matching condition or default flow', () => {
  const model = createXorModel({
    flows: [flow('flow_condition', 1, true)]
  });
  const logs: SimulationLogEntry[] = [];
  const interpreter = new BpmnSimulationInterpreter(model);

  const selected = interpreter.getOutgoingFlowIds(
    model.nodes.get('xor') as SimNode,
    new SeededRandom(3),
    (entry) => logs.push(entry)
  );

  assert.deepEqual(selected, []);
  assert.ok(logs.some((entry) => entry.message.includes('kein Default Flow')));
});

test('XOR gateway warns and falls back to equal distribution if branchProbability is missing', () => {
  const model = createXorModel({
    flows: [
      flow('flow_a', undefined, false),
      flow('flow_b', 0.4, false)
    ]
  });
  const logs: SimulationLogEntry[] = [];
  const interpreter = new BpmnSimulationInterpreter(model);

  const selected = interpreter.getOutgoingFlowIds(
    model.nodes.get('xor') as SimNode,
    new SeededRandom(3),
    (entry) => logs.push(entry)
  );

  assert.equal(selected.length, 1);
  assert.ok(logs.some((entry) => entry.message.includes('gleichverteilte Branch-Auswahl')));
});

test('XOR gateway normalizes branchProbability sums that are not 1', () => {
  const model = createXorModel({
    flows: [
      flow('flow_a', 2, false),
      flow('flow_b', 1, false)
    ]
  });
  const logs: SimulationLogEntry[] = [];
  const interpreter = new BpmnSimulationInterpreter(model);

  const selected = interpreter.getOutgoingFlowIds(
    model.nodes.get('xor') as SimNode,
    new SeededRandom(3),
    (entry) => logs.push(entry)
  );

  assert.equal(selected.length, 1);
  assert.ok(logs.some((entry) => entry.message.includes('normalisiert')));
});

function createXorModel(options: { flows: SimFlow[]; defaultFlowId?: string }): SimModel {
  const xor: SimNode = {
    id: 'xor',
    name: 'Decision',
    type: 'bpmn:ExclusiveGateway',
    kind: 'exclusiveGateway',
    incoming: ['in'],
    outgoing: options.flows.map((item) => item.id),
    params: {},
    supported: true,
    defaultFlowId: options.defaultFlowId
  };

  return {
    id: 'process',
    name: 'Process',
    resources: new Map(),
    nodes: new Map([['xor', xor]]),
    flows: new Map(options.flows.map((item) => [item.id, item])),
    startNodeIds: [],
    unsupportedElementIds: []
  };
}

function flow(id: string, probability: number | undefined, hasCondition: boolean): SimFlow {
  return {
    id,
    name: id,
    sourceId: 'xor',
    targetId: `${id}_target`,
    hasCondition,
    conditionExpression: hasCondition ? '${approved}' : undefined,
    params: {
      branch: {
        probability
      }
    }
  };
}
