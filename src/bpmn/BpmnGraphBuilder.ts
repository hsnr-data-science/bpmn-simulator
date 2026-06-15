import type {
  BpmnBusinessObject,
  BpmnDefinitions,
  SimEventDefinition,
  SimEventDirection,
  SimFlow,
  SimMessageFlow,
  SimModel,
  SimNode,
  SimProcess
} from '../types/bpmn';
import type { ElementSimulationConfig, SimulationResource } from '../types/simulation';
import { classifyBpmnElement } from './BpmnElementClassifier';
import { readConditionExpression, readResourceCatalog, readSimulationConfig } from './ExtensionElementReader';

type BuildContext = {
  resources: Map<string, SimulationResource>;
  nodes: Map<string, SimNode>;
  flows: Map<string, SimFlow>;
  unsupportedElementIds: string[];
  processes: Map<string, SimProcess>;
  messageFlows: SimMessageFlow[];
  messages: Map<string, string>;
  signals: Map<string, string>;
};

export function buildBpmnGraph(definitions: BpmnDefinitions): SimModel {
  const rootElements = definitions.rootElements ?? [];
  const processes = rootElements.filter((root) => root.$type === 'bpmn:Process');

  if (!processes.length) {
    throw new Error('Kein bpmn:Process im Diagramm gefunden.');
  }

  const participantsByProcessId = collectParticipantsByProcessId(rootElements);
  const context: BuildContext = {
    resources: new Map(),
    nodes: new Map(),
    flows: new Map(),
    unsupportedElementIds: [],
    processes: new Map(),
    messageFlows: [],
    messages: collectNamedRootElements(rootElements, 'bpmn:Message'),
    signals: collectNamedRootElements(rootElements, 'bpmn:Signal')
  };

  for (const process of processes) {
    for (const resource of readResourceCatalog(process)) {
      if (!context.resources.has(resource.id)) {
        context.resources.set(resource.id, resource);
      }
    }
  }

  for (const [index, process] of processes.entries()) {
    const processId = process.id ?? `Process_${index + 1}`;
    const participant = participantsByProcessId.get(processId);

    context.processes.set(processId, {
      id: processId,
      name: participant?.name ?? process.name ?? processId,
      participantId: participant?.id,
      participantName: participant?.name,
      startNodeIds: []
    });

    addFlowElements(process.flowElements ?? [], context, undefined, processId);
  }

  const startNodeIds = [...context.nodes.values()]
    .filter((node) => node.kind === 'startEvent' && !node.parentSubProcessId)
    .map((node) => node.id);

  if (!startNodeIds.length) {
    throw new Error('Das Modell braucht mindestens ein Start Event.');
  }

  for (const process of context.processes.values()) {
    process.startNodeIds = startNodeIds.filter((startNodeId) => {
      return context.nodes.get(startNodeId)?.processId === process.id;
    });
  }

  addMessageFlows(rootElements, context);

  const firstProcess = processes[0];
  const firstProcessId = firstProcess.id ?? 'Process';
  const modelName = createModelName(context.processes, firstProcess.name ?? firstProcessId);

  return {
    id: firstProcessId,
    name: modelName,
    resources: context.resources,
    nodes: context.nodes,
    flows: context.flows,
    startNodeIds,
    unsupportedElementIds: context.unsupportedElementIds,
    processes: context.processes,
    messageFlows: context.messageFlows,
    messages: context.messages,
    signals: context.signals
  };
}

function addFlowElements(
  flowElements: BpmnBusinessObject[],
  context: BuildContext,
  parentSubProcessId?: string,
  processId?: string
): void {
  for (const element of flowElements) {
    if (!element.id) {
      continue;
    }

    if (element.$type === 'bpmn:SequenceFlow') {
      addFlow(element, context, processId);
      continue;
    }

    addNode(element, context, parentSubProcessId, processId);
  }
}

function addNode(
  element: BpmnBusinessObject,
  context: BuildContext,
  parentSubProcessId?: string,
  processId?: string
): void {
  if (!element.id) {
    return;
  }

  const classification = classifyBpmnElement(element);
  const childFlowElements = element.$type === 'bpmn:SubProcess' ? element.flowElements ?? [] : [];
  const childStartIds = childFlowElements
    .filter((child) => child.$type === 'bpmn:StartEvent' && child.id)
    .map((child) => child.id as string);
  const childEndIds = childFlowElements
    .filter((child) => child.$type === 'bpmn:EndEvent' && child.id)
    .map((child) => child.id as string);

  if (!classification.supported) {
    context.unsupportedElementIds.push(element.id);
  }

  const params = resolveResourceConfig(readSimulationConfig(element), context.resources);

  context.nodes.set(element.id, {
    id: element.id,
    name: element.name ?? element.id,
    type: element.$type ?? 'unknown',
    kind: classification.kind,
    incoming: toIds(element.incoming),
    outgoing: toIds(element.outgoing),
    params,
    supported: classification.supported,
    processId,
    parentSubProcessId,
    subProcessStartIds: childStartIds,
    subProcessEndIds: childEndIds,
    defaultFlowId: element.default?.id,
    eventDefinitions: readEventDefinitions(element, context),
    eventDirection: readEventDirection(element)
  });

  if (childFlowElements.length) {
    addFlowElements(childFlowElements, context, element.id, processId);
  }
}

function resolveResourceConfig(
  params: ElementSimulationConfig,
  resources: Map<string, SimulationResource>
): ElementSimulationConfig {
  const taskResource = params.resource;
  const resourceId = taskResource?.resourceId;

  if (!resourceId) {
    return params;
  }

  const resource = resources.get(resourceId);

  if (!resource) {
    return params;
  }

  return {
    ...params,
    resource: {
      ...taskResource,
      resourceId,
      resourceName: resource.name,
      capacity: resource.capacity ?? taskResource.capacity,
      weekdays: resource.weekdays ?? taskResource.weekdays,
      hourRanges: resource.hourRanges ?? taskResource.hourRanges
    }
  };
}

