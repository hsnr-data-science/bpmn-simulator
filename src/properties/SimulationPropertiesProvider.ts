import {
  CheckboxEntry,
  isCheckboxEntryEdited,
  isSelectEntryEdited,
  isTextFieldEntryEdited,
  SelectEntry,
  TextFieldEntry
} from '@bpmn-io/properties-panel';
import { useService } from 'bpmn-js-properties-panel';
import {
  getRawSimulationValue,
  isSimulationSupported,
  updateSimulationParameter,
  type BpmnElement,
  type BpmnFactory,
  type Modeling
} from '../bpmn/simulationExtension';
import type { DurationDistribution, SimulationParameters } from '../des/types';

type Entry = {
  id: string;
  element: BpmnElement;
  component: (props: Entry) => unknown;
  isEdited?: (...args: unknown[]) => boolean;
  label?: string;
  field?: keyof SimulationParameters;
  type?: string;
  min?: string;
  max?: string;
  step?: string;
  validate?: (value: string) => string | undefined;
  getOptions?: () => Array<{ label: string; value: string }>;
};

type Group = {
  id: string;
  label: string;
  entries: Entry[];
};

type PropertiesPanel = {
  registerProvider(priority: number, provider: SimulationPropertiesProvider): void;
};

export default class SimulationPropertiesProvider {
  static $inject = ['propertiesPanel'];

  constructor(propertiesPanel: PropertiesPanel) {
    propertiesPanel.registerProvider(700, this);
  }

  getGroups(element: BpmnElement) {
    return (groups: Group[]) => {
      if (!isSimulationSupported(element)) {
        return groups;
      }

      groups.push(createSimulationGroup(element));

      return groups;
    };
  }
}

export const SimulationPropertiesProviderModule = {
  __init__: ['simulationPropertiesProvider'],
  simulationPropertiesProvider: ['type', SimulationPropertiesProvider]
};

function createSimulationGroup(element: BpmnElement): Group {
  return {
    id: 'desSimulation',
    label: 'DES Simulation',
    entries: createEntries(element)
  };
}

function createEntries(element: BpmnElement): Entry[] {
  const type = element.businessObject?.$type ?? '';
  const entries: Entry[] = [
    checkboxEntry(element, 'sim-enabled', 'In DES verwenden', 'enabled')
  ];

  if (type === 'bpmn:StartEvent') {
    entries.push(
      textEntry(element, 'sim-arrival', 'Mittlere Ankunftszeit', 'arrivalIntervalMean', {
        type: 'number',
        min: '0',
        step: '0.1',
        validate: positiveNumber
      })
    );
  }

  if (type === 'bpmn:SequenceFlow') {
    entries.push(
      textEntry(element, 'sim-probability', 'Pfadwahrscheinlichkeit', 'probability', {
        type: 'number',
        min: '0',
        max: '1',
        step: '0.01',
        validate: probability
      })
    );
  }

  if (isActivityType(type)) {
    entries.push(
      selectEntry(element, 'sim-duration-distribution', 'Zeitverteilung', 'durationDistribution', durationOptions),
      textEntry(element, 'sim-duration-min', 'Dauer Minimum', 'durationMin', {
        type: 'number',
        min: '0',
        step: '0.1',
        validate: positiveNumber
      }),
      textEntry(element, 'sim-duration-mode', 'Dauer Modus', 'durationMode', {
        type: 'number',
        min: '0',
        step: '0.1',
        validate: positiveNumber
      }),
      textEntry(element, 'sim-duration-mean', 'Dauer Mittelwert', 'durationMean', {
        type: 'number',
        min: '0',
        step: '0.1',
        validate: positiveNumber
      }),
      textEntry(element, 'sim-duration-max', 'Dauer Maximum', 'durationMax', {
        type: 'number',
        min: '0',
        step: '0.1',
        validate: positiveNumber
      }),
      textEntry(element, 'sim-duration-stddev', 'Dauer Std. Abw.', 'durationStdDev', {
        type: 'number',
        min: '0',
        step: '0.1',
        validate: positiveNumber
      }),
      textEntry(element, 'sim-resource-pool', 'Ressourcenpool', 'resourcePool'),
      textEntry(element, 'sim-resource-capacity', 'Kapazitaet', 'resourceCapacity', {
        type: 'number',
        min: '1',
        step: '1',
        validate: positiveInteger
      }),
      textEntry(element, 'sim-error-probability', 'Fehlerwahrscheinlichkeit', 'errorProbability', {
        type: 'number',
        min: '0',
        max: '1',
        step: '0.01',
        validate: probability
      }),
      textEntry(element, 'sim-retry-probability', 'Retry-Wahrscheinlichkeit', 'retryProbability', {
        type: 'number',
        min: '0',
        max: '1',
        step: '0.01',
        validate: probability
      }),
      textEntry(element, 'sim-max-retries', 'Max. Retries', 'maxRetries', {
        type: 'number',
        min: '0',
        step: '1',
        validate: nonNegativeInteger
      }),
      textEntry(element, 'sim-retry-delay', 'Retry Delay', 'retryDelay', {
        type: 'number',
        min: '0',
        step: '0.1',
        validate: positiveNumber
      }),
      textEntry(element, 'sim-output-key', 'Output-Schluessel', 'outputKey'),
      textEntry(element, 'sim-output-values', 'Output-Werte', 'outputValues')
    );
  }

  return entries;
}

