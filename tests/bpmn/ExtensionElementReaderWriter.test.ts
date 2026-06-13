import test from 'node:test';
import assert from 'node:assert/strict';
import type { BpmnBusinessObject, BpmnElement } from '../../src/types/bpmn';
import { readResourceCatalog, readTaskConfig } from '../../src/bpmn/ExtensionElementReader';
import { updateResourceCatalog, updateSimulationValue } from '../../src/bpmn/ExtensionElementWriter';

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
  updateSimulationValue(
    element,
    'task',
    ['outputObject', 'fields'],
    'score:int:normal:mean=10,stddev=2,min=0; status:string:categorical:ok:0.8|manual:0.2',
    bpmnFactory,
    modeling
  );
  updateSimulationValue(element, 'task', ['output', 'possibleOutputs'], 'ok:0.8, manual:0.2', bpmnFactory, modeling);

  const config = readTaskConfig(businessObject);

  assert.equal(config.duration?.type, 'normal');
  assert.equal(config.duration?.mean, 10);
  assert.equal(config.duration?.stddev, 2);
  assert.equal(config.resource?.resourceId, 'clerk');
  assert.equal(config.resource?.capacity, 3);
  assert.deepEqual(config.outputObject?.fields, [
    {
      key: 'score',
      type: 'int',
      generator: 'normal',
      value: undefined,
      choices: undefined,
      mean: 10,
      stddev: 2,
      min: 0,
      max: undefined,
      mode: undefined,
      lambda: undefined,
      length: undefined
    },
    {
      key: 'status',
      type: 'string',
      generator: 'categorical',
      value: undefined,
      choices: [
        { value: 'ok', probability: 0.8 },
        { value: 'manual', probability: 0.2 }
      ],
      mean: undefined,
      stddev: undefined,
      min: undefined,
      max: undefined,
      mode: undefined,
      lambda: undefined,
      length: undefined
    }
  ]);
  assert.deepEqual(config.output?.possibleOutputs, [
    { value: 'ok', probability: 0.8 },
    { value: 'manual', probability: 0.2 }
  ]);
});

test('ExtensionElementWriter persists the global resource catalog', () => {
  const process: BpmnBusinessObject = {
    $type: 'bpmn:Process',
    id: 'process'
  };
  const rootElement: BpmnElement = {
    id: 'process',
    businessObject: process
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

  updateResourceCatalog(
    rootElement,
    process,
    [
      {
        id: 'clerk',
        name: 'Clerk Team',
        capacity: 2,
        weekdays: [1, 2, 3, 4, 5],
        hourRanges: [{ start: 8, end: 17 }],
        calendar: 'Mo-Fr 08:00-17:00'
      }
    ],
    bpmnFactory,
    modeling
  );

  assert.deepEqual(readResourceCatalog(process), [
    {
      id: 'clerk',
      name: 'Clerk Team',
      capacity: 2,
      weekdays: [1, 2, 3, 4, 5],
      hourRanges: [{ start: 8, end: 17 }],
      calendar: 'Mo-Fr 08:00-17:00'
    }
  ]);
});
