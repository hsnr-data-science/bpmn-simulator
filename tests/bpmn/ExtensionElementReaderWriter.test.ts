import test from 'node:test';
import assert from 'node:assert/strict';
import type { BpmnBusinessObject, BpmnElement } from '../../src/types/bpmn';
import {
  readConditionExpression,
  readResourceCatalog,
  readStartEventConfig,
  readTaskConfig
} from '../../src/bpmn/ExtensionElementReader';
import {
  updateArrivalConfig,
  updateConditionExpression,
  updateDurationConfig,
  updateOutputObjectFields,
  updateResourceCatalog,
  updateSimulationValue
} from '../../src/bpmn/ExtensionElementWriter';

test('ExtensionElementWriter persists nested task simulation config', () => {
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

  updateDurationConfig(element, { type: 'normal', mean: 10, stddev: 2 }, bpmnFactory, modeling);
  updateSimulationValue(element, 'task', ['resource', 'resourceId'], 'clerk', bpmnFactory, modeling);
  updateSimulationValue(element, 'task', ['error', 'probability'], '0.25', bpmnFactory, modeling);
  updateSimulationValue(element, 'task', ['error', 'possibleErrors'], 'pickerror:1', bpmnFactory, modeling);
  updateOutputObjectFields(
    element,
    [
      {
        key: 'score',
        type: 'int',
        generator: 'normal',
        mean: 10,
        stddev: 2,
        min: 0
      },
      {
        key: 'status',
        type: 'string',
        generator: 'categorical',
        choices: [
          { value: 'ok', probability: 0.8 },
          { value: 'manual', probability: 0.2 }
        ]
      }
    ],
    bpmnFactory,
    modeling
  );

  const config = readTaskConfig(businessObject);

  assert.equal(config.duration?.type, 'normal');
  assert.equal(config.duration?.mean, 10);
  assert.equal(config.duration?.stddev, 2);
  assert.equal(config.resource?.resourceId, 'clerk');
  assert.equal(config.error?.probability, 0.25);
  assert.deepEqual(config.error?.possibleErrors, [{ errorCode: 'pickerror', probability: 1 }]);
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
});

test('ExtensionElementWriter replaces duration attributes when the distribution changes', () => {
  const businessObject: BpmnBusinessObject = {
    $type: 'bpmn:Task',
    id: 'task'
  };
  const element: BpmnElement = {
    id: 'task',
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

  updateDurationConfig(element, { type: 'normal', mean: 10, stddev: 2, min: 0 }, bpmnFactory, modeling);
  updateDurationConfig(element, { type: 'uniform', min: 3, max: 8 }, bpmnFactory, modeling);

  const duration = readTaskConfig(businessObject).duration;

  assert.deepEqual(duration, {
    type: 'uniform',
    mean: undefined,
    stddev: undefined,
    min: 3,
    max: 8,
    lambda: undefined,
    mode: undefined
  });
});

test('ExtensionElementWriter persists sequence flow JavaScript conditions as BPMN formal expressions', () => {
  const businessObject: BpmnBusinessObject = {
    $type: 'bpmn:SequenceFlow',
    id: 'flow'
  };
  const element: BpmnElement = {
    id: 'flow',
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

  updateConditionExpression(element, 'status === "ok"', bpmnFactory, modeling);

  assert.equal(businessObject.conditionExpression?.$type, 'bpmn:FormalExpression');
  assert.equal(businessObject.conditionExpression?.language, 'JavaScript');
  assert.equal(readConditionExpression(businessObject), 'status === "ok"');
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
        hourRanges: [{ start: 8, end: 17 }]
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
      hourRanges: [{ start: 8, end: 17 }]
    }
  ]);
});

test('ExtensionElementWriter persists start event arrival calendars', () => {
  const businessObject: BpmnBusinessObject = {
    $type: 'bpmn:StartEvent',
    id: 'start'
  };
  const element: BpmnElement = {
    id: 'start',
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

  updateSimulationValue(element, 'startEvent', ['arrival', 'weekdays'], '1,2,3,4,5', bpmnFactory, modeling);
  updateSimulationValue(element, 'startEvent', ['arrival', 'hourRanges'], '8-12,13-17', bpmnFactory, modeling);
  updateSimulationValue(element, 'startEvent', ['arrival', 'numberOfCases'], '12', bpmnFactory, modeling);
  updateArrivalConfig(element, { type: 'fixed', interval: 5, mean: 99 }, bpmnFactory, modeling);
  updateArrivalConfig(element, { type: 'normal', interval: 5, mean: 3, stddev: 0.5 }, bpmnFactory, modeling);
  updateArrivalConfig(element, { type: 'exponential', interval: 5, mean: 3 }, bpmnFactory, modeling);
  updateArrivalConfig(element, { type: 'none', interval: 5, mean: 3 }, bpmnFactory, modeling);

  const config = readStartEventConfig(businessObject);

  assert.equal(config.arrival?.type, 'none');
  assert.equal(config.arrival?.interval, undefined);
  assert.equal(config.arrival?.mean, undefined);
  assert.equal(config.arrival?.numberOfCases, 12);
  assert.deepEqual(config.arrival?.weekdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(config.arrival?.hourRanges, [{ start: 8, end: 12 }, { start: 13, end: 17 }]);
});

test('ExtensionElementWriter persists output object fields from structured UI updates', () => {
  const businessObject: BpmnBusinessObject = {
    $type: 'bpmn:UserTask',
    id: 'user'
  };
  const element: BpmnElement = {
    id: 'user',
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

  updateOutputObjectFields(
    element,
    [
      {
        key: 'amount',
        type: 'float',
        generator: 'normal',
        mean: 12,
        stddev: 2,
        min: 0
      },
      {
        key: 'status',
        type: 'string',
        generator: 'categorical',
        choices: [
          { value: 'ok', probability: 0.9 },
          { value: 'manual', probability: 0.1 }
        ]
      }
    ],
    bpmnFactory,
    modeling
  );

  const config = readTaskConfig(businessObject);

  assert.equal(config.outputObject?.fields?.[0].key, 'amount');
  assert.equal(config.outputObject?.fields?.[0].mean, 12);
  assert.deepEqual(config.outputObject?.fields?.[1].choices, [
    { value: 'ok', probability: 0.9 },
    { value: 'manual', probability: 0.1 }
  ]);
});
