import type { ElementSimulationConfig } from './simulation';

export type BpmnBusinessObject = {
  $type?: string;
  id?: string;
  name?: string;
  values?: BpmnBusinessObject[];
  flowElements?: BpmnBusinessObject[];
  incoming?: BpmnBusinessObject[];
  outgoing?: BpmnBusinessObject[];
  default?: BpmnBusinessObject;
  sourceRef?: BpmnBusinessObject;
  targetRef?: BpmnBusinessObject;
  attachedToRef?: BpmnBusinessObject;
  eventDefinitions?: BpmnBusinessObject[];
  conditionExpression?: BpmnBusinessObject;
  extensionElements?: BpmnBusinessObject & {
    values?: BpmnBusinessObject[];
  };
  [key: string]: unknown;
};

export type BpmnDefinitions = {
  rootElements?: BpmnBusinessObject[];
};

export type BpmnElement = {
  id: string;
  businessObject?: BpmnBusinessObject;
  [key: string]: unknown;
};

export type BpmnFactory = {
  create(type: string, properties?: Record<string, unknown>): BpmnBusinessObject;
};

export type Modeling = {
  updateModdleProperties(
    element: BpmnElement,
    moddleElement: BpmnBusinessObject,
    properties: Record<string, unknown>
  ): void;
};

export type FlowNodeKind =
  | 'startEvent'
  | 'endEvent'
  | 'task'
  | 'serviceTask'
  | 'userTask'
  | 'exclusiveGateway'
  | 'parallelGateway'
  | 'sequenceFlow'
  | 'subProcess'
  | 'timerIntermediateEvent'
  | 'inclusiveGateway'
  | 'messageEvent'
  | 'eventSubProcess'
  | 'boundaryEvent'
  | 'multiInstanceActivity'
  | 'unsupported';

export type SimNode = {
  id: string;
  name: string;
  type: string;
  kind: FlowNodeKind;
  incoming: string[];
  outgoing: string[];
  params: ElementSimulationConfig;
  supported: boolean;
  parentSubProcessId?: string;
  subProcessStartIds?: string[];
  subProcessEndIds?: string[];
  defaultFlowId?: string;
};

export type SimFlow = {
  id: string;
  name: string;
  sourceId: string;
  targetId: string;
  hasCondition: boolean;
  conditionExpression?: string;
  params: ElementSimulationConfig;
};

export type SimModel = {
  id: string;
  name: string;
  nodes: Map<string, SimNode>;
  flows: Map<string, SimFlow>;
  startNodeIds: string[];
  unsupportedElementIds: string[];
};
