import type { BpmnBusinessObject, FlowNodeKind } from '../types/bpmn';

export type Classification = {
  kind: FlowNodeKind;
  supported: boolean;
  reason?: string;
};

export function classifyBpmnElement(element: BpmnBusinessObject): Classification {
  const type = element.$type ?? '';

  if (isEventSubProcess(element)) {
    return {
      kind: 'eventSubProcess',
      supported: false,
      reason: 'Event Subprocesses sind vorbereitet, aber noch nicht implementiert.'
    };
  }

  if (hasMultiInstanceMarker(element)) {
    return {
      kind: 'multiInstanceActivity',
      supported: false,
      reason: 'Multi-Instance Activities sind vorbereitet, aber noch nicht implementiert.'
    };
  }

  if (type === 'bpmn:StartEvent') {
    return { kind: 'startEvent', supported: true };
  }

  if (type === 'bpmn:EndEvent') {
    return { kind: 'endEvent', supported: true };
  }

  if (type === 'bpmn:SequenceFlow') {
    return { kind: 'sequenceFlow', supported: true };
  }

  if (type === 'bpmn:ExclusiveGateway') {
    return { kind: 'exclusiveGateway', supported: true };
  }

  if (type === 'bpmn:ParallelGateway') {
    return { kind: 'parallelGateway', supported: true };
  }

  if (type === 'bpmn:EventBasedGateway') {
    return { kind: 'eventBasedGateway', supported: true };
  }

  if (type === 'bpmn:InclusiveGateway') {
    return {
      kind: 'inclusiveGateway',
      supported: false,
      reason: 'Inclusive Gateways sind vorbereitet, aber noch nicht voll implementiert.'
    };
  }

  if (type === 'bpmn:BoundaryEvent') {
    return {
      kind: 'boundaryEvent',
      supported: false,
      reason: 'Boundary Events sind vorbereitet, aber noch nicht implementiert.'
    };
  }

  if (isTimerIntermediateEvent(element)) {
    return { kind: 'timerIntermediateEvent', supported: true };
  }

  if (isMessageEvent(element)) {
    return { kind: 'messageEvent', supported: true };
  }

  if (isSignalEvent(element)) {
    return { kind: 'signalEvent', supported: true };
  }

  if (type === 'bpmn:SubProcess') {
    return { kind: 'subProcess', supported: true };
  }

  if (type === 'bpmn:ServiceTask') {
    return { kind: 'serviceTask', supported: true };
  }

  if (type === 'bpmn:UserTask') {
    return { kind: 'userTask', supported: true };
  }

  if (isTaskLike(type)) {
    return { kind: 'task', supported: true };
  }

  if (isFlowNodeLike(element)) {
    return {
      kind: 'unsupported',
      supported: false,
      reason: `${type || element.id || 'Element'} wird von der DES-Engine noch nicht unterstuetzt.`
    };
  }

  return {
    kind: 'unsupported',
    supported: false,
    reason: `${type || element.id || 'Element'} wird nicht als simulierbarer Flow Node erkannt.`
  };
}

export function isSimulationEditable(element: BpmnBusinessObject | undefined): boolean {
  if (!element?.$type) {
    return false;
  }

  const classification = classifyBpmnElement(element);

  return classification.supported || classification.kind === 'inclusiveGateway';
}

export function isTaskKind(kind: FlowNodeKind): boolean {
  return kind === 'task' || kind === 'serviceTask' || kind === 'userTask';
}

export function isTaskType(type: string): boolean {
  return isTaskLike(type);
}

export function supportsOutputObject(type: string): boolean {
  return [
    'bpmn:UserTask',
    'bpmn:ScriptTask',
    'bpmn:ReceiveTask',
    'bpmn:ServiceTask'
  ].includes(type);
}

function isTaskLike(type: string): boolean {
  return [
    'bpmn:Task',
    'bpmn:UserTask',
    'bpmn:ServiceTask',
    'bpmn:ScriptTask',
    'bpmn:BusinessRuleTask',
    'bpmn:ManualTask',
    'bpmn:ReceiveTask',
    'bpmn:SendTask',
    'bpmn:CallActivity'
  ].includes(type);
}

function isTimerIntermediateEvent(element: BpmnBusinessObject): boolean {
  return (
    element.$type === 'bpmn:IntermediateCatchEvent' &&
    (element.eventDefinitions ?? []).some((definition) => definition.$type === 'bpmn:TimerEventDefinition')
  );
}

function isMessageEvent(element: BpmnBusinessObject): boolean {
  return (element.eventDefinitions ?? []).some((definition) => {
    return definition.$type === 'bpmn:MessageEventDefinition';
  });
}

function isSignalEvent(element: BpmnBusinessObject): boolean {
  return (element.eventDefinitions ?? []).some((definition) => {
    return definition.$type === 'bpmn:SignalEventDefinition';
  });
}

function isEventSubProcess(element: BpmnBusinessObject): boolean {
  return element.$type === 'bpmn:SubProcess' && element.triggeredByEvent === true;
}

function hasMultiInstanceMarker(element: BpmnBusinessObject): boolean {
  const loopCharacteristics = element.loopCharacteristics as BpmnBusinessObject | undefined;

  return loopCharacteristics?.$type === 'bpmn:MultiInstanceLoopCharacteristics';
}

function isFlowNodeLike(element: BpmnBusinessObject): boolean {
  const type = element.$type ?? '';

  return (
    type.startsWith('bpmn:') &&
    (type.endsWith('Event') ||
      type.endsWith('Gateway') ||
      type.endsWith('Task') ||
      type === 'bpmn:SubProcess' ||
      type === 'bpmn:CallActivity' ||
      Boolean(element.incoming?.length) ||
      Boolean(element.outgoing?.length))
  );
}
