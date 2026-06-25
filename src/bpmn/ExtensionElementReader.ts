import type { BpmnBusinessObject } from '../types/bpmn';
import type {
  ArrivalConfig,
  DurationConfig,
  ElementSimulationConfig,
  ErrorConfig,
  FailureConfig,
  OutputFieldConfig,
  OutputObjectConfig,
  PossibleError,
  ResourceConfig,
  SequenceFlowSimulationConfig,
  SimulationResource,
  StartEventSimulationConfig,
  TaskSimulationConfig
} from '../types/simulation';
import {
  normalizeResourceSchedule,
  parseHourRanges,
  parseWeekdays
} from '../simulation/ResourceCalendar';
import { parseOutputChoices } from '../simulation/OutputObjects';

export const SIM_NS_URI = 'https://hsnr.de/data-science/bpmn/simulation';
export const TASK_CONFIG_TYPE = 'sim:TaskConfig';
export const START_EVENT_CONFIG_TYPE = 'sim:StartEventConfig';
export const SEQUENCE_FLOW_CONFIG_TYPE = 'sim:SequenceFlowConfig';
export const RESOURCE_CATALOG_TYPE = 'sim:ResourceCatalog';
export const PROCESS_CONFIG_TYPE = 'sim:ProcessConfig';

export function readProcessConfig(element?: BpmnBusinessObject): { startDateTime?: string } {
  const config = findExtension(element, PROCESS_CONFIG_TYPE);

  return {
    startDateTime: asString(readAttribute(config, 'startDateTime'))
  };
}

export function readSimulationConfig(element?: BpmnBusinessObject): ElementSimulationConfig {
  if (!element) {
    return {};
  }

  if (element.$type === 'bpmn:StartEvent') {
    return readStartEventConfig(element);
  }

  if (element.$type === 'bpmn:SequenceFlow') {
    return readSequenceFlowConfig(element);
  }

  return readTaskConfig(element);
}

export function readTaskConfig(element?: BpmnBusinessObject): TaskSimulationConfig {
  const config = findExtension(element, TASK_CONFIG_TYPE);

  if (!config) {
    return {};
  }

  return {
    enabled: asBoolean(readAttribute(config, 'enabled')),
    duration: readDuration(findChild(config, 'sim:Duration', 'duration')),
    resource: readResource(findChild(config, 'sim:Resource', 'resource')),
    failure: readFailure(findChild(config, 'sim:Failure', 'failure')),
    outputObject: readOutputObject(findChild(config, 'sim:OutputObject', 'outputObject')),
    error: readError(findChild(config, 'sim:ServiceError', 'serviceError'))
  };
}

export function readStartEventConfig(element?: BpmnBusinessObject): StartEventSimulationConfig {
  const config = findExtension(element, START_EVENT_CONFIG_TYPE);

  if (!config) {
    return {};
  }

  return {
    enabled: asBoolean(readAttribute(config, 'enabled')),
    arrival: readArrival(findChild(config, 'sim:Arrival', 'arrival'))
  };
}

export function readSequenceFlowConfig(element?: BpmnBusinessObject): SequenceFlowSimulationConfig {
  const config = findExtension(element, SEQUENCE_FLOW_CONFIG_TYPE);

  if (!config) {
    return {};
  }

  return {
    enabled: asBoolean(readAttribute(config, 'enabled')),
    branch: {
      probability: asNumber(readAttribute(findChild(config, 'sim:Branch', 'branch'), 'probability'))
    }
  };
}

