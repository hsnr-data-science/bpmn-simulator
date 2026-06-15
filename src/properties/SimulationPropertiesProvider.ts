import {
  CheckboxEntry,
  isCheckboxEntryEdited,
  isSelectEntryEdited,
  isTextFieldEntryEdited,
  SelectEntry,
  TextFieldEntry
} from '@bpmn-io/properties-panel';
import { useService } from 'bpmn-js-properties-panel';
import { h } from 'preact';
import { isSimulationEditable, isTaskType, supportsOutputObject } from '../bpmn/BpmnElementClassifier';
import {
  readConditionExpression,
  readRawSimulationValue,
  readResourceCatalog,
  readSimulationConfig
} from '../bpmn/ExtensionElementReader';
import {
  updateArrivalConfig,
  updateConditionExpression,
  updateDurationConfig,
  updateOutputObjectFields,
  updateSimulationValue
} from '../bpmn/ExtensionElementWriter';
import type { BpmnBusinessObject, BpmnElement, BpmnFactory, Modeling } from '../types/bpmn';
import type {
  ArrivalConfig,
  ArrivalDistributionType,
  DurationConfig,
  DurationDistributionType,
  HourRange,
  OutputChoice,
  OutputFieldConfig,
  OutputGeneratorType,
  OutputValueType,
  Weekday
} from '../types/simulation';
import {
  DEFAULT_HOUR_RANGES,
  DEFAULT_WEEKDAYS,
  hoursToRanges,
  normalizeHourRanges,
  normalizeWeekdays,
  rangesToHours,
  serializeHourRanges,
  serializeWeekdays,
  WEEKDAY_OPTIONS
} from '../simulation/ResourceCalendar';
import { branchProbabilityEntries } from './entries/BranchProbabilityEntry';
import { durationDistributionEntries } from './entries/DurationDistributionEntry';
import { outputObjectEntries } from './entries/OutputObjectEntry';
import { resourceEntries } from './entries/ResourceEntry';
import { serviceTaskErrorEntries } from './entries/ServiceTaskErrorEntry';

