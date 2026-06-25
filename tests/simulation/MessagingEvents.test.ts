import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { BpmnDefinitions, SimFlow, SimModel, SimNode } from '../../src/types/bpmn';
import { buildBpmnGraph } from '../../src/bpmn/BpmnGraphBuilder';
import { TimelineFrameBuilder } from '../../src/playback/TimelineFrameBuilder';
import { VisualStateStore } from '../../src/playback/VisualStateStore';
import { DesEngine } from '../../src/simulation/DesEngine';

type BpmnModdleCtor = new () => {
  fromXML(xml: string): Promise<{ rootElement: unknown }>;
};

test('BPMN graph builder reads collaborations with multiple processes and message flows', async () => {
  const model = await loadMessagingModel();

  assert.equal(model.processes?.size, 2);
  assert.equal(model.messageFlows?.length, 2);
  assert.deepEqual(new Set(model.startNodeIds), new Set(['StartEvent_Order', 'Event_179da30']));
  assert.equal(model.nodes.get('Gateway_1r2so5n')?.kind, 'eventBasedGateway');
  assert.equal(model.nodes.get('Event_041oh80')?.eventDefinitions?.[0]?.name, 'ordermsg2');
  assert.equal(model.nodes.get('Event_1vd2smq')?.eventDefinitions?.[0]?.name, 'shipmsg2');
  assert.equal(model.nodes.get('Event_179da30')?.params.arrival?.type, 'none');
});

test('DES delivers messages across pools and resumes a waiting catch event', async () => {
  const model = await loadMessagingModel();

  makeMessagingModelDeterministic(model);
  forceExclusivePath(model, 'Flow_1n6mqny', ['Flow_0jb5mwb', 'Flow_1om6y6c']);

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 7,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const casesById = new Map(result.cases.map((caseTrace) => [caseTrace.id, caseTrace]));
  const parentCases = result.cases.filter((caseTrace) => {
    return caseTrace.processId === 'Process_Order_Fulfillment' && caseTrace.trigger === 'arrival';
  });
  const childCases = result.cases.filter((caseTrace) => {
    return caseTrace.processId === 'Process_1n5337j';
  });
  const receivedReplies = result.log.filter((entry) => {
    return entry.eventType === 'MESSAGE_RECEIVED' && entry.elementId === 'Event_1vd2smq';
  });

  assert.equal(parentCases.length, 10);
  assert.equal(childCases.length, 10);
  assert.equal(result.completedCases, 20);
  assert.equal(result.deadlockSuspicions, 0);
  assert.ok(childCases.every((caseTrace) => {
    return caseTrace.parentCaseId !== undefined &&
      caseTrace.outputs.parentCaseId === caseTrace.parentCaseId &&
      caseTrace.trigger === 'message' &&
      caseTrace.triggerEventKey === 'ordermsg2';
  }));
  assert.equal(receivedReplies.length, 10);

  for (const reply of receivedReplies) {
    const childCase = reply.sourceCaseId === undefined ? undefined : casesById.get(reply.sourceCaseId);

    assert.equal(childCase?.parentCaseId, reply.caseId);
  }
});

test('Messaging playback waits at the event-based gateway and clears the winning catch event', async () => {
  const model = await loadMessagingModel();

  makeMessagingModelDeterministic(model);
  forceExclusivePath(model, 'Flow_1n6mqny', ['Flow_0jb5mwb', 'Flow_1om6y6c']);
  const start = model.nodes.get('StartEvent_Order');

  if (!start?.params.arrival) {
    throw new Error('Messaging start event arrival config missing');
  }

  start.params.arrival.numberOfCases = 1;

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 7,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const messageReceived = result.log.find((entry) => {
    return entry.eventType === 'MESSAGE_RECEIVED' && entry.elementId === 'Event_1vd2smq';
  });
  const catchLeave = result.log.find((entry) => {
    return entry.eventType === 'TOKEN_LEAVE_ELEMENT' &&
      entry.elementId === 'Event_1vd2smq' &&
      entry.caseId === messageReceived?.caseId;
  });
  const gatewayMovement = result.timeline.find((event) => {
    return event.type === 'TOKEN_MOVE_START' && event.sequenceFlowId === 'Flow_01eymnt';
  });
  const senderArrival = result.timeline.find((event) => {
    return event.type === 'TOKEN_MOVE_END' && event.sequenceFlowId === 'Flow_1n6mqny';
  });
  const finalFrameTime = result.timeline.at(-1)?.simulationTime ?? 0;
  const finalState = new VisualStateStore(
    new TimelineFrameBuilder().buildFrames(result.timeline)
  ).rebuildUntil(finalFrameTime);

  assert.ok(messageReceived?.time !== undefined);
  assert.equal(catchLeave?.time, messageReceived.time);
  assert.ok(senderArrival);
  assert.ok((gatewayMovement?.simulationTime ?? 0) >= senderArrival.simulationTime);
  assert.ok(!finalState.tokens.some((token) => {
    return token.elementId === 'Event_1vd2smq' || token.elementId === 'Event_0rwco36';
  }));
});