export function readRawSimulationValue(
  element: BpmnBusinessObject | undefined,
  path: string[]
): string | boolean | undefined {
  const value = readPath(readSimulationConfig(element), path);

  if (Array.isArray(value)) {
    return serializeWeightedList(value);
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  return undefined;
}

export function readConditionExpression(element?: BpmnBusinessObject): string | undefined {
  const conditionExpression = element?.conditionExpression;

  if (!conditionExpression) {
    return undefined;
  }

  return asString(conditionExpression.body) ??
    asString(conditionExpression.$body) ??
    asString(conditionExpression.textContent);
}

export function readResourceCatalog(element?: BpmnBusinessObject): SimulationResource[] {
  const catalog = findExtension(element, RESOURCE_CATALOG_TYPE);
  const resources = findChildren(catalog, 'sim:Resource', 'resources');

  if (!resources?.length) {
    return [];
  }

  return resources
    .map(readCatalogResource)
    .filter((resource): resource is SimulationResource => Boolean(resource));
}

export function findExtension(
  element: BpmnBusinessObject | undefined,
  type: string
): BpmnBusinessObject | undefined {
  return element?.extensionElements?.values?.find((value) => matchesExtensionType(value, type));
}

function findChild(
  element: BpmnBusinessObject | undefined,
  type: string,
  propertyName: string
): BpmnBusinessObject | undefined {
  const direct = element?.[propertyName];

  if (Array.isArray(direct)) {
    return direct[0] as BpmnBusinessObject | undefined;
  }

  if (direct && typeof direct === 'object') {
    return direct as BpmnBusinessObject;
  }

  return findChildren(element, type)?.[0];
}

function findChildren(
  element: BpmnBusinessObject | undefined,
  type: string,
  propertyName?: string
): BpmnBusinessObject[] | undefined {
  const direct = propertyName ? element?.[propertyName] : undefined;

  if (Array.isArray(direct)) {
    return direct as BpmnBusinessObject[];
  }

  if (direct && typeof direct === 'object') {
    return [direct as BpmnBusinessObject];
  }

  const children = (element?.$children as BpmnBusinessObject[] | undefined)
    ?.filter((child) => matchesExtensionType(child, type));

  return children?.length ? children : undefined;
}

function readAttribute(element: BpmnBusinessObject | undefined, key: string): unknown {
  const attrs = element?.$attrs as Record<string, unknown> | undefined;

  return element?.[key] ?? attrs?.[key];
}

function matchesExtensionType(element: BpmnBusinessObject | undefined, expected: string): boolean {
  const type = asString(element?.$type) ?? asString((element?.$descriptor as BpmnBusinessObject | undefined)?.name);

  return normalizeExtensionType(type) === normalizeExtensionType(expected);
}

function normalizeExtensionType(type: string | undefined): string {
  return (type ?? '').toLowerCase();
}

function readDuration(element?: BpmnBusinessObject): DurationConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    type: normalizeDurationType(asString(readAttribute(element, 'type'))),
    mean: asNumber(readAttribute(element, 'mean')),
    stddev: asNumber(readAttribute(element, 'stddev')),
    min: asNumber(readAttribute(element, 'min')),
    max: asNumber(readAttribute(element, 'max')),
    lambda: asNumber(readAttribute(element, 'lambda')),
    mode: asNumber(readAttribute(element, 'mode'))
  };
}

function readResource(element?: BpmnBusinessObject): ResourceConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    resourceId: asString(readAttribute(element, 'id')),
    resourceName: asString(readAttribute(element, 'name')),
    capacity: asInteger(readAttribute(element, 'capacity')),
    weekdays: parseWeekdays(asString(readAttribute(element, 'weekdays'))),
    hourRanges: parseHourRanges(asString(readAttribute(element, 'hourRanges')))
  };
}

function readCatalogResource(element?: BpmnBusinessObject): SimulationResource | undefined {
  const id = asString(readAttribute(element, 'id'));

  if (!id) {
    return undefined;
  }

  const schedule = normalizeResourceSchedule({
    weekdays: parseWeekdays(asString(readAttribute(element, 'weekdays'))),
    hourRanges: parseHourRanges(asString(readAttribute(element, 'hourRanges')))
  });

  return {
    id,
    name: asString(readAttribute(element, 'name')) ?? id,
    capacity: asInteger(readAttribute(element, 'capacity')),
    weekdays: schedule.weekdays,
    hourRanges: schedule.hourRanges
  };
}

function readFailure(element?: BpmnBusinessObject): FailureConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    probability: asNumber(readAttribute(element, 'probability')),
    retryCount: asInteger(readAttribute(element, 'retryCount')),
    retryDelay: readDuration(findChild(element, 'sim:RetryDelay', 'retryDelay'))
  };
}

function readOutputObject(element?: BpmnBusinessObject): OutputObjectConfig | undefined {
  const fields = readOutputFields(findChildren(element, 'sim:OutputField', 'fields'));

  return fields?.length ? { fields } : undefined;
}

function readOutputFields(elements?: BpmnBusinessObject[]): OutputFieldConfig[] | undefined {
  if (!elements?.length) {
    return undefined;
  }

  const fields = elements
    .map(readOutputField)
    .filter((field): field is OutputFieldConfig => Boolean(field));

  return fields.length ? fields : undefined;
}