type EntryDefinition = {
  id: string;
  label: string;
  path: string[];
  control:
    | 'text'
    | 'select'
    | 'checkbox'
    | 'resourceSelect'
    | 'outputObjectList'
    | 'durationDistribution'
    | 'arrivalDistribution'
    | 'arrivalCalendar'
    | 'conditionExpression';
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

const durationDrafts = new WeakMap<object, DurationConfig>();
const arrivalDrafts = new WeakMap<object, ArrivalConfig>();
const outputObjectDrafts = new WeakMap<object, OutputFieldConfig[]>();

export default class SimulationPropertiesProvider {
  static $inject = ['propertiesPanel'];

  constructor(propertiesPanel: PropertiesPanel) {
    propertiesPanel.registerProvider(700, this);
  }

  getGroups(element: BpmnElement) {
    return (groups: Group[]) => {
      if (element.businessObject?.$type === 'bpmn:SequenceFlow') {
        addConditionExpressionToDocumentationGroup(groups, element);
      }

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
      label: 'Use in DES',
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
    definitions.push(...(serviceTaskErrorEntries() as EntryDefinition[]));
  }

  return definitions.map((definition) => createEntry(element, definition));
}

function createEntry(element: BpmnElement, definition: EntryDefinition): Entry {
  const component =
    definition.control === 'outputObjectList'
      ? SimulationOutputObjectList
      : definition.control === 'durationDistribution'
        ? SimulationDurationDistribution
        : definition.control === 'arrivalDistribution'
          ? SimulationArrivalDistribution
        : definition.control === 'arrivalCalendar'
          ? SimulationArrivalCalendar
        : definition.control === 'conditionExpression'
          ? SimulationConditionExpression
      : definition.control === 'resourceSelect'
      ? SimulationResourceSelect
      : definition.control === 'select'
      ? SimulationSelect
      : definition.control === 'checkbox'
        ? SimulationCheckbox
        : SimulationTextField;
  const isEdited =
    definition.control === 'outputObjectList'
      ? isOutputObjectListEdited
      : definition.control === 'durationDistribution'
        ? isDurationDistributionEdited
        : definition.control === 'arrivalDistribution'
          ? isArrivalDistributionEdited
        : definition.control === 'arrivalCalendar'
          ? isArrivalCalendarEdited
        : definition.control === 'conditionExpression'
          ? isConditionExpressionEdited
      : definition.control === 'select' || definition.control === 'resourceSelect'
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

function addConditionExpressionToDocumentationGroup(groups: Group[], element: BpmnElement): void {
  const entry = createEntry(element, conditionExpressionEntry());
  const documentationGroup = groups.find((group) => group.id === 'documentation');

  if (documentationGroup) {
    if (!documentationGroup.entries.some((item) => item.id === entry.id)) {
      documentationGroup.entries.push(entry);
    }

    return;
  }

  groups.push({
    id: 'documentation',
    label: 'Documentation',
    entries: [entry]
  });
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

function SimulationConditionExpression(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');
  const debounce = useService('debounceInput');

  return TextFieldEntry({
    id: props.id,
    element: props.element,
    label: props.label,
    debounce,
    getValue: () => readConditionExpression(props.element.businessObject) ?? '',
    setValue: (value: string | undefined) => {
      updateConditionExpression(props.element, value, bpmnFactory, modeling);
    }
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
      const resources = readResourcesForElement(props.element.businessObject, canvas.getRootElement()?.businessObject);

      return [
        { label: 'No Resource', value: '' },
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

function readResourcesForElement(
  element: BpmnBusinessObject | undefined,
  root: BpmnBusinessObject | undefined
) {
  const owner = findOwningProcess(element);
  const ownerResources = readResourceCatalog(owner);

  if (ownerResources.length) {
    return ownerResources;
  }

  const rootResources = collectRootResources(root);

  return rootResources.length ? rootResources : ownerResources;
}

function findOwningProcess(element: BpmnBusinessObject | undefined): BpmnBusinessObject | undefined {
  let current = element;

  while (current) {
    if (current.$type === 'bpmn:Process') {
      return current;
    }

    current = current.$parent as BpmnBusinessObject | undefined;
  }

  return undefined;
}

function collectRootResources(root: BpmnBusinessObject | undefined) {
  if (!root) {
    return [];
  }

  if (root.$type === 'bpmn:Process') {
    return readResourceCatalog(root);
  }

  if (root.$type === 'bpmn:Collaboration') {
    return (root.participants ?? [])
      .flatMap((participant) => {
        const process = participant.processRef;

        return typeof process === 'string'
          ? []
          : readResourceCatalog(process);
      });
  }

  return [];
}

function SimulationArrivalDistribution(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');
  const arrival = getArrivalConfig(props.element);

  const persist = (nextArrival: ArrivalConfig) => {
    if (props.element.businessObject) {
      arrivalDrafts.set(props.element.businessObject, nextArrival);
    }

    updateArrivalConfig(props.element, nextArrival, bpmnFactory, modeling);
  };
  const update = (patch: Partial<ArrivalConfig>) => {
    persist(normalizeArrivalPatch({ ...getArrivalConfig(props.element), ...patch }));
  };

  return h('div', {
    id: props.id,
    class: 'sim-duration-editor sim-arrival-distribution-editor'
  }, [
    h('label', { class: 'sim-field-row' }, [
      h('span', null, props.label),
      h('select', {
        value: arrival.type ?? 'fixed',
        onChange: (event: Event) => persist(setArrivalTypeDefaults(
          arrival,
          (event.currentTarget as HTMLSelectElement).value as ArrivalDistributionType
        ))
      }, ARRIVAL_DISTRIBUTION_OPTIONS.map((option) => h('option', { value: option.value }, option.label)))
    ]),
    h('div', { class: 'sim-duration-parameters' }, renderArrivalParameters(arrival, update))
  ]);
}

function getArrivalConfig(element: BpmnElement): ArrivalConfig {
  if (element.businessObject && arrivalDrafts.has(element.businessObject)) {
    return arrivalDrafts.get(element.businessObject) ?? { type: 'fixed', interval: 1 };
  }

  return normalizeArrivalPatch(readSimulationConfig(element.businessObject).arrival ?? { type: 'fixed', interval: 1 });
}

function renderArrivalParameters(
  arrival: ArrivalConfig,
  update: (patch: Partial<ArrivalConfig>) => void
) {
  if ((arrival.type ?? 'fixed') === 'none') {
    return [
      h('p', { class: 'sim-output-empty' }, 'No tokens are generated for this start event.')
    ];
  }

  return getArrivalParameters(arrival.type ?? 'fixed').map((parameter) => renderNumberParameter(
    parameter.label,
    Number(arrival[parameter.key] ?? parameter.defaultValue),
    (value) => update({ [parameter.key]: value }),
    parameter.min,
    undefined,
    parameter.step
  ));
}

function SimulationArrivalCalendar(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');
  const arrival = readSimulationConfig(props.element.businessObject).arrival ?? {};
  const weekdays = getCalendarWeekdays(arrival);
  const hours = getCalendarHours(arrival);
  const persistWeekdays = (nextWeekdays: Weekday[]) => {
    updateSimulationValue(
      props.element,
      'startEvent',
      ['arrival', 'weekdays'],
      serializeWeekdays(nextWeekdays),
      bpmnFactory,
      modeling
    );
  };
  const persistHours = (nextHours: number[]) => {
    updateSimulationValue(
      props.element,
      'startEvent',
      ['arrival', 'hourRanges'],
      serializeHourRanges(hoursToRanges(nextHours)),
      bpmnFactory,
      modeling
    );
  };

  return h('details', {
    id: props.id,
    class: 'sim-arrival-calendar sim-collapsible-list',
    open: true
  }, [
    h('summary', { class: 'sim-collapsible-summary' }, [
      h('span', null, props.label),
      h('small', null, formatCalendarSummary(weekdays, hoursToRanges(hours)))
    ]),
    h('div', { class: 'sim-collapsible-body' }, [
      h('div', { class: 'sim-calendar-block' }, [
        h('span', null, 'Days'),
        h('div', { class: 'sim-calendar-chip-grid' }, WEEKDAY_OPTIONS.map((day) => {
          const checked = weekdays.includes(day.value);

          return h('label', { class: 'sim-calendar-chip', key: `day-${day.value}` }, [
            h('input', {
              type: 'checkbox',
              value: String(day.value),
              checked,
              onChange: (event: Event) => {
                const input = event.currentTarget as HTMLInputElement;
                const next = toggleCalendarValue(weekdays, day.value, input.checked);

                if (!next.length) {
                  input.checked = true;
                  return;
                }

                persistWeekdays(next);
              }
            }),
            h('span', null, day.label)
          ]);
        }))
      ]),
      h('div', { class: 'sim-calendar-block' }, [
        h('span', null, 'Hours'),
        h('div', { class: 'sim-calendar-chip-grid sim-calendar-hour-grid' }, ALL_HOURS.map((hour) => {
          const checked = hours.includes(hour);

          return h('label', { class: 'sim-calendar-chip sim-calendar-hour-chip', key: `hour-${hour}` }, [
            h('input', {
              type: 'checkbox',
              value: String(hour),
              checked,
              onChange: (event: Event) => {
                const input = event.currentTarget as HTMLInputElement;
                const next = toggleCalendarValue(hours, hour, input.checked);

                if (!next.length) {
                  input.checked = true;
                  return;
                }

                persistHours(next);
              }
            }),
            h('span', null, formatHourRangeLabel(hour))
          ]);
        }))
      ])
    ])
  ]);
}

function SimulationDurationDistribution(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');
  const duration = getDurationConfig(props.element);

  const persist = (nextDuration: DurationConfig) => {
    if (props.element.businessObject) {
      durationDrafts.set(props.element.businessObject, nextDuration);
    }

    updateDurationConfig(props.element, nextDuration, bpmnFactory, modeling);
  };
  const update = (patch: Partial<DurationConfig>) => {
    persist(normalizeDurationPatch({ ...getDurationConfig(props.element), ...patch }));
  };

  return h('div', {
    id: props.id,
    class: 'sim-duration-editor'
  }, [
    h('label', { class: 'sim-field-row' }, [
      h('span', null, props.label),
      h('select', {
        value: duration.type ?? 'fixed',
        onChange: (event: Event) => persist(setDurationTypeDefaults(
          duration,
          (event.currentTarget as HTMLSelectElement).value as DurationDistributionType
        ))
      }, DURATION_DISTRIBUTION_OPTIONS.map((option) => h('option', { value: option.value }, option.label)))
    ]),
    h('div', { class: 'sim-duration-parameters' }, renderDurationParameters(duration, update))
  ]);
}

function getDurationConfig(element: BpmnElement): DurationConfig {
  if (element.businessObject && durationDrafts.has(element.businessObject)) {
    return durationDrafts.get(element.businessObject) ?? { type: 'fixed', mean: 0 };
  }

  return normalizeDurationPatch(readSimulationConfig(element.businessObject).duration ?? { type: 'fixed', mean: 0 });
}

function renderDurationParameters(
  duration: DurationConfig,
  update: (patch: Partial<DurationConfig>) => void
) {
  return getDurationParameters(duration.type ?? 'fixed').map((parameter) => renderNumberParameter(
    parameter.label,
    Number(duration[parameter.key] ?? parameter.defaultValue),
    (value) => update({ [parameter.key]: value }),
    parameter.min,
    undefined,
    parameter.step
  ));
}

function SimulationOutputObjectList(props: Entry): unknown {
  const modeling = useService<Modeling>('modeling');
  const bpmnFactory = useService<BpmnFactory>('bpmnFactory');
  const fields = getOutputObjectFields(props.element);

  const persist = (nextFields: OutputFieldConfig[]) => {
    if (props.element.businessObject) {
      outputObjectDrafts.set(props.element.businessObject, nextFields);
    }

    updateOutputObjectFields(props.element, nextFields, bpmnFactory, modeling);
  };
  const updateFields = (createNext: (current: OutputFieldConfig[]) => OutputFieldConfig[]) => {
    persist(createNext(getOutputObjectFields(props.element)));
  };

  return h('details', {
    id: props.id,
    class: 'sim-output-object-list sim-collapsible-list',
    open: true
  }, [
    h('summary', { class: 'sim-collapsible-summary' }, [
      h('span', null, props.label),
      h('small', null, `${fields.length}`)
    ]),
    h('div', { class: 'sim-collapsible-body' }, [
      h('button', {
        type: 'button',
        class: 'bio-properties-panel-button sim-output-add',
        onClick: () => updateFields((current) => [...current, createDefaultOutputField(current.length)])
      }, '+ Add'),
      fields.length
        ? h('div', { class: 'sim-output-object-items' }, fields.map((field, index) => renderOutputField(field, index, updateFields)))
        : h('p', { class: 'sim-output-empty' }, 'No output fields configured.')
    ])
  ]);
}

function getOutputObjectFields(element: BpmnElement): OutputFieldConfig[] {
  if (element.businessObject && outputObjectDrafts.has(element.businessObject)) {
    return outputObjectDrafts.get(element.businessObject) ?? [];
  }

  return readSimulationConfig(element.businessObject).outputObject?.fields ?? [];
}

function renderOutputField(
  field: OutputFieldConfig,
  index: number,
  updateFields: (createNext: (current: OutputFieldConfig[]) => OutputFieldConfig[]) => void
) {
  const update = (patch: Partial<OutputFieldConfig>) => {
    updateFields((fields) => fields.map((item, itemIndex) => itemIndex === index ? normalizeFieldPatch({ ...item, ...patch }) : item));
  };
  const remove = () => {
    updateFields((fields) => fields.filter((_, itemIndex) => itemIndex !== index));
  };

  return h('article', { class: 'sim-output-item', key: `${field.key}-${index}` }, [
    h('div', { class: 'sim-output-item-title' }, [
      h('strong', null, field.key || `Output ${index + 1}`),
      h('button', {
        type: 'button',
        class: 'bio-properties-panel-button sim-output-remove',
        onClick: remove
      }, 'Remove')
    ]),
    h('label', null, [
      h('span', null, 'Name'),
      h('input', {
        type: 'text',
        defaultValue: field.key,
        onInput: (event: Event) => update({ key: (event.currentTarget as HTMLInputElement).value }),
        onChange: (event: Event) => update({ key: (event.currentTarget as HTMLInputElement).value }),
        onBlur: (event: Event) => update({ key: (event.currentTarget as HTMLInputElement).value }),
        onKeyUp: (event: Event) => update({ key: (event.currentTarget as HTMLInputElement).value })
      })
    ]),
    h('label', null, [
      h('span', null, 'Type'),
      h('select', {
        value: field.type,
        onChange: (event: Event) => update(setTypeDefaults(field, (event.currentTarget as HTMLSelectElement).value as OutputValueType))
      }, OUTPUT_TYPE_OPTIONS.map((option) => h('option', { value: option.value }, option.label)))
    ]),
    h('label', null, [
      h('span', null, 'Generator'),
      h('select', {
        value: field.generator,
        onChange: (event: Event) => update(setGeneratorDefaults(field, (event.currentTarget as HTMLSelectElement).value as OutputGeneratorType))
      }, getGeneratorOptions(field.type).map((option) => h('option', { value: option.value }, option.label)))
    ]),
    ...renderGeneratorParameters(field, update)
  ]);
}

function renderGeneratorParameters(
  field: OutputFieldConfig,
  update: (patch: Partial<OutputFieldConfig>) => void
) {
  if (field.type === 'string') {
    if (field.generator === 'categorical') {
      return [
        h('label', null, [
          h('span', null, 'Values'),
          h('input', {
            type: 'text',
            defaultValue: choicesToText(field.choices),
            placeholder: 'a:0.34|b:0.33|c:0.33',
            onInput: (event: Event) => update({ choices: textToChoices((event.currentTarget as HTMLInputElement).value) }),
            onChange: (event: Event) => update({ choices: textToChoices((event.currentTarget as HTMLInputElement).value) }),
            onBlur: (event: Event) => update({ choices: textToChoices((event.currentTarget as HTMLInputElement).value) })
          })
        ])
      ];
    }

    if (field.generator === 'fixed') {
      return [renderTextParameter('Value', field.value ?? '', (value) => update({ value }))];
    }

    return [renderNumberParameter('Length', field.length ?? 8, (value) => update({ length: value }), 1, 64, 1)];
  }

  if (field.generator === 'randomChoice') {
    return [
      h('label', null, [
        h('span', null, 'Values'),
          h('input', {
            type: 'text',
            defaultValue: choicesToText(field.choices),
          placeholder: '1:0.34|2:0.33|3:0.33',
          onInput: (event: Event) => update({ choices: textToChoices((event.currentTarget as HTMLInputElement).value) }),
          onChange: (event: Event) => update({ choices: textToChoices((event.currentTarget as HTMLInputElement).value) }),
          onBlur: (event: Event) => update({ choices: textToChoices((event.currentTarget as HTMLInputElement).value) })
        })
      ])
    ];
  }

  if (field.generator === 'fixed') {
    return [renderNumberParameter('Value', Number(field.value ?? field.mean ?? 0), (value) => update({ value: String(value), mean: value }))];
  }

  return getDistributionParameters(field.generator).map((parameter) => renderNumberParameter(
    parameter.label,
    Number(field[parameter.key] ?? parameter.defaultValue),
    (value) => update({ [parameter.key]: value }),
    parameter.min,
    undefined,
    parameter.step
  ));
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

function isOutputObjectListEdited(...args: unknown[]): boolean {
  const props = args[1] as Entry | undefined;

  return Boolean(props?.element && readSimulationConfig(props.element.businessObject).outputObject?.fields?.length);
}

function isDurationDistributionEdited(...args: unknown[]): boolean {
  const props = args[1] as Entry | undefined;

  return Boolean(props?.element && readSimulationConfig(props.element.businessObject).duration);
}

function isArrivalDistributionEdited(...args: unknown[]): boolean {
  const props = args[1] as Entry | undefined;
  const arrival = props?.element ? readSimulationConfig(props.element.businessObject).arrival : undefined;

  return Boolean(
    arrival?.type ||
    arrival?.interval !== undefined ||
    arrival?.mean !== undefined ||
    arrival?.stddev !== undefined
  );
}

function isArrivalCalendarEdited(...args: unknown[]): boolean {
  const props = args[1] as Entry | undefined;
  const arrival = props?.element ? readSimulationConfig(props.element.businessObject).arrival : undefined;

  return Boolean(
    normalizeWeekdays(arrival?.weekdays).length ||
    normalizeHourRanges(arrival?.hourRanges).length
  );
}

function isConditionExpressionEdited(...args: unknown[]): boolean {
  const props = args[1] as Entry | undefined;

  return Boolean(props?.element && readConditionExpression(props.element.businessObject));
}

const DURATION_DISTRIBUTION_OPTIONS: Array<{ label: string; value: DurationDistributionType }> = [
  { label: 'Fixed', value: 'fixed' },
  { label: 'Uniform', value: 'uniform' },
  { label: 'Normal', value: 'normal' },
  { label: 'Exponential', value: 'exponential' },
  { label: 'Triangular', value: 'triangular' }
];

const ARRIVAL_DISTRIBUTION_OPTIONS: Array<{ label: string; value: ArrivalDistributionType }> = [
  { label: 'None', value: 'none' },
  { label: 'Fixed', value: 'fixed' },
  { label: 'Normal', value: 'normal' },
  { label: 'Exponential', value: 'exponential' }
];

const OUTPUT_TYPE_OPTIONS: Array<{ label: string; value: OutputValueType }> = [
  { label: 'Int', value: 'int' },
  { label: 'Float', value: 'float' },
  { label: 'String', value: 'string' }
];

const NUMERIC_GENERATOR_OPTIONS: Array<{ label: string; value: OutputGeneratorType }> = [
  { label: 'Fixed', value: 'fixed' },
  { label: 'Random Choice', value: 'randomChoice' },
  { label: 'Uniform', value: 'uniform' },
  { label: 'Normal', value: 'normal' },
  { label: 'Exponential', value: 'exponential' },
  { label: 'Triangular', value: 'triangular' }
];

const STRING_GENERATOR_OPTIONS: Array<{ label: string; value: OutputGeneratorType }> = [
  { label: 'Random', value: 'random' },
  { label: 'Categorical', value: 'categorical' },
  { label: 'Fixed', value: 'fixed' }
];

const ALL_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function getCalendarWeekdays(arrival: ArrivalConfig): Weekday[] {
  const weekdays = normalizeWeekdays(arrival.weekdays);

  return weekdays.length ? weekdays : [...DEFAULT_WEEKDAYS];
}

function getCalendarHours(arrival: ArrivalConfig): number[] {
  const hours = rangesToHours(arrival.hourRanges);

  return hours.length ? hours : rangesToHours(DEFAULT_HOUR_RANGES);
}

function toggleCalendarValue<T extends number>(values: T[], value: T, checked: boolean): T[] {
  const next = checked
    ? [...new Set([...values, value])]
    : values.filter((item) => item !== value);

  return next.sort((a, b) => a - b);
}

function formatCalendarSummary(weekdays: Weekday[], hourRanges: HourRange[]): string {
  return `${weekdays.length}d/${rangesToHours(hourRanges).length}h`;
}

function formatHourRangeLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}-${String(hour + 1).padStart(2, '0')}`;
}

function createDefaultOutputField(index: number): OutputFieldConfig {
  return {
    key: `field_${index + 1}`,
    type: 'string',
    generator: 'random',
    length: 8
  };
}

function getGeneratorOptions(type: OutputValueType): Array<{ label: string; value: OutputGeneratorType }> {
  return type === 'string' ? STRING_GENERATOR_OPTIONS : NUMERIC_GENERATOR_OPTIONS;
}

function setTypeDefaults(field: OutputFieldConfig, type: OutputValueType): Partial<OutputFieldConfig> {
  if (type === 'string') {
    return {
      ...field,
      type,
      generator: 'random',
      value: undefined,
      choices: undefined,
      mean: undefined,
      stddev: undefined,
      min: undefined,
      max: undefined,
      mode: undefined,
      lambda: undefined,
      length: field.length ?? 8
    };
  }

  return {
    ...field,
    type,
    generator: 'fixed',
    value: field.value ?? '0',
    choices: undefined,
    mean: Number(field.value ?? field.mean ?? 0),
    stddev: undefined,
    min: undefined,
    max: undefined,
    mode: undefined,
    lambda: undefined,
    length: undefined
  };
}

function setGeneratorDefaults(field: OutputFieldConfig, generator: OutputGeneratorType): Partial<OutputFieldConfig> {
  if (generator === 'randomChoice' || generator === 'categorical') {
    return {
      ...field,
      generator,
      choices: field.choices?.length ? field.choices : createDefaultChoices(field.type),
      value: undefined
    };
  }

  if (generator === 'random') {
    return {
      ...field,
      generator,
      length: field.length ?? 8,
      choices: undefined,
      value: undefined
    };
  }

  if (generator === 'fixed') {
    return {
      ...field,
      generator,
      value: field.value ?? (field.type === 'string' ? '' : String(field.mean ?? 0)),
      choices: undefined
    };
  }

  return {
    ...field,
    generator,
    choices: undefined,
    value: undefined,
    mean: field.mean ?? 1,
    stddev: generator === 'normal' ? field.stddev ?? 1 : field.stddev,
    min: generator === 'exponential' ? field.min : field.min ?? 0,
    max: generator === 'uniform' || generator === 'triangular' ? field.max ?? 10 : field.max,
    mode: generator === 'triangular' ? field.mode ?? field.mean ?? 5 : field.mode,
    lambda: generator === 'exponential' ? field.lambda ?? 1 : field.lambda
  };
}

function createDefaultChoices(type: OutputValueType): OutputChoice[] {
  const values = type === 'string' ? ['a', 'b', 'c'] : ['1', '2', '3'];

  return values.map((value, index) => ({
    value,
    probability: index === 0 ? 0.34 : 0.33
  }));
}

function normalizeFieldPatch(field: OutputFieldConfig): OutputFieldConfig {
  const validGenerator = getGeneratorOptions(field.type).some((option) => option.value === field.generator);

  return validGenerator ? field : {
    ...field,
    generator: field.type === 'string' ? 'random' : 'fixed'
  };
}

function setArrivalTypeDefaults(arrival: ArrivalConfig, type: ArrivalDistributionType): ArrivalConfig {
  const preserved = {
    numberOfCases: arrival.numberOfCases,
    weekdays: arrival.weekdays,
    hourRanges: arrival.hourRanges
  };

  if (type === 'none') {
    return {
      ...preserved,
      type
    };
  }

  if (type === 'fixed') {
    return {
      ...preserved,
      type,
      interval: arrival.interval ?? arrival.mean ?? 1
    };
  }

  if (type === 'normal') {
    return {
      ...preserved,
      type,
      mean: arrival.mean ?? arrival.interval ?? 1,
      stddev: arrival.stddev ?? 1,
      min: arrival.min ?? 0,
      max: arrival.max
    };
  }

  if (type === 'exponential') {
    return {
      ...preserved,
      type,
      mean: arrival.mean ?? arrival.interval ?? 1,
      lambda: arrival.lambda
    };
  }

  return {
    ...preserved,
    type: 'fixed',
    interval: arrival.interval ?? arrival.mean ?? 1
  };
}

function normalizeArrivalPatch(arrival: ArrivalConfig): ArrivalConfig {
  return setArrivalTypeDefaults(arrival, arrival.type ?? 'fixed');
}

function setDurationTypeDefaults(duration: DurationConfig, type: DurationDistributionType): DurationConfig {
  if (type === 'fixed') {
    return {
      type,
      mean: duration.mean ?? 1
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

function normalizeDurationPatch(duration: DurationConfig): DurationConfig {
  return setDurationTypeDefaults(duration, duration.type ?? 'fixed');
}

function renderNumberParameter(
  label: string,
  value: number,
  onChange: (value: number | undefined) => void,
  min?: number,
  max?: number,
  step = 0.1
) {
  return h('label', null, [
    h('span', null, label),
    h('input', {
      type: 'number',
      min,
      max,
      step,
      defaultValue: Number.isFinite(value) ? value : '',
      onInput: (event: Event) => {
        const rawValue = (event.currentTarget as HTMLInputElement).value;
        const number = Number(rawValue);

        onChange(rawValue === '' || !Number.isFinite(number) ? undefined : number);
      },
      onChange: (event: Event) => {
        const rawValue = (event.currentTarget as HTMLInputElement).value;
        const number = Number(rawValue);

        onChange(rawValue === '' || !Number.isFinite(number) ? undefined : number);
      },
      onBlur: (event: Event) => {
        const rawValue = (event.currentTarget as HTMLInputElement).value;
        const number = Number(rawValue);

        onChange(rawValue === '' || !Number.isFinite(number) ? undefined : number);
      }
    })
  ]);
}

function renderTextParameter(label: string, value: string, onChange: (value: string) => void) {
  return h('label', null, [
    h('span', null, label),
    h('input', {
      type: 'text',
      defaultValue: value,
      onInput: (event: Event) => onChange((event.currentTarget as HTMLInputElement).value),
      onChange: (event: Event) => onChange((event.currentTarget as HTMLInputElement).value),
      onBlur: (event: Event) => onChange((event.currentTarget as HTMLInputElement).value),
      onKeyUp: (event: Event) => onChange((event.currentTarget as HTMLInputElement).value)
    })
  ]);
}

function getDistributionParameters(generator: OutputGeneratorType): Array<{
  key: 'mean' | 'stddev' | 'min' | 'max' | 'mode' | 'lambda';
  label: string;
  defaultValue: number;
  min?: number;
  step?: number;
}> {
  if (generator === 'uniform') {
    return [
      { key: 'min', label: 'Min', defaultValue: 0 },
      { key: 'max', label: 'Max', defaultValue: 10 }
    ];
  }

  if (generator === 'normal') {
    return [
      { key: 'mean', label: 'Mean', defaultValue: 1 },
      { key: 'stddev', label: 'Stddev', defaultValue: 1, min: 0 },
      { key: 'min', label: 'Min', defaultValue: 0 },
      { key: 'max', label: 'Max', defaultValue: 10 }
    ];
  }

  if (generator === 'exponential') {
    return [
      { key: 'mean', label: 'Mean', defaultValue: 1, min: 0 },
      { key: 'lambda', label: 'Lambda', defaultValue: 1, min: 0 }
    ];
  }

  if (generator === 'triangular') {
    return [
      { key: 'min', label: 'Min', defaultValue: 0 },
      { key: 'mode', label: 'Mode', defaultValue: 5 },
      { key: 'max', label: 'Max', defaultValue: 10 }
    ];
  }

  return [];
}

function getDurationParameters(type: DurationDistributionType): Array<{
  key: 'mean' | 'stddev' | 'min' | 'max' | 'mode' | 'lambda';
  label: string;
  defaultValue: number;
  min?: number;
  step?: number;
}> {
  if (type === 'fixed') {
    return [
      { key: 'mean', label: 'Duration (min)', defaultValue: 1, min: 0 }
    ];
  }

  if (type === 'uniform') {
    return [
      { key: 'min', label: 'Min (min)', defaultValue: 0, min: 0 },
      { key: 'max', label: 'Max (min)', defaultValue: 10, min: 0 }
    ];
  }

  if (type === 'normal') {
    return [
      { key: 'mean', label: 'Mean (min)', defaultValue: 1, min: 0 },
      { key: 'stddev', label: 'Stddev (min)', defaultValue: 1, min: 0 },
      { key: 'min', label: 'Min (min)', defaultValue: 0, min: 0 },
      { key: 'max', label: 'Max (min)', defaultValue: 10, min: 0 }
    ];
  }

  if (type === 'exponential') {
    return [
      { key: 'mean', label: 'Mean (min)', defaultValue: 1, min: 0 },
      { key: 'lambda', label: 'Lambda', defaultValue: 1, min: 0 }
    ];
  }

  return [
    { key: 'min', label: 'Min (min)', defaultValue: 0, min: 0 },
    { key: 'mode', label: 'Mode (min)', defaultValue: 5, min: 0 },
    { key: 'max', label: 'Max (min)', defaultValue: 10, min: 0 }
  ];
}

function getArrivalParameters(type: ArrivalDistributionType): Array<{
  key: 'interval' | 'mean' | 'stddev' | 'min' | 'max' | 'lambda';
  label: string;
  defaultValue: number;
  min?: number;
  step?: number;
}> {
  if (type === 'normal') {
    return [
      { key: 'mean', label: 'Mean Interarrival (min)', defaultValue: 1, min: 0 },
      { key: 'stddev', label: 'Stddev (min)', defaultValue: 1, min: 0 },
      { key: 'min', label: 'Min (min)', defaultValue: 0, min: 0 },
      { key: 'max', label: 'Max (min)', defaultValue: 10, min: 0 }
    ];
  }

  if (type === 'exponential') {
    return [
      { key: 'mean', label: 'Mean Interarrival (min)', defaultValue: 1, min: 0 },
      { key: 'lambda', label: 'Lambda', defaultValue: 1, min: 0 }
    ];
  }

  return [
    { key: 'interval', label: 'Interval (min)', defaultValue: 1, min: 0 }
  ];
}

function choicesToText(choices: OutputChoice[] | undefined): string {
  return (choices ?? [])
    .map((choice) => choice.probability === undefined ? choice.value : `${choice.value}:${choice.probability}`)
    .join('|');
}

function textToChoices(value: string): OutputChoice[] | undefined {
  const choices = value
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [choiceValue, probabilityValue] = part.split(':').map((segment) => segment.trim());
      const probability = Number(probabilityValue);

      return {
        value: choiceValue,
        probability: Number.isFinite(probability) ? probability : undefined
      };
    })
    .filter((choice) => choice.value);

  return choices.length ? choices : undefined;
}

function conditionExpressionEntry(): EntryDefinition {
  return {
    id: 'condition-expression',
    label: 'Condition (JS)',
    path: ['conditionExpression'],
    control: 'conditionExpression'
  };
}

function startEventEntries(): EntryDefinition[] {
  return [
    {
      id: 'sim-arrival-distribution',
      label: 'Arrival Distribution (minutes)',
      path: ['arrival'],
      control: 'arrivalDistribution'
    },
    {
      id: 'sim-number-of-cases',
      label: 'Number of Cases',
      path: ['arrival', 'numberOfCases'],
      control: 'text',
      type: 'number',
      min: '1',
      step: '1',
      validate: 'positiveInteger'
    },
    {
      id: 'sim-arrival-calendar',
      label: 'Arrival Calendar',
      path: ['arrival'],
      control: 'arrivalCalendar'
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
      : 'Expected a value between 0 and 1.';
  },
  nonNegativeNumber(value: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const number = Number(value);

    return Number.isFinite(number) && number >= 0 ? undefined : 'Expected a non-negative number.';
  },
  positiveInteger(value: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const number = Number(value);

    return Number.isInteger(number) && number > 0 ? undefined : 'Expected an integer greater than 0.';
  },
  nonNegativeInteger(value: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const number = Number(value);

    return Number.isInteger(number) && number >= 0 ? undefined : 'Expected a non-negative integer.';
  }
};
