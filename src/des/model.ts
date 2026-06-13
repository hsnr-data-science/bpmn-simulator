import { getSimulationParameters, type BpmnBusinessObject } from '../bpmn/simulationExtension';
import type { FlowNodeKind, SimFlow, SimModel, SimNode } from './types';

type Definitions = {
  rootElements?: BpmnBusinessObject[];
};

type FlowElement = BpmnBusinessObject & {
  sourceRef?: BpmnBusinessObject;
  targetRef?: BpmnBusinessObject;
  incoming?: BpmnBusinessObject[];
  outgoing?: BpmnBusinessObject[];
};

export function compileModel(definitions: Definitions): SimModel {
  const process = definitions.rootElements?.find((root) => root.$type === 'bpmn:Process');

  if (!process) {
    throw new Error('Kein bpmn:Process im Diagramm gefunden.');
  }

  const flowElements = (process.flowElements ?? []) as FlowElement[];
  const nodes = new Map<string, SimNode>();
  const flows = new Map<string, SimFlow>();

  for (const element of flowElements) {
    if (!element.id) {
      continue;
    }

    if (element.$type === 'bpmn:SequenceFlow') {
      if (!element.sourceRef?.id || !element.targetRef?.id) {
        continue;
      }

      flows.set(element.id, {
        id: element.id,
        name: element.name ?? element.id,
        sourceId: element.sourceRef.id,
        targetId: element.targetRef.id,
        params: getSimulationParameters(element)
      });

      continue;
    }

    const kind = classifyNode(element.$type ?? '');

    if (kind === 'unknown') {
      continue;
    }

    nodes.set(element.id, {
      id: element.id,
      name: element.name ?? element.id,
      type: element.$type ?? 'unknown',
      kind,
      incoming: (element.incoming ?? []).map((flow) => flow.id).filter(Boolean) as string[],
      outgoing: (element.outgoing ?? []).map((flow) => flow.id).filter(Boolean) as string[],
      params: getSimulationParameters(element)
    });
  }

  const startNodeIds = [...nodes.values()]
    .filter((node) => node.kind === 'startEvent')
    .map((node) => node.id);

  if (!startNodeIds.length) {
    throw new Error('Das Modell braucht mindestens ein Start Event.');
  }

  return {
    id: process.id ?? 'Process',
    name: process.name ?? process.id ?? 'BPMN Process',
    nodes,
    flows,
    startNodeIds
  };
}

function classifyNode(type: string): FlowNodeKind {
  switch (type) {
    case 'bpmn:StartEvent':
      return 'startEvent';
    case 'bpmn:EndEvent':
      return 'endEvent';
    case 'bpmn:ExclusiveGateway':
      return 'exclusiveGateway';
    case 'bpmn:EventBasedGateway':
      return 'eventBasedGateway';
    case 'bpmn:ParallelGateway':
      return 'parallelGateway';
    case 'bpmn:InclusiveGateway':
      return 'inclusiveGateway';
    case 'bpmn:IntermediateCatchEvent':
    case 'bpmn:IntermediateThrowEvent':
      return 'event';
    case 'bpmn:Task':
    case 'bpmn:UserTask':
    case 'bpmn:ServiceTask':
    case 'bpmn:ScriptTask':
    case 'bpmn:BusinessRuleTask':
    case 'bpmn:ManualTask':
    case 'bpmn:ReceiveTask':
    case 'bpmn:SendTask':
    case 'bpmn:CallActivity':
    case 'bpmn:SubProcess':
      return 'activity';
    default:
      return 'unknown';
  }
}