function textEntry(
  element: BpmnElement,
  id: string,
  label: string,
  field: keyof SimulationParameters,
  options: Partial<Entry> = {}
): Entry {
  return {
    id,
    element,
    label,
    field,
    component: SimulationTextField,
    isEdited: isTextFieldEntryEdited,
    ...options
  };
}

function selectEntry(
  element: BpmnElement,
  id: string,
  label: string,
  field: keyof SimulationParameters,
  getOptions: () => Array<{ label: string; value: string }>
): Entry {
  return {
    id,
    element,
    label,
    field,
    getOptions,
    component: SimulationSelect,
    isEdited: isSelectEntryEdited
  };
}

function checkboxEntry(
  element: BpmnElement,
  id: string,
  label: string,
  field: keyof SimulationParameters
): Entry {
  return {
    id,
    element,
    label,
    field,
    component: SimulationCheckbox,
    isEdited: isCheckboxEntryEdited
  };
}

function SimulationTextField(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');
  const debounce = useService('debounceInput');

  return TextFieldEntry({
    id: props.id,
    element: props.element,
    label: props.label,
    type: props.type ?? 'text',
    min: props.min,
    max: props.max,
    step: props.step,
    debounce,
    getValue: () => {
      const value = getRawSimulationValue(props.element.businessObject, props.field as keyof SimulationParameters);

      return typeof value === 'boolean' ? String(value) : value ?? '';
    },
    setValue: (value: string | undefined) => {
      updateSimulationParameter(
        props.element,
        props.field as keyof SimulationParameters,
        value,
        bpmnFactory,
        modeling
      );
    },
    validate: props.validate
  });
}

function SimulationSelect(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');

  return SelectEntry({
    id: props.id,
    element: props.element,
    label: props.label,
    getOptions: props.getOptions,
    getValue: () => {
      return getRawSimulationValue(props.element.businessObject, props.field as keyof SimulationParameters) ?? '';
    },
    setValue: (value: DurationDistribution | '') => {
      updateSimulationParameter(
        props.element,
        props.field as keyof SimulationParameters,
        value,
        bpmnFactory,
        modeling
      );
    }
  });
}

function SimulationCheckbox(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');

  return CheckboxEntry({
    id: props.id,
    element: props.element,
    label: props.label,
    getValue: () => {
      const value = getRawSimulationValue(props.element.businessObject, props.field as keyof SimulationParameters);

      return value === undefined ? true : value === true || value === 'true';
    },
    setValue: (value: boolean) => {
      updateSimulationParameter(
        props.element,
        props.field as keyof SimulationParameters,
        value,
        bpmnFactory,
        modeling
      );
    }
  });
}

function durationOptions(): Array<{ label: string; value: string }> {
  return [
    { label: 'Konstant', value: 'constant' },
    { label: 'Gleichverteilung', value: 'uniform' },
    { label: 'Dreieck', value: 'triangular' },
    { label: 'Normal', value: 'normal' },
    { label: 'Exponential', value: 'exponential' }
  ];
}

function isActivityType(type: string): boolean {
  return [
    'bpmn:Task',
    'bpmn:UserTask',
    'bpmn:ServiceTask',
    'bpmn:ScriptTask',
    'bpmn:BusinessRuleTask',
    'bpmn:ManualTask',
    'bpmn:ReceiveTask',
    'bpmn:SendTask',
    'bpmn:CallActivity',
    'bpmn:SubProcess'
  ].includes(type);
}

function probability(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < 0 || number > 1) {
    return 'Wert zwischen 0 und 1 erwartet.';
  }

  return undefined;
}

function positiveNumber(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return 'Nicht-negative Zahl erwartet.';
  }

  return undefined;
}

function positiveInteger(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    return 'Ganzzahl groesser 0 erwartet.';
  }

  return undefined;
}

function nonNegativeInteger(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number < 0) {
    return 'Nicht-negative Ganzzahl erwartet.';
  }

  return undefined;
}