test('DES lets a signal win an event-based gateway race in the parent case', async () => {
  const model = await loadMessagingModel();

  makeMessagingModelDeterministic(model);
  forceExclusivePath(model, 'Flow_0jb5mwb', ['Flow_1n6mqny', 'Flow_1om6y6c']);

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 7,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const parentCases = result.cases.filter((caseTrace) => {
    return caseTrace.processId === 'Process_Order_Fulfillment' && caseTrace.trigger === 'arrival';
  });
  const receivedReplies = result.log.filter((entry) => {
    return entry.eventType === 'MESSAGE_RECEIVED' && entry.elementId === 'Event_1vd2smq';
  });
  const signalContinues = result.log.filter((entry) => {
    return entry.eventType === 'SIGNAL_RECEIVED' && entry.elementId === 'Event_0rwco36';
  });
  const senderArrival = result.timeline.find((event) => {
    return event.type === 'TOKEN_MOVE_END' && event.sequenceFlowId === 'Flow_0jb5mwb';
  });
  const gatewayMovement = result.timeline.find((event) => {
    return event.type === 'TOKEN_MOVE_START' && event.sequenceFlowId === 'Flow_0exe2s5';
  });
  const finalFrameTime = result.timeline.at(-1)?.simulationTime ?? 0;
  const finalState = new VisualStateStore(
    new TimelineFrameBuilder().buildFrames(result.timeline)
  ).rebuildUntil(finalFrameTime);

  assert.equal(parentCases.length, 10);
  assert.equal(signalContinues.length, 10);
  assert.equal(receivedReplies.length, 0);
  assert.equal(result.completedCases, 20);
  assert.equal(result.deadlockSuspicions, 0);
  assert.ok(senderArrival);
  assert.ok((gatewayMovement?.simulationTime ?? 0) >= senderArrival.simulationTime);
  assert.ok(!finalState.tokens.some((token) => token.elementId === 'Event_0rwco36'));
});

