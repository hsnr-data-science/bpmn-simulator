import {
  CheckboxEntry,
  isCheckboxEntryEdited,
  isSelectEntryEdited,
  isTextFieldEntryEdited,
  SelectEntry,
  TextFieldEntry
} from '@bpmn-io/properties-panel';
import { useService } from 'bpmn-js-properties-panel';
import { isSimulationEditable, isTaskType, supportsOutputObject } from '../bpmn/BpmnElementClassifier';
import { readRawSimulationValue, readResourceCatalog } from '../bpmn/ExtensionElementReader';
import { updateSimulationValue } from '../bpmn/ExtensionElementWriter';
import type { BpmnElement, BpmnFactory, Modeling } from '../types/bpmn';
import { branchProbabilityEntries } from './entries/BranchProbabilityEntry';
import { durationDistributionEntries } from './entries/DurationDistributionEntry';
import { outputObjectEntries } from './entries/OutputObjectEntry';
import { resourceEntries } from './entries/ResourceEntry';
import { serviceTaskOutputEntries } from './entries/ServiceTaskOutputEntry';

type EntryDefinition = {
  id: string;
  label: string;
  path: string[];
  control: 'text' | 'select' | 'checkbox' | 'resourceSelect';
  type?: string;
  min?: string;
  max?: string;
  step?: string;
  validate?: 'probability' | 'nonNegativeNumber' | 'positiveInteger' | 'nonNegativeInteger';
  options?: Array<{ label: string; value: string }>;
};

type Entry = EntryDefinition & {
  element: BpmnElement;
  component: (props: Entry) => unknown;
  isEdited?: (...args: unknown[]) => boolean;
};

type Group = {
  id: string;
  label: string;
  entries: Entry[];
};

type PropertiesPanel = {
  registerProvider(priority: number, provider: SimulationPropertiesProvider): void;
};

type CanvasWithRoot = {
  getRootElement(): BpmnElement;
};

export default class SimulationPropertiesProvider {
  static $inject = ['propertiesPanel'];

  constructor(propertiesPanel: PropertiesPanel) {
    propertiesPanel.registerProvider(700, this);
  }

  getGroups(element: BpmnElement) {
    return (groups: Group[]) => {
      if (!isSimulationEditable(element.businessObject)) {
        return groups;
      }

      groups.push({
        id: 'desSimulation',
        label: 'DES Simulation',
        entries: createEntries(element)
      });

      return groups;
    };
  }
}

export const SimulationPropertiesProviderModule = {
  __init__: ['simulationPropertiesProvider'],
  simulationPropertiesProvider: ['type', SimulationPropertiesProvider]
};

function createEntries(element: BpmnElement): Entry[] {
  const type = element.businessObject?.$type ?? '';
  const definitions: EntryDefinition[] = [
    {
      id: 'sim-enabled',
      label: 'In DES verwenden',
      path: ['enabled'],
      control: 'checkbox'
    }
  ];

  if (type === 'bpmn:StartEvent') {
    definitions.push(...startEventEntries());
  }

  if (type === 'bpmn:SequenceFlow') {
    definitions.push(...branchProbabilityEntries() as EntryDefinition[]);
  }

  if (isTaskType(type) || type === 'bpmn:SubProcess') {
    definitions.push(
      ...(durationDistributionEntries() as EntryDefinition[]),
      ...(resourceEntries() as EntryDefinition[])
    );
  }

  if (supportsOutputObject(type)) {
    definitions.push(...(outputObjectEntries() as EntryDefinition[]));
  }

  if (type === 'bpmn:ServiceTask') {
    definitions.push(...(serviceTaskOutputEntries() as EntryDefinition[]));
  }

  return definitions.map((definition) => createEntry(element, definition));
}

function createEntry(element: BpmnElement, definition: EntryDefinition): Entry {
  const component =
    definition.control === 'resourceSelect'
      ? SimulationResourceSelect
      : definition.control === 'select'
      ? SimulationSelect
      : definition.control === 'checkbox'
        ? SimulationCheckbox
        : SimulationTextField;
  const isEdited =
    definition.control === 'select' || definition.control === 'resourceSelect'
      ? isSelectEntryEdited
      : definition.control === 'checkbox'
        ? isCheckboxEntryEdited
        : isTextFieldEntryEdited;

  return {
    ...definition,
    element,
    component,
    isEdited
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
    getValue: () => readRawSimulationValue(props.element.businessObject, props.path) ?? '',
    setValue: (value: string | undefined) => {
      updateSimulationValue(props.element, getConfigKind(props.element), props.path, value, bpmnFactory, modeling);
    },
    validate: props.validate ? validators[props.validate] : undefined
  });
}