function readOutputField(element?: BpmnBusinessObject): OutputFieldConfig | undefined {
  const key = asString(readAttribute(element, 'key'));
  const type = normalizeOutputValueType(asString(readAttribute(element, 'type')));

  if (!key || !type) {
    return undefined;
  }

  return {
    key,
    type,
    generator: normalizeOutputGenerator(asString(readAttribute(element, 'generator')), type),
    value: asString(readAttribute(element, 'value')),
    choices: parseOutputChoices(asString(readAttribute(element, 'choices'))),
    mean: asNumber(readAttribute(element, 'mean')),
    stddev: asNumber(readAttribute(element, 'stddev')),
    min: asNumber(readAttribute(element, 'min')),
    max: asNumber(readAttribute(element, 'max')),
    mode: asNumber(readAttribute(element, 'mode')),
    lambda: asNumber(readAttribute(element, 'lambda')),
    length: asInteger(readAttribute(element, 'length'))
  };
}

function readError(element?: BpmnBusinessObject): ErrorConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    probability: asNumber(readAttribute(element, 'probability')),
    possibleErrors: readWeightedChildren<PossibleError>(
      findChildren(element, 'sim:PossibleError', 'possibleErrors'),
      'errorCode'
    )
  };
}

function readArrival(element?: BpmnBusinessObject): ArrivalConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    type: asString(readAttribute(element, 'type')) as ArrivalConfig['type'],
    interval: asNumber(readAttribute(element, 'interval')),
    mean: asNumber(readAttribute(element, 'mean')),
    stddev: asNumber(readAttribute(element, 'stddev')),
    min: asNumber(readAttribute(element, 'min')),
    max: asNumber(readAttribute(element, 'max')),
    lambda: asNumber(readAttribute(element, 'lambda')),
    numberOfCases: asInteger(readAttribute(element, 'numberOfCases')),
    weekdays: parseWeekdays(asString(readAttribute(element, 'weekdays'))),
    hourRanges: parseHourRanges(asString(readAttribute(element, 'hourRanges')))
  };
}

function readWeightedChildren<T extends { probability?: number }>(
  children: BpmnBusinessObject[] | undefined,
  valueKey: 'value' | 'errorCode'
): T[] | undefined {
  if (!children?.length) {
    return undefined;
  }

  return children
    .map((child) => ({
      [valueKey]: asString(readAttribute(child, valueKey)) ?? '',
      probability: asNumber(readAttribute(child, 'probability'))
    }))
    .filter((entry) => entry[valueKey]) as T[];
}

function normalizeOutputValueType(value: string | undefined): OutputFieldConfig['type'] | undefined {
  if (value === 'integer') {
    return 'int';
  }

  if (value === 'int' || value === 'float' || value === 'string') {
    return value;
  }

  return undefined;
}

function normalizeOutputGenerator(
  value: string | undefined,
  type: OutputFieldConfig['type']
): OutputFieldConfig['generator'] {
  if (value === 'choice') {
    return type === 'string' ? 'categorical' : 'randomChoice';
  }

  if (value === 'randomChoice' || value === 'fixed' || value === 'uniform' || value === 'normal' ||
    value === 'exponential' || value === 'triangular' || value === 'random' || value === 'categorical') {
    return value;
  }

  return type === 'string' ? 'random' : 'fixed';
}

function readPath(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, source);
}

export function parseWeightedText<T extends { probability?: number }>(
  value: string | undefined,
  key: 'value' | 'errorCode'
): T[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawValue, rawProbability] = part.split(':').map((segment) => segment.trim());

      return {
        [key]: rawValue,
        probability: asNumber(rawProbability)
      };
    })
    .filter((entry) => entry[key]);

  return entries.length ? (entries as T[]) : undefined;
}

function serializeWeightedList(values: Array<Record<string, unknown>>): string {
  return values
    .map((entry) => {
      const value = entry.value ?? entry.errorCode;
      const probability = entry.probability;

      return probability === undefined ? `${value}` : `${value}:${probability}`;
    })
    .join(', ');
}

function normalizeDurationType(value: string | undefined): DurationConfig['type'] {
  if (value === 'constant') {
    return 'fixed';
  }

  if (['fixed', 'uniform', 'normal', 'exponential', 'triangular'].includes(value ?? '')) {
    return value as DurationConfig['type'];
  }

  return undefined;
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

function asBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value === true || value === 'true';
}
