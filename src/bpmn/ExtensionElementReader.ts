import type { BpmnBusinessObject } from '../types/bpmn';
import type {
  ArrivalConfig,
  DurationConfig,
  ElementSimulationConfig,
  ErrorConfig,
  FailureConfig,
  OutputConfig,
  PossibleError,
  PossibleOutput,
  ResourceConfig,
  SequenceFlowSimulationConfig,
  StartEventSimulationConfig,
  TaskSimulationConfig
} from '../types/simulation';

export const SIM_NS_URI = 'https://hsnr.de/data-science/bpmn/simulation';
export const TASK_CONFIG_TYPE = 'sim:TaskConfig';
export const START_EVENT_CONFIG_TYPE = 'sim:StartEventConfig';
export const SEQUENCE_FLOW_CONFIG_TYPE = 'sim:SequenceFlowConfig';
export const LEGACY_CONFIG_TYPE = 'sim:SimulationParameters';

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
    return readLegacyConfig(element);
  }

  return {
    enabled: asBoolean(config.enabled),
    duration: readDuration(config.duration as BpmnBusinessObject | undefined),
    resource: readResource(config.resource as BpmnBusinessObject | undefined),
    failure: readFailure(config.failure as BpmnBusinessObject | undefined),
    output: readOutput(config.serviceOutput as BpmnBusinessObject | undefined),
    error: readError(config.serviceError as BpmnBusinessObject | undefined)
  };
}

export function readStartEventConfig(element?: BpmnBusinessObject): StartEventSimulationConfig {
  const config = findExtension(element, START_EVENT_CONFIG_TYPE);

  if (!config) {
    return readLegacyConfig(element);
  }

  return {
    enabled: asBoolean(config.enabled),
    arrival: readArrival(config.arrival as BpmnBusinessObject | undefined)
  };
}

export function readSequenceFlowConfig(element?: BpmnBusinessObject): SequenceFlowSimulationConfig {
  const config = findExtension(element, SEQUENCE_FLOW_CONFIG_TYPE);

  if (!config) {
    return readLegacyConfig(element);
  }

  return {
    enabled: asBoolean(config.enabled),
    branch: {
      probability: asNumber((config.branch as BpmnBusinessObject | undefined)?.probability)
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

export function findExtension(
  element: BpmnBusinessObject | undefined,
  type: string
): BpmnBusinessObject | undefined {
  return element?.extensionElements?.values?.find((value) => value.$type === type);
}

function readDuration(element?: BpmnBusinessObject): DurationConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    type: normalizeDurationType(asString(element.type)),
    mean: asNumber(element.mean),
    stddev: asNumber(element.stddev),
    min: asNumber(element.min),
    max: asNumber(element.max),
    lambda: asNumber(element.lambda),
    mode: asNumber(element.mode)
  };
}

function readResource(element?: BpmnBusinessObject): ResourceConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    resourceId: asString(element.id),
    capacity: asInteger(element.capacity),
    calendar: asString(element.calendar)
  };
}

function readFailure(element?: BpmnBusinessObject): FailureConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    probability: asNumber(element.probability),
    retryCount: asInteger(element.retryCount),
    retryDelay: readDuration(element.retryDelay as BpmnBusinessObject | undefined)
  };
}

function readOutput(element?: BpmnBusinessObject): OutputConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    distribution: asString(element.distribution) === 'none' ? 'none' : 'categorical',
    possibleOutputs: readWeightedChildren<PossibleOutput>(
      element.possibleOutputs as BpmnBusinessObject[] | undefined,
      'value'
    )
  };
}

function readError(element?: BpmnBusinessObject): ErrorConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    probability: asNumber(element.probability),
    possibleErrors: readWeightedChildren<PossibleError>(
      element.possibleErrors as BpmnBusinessObject[] | undefined,
      'errorCode'
    )
  };
}

function readArrival(element?: BpmnBusinessObject): ArrivalConfig | undefined {
  if (!element) {
    return undefined;
  }

  return {
    type: asString(element.type) as ArrivalConfig['type'],
    interval: asNumber(element.interval),
    mean: asNumber(element.mean),
    schedule: asString(element.schedule),
    numberOfCases: asInteger(element.numberOfCases)
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
      [valueKey]: asString(child[valueKey]) ?? '',
      probability: asNumber(child.probability)
    }))
    .filter((entry) => entry[valueKey]) as T[];
}

function readLegacyConfig(element?: BpmnBusinessObject): ElementSimulationConfig {
  const legacy = findExtension(element, LEGACY_CONFIG_TYPE);

  if (!legacy) {
    return {};
  }

  const duration: DurationConfig = {
    type: normalizeDurationType(asString(legacy.durationDistribution)),
    min: asNumber(legacy.durationMin),
    mode: asNumber(legacy.durationMode),
    mean: asNumber(legacy.durationMean),
    max: asNumber(legacy.durationMax),
    stddev: asNumber(legacy.durationStdDev)
  };

  return {
    enabled: asBoolean(legacy.enabled),
    duration,
    arrival: {
      type: legacy.arrivalIntervalMean ? 'exponentialInterarrival' : undefined,
      mean: asNumber(legacy.arrivalIntervalMean)
    },
    branch: {
      probability: asNumber(legacy.probability)
    },
    resource: {
      resourceId: asString(legacy.resourcePool),
      capacity: asInteger(legacy.resourceCapacity)
    },
    failure: {
      probability: asNumber(legacy.errorProbability),
      retryCount: asInteger(legacy.maxRetries),
      retryDelay: {
        type: 'fixed',
        mean: asNumber(legacy.retryDelay)
      }
    },
    output: {
      distribution: legacy.outputValues ? 'categorical' : undefined,
      possibleOutputs: parseWeightedText(asString(legacy.outputValues), 'value')
    }
  };
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