function SimulationSelect(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');

  return SelectEntry({
    id: props.id,
    element: props.element,
    label: props.label,
    getOptions: () => props.options ?? [],
    getValue: () => readRawSimulationValue(props.element.businessObject, props.path) ?? '',
    setValue: (value: string | undefined) => {
      updateSimulationValue(props.element, getConfigKind(props.element), props.path, value, bpmnFactory, modeling);
    }
  });
}

function SimulationResourceSelect(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');
  const canvas = useService<CanvasWithRoot>('canvas');

  return SelectEntry({
    id: props.id,
    element: props.element,
    label: props.label,
    getOptions: () => {
      const process = canvas.getRootElement()?.businessObject;
      const resources = readResourceCatalog(process);

      return [
        { label: 'Keine Ressource', value: '' },
        ...resources.map((resource) => ({
          label: `${resource.name} (${resource.id})`,
          value: resource.id
        }))
      ];
    },
    getValue: () => readRawSimulationValue(props.element.businessObject, props.path) ?? '',
    setValue: (value: string | undefined) => {
      updateSimulationValue(props.element, getConfigKind(props.element), props.path, value, bpmnFactory, modeling);
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
      const value = readRawSimulationValue(props.element.businessObject, props.path);

      return value === undefined ? true : value === true || value === 'true';
    },
    setValue: (value: boolean) => {
      updateSimulationValue(props.element, getConfigKind(props.element), props.path, value, bpmnFactory, modeling);
    }
  });
}

function startEventEntries(): EntryDefinition[] {
  return [
    {
      id: 'sim-arrival-type',
      label: 'Arrival Distribution',
      path: ['arrival', 'type'],
      control: 'select',
      options: [
        { label: 'Fixed Interval', value: 'fixedInterval' },
        { label: 'Exponential Interarrival', value: 'exponentialInterarrival' },
        { label: 'Schedule', value: 'schedule' }
      ]
    },
    {
      id: 'sim-arrival-interval',
      label: 'Arrival Interval',
      path: ['arrival', 'interval'],
      control: 'text',
      type: 'number',
      min: '0',
      step: '0.1',
      validate: 'nonNegativeNumber'
    },
    {
      id: 'sim-arrival-mean',
      label: 'Arrival Mean',
      path: ['arrival', 'mean'],
      control: 'text',
      type: 'number',
      min: '0',
      step: '0.1',
      validate: 'nonNegativeNumber'
    },
    {
      id: 'sim-arrival-schedule',
      label: 'Arrival Schedule',
      path: ['arrival', 'schedule'],
      control: 'text'
    },
    {
      id: 'sim-number-of-cases',
      label: 'Number Of Cases',
      path: ['arrival', 'numberOfCases'],
      control: 'text',
      type: 'number',
      min: '1',
      step: '1',
      validate: 'positiveInteger'
    }
  ];
}

function getConfigKind(element: BpmnElement): 'task' | 'startEvent' | 'sequenceFlow' {
  if (element.businessObject?.$type === 'bpmn:StartEvent') {
    return 'startEvent';
  }

  if (element.businessObject?.$type === 'bpmn:SequenceFlow') {
    return 'sequenceFlow';
  }

  return 'task';
}

const validators = {
  probability(value: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const number = Number(value);

    return Number.isFinite(number) && number >= 0 && number <= 1
      ? undefined
      : 'Wert zwischen 0 und 1 erwartet.';
  },
  nonNegativeNumber(value: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const number = Number(value);

    return Number.isFinite(number) && number >= 0 ? undefined : 'Nicht-negative Zahl erwartet.';
  },
  positiveInteger(value: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const number = Number(value);

    return Number.isInteger(number) && number > 0 ? undefined : 'Ganzzahl groesser 0 erwartet.';
  },
  nonNegativeInteger(value: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const number = Number(value);

    return Number.isInteger(number) && number >= 0 ? undefined : 'Nicht-negative Ganzzahl erwartet.';
  }
};
