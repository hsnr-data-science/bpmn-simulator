import type { SimulationParameters } from '../des/types';

export const SIMULATION_ELEMENT_TYPE = 'sim:SimulationParameters';

export interface BpmnBusinessObject {
  $type?: string;
  id?: string;
  name?: string;
  values?: BpmnBusinessObject[];
  extensionElements?: BpmnExtensionElements;
  [key: string]: unknown;
}

export interface BpmnExtensionElements extends BpmnBusinessObject {
  values?: BpmnBusinessObject[];
}

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

export function isSimulationSupported(element: BpmnElement): boolean {
  const type = element.businessObject?.$type ?? '';

  return [
    'bpmn:StartEvent',
    'bpmn:IntermediateCatchEvent',
    'bpmn:IntermediateThrowEvent',
    'bpmn:EndEvent',
    'bpmn:Task',
    'bpmn:UserTask',
    'bpmn:ServiceTask',
    'bpmn:ScriptTask',
    'bpmn:BusinessRuleTask',
    'bpmn:ManualTask',
    'bpmn:ReceiveTask',
    'bpmn:SendTask',
    'bpmn:CallActivity',
    'bpmn:SubProcess',
    'bpmn:ExclusiveGateway',
    'bpmn:InclusiveGateway',
    'bpmn:ParallelGateway',
    'bpmn:EventBasedGateway',
    'bpmn:SequenceFlow'
  ].includes(type);
}

export function getSimulationParameters(
  businessObject?: BpmnBusinessObject
): Partial<SimulationParameters> {
  const extension = findSimulationExtension(businessObject);

  if (!extension) {
    return {};
  }

  return {
    enabled: extension.enabled as boolean | undefined,
    durationDistribution: extension.durationDistribution as SimulationParameters['durationDistribution'],
    durationMin: asNumber(extension.durationMin),
    durationMode: asNumber(extension.durationMode),
    durationMean: asNumber(extension.durationMean),
    durationMax: asNumber(extension.durationMax),
    durationStdDev: asNumber(extension.durationStdDev),
    arrivalIntervalMean: asNumber(extension.arrivalIntervalMean),
    successProbability: asNumber(extension.successProbability),
    errorProbability: asNumber(extension.errorProbability),
    retryProbability: asNumber(extension.retryProbability),
    maxRetries: asInteger(extension.maxRetries),
    retryDelay: asNumber(extension.retryDelay),
    resourcePool: asString(extension.resourcePool),
    resourceCapacity: asInteger(extension.resourceCapacity),
    probability: asNumber(extension.probability),
    outputKey: asString(extension.outputKey),
    outputValues: parseOutputValues(extension.outputValues)
  };
}

export function getRawSimulationValue(
  businessObject: BpmnBusinessObject | undefined,
  key: keyof SimulationParameters
): string | boolean | undefined {
  const extension = findSimulationExtension(businessObject);
  const value = extension?.[key];

  if (Array.isArray(value)) {
    return value.join(',');
  }

  return value as string | boolean | undefined;
}

export function updateSimulationParameter(
  element: BpmnElement,
  key: keyof SimulationParameters,
  value: string | boolean | undefined,
  bpmnFactory: BpmnFactory,
  modeling: Modeling
): void {
  const businessObject = element.businessObject;

  if (!businessObject) {
    return;
  }

  const extensionElements = ensureExtensionElements(businessObject, bpmnFactory);
  const simulationParameters = ensureSimulationParameters(extensionElements, bpmnFactory);

  if (value === undefined || value === '') {
    delete simulationParameters[key];
  } else {
    simulationParameters[key] = value;
  }

  modeling.updateModdleProperties(element, businessObject, {
    extensionElements
  });
}

export function findSimulationExtension(
  businessObject?: BpmnBusinessObject
): BpmnBusinessObject | undefined {
  return businessObject?.extensionElements?.values?.find((value) => {
    return (value as BpmnBusinessObject).$type === SIMULATION_ELEMENT_TYPE;
  }) as BpmnBusinessObject | undefined;
}

function ensureExtensionElements(
  businessObject: BpmnBusinessObject,
  bpmnFactory: BpmnFactory
): BpmnBusinessObject {
  if (!businessObject.extensionElements) {
    businessObject.extensionElements = bpmnFactory.create('bpmn:ExtensionElements', {
      values: []
    });
  }

  if (!businessObject.extensionElements.values) {
    businessObject.extensionElements.values = [];
  }

  return businessObject.extensionElements as BpmnBusinessObject;
}

function ensureSimulationParameters(
  extensionElements: BpmnBusinessObject,
  bpmnFactory: BpmnFactory
): BpmnBusinessObject {
  const existing = extensionElements.values?.find((value) => {
    return value.$type === SIMULATION_ELEMENT_TYPE;
  });

  if (existing) {
    return existing;
  }

  const simulationParameters = bpmnFactory.create(SIMULATION_ELEMENT_TYPE, {
    enabled: true
  });

  extensionElements.values = [...(extensionElements.values ?? []), simulationParameters];

  return simulationParameters;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : undefined;
}

function asInteger(value: unknown): number | undefined {
  const number = asNumber(value);

  return number === undefined ? undefined : Math.max(0, Math.floor(number));
}

function parseOutputValues(value: unknown): string[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const values = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return values.length ? values : undefined;
}