test('DES can start event-based processes from stochastic external events', () => {
  const model = createExternalEventModel();

  const result = new DesEngine(model, {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.equal(result.completedCases, 3);
  assert.equal(result.cases.filter((caseTrace) => caseTrace.trigger === 'externalEvent').length, 3);
  assert.deepEqual(result.cases.map((caseTrace) => caseTrace.startTime), [8, 10, 12]);
});

test('DES never auto-starts message start events from arrival settings', () => {
  const model = createExternalEventModel();
  const start = model.nodes.get('externalStart');

  if (!start) {
    throw new Error('external start missing');
  }

  start.eventDefinitions = [
    {
      type: 'message',
      name: 'externalOrder'
    }
  ];

  const result = new DesEngine(model, {
    numberOfRuns: 3,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();

  assert.equal(result.cases.length, 0);
  assert.equal(result.completedCases, 0);
});

test('DES exposes parentCaseId as a child process variable', () => {
  const result = new DesEngine(createCorrelatedMessageModel(), {
    numberOfRuns: 1,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const childCase = result.cases.find((caseTrace) => {
    return caseTrace.processId === 'workerA' && caseTrace.trigger === 'message';
  });

  assert.equal(childCase?.outputs.parentCaseId, childCase?.parentCaseId);
  assert.match(result.exports.eventLogCsv, /parentCaseId/);
});

test('DES correlates child process replies to the parent case that started the child', () => {
  const result = new DesEngine(createCorrelatedMessageModel(), {
    numberOfRuns: 5,
    randomSeed: 1,
    animationSpeed: 1,
    collectTraces: true
  }).run();
  const casesById = new Map(result.cases.map((caseTrace) => [caseTrace.id, caseTrace]));
  const receivedReplies = result.log.filter((entry) => {
    return entry.eventType === 'MESSAGE_RECEIVED' && entry.elementId === 'mainWaitReply';
  });

  assert.equal(result.completedCases, 4);
  assert.equal(receivedReplies.length, 2);

  for (const reply of receivedReplies) {
    const childCase = reply.sourceCaseId === undefined ? undefined : casesById.get(reply.sourceCaseId);

    assert.equal(childCase?.parentCaseId, reply.caseId);
  }
});

async function loadMessagingModel(): Promise<SimModel> {
  const xml = readFileSync('tests/bpmn/messaging.bpmn', 'utf8');
  const { BpmnModdle } = await importBpmnModdle();
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);

  return buildBpmnGraph(rootElement as BpmnDefinitions);
}

function createCorrelatedMessageModel(): SimModel {
  const nodes: SimNode[] = [
    messageNode('mainStartA', 'Main Start A', 'startEvent', 'none', [], ['flow_main_start_a_send']),
    messageNode('mainSendA', 'Send Order A', 'messageEvent', 'throw', ['flow_main_start_a_send'], ['flow_main_send_a_wait'], 'orderA'),
    messageNode('mainStartB', 'Main Start B', 'startEvent', 'none', [], ['flow_main_start_b_send']),
    messageNode('mainSendB', 'Send Order B', 'messageEvent', 'throw', ['flow_main_start_b_send'], ['flow_main_send_b_wait'], 'orderB'),
    messageNode('mainWaitReply', 'Wait Reply', 'messageEvent', 'catch', ['flow_main_send_a_wait', 'flow_main_send_b_wait'], ['flow_main_wait_end'], 'reply'),
    messageNode('mainEnd', 'Main End', 'endEvent', 'throw', ['flow_main_wait_end'], []),
    messageNode('workerStartA', 'Worker Start A', 'startEvent', 'catch', [], ['flow_worker_a_start_timer'], 'orderA', 'workerA'),
    {
      ...messageNode('workerTimerA', 'Worker Delay A', 'timerIntermediateEvent', 'catch', ['flow_worker_a_start_timer'], ['flow_worker_a_timer_reply'], undefined, 'workerA'),
      params: {
        duration: {
          type: 'fixed',
          mean: 120
        }
      }
    },
    messageNode('workerReplyA', 'Reply A', 'messageEvent', 'throw', ['flow_worker_a_timer_reply'], ['flow_worker_a_reply_end'], 'reply', 'workerA'),
    messageNode('workerEndA', 'Worker End A', 'endEvent', 'throw', ['flow_worker_a_reply_end'], [], undefined, 'workerA'),
    messageNode('workerStartB', 'Worker Start B', 'startEvent', 'catch', [], ['flow_worker_b_start_reply'], 'orderB', 'workerB'),
    messageNode('workerReplyB', 'Reply B', 'messageEvent', 'throw', ['flow_worker_b_start_reply'], ['flow_worker_b_reply_end'], 'reply', 'workerB'),
    messageNode('workerEndB', 'Worker End B', 'endEvent', 'throw', ['flow_worker_b_reply_end'], [], undefined, 'workerB')
  ];
  const flows: SimFlow[] = [
    flow('flow_main_start_a_send', 'mainStartA', 'mainSendA', 'main'),
    flow('flow_main_send_a_wait', 'mainSendA', 'mainWaitReply', 'main'),
    flow('flow_main_start_b_send', 'mainStartB', 'mainSendB', 'main'),
    flow('flow_main_send_b_wait', 'mainSendB', 'mainWaitReply', 'main'),
    flow('flow_main_wait_end', 'mainWaitReply', 'mainEnd', 'main'),
    flow('flow_worker_a_start_timer', 'workerStartA', 'workerTimerA', 'workerA'),
    flow('flow_worker_a_timer_reply', 'workerTimerA', 'workerReplyA', 'workerA'),
    flow('flow_worker_a_reply_end', 'workerReplyA', 'workerEndA', 'workerA'),
    flow('flow_worker_b_start_reply', 'workerStartB', 'workerReplyB', 'workerB'),
    flow('flow_worker_b_reply_end', 'workerReplyB', 'workerEndB', 'workerB')
  ];

  return {
    id: 'main',
    name: 'Correlated Messages',
    resources: new Map(),
    nodes: new Map(nodes.map((node) => [node.id, node])),
    flows: new Map(flows.map((item) => [item.id, item])),
    startNodeIds: ['mainStartA', 'mainStartB', 'workerStartA', 'workerStartB'],
    unsupportedElementIds: [],
    processes: new Map([
      ['main', { id: 'main', name: 'Main', startNodeIds: ['mainStartA', 'mainStartB'] }],
      ['workerA', { id: 'workerA', name: 'Worker A', startNodeIds: ['workerStartA'] }],
      ['workerB', { id: 'workerB', name: 'Worker B', startNodeIds: ['workerStartB'] }]
    ]),
    messageFlows: [
      { id: 'message_order_a', name: 'Order A', sourceId: 'mainSendA', targetId: 'workerStartA', messageName: 'orderA' },
      { id: 'message_order_b', name: 'Order B', sourceId: 'mainSendB', targetId: 'workerStartB', messageName: 'orderB' },
      { id: 'message_reply_a', name: 'Reply A', sourceId: 'workerReplyA', targetId: 'mainWaitReply', messageName: 'reply' },
      { id: 'message_reply_b', name: 'Reply B', sourceId: 'workerReplyB', targetId: 'mainWaitReply', messageName: 'reply' }
    ]
  };
}

function messageNode(
  id: string,
  name: string,
  kind: SimNode['kind'],
  direction: SimNode['eventDirection'],
  incoming: string[],
  outgoing: string[],
  messageName?: string,
  processId = 'main'
): SimNode {
  return {
    id,
    name,
    type: kind === 'startEvent'
      ? 'bpmn:StartEvent'
      : kind === 'endEvent'
        ? 'bpmn:EndEvent'
        : kind === 'timerIntermediateEvent'
          ? 'bpmn:IntermediateCatchEvent'
          : 'bpmn:IntermediateThrowEvent',
    kind,
    incoming,
    outgoing,
    params: kind === 'startEvent'
      ? {
          arrival: processId === 'main'
            ? {
                type: 'fixed',
                interval: 60,
                numberOfCases: 1
              }
            : {
                type: 'none'
              }
        }
      : {},
    supported: true,
    processId,
    eventDirection: direction,
    eventDefinitions: messageName
      ? [
          {
            type: 'message',
            name: messageName
          }
        ]
      : undefined
  };
}

function flow(id: string, sourceId: string, targetId: string, processId: string): SimFlow {
  return {
    id,
    name: id,
    sourceId,
    targetId,
    hasCondition: false,
    params: {},
    processId
  };
}

async function importBpmnModdle(): Promise<{ BpmnModdle: BpmnModdleCtor }> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as
    (specifier: string) => Promise<{ BpmnModdle: BpmnModdleCtor }>;

  return dynamicImport('bpmn-moddle');
}

function makeMessagingModelDeterministic(model: SimModel): void {
  for (const node of model.nodes.values()) {
    if (node.kind === 'task' || node.kind === 'userTask' || node.kind === 'serviceTask') {
      node.params.duration = {
        type: 'fixed',
        mean: 0
      };
      node.params.resource = undefined;
      node.params.failure = {
        probability: 0,
        retryCount: 0
      };
      node.params.error = {
        probability: 0,
        possibleErrors: []
      };
    }
  }
}

function forceExclusivePath(model: SimModel, selectedFlowId: string, otherFlowIds: string[]): void {
  const selected = model.flows.get(selectedFlowId);
  const others = otherFlowIds.map((flowId) => model.flows.get(flowId));

  if (!selected || others.some((flow) => !flow)) {
    throw new Error('Messaging XOR flows missing');
  }

  selected.params.branch = { probability: 1 };

  for (const other of others) {
    if (other) {
      other.params.branch = { probability: 0 };
    }
  }
}

function createExternalEventModel(): SimModel {
  const nodes: SimNode[] = [
    {
      id: 'externalStart',
      name: 'External Start',
      type: 'bpmn:StartEvent',
      kind: 'startEvent',
      incoming: [],
      outgoing: ['flow_start_end'],
      params: {
        arrival: {
          type: 'fixed',
          interval: 120,
          numberOfCases: 3
        }
      },
      supported: true,
      processId: 'externalProcess',
      eventDefinitions: [
        {
          type: 'timer',
          name: 'externalOrder'
        }
      ],
      eventDirection: 'catch'
    },
    {
      id: 'end',
      name: 'End',
      type: 'bpmn:EndEvent',
      kind: 'endEvent',
      incoming: ['flow_start_end'],
      outgoing: [],
      params: {},
      supported: true,
      processId: 'externalProcess',
      eventDirection: 'throw'
    }
  ];
  const flows: SimFlow[] = [
    {
      id: 'flow_start_end',
      name: 'flow_start_end',
      sourceId: 'externalStart',
      targetId: 'end',
      hasCondition: false,
      params: {},
      processId: 'externalProcess'
    }
  ];

  return {
    id: 'externalProcess',
    name: 'External Events',
    resources: new Map(),
    nodes: new Map(nodes.map((node) => [node.id, node])),
    flows: new Map(flows.map((flow) => [flow.id, flow])),
    startNodeIds: ['externalStart'],
    unsupportedElementIds: [],
    processes: new Map([
      [
        'externalProcess',
        {
          id: 'externalProcess',
          name: 'External Events',
          startNodeIds: ['externalStart']
        }
      ]
    ])
  };
}
