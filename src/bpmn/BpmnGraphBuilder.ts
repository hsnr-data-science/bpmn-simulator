import type { BpmnBusinessObject, BpmnDefinitions, SimFlow, SimModel, SimNode } from '../types/bpmn';
import { classifyBpmnElement } from './BpmnElementClassifier';
import { readSimulationConfig } from './ExtensionElementReader';

type BuildContext = {
  nodes: Map<string, SimNode>;
  flows: Map<string, SimFlow>;
  unsupportedElementIds: string[];
};

export function buildBpmnGraph(definitions: BpmnDefinitions): SimModel {
  const process = definitions.rootElements?.find((root) => root.$type === 'bpmn:Process');

  if (!process) {
    throw new Error('Kein bpmn:Process im Diagramm gefunden.');
  }

  const context: BuildContext = {
    nodes: new Map(),
    flows: new Map(),
    unsupportedElementIds: []
  };

  addFlowElements(process.flowElements ?? [], context);

  const startNodeIds = [...context.nodes.values()]
    .filter((node) => node.kind === 'startEvent' && !node.parentSubProcessId)
    .map((node) => node.id);

  if (!startNodeIds.length) {
    throw new Error('Das Modell braucht mindestens ein Start Event.');
  }

  return {
    id: process.id ?? 'Process',
    name: process.name ?? process.id ?? 'BPMN Process',
    nodes: context.nodes,
    flows: context.flows,
    startNodeIds,
    unsupportedElementIds: context.unsupportedElementIds
  };
}

function addFlowElements(
  flowElements: BpmnBusinessObject[],
  context: BuildContext,
  parentSubProcessId?: string
): void {
  for (const element of flowElements) {
    if (!element.id) {
      continue;
    }

    if (element.$type === 'bpmn:SequenceFlow') {
      addFlow(element, context);
      continue;
    }

    addNode(element, context, parentSubProcessId);
  }
}

function addNode(
  element: BpmnBusinessObject,
  context: BuildContext,
  parentSubProcessId?: string
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

  context.nodes.set(element.id, {
    id: element.id,
    name: element.name ?? element.id,
    type: element.$type ?? 'unknown',
    kind: classification.kind,
    incoming: toIds(element.incoming),
    outgoing: toIds(element.outgoing),
    params: readSimulationConfig(element),
    supported: classification.supported,
    parentSubProcessId,
    subProcessStartIds: childStartIds,
    subProcessEndIds: childEndIds,
    defaultFlowId: element.default?.id
  });

  if (childFlowElements.length) {
    addFlowElements(childFlowElements, context, element.id);
  }
}

function addFlow(element: BpmnBusinessObject, context: BuildContext): void {
  if (!element.id || !element.sourceRef?.id || !element.targetRef?.id) {
    return;
  }

  context.flows.set(element.id, {
    id: element.id,
    name: element.name ?? element.id,
    sourceId: element.sourceRef.id,
    targetId: element.targetRef.id,
    hasCondition: Boolean(element.conditionExpression),
    conditionExpression: getConditionBody(element.conditionExpression),
    params: readSimulationConfig(element)
  });
}

function toIds(values: BpmnBusinessObject[] | undefined): string[] {
  return (values ?? []).map((value) => value.id).filter(Boolean) as string[];
}

function getConditionBody(conditionExpression: BpmnBusinessObject | undefined): string | undefined {
  if (!conditionExpression) {
    return undefined;
  }

  return (
    (conditionExpression.body as string | undefined) ??
    (conditionExpression.$body as string | undefined) ??
    (conditionExpression.textContent as string | undefined)
  );
}
