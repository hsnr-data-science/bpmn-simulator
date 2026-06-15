import type { ElementSimulationConfig, SimulationResource } from './simulation';

export type BpmnBusinessObject = {
  $type?: string;
  id?: string;
  name?: string;
  values?: BpmnBusinessObject[];
  flowElements?: BpmnBusinessObject[];
  participants?: BpmnBusinessObject[];
  messageFlows?: BpmnBusinessObject[];
  incoming?: BpmnBusinessObject[];
  outgoing?: BpmnBusinessObject[];
  default?: BpmnBusinessObject;
  sourceRef?: BpmnBusinessObject | string;
  targetRef?: BpmnBusinessObject | string;
  attachedToRef?: BpmnBusinessObject;
  eventDefinitions?: BpmnBusinessObject[];
  conditionExpression?: BpmnBusinessObject;
  processRef?: BpmnBusinessObject | string;
  messageRef?: BpmnBusinessObject | string;
  signalRef?: BpmnBusinessObject | string;
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
  | 'eventBasedGateway'
  | 'sequenceFlow'
  | 'subProcess'
  | 'timerIntermediateEvent'
  | 'inclusiveGateway'
  | 'messageEvent'
  | 'signalEvent'
  | 'eventSubProcess'
  | 'boundaryEvent'
  | 'multiInstanceActivity'
  | 'unsupported';

export type SimEventDefinitionType = 'message' | 'signal' | 'timer' | 'error' | 'unknown';

export type SimEventDirection = 'catch' | 'throw' | 'none';

export type SimEventDefinition = {
  id?: string;
  type: SimEventDefinitionType;
  refId?: string;
  name?: string;
};

export type SimNode = {
  id: string;
  name: string;
  type: string;
  kind: FlowNodeKind;
  incoming: string[];
  outgoing: string[];
  params: ElementSimulationConfig;
  supported: boolean;
  processId?: string;
  parentSubProcessId?: string;
  subProcessStartIds?: string[];
  subProcessEndIds?: string[];
  defaultFlowId?: string;
  eventDefinitions?: SimEventDefinition[];
  eventDirection?: SimEventDirection;
};

export type SimFlow = {
  id: string;
  name: string;
  sourceId: string;
  targetId: string;
  hasCondition: boolean;
  conditionExpression?: string;
  params: ElementSimulationConfig;
  processId?: string;
};

export type SimProcess = {
  id: string;
  name: string;
  participantId?: string;
  participantName?: string;
  startNodeIds: string[];
};

export type SimMessageFlow = {
  id: string;
  name: string;
  sourceId: string;
  targetId: string;
  messageId?: string;
  messageName?: string;
};

export type SimModel = {
  id: string;
  name: string;
  resources: Map<string, SimulationResource>;
  nodes: Map<string, SimNode>;
  flows: Map<string, SimFlow>;
  startNodeIds: string[];
  unsupportedElementIds: string[];
  processes?: Map<string, SimProcess>;
  messageFlows?: SimMessageFlow[];
  messages?: Map<string, string>;
  signals?: Map<string, string>;
};