function addFlow(element: BpmnBusinessObject, context: BuildContext, processId?: string): void {
  const sourceId = referenceId(element.sourceRef);
  const targetId = referenceId(element.targetRef);

  if (!element.id || !sourceId || !targetId) {
    return;
  }

  context.flows.set(element.id, {
    id: element.id,
    name: element.name ?? element.id,
    sourceId,
    targetId,
    hasCondition: Boolean(element.conditionExpression),
    conditionExpression: readConditionExpression(element),
    params: readSimulationConfig(element),
    processId
  });
}

function toIds(values: BpmnBusinessObject[] | undefined): string[] {
  return (values ?? []).map((value) => value.id).filter(Boolean) as string[];
}

function collectParticipantsByProcessId(rootElements: BpmnBusinessObject[]): Map<string, BpmnBusinessObject> {
  const participants = new Map<string, BpmnBusinessObject>();

  for (const collaboration of rootElements.filter((root) => root.$type === 'bpmn:Collaboration')) {
    for (const participant of collaboration.participants ?? []) {
      const processId = referenceId(participant.processRef);

      if (participant.id && processId) {
        participants.set(processId, participant);
      }
    }
  }

  return participants;
}

function collectNamedRootElements(rootElements: BpmnBusinessObject[], type: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const element of rootElements) {
    if (element.$type === type && element.id) {
      values.set(element.id, element.name ?? element.id);
    }
  }

  return values;
}

function addMessageFlows(rootElements: BpmnBusinessObject[], context: BuildContext): void {
  for (const collaboration of rootElements.filter((root) => root.$type === 'bpmn:Collaboration')) {
    for (const messageFlow of collaboration.messageFlows ?? []) {
      const sourceId = referenceId(messageFlow.sourceRef);
      const targetId = referenceId(messageFlow.targetRef);

      if (!messageFlow.id || !sourceId || !targetId) {
        continue;
      }

      const sourceMessage = firstEventDefinition(context.nodes.get(sourceId), 'message');
      const targetMessage = firstEventDefinition(context.nodes.get(targetId), 'message');
      const messageId = referenceId(messageFlow.messageRef) ?? sourceMessage?.refId ?? targetMessage?.refId;
      const messageName = messageId ? context.messages.get(messageId) : undefined;

      context.messageFlows.push({
        id: messageFlow.id,
        name: messageFlow.name ?? messageFlow.id,
        sourceId,
        targetId,
        messageId,
        messageName: messageName ?? sourceMessage?.name ?? targetMessage?.name
      });
    }
  }
}

function firstEventDefinition(
  node: SimNode | undefined,
  type: SimEventDefinition['type']
): SimEventDefinition | undefined {
  return node?.eventDefinitions?.find((definition) => definition.type === type);
}

function readEventDefinitions(element: BpmnBusinessObject, context: BuildContext): SimEventDefinition[] {
  return (element.eventDefinitions ?? []).map((definition) => {
    const type = toEventDefinitionType(definition.$type);
    const ref = type === 'message'
      ? definition.messageRef
      : type === 'signal'
        ? definition.signalRef
        : undefined;
    const refId = referenceId(ref);
    const refName = referenceName(ref);
    const names = type === 'message'
      ? context.messages
      : type === 'signal'
        ? context.signals
        : undefined;

    return {
      id: definition.id,
      type,
      refId,
      name: refName ?? (refId ? names?.get(refId) : undefined) ?? definition.name
    };
  });
}

function toEventDefinitionType(type: string | undefined): SimEventDefinition['type'] {
  if (type === 'bpmn:MessageEventDefinition') {
    return 'message';
  }

  if (type === 'bpmn:SignalEventDefinition') {
    return 'signal';
  }

  if (type === 'bpmn:TimerEventDefinition') {
    return 'timer';
  }

  if (type === 'bpmn:ErrorEventDefinition') {
    return 'error';
  }

  return 'unknown';
}

function readEventDirection(element: BpmnBusinessObject): SimEventDirection {
  if (
    element.$type === 'bpmn:StartEvent' ||
    element.$type === 'bpmn:IntermediateCatchEvent' ||
    element.$type === 'bpmn:BoundaryEvent'
  ) {
    return 'catch';
  }

  if (
    element.$type === 'bpmn:IntermediateThrowEvent' ||
    element.$type === 'bpmn:EndEvent'
  ) {
    return 'throw';
  }

  return 'none';
}

function referenceId(ref: BpmnBusinessObject | string | unknown): string | undefined {
  if (typeof ref === 'string') {
    return ref;
  }

  if (ref && typeof ref === 'object') {
    const id = (ref as BpmnBusinessObject).id;

    return typeof id === 'string' && id ? id : undefined;
  }

  return undefined;
}

function referenceName(ref: BpmnBusinessObject | string | unknown): string | undefined {
  if (ref && typeof ref === 'object') {
    const name = (ref as BpmnBusinessObject).name;

    return typeof name === 'string' && name ? name : undefined;
  }

  return undefined;
}

function createModelName(processes: Map<string, SimProcess>, fallback: string): string {
  const participantNames = [...processes.values()]
    .map((process) => process.participantName)
    .filter(Boolean) as string[];

  if (participantNames.length > 1) {
    return participantNames.join(' + ');
  }

  return participantNames[0] ?? fallback ?? 'BPMN Process';
}
