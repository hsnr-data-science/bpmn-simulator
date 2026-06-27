import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBpmnGraph } from '../../src/bpmn/BpmnGraphBuilder';
import { parseTimerExpression } from '../../src/bpmn/TimerExpression';
import { DesEngine } from '../../src/simulation/DesEngine';
import type { BpmnDefinitions, SimModel } from '../../src/types/bpmn';

type BpmnModdleCtor = new () => {
  fromXML(xml: string): Promise<{ rootElement: unknown }>;
};

test('BPMN timer expressions accept durations and duration-based cycles only', () => {
  assert.deepEqual(parseTimerExpression('PT60M'), {
    kind: 'duration',
    durationMinutes: 60,
    expression: 'PT60M'
  });
  assert.deepEqual(parseTimerExpression('P14D'), {
    kind: 'duration',
    durationMinutes: 14 * 24 * 60,
    expression: 'P14D'
  });
  assert.deepEqual(parseTimerExpression('R3/PT1H30M'), {
    kind: 'cycle',
    durationMinutes: 90,
    expression: 'R3/PT1H30M'
  });
  assert.equal(parseTimerExpression('2026-07-01T08:00:00Z'), undefined);
  assert.equal(parseTimerExpression('R3/2026-07-01T08:00:00Z/PT60M'), undefined);
  assert.equal(parseTimerExpression('P1M'), undefined);
});

test('BPMN graph builder reads duration-based time cycles from timer definitions', async () => {
  const { BpmnModdle } = await importBpmnModdle();
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(`<?xml version="1.0" encoding="UTF-8"?>
    <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <bpmn:process id="CycleProcess">
        <bpmn:startEvent id="Start"><bpmn:outgoing>Flow_Start_Timer</bpmn:outgoing></bpmn:startEvent>
        <bpmn:intermediateCatchEvent id="Timer">
          <bpmn:incoming>Flow_Start_Timer</bpmn:incoming>
          <bpmn:timerEventDefinition><bpmn:timeCycle xsi:type="bpmn:tFormalExpression">R3/P14D</bpmn:timeCycle></bpmn:timerEventDefinition>
        </bpmn:intermediateCatchEvent>
        <bpmn:sequenceFlow id="Flow_Start_Timer" sourceRef="Start" targetRef="Timer" />
      </bpmn:process>
    </bpmn:definitions>`);
  const timer = buildBpmnGraph(rootElement as BpmnDefinitions).nodes.get('Timer')?.eventDefinitions?.[0];

  assert.equal(timer?.timerDurationMinutes, 14 * 24 * 60);
  assert.equal(timer?.timerIsCycle, true);
});

test('pizza delivery timer waits 60 minutes and correlates the customer request to the pizza vendor', async () => {
  const model = await loadPizzaDeliveryModel();
  const timer = model.nodes.get('_6-219')?.eventDefinitions?.[0];

  assert.equal(timer?.timerDurationMinutes, 60);
  assert.equal(timer?.timerExpression, 'PT60M');

  makePizzaScenarioDeterministic(model);

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 17,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const timerFired = result.log.find((entry) => {
    return entry.eventType === 'TIMER_FIRED' && entry.elementId === '_6-219';
  });
  const customerRequests = result.log.filter((entry) => {
    return entry.eventType === 'MESSAGE_RECEIVED' && entry.elementId === '_6-674';
  });
  const customerCase = result.cases.find((caseTrace) => caseTrace.processId === '_6-2');

  if (timerFired?.time === undefined || !customerCase) {
    throw new Error('Pizza timer event or customer case missing.');
  }

  assert.ok(Math.abs((timerFired.time - customerCase.startTime) - 65 / 60) < 1e-9);
  assert.equal(customerRequests.length, 1);
  assert.equal(executionCount(result, 'CalmCustomerTask'), 1);
});

async function loadPizzaDeliveryModel(): Promise<SimModel> {
  const xml = readFileSync('tests/bpmn/pizza-delivery.bpmn', 'utf8');
  const { BpmnModdle } = await importBpmnModdle();
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);

  return buildBpmnGraph(rootElement as BpmnDefinitions);
}

function makePizzaScenarioDeterministic(model: SimModel): void {
  for (const node of model.nodes.values()) {
    if (node.kind === 'task' || node.kind === 'userTask' || node.kind === 'serviceTask') {
      node.params.duration = { type: 'fixed', mean: 0 };
      node.params.resource = undefined;
      node.params.error = { probability: 0 };
    }
  }

  const customerStart = model.nodes.get('_6-61');
  const selectPizza = model.nodes.get('SelectAPizzaTask');
  const orderPizza = model.nodes.get('_6-127');
  const bakePizza = model.nodes.get('_6-463');
  const askPizza = model.nodes.get('_6-236');

  if (!customerStart || !selectPizza || !orderPizza || !bakePizza || !askPizza) {
    throw new Error('Pizza delivery model is incomplete.');
  }

  customerStart.params.arrival = { type: 'fixed', interval: 0, numberOfCases: 1 };
  selectPizza.params.duration = { type: 'fixed', mean: 3 };
  orderPizza.params.duration = { type: 'fixed', mean: 2 };
  bakePizza.params.duration = { type: 'fixed', mean: 120 };
  askPizza.params.duration = { type: 'fixed', mean: 1 };
}

function executionCount(result: ReturnType<DesEngine['run']>, elementId: string): number {
  return result.elementMetrics.find((metric) => metric.elementId === elementId)?.visits ?? 0;
}

async function importBpmnModdle(): Promise<{ BpmnModdle: BpmnModdleCtor }> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as
    (specifier: string) => Promise<{ BpmnModdle: BpmnModdleCtor }>;

  return dynamicImport('bpmn-moddle');
}
