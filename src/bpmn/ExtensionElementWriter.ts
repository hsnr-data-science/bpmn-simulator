import type { BpmnBusinessObject, BpmnElement, BpmnFactory, Modeling } from '../types/bpmn';
import type { ArrivalConfig, DurationConfig, OutputFieldConfig, SimulationResource } from '../types/simulation';
import {
  normalizeResourceSchedule,
  serializeHourRanges,
  serializeWeekdays
} from '../simulation/ResourceCalendar';
import { serializeOutputChoices } from '../simulation/OutputObjects';
import {
  parseWeightedText,
  RESOURCE_CATALOG_TYPE,
  SEQUENCE_FLOW_CONFIG_TYPE,
  START_EVENT_CONFIG_TYPE,
  TASK_CONFIG_TYPE
} from './ExtensionElementReader';

type ConfigKind = 'task' | 'startEvent' | 'sequenceFlow';

const PATH_TYPE_MAP: Record<string, string> = {
  delay: 'sim:Duration',
  duration: 'sim:Duration',
  resource: 'sim:Resource',
  outputObject: 'sim:OutputObject',
  error: 'sim:ErrorConfig',
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

export function updateResourceCatalog(
  element: BpmnElement,
  process: BpmnBusinessObject,
  resources: SimulationResource[],
  bpmnFactory: BpmnFactory,
  modeling: Modeling
): void {
  const extensionElements = ensureExtensionElements(process, bpmnFactory);
  const catalog = ensureResourceCatalog(extensionElements, bpmnFactory);

  catalog.resources = resources
    .map(normalizeResource)
    .filter((resource): resource is SimulationResource => Boolean(resource))
    .map((resource) => bpmnFactory.create('sim:Resource', {
      id: resource.id,
      name: resource.name,
      capacity: resource.capacity === undefined ? undefined : String(resource.capacity),
      weekdays: serializeWeekdays(resource.weekdays),
      hourRanges: serializeHourRanges(resource.hourRanges)
    }));

  modeling.updateModdleProperties(element, process, {
    extensionElements
  });
}

export function updateConditionExpression(
  element: BpmnElement,
  value: string | undefined,
  bpmnFactory: BpmnFactory,
  modeling: Modeling
): void {
  const businessObject = element.businessObject;

  if (!businessObject) {
    return;
  }

  const body = value?.trim();
  const conditionExpression = body
    ? bpmnFactory.create('bpmn:FormalExpression', {
      body,
      language: 'JavaScript'
    })
    : undefined;

  modeling.updateModdleProperties(element, businessObject, {
    conditionExpression
  });
}

export function updateDurationConfig(
  element: BpmnElement,
  duration: DurationConfig,
  bpmnFactory: BpmnFactory,
  modeling: Modeling,
  path: 'duration' | 'delay' = 'duration'
): void {
  const businessObject = element.businessObject;

  if (!businessObject) {
    return;
  }

  const extensionElements = ensureExtensionElements(businessObject, bpmnFactory);
  const config = ensureConfig(extensionElements, 'task', bpmnFactory);
  const durationElement = ensureChild(config, path, bpmnFactory);

  for (const attribute of ['type', 'mean', 'stddev', 'min', 'max', 'mode', 'lambda']) {
    delete durationElement[attribute];
  }

  const normalized = normalizeDuration(duration);

  for (const [attribute, value] of Object.entries(normalized)) {
    if (value !== undefined) {
      durationElement[attribute] = String(value);
    }
  }

  modeling.updateModdleProperties(element, businessObject, {
    extensionElements
  });
}

export function updateArrivalConfig(
  element: BpmnElement,
  arrival: ArrivalConfig,
  bpmnFactory: BpmnFactory,
  modeling: Modeling
): void {
  const businessObject = element.businessObject;

  if (!businessObject) {
    return;
  }

  const extensionElements = ensureExtensionElements(businessObject, bpmnFactory);
  const config = ensureConfig(extensionElements, 'startEvent', bpmnFactory);
  const arrivalElement = ensureChild(config, 'arrival', bpmnFactory);

  for (const attribute of ['type', 'interval', 'mean', 'stddev', 'min', 'max', 'lambda']) {
    delete arrivalElement[attribute];
  }

  const normalized = normalizeArrival(arrival);

  for (const [attribute, value] of Object.entries(normalized)) {
    if (value !== undefined) {
      arrivalElement[attribute] = String(value);
    }
  }

  modeling.updateModdleProperties(element, businessObject, {
    extensionElements
  });
}

export function updateOutputObjectFields(
  element: BpmnElement,
  fields: OutputFieldConfig[],
  bpmnFactory: BpmnFactory,
  modeling: Modeling
): void {
  const businessObject = element.businessObject;

  if (!businessObject) {
    return;
  }

  const extensionElements = ensureExtensionElements(businessObject, bpmnFactory);
  const config = ensureConfig(extensionElements, 'task', bpmnFactory);
  const outputObject = ensureChild(config, 'outputObject', bpmnFactory);

  outputObject.fields = createOutputFieldElementsFromFields(fields, bpmnFactory);

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

function ensureResourceCatalog(
  extensionElements: BpmnBusinessObject,
  bpmnFactory: BpmnFactory
): BpmnBusinessObject {
  const existing = extensionElements.values?.find((value) => value.$type === RESOURCE_CATALOG_TYPE);

  if (existing) {
    return existing;
  }

  const catalog = bpmnFactory.create(RESOURCE_CATALOG_TYPE, {
    resources: []
  });

  extensionElements.values = [...(extensionElements.values ?? []), catalog];

  return catalog;
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

  if (path[0] === 'error' && path[1] === 'possibleErrors') {
    const error = ensureChild(config, 'error', bpmnFactory);
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

  if (path[0] === 'resource' && path[1] === 'resourceId') {
    delete target.capacity;
    delete target.name;
    delete target.weekdays;
    delete target.hourRanges;
    delete target.sameInstanceAsBefore;
  }
}

function createOutputFieldElementsFromFields(
  fields: OutputFieldConfig[],
  bpmnFactory: BpmnFactory
): BpmnBusinessObject[] {
  return fields.map(normalizeOutputField)
    .filter((field): field is OutputFieldConfig => Boolean(field))
    .map((field) => bpmnFactory.create('sim:OutputField', {
    key: field.key,
    type: field.type,
    generator: field.generator,
    value: field.value,
    choices: serializeOutputChoices(field.choices),
    mean: field.mean === undefined ? undefined : String(field.mean),
    stddev: field.stddev === undefined ? undefined : String(field.stddev),
    min: field.min === undefined ? undefined : String(field.min),
    max: field.max === undefined ? undefined : String(field.max),
    mode: field.mode === undefined ? undefined : String(field.mode),
    lambda: field.lambda === undefined ? undefined : String(field.lambda),
    length: field.length === undefined ? undefined : String(field.length)
  }));
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

function normalizeResource(resource: SimulationResource): SimulationResource | undefined {
  const id = resource.id.trim();

  if (!id) {
    return undefined;
  }

  const name = resource.name.trim() || id;
  const capacity = resource.capacity;
  const schedule = normalizeResourceSchedule(resource, 'businessHours');

  return {
    id,
    name,
    capacity: capacity === undefined || capacity <= 0 ? undefined : Math.floor(capacity),
    weekdays: schedule.weekdays,
    hourRanges: schedule.hourRanges
  };
}

function normalizeDuration(duration: DurationConfig): DurationConfig {
  const type = ['fixed', 'uniform', 'normal', 'exponential', 'triangular'].includes(duration.type ?? '')
    ? duration.type
    : 'fixed';

  if (type === 'fixed') {
    return {
      type,
      mean: duration.mean ?? 0
    };
  }

  if (type === 'uniform') {
    return {
      type,
      min: duration.min ?? 0,
      max: duration.max ?? 10
    };
  }

  if (type === 'normal') {
    return {
      type,
      mean: duration.mean ?? 1,
      stddev: duration.stddev ?? 1,
      min: duration.min,
      max: duration.max
    };
  }

  if (type === 'exponential') {
    return {
      type,
      mean: duration.mean ?? 1,
      lambda: duration.lambda
    };
  }

  return {
    type,
    min: duration.min ?? 0,
    mode: duration.mode ?? 5,
    max: duration.max ?? 10
  };
}

function normalizeArrival(arrival: ArrivalConfig): ArrivalConfig {
  const type = ['none', 'fixed', 'normal', 'exponential'].includes(arrival.type ?? '')
    ? arrival.type
    : 'fixed';

  if (type === 'none') {
    return {
      type
    };
  }

  if (type === 'fixed') {
    return {
      type,
      interval: arrival.interval ?? arrival.mean ?? 1
    };
  }

  if (type === 'normal') {
    return {
      type,
      mean: arrival.mean ?? arrival.interval ?? 1,
      stddev: arrival.stddev ?? 1,
      min: arrival.min,
      max: arrival.max
    };
  }

  if (type === 'exponential') {
    return {
      type,
      mean: arrival.mean ?? arrival.interval ?? 1,
      lambda: arrival.lambda
    };
  }

  return {
    type: 'fixed',
    interval: arrival.interval ?? 1
  };
}

function normalizeOutputField(field: OutputFieldConfig): OutputFieldConfig | undefined {
  const key = field.key.trim();

  if (!key) {
    return undefined;
  }

  const type = field.type;
  const generator = normalizeOutputGenerator(type, field.generator);

  return {
    ...field,
    key,
    type,
    generator,
    value: field.value === '' ? undefined : field.value,
    choices: field.choices?.filter((choice) => choice.value.trim()).map((choice) => ({
      value: choice.value.trim(),
      probability: choice.probability
    }))
  };
}

function normalizeOutputGenerator(
  type: OutputFieldConfig['type'],
  generator: OutputFieldConfig['generator']
): OutputFieldConfig['generator'] {
  if (type === 'string') {
    return ['random', 'categorical', 'fixed'].includes(generator) ? generator : 'random';
  }

  return ['fixed', 'randomChoice', 'uniform', 'normal', 'exponential', 'triangular'].includes(generator)
    ? generator
    : 'fixed';
}
