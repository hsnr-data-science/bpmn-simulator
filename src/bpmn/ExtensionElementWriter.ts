import type { BpmnBusinessObject, BpmnElement, BpmnFactory, Modeling } from '../types/bpmn';
import { parseWeightedText, SEQUENCE_FLOW_CONFIG_TYPE, START_EVENT_CONFIG_TYPE, TASK_CONFIG_TYPE } from './ExtensionElementReader';

type ConfigKind = 'task' | 'startEvent' | 'sequenceFlow';

const PATH_TYPE_MAP: Record<string, string> = {
  duration: 'sim:Duration',
  resource: 'sim:Resource',
  failure: 'sim:Failure',
  retryDelay: 'sim:RetryDelay',
  serviceOutput: 'sim:ServiceOutput',
  serviceError: 'sim:ServiceError',
  arrival: 'sim:Arrival',
  branch: 'sim:Branch'
};

export function updateSimulationValue(
  element: BpmnElement,
  kind: ConfigKind,
  path: string[],
  value: string | boolean | undefined,
  bpmnFactory: BpmnFactory,
  modeling: Modeling
): void {
  const businessObject = element.businessObject;

  if (!businessObject) {
    return;
  }

  const extensionElements = ensureExtensionElements(businessObject, bpmnFactory);
  const config = ensureConfig(extensionElements, kind, bpmnFactory);

  setConfigPath(config, path, value, bpmnFactory);

  modeling.updateModdleProperties(element, businessObject, {
    extensionElements
  });
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

  return businessObject.extensionElements;
}

function ensureConfig(
  extensionElements: BpmnBusinessObject,
  kind: ConfigKind,
  bpmnFactory: BpmnFactory
): BpmnBusinessObject {
  const type = getConfigType(kind);
  const existing = extensionElements.values?.find((value) => value.$type === type);

  if (existing) {
    return existing;
  }

  const config = bpmnFactory.create(type, {
    enabled: true
  });

  extensionElements.values = [...(extensionElements.values ?? []), config];

  return config;
}

function setConfigPath(
  config: BpmnBusinessObject,
  path: string[],
  value: string | boolean | undefined,
  bpmnFactory: BpmnFactory
): void {
  if (!path.length) {
    return;
  }

  if (path[0] === 'output' && path[1] === 'possibleOutputs') {
    const output = ensureChild(config, 'serviceOutput', bpmnFactory);
    output.possibleOutputs = createWeightedElements(value as string | undefined, 'sim:PossibleOutput', 'value', bpmnFactory);
    return;
  }

  if (path[0] === 'error' && path[1] === 'possibleErrors') {
    const error = ensureChild(config, 'serviceError', bpmnFactory);
    error.possibleErrors = createWeightedElements(value as string | undefined, 'sim:PossibleError', 'errorCode', bpmnFactory);
    return;
  }

  const normalizedPath = normalizePath(path);
  const attribute = normalizedPath[normalizedPath.length - 1];
  const target = normalizedPath.slice(0, -1).reduce((current, segment) => {
    return ensureChild(current, segment, bpmnFactory);
  }, config);

  if (value === undefined || value === '') {
    delete target[attribute];
  } else {
    target[attribute] = value;
  }
}

function ensureChild(
  parent: BpmnBusinessObject,
  propertyName: string,
  bpmnFactory: BpmnFactory
): BpmnBusinessObject {
  const existing = parent[propertyName] as BpmnBusinessObject | undefined;

  if (existing) {
    return existing;
  }

  const child = bpmnFactory.create(PATH_TYPE_MAP[propertyName] ?? `sim:${capitalize(propertyName)}`);
  parent[propertyName] = child;

  return child;
}

function createWeightedElements(
  value: string | undefined,
  type: string,
  key: 'value' | 'errorCode',
  bpmnFactory: BpmnFactory
): BpmnBusinessObject[] {
  return (parseWeightedText(value, key) ?? []).map((entry) => {
    const entryRecord = entry as Record<string, unknown>;

    return bpmnFactory.create(type, {
      [key]: entryRecord[key],
      probability: entry.probability === undefined ? undefined : String(entry.probability)
    });
  });
}

function normalizePath(path: string[]): string[] {
  if (path[0] === 'resource' && path[1] === 'resourceId') {
    return ['resource', 'id'];
  }

  if (path[0] === 'output') {
    return ['serviceOutput', ...path.slice(1)];
  }

  if (path[0] === 'error') {
    return ['serviceError', ...path.slice(1)];
  }

  if (path[0] === 'failure' && path[1] === 'retryDelay') {
    return ['failure', 'retryDelay', ...path.slice(2)];
  }

  return path;
}

function getConfigType(kind: ConfigKind): string {
  if (kind === 'startEvent') {
    return START_EVENT_CONFIG_TYPE;
  }

  if (kind === 'sequenceFlow') {
    return SEQUENCE_FLOW_CONFIG_TYPE;
  }

  return TASK_CONFIG_TYPE;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
