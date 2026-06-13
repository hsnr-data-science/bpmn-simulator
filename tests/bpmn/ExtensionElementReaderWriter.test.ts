import test from 'node:test';
import assert from 'node:assert/strict';
import type { BpmnBusinessObject, BpmnElement } from '../../src/types/bpmn';
import { readTaskConfig } from '../../src/bpmn/ExtensionElementReader';
import { updateSimulationValue } from '../../src/bpmn/ExtensionElementWriter';

test('ExtensionElementWriter persists nested task duration and resource config', () => {
  const businessObject: BpmnBusinessObject = {
    $type: 'bpmn:ServiceTask',
    id: 'service'
  };
  const element: BpmnElement = {
    id: 'service',
    businessObject
  };
  const bpmnFactory = {
    create(type: string, properties: Record<string, unknown> = {}) {
      return {
        $type: type,
        ...properties
      };
    }
  };
  const modeling = {
    updateModdleProperties(
      _element: BpmnElement,
      moddleElement: BpmnBusinessObject,
      properties: Record<string, unknown>
    ) {
      Object.assign(moddleElement, properties);
    }
  };

  updateSimulationValue(element, 'task', ['duration', 'type'], 'normal', bpmnFactory, modeling);
  updateSimulationValue(element, 'task', ['duration', 'mean'], '10', bpmnFactory, modeling);
  updateSimulationValue(element, 'task', ['duration', 'stddev'], '2', bpmnFactory, modeling);
  updateSimulationValue(element, 'task', ['resource', 'resourceId'], 'clerk', bpmnFactory, modeling);
  updateSimulationValue(element, 'task', ['resource', 'capacity'], '3', bpmnFactory, modeling);
  updateSimulationValue(element, 'task', ['output', 'possibleOutputs'], 'ok:0.8, manual:0.2', bpmnFactory, modeling);

  const config = readTaskConfig(businessObject);

  assert.equal(config.duration?.type, 'normal');
  assert.equal(config.duration?.mean, 10);
  assert.equal(config.duration?.stddev, 2);
  assert.equal(config.resource?.resourceId, 'clerk');
  assert.equal(config.resource?.capacity, 3);
  assert.deepEqual(config.output?.possibleOutputs, [
    { value: 'ok', probability: 0.8 },
    { value: 'manual', probability: 0.2 }
  ]);
});
