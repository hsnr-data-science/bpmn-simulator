import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
  type Node as XmlNode
} from '@xmldom/xmldom';
import type {
  ArrivalConfig,
  DurationConfig,
  HourRange,
  SimulationResource,
  Weekday
} from '../types/simulation';
import {
  normalizeHourRanges,
  normalizeWeekdays,
  serializeHourRanges,
  serializeWeekdays
} from '../simulation/ResourceCalendar';
import { SIM_NS_URI } from './ExtensionElementReader';

const BPMN_NS_URI = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const BPMNDI_NS_URI = 'http://www.omg.org/spec/BPMN/20100524/DI';
const QBP_NS_URI = 'http://www.qbp-simulator.com/Schema201212';
const XMLNS_NS_URI = 'http://www.w3.org/2000/xmlns/';

export type QbpSimulationImportResult = {
  xml: string;
  imported: boolean;
  startDateTime?: string;
  warnings: string[];
  summary: {
    processSimulationInfos: number;
    resources: number;
    taskConfigurations: number;
    sequenceFlows: number;
  };
};

type QbpTimetable = {
  id: string;
  isDefault: boolean;
  weekdays: Weekday[];
  hourRanges: HourRange[];
};

export function importQbpSimulationInfo(xml: string): QbpSimulationImportResult {
  const warnings: string[] = [];
  const document = new DOMParser({
    onError(level, message) {
      if (level === 'error' || level === 'fatalError') {
        throw new Error(message);
      }
    }
  }).parseFromString(xml, 'application/xml');
  const documentElement = document.documentElement;

  if (!documentElement) {
    throw new Error('BPMN import failed: XML document has no root element.');
  }

  const removedInvalidAssociations = removeInvalidAssociations(document, warnings);
  const simulationInfos = elementsByName(document, QBP_NS_URI, 'processSimulationInfo');
  const result: QbpSimulationImportResult = {
    xml,
    imported: simulationInfos.length > 0,
    warnings,
    summary: {
      processSimulationInfos: simulationInfos.length,
      resources: 0,
      taskConfigurations: 0,
      sequenceFlows: 0
    }
  };

  if (!simulationInfos.length) {
    if (removedInvalidAssociations > 0) {
      result.xml = new XMLSerializer().serializeToString(document);
    }

    return result;
  }

  documentElement.setAttributeNS(XMLNS_NS_URI, 'xmlns:sim', SIM_NS_URI);

  for (const simulationInfo of simulationInfos) {
    const process = findOwningProcess(document, simulationInfo);

    if (!process) {
      warnings.push('QBP simulation data could not be assigned because no BPMN process was found.');
      simulationInfo.parentNode?.removeChild(simulationInfo);
      continue;
    }

    const startDateTime = attribute(simulationInfo, 'startDateTime');

    if (startDateTime) {
      result.startDateTime ??= startDateTime;
      writeProcessConfig(document, process, startDateTime);
    }

    const timetables = readTimetables(simulationInfo, warnings);
    const resources = readResources(simulationInfo, timetables);

    writeResourceCatalog(document, process, resources);
    result.summary.resources += resources.length;

    const arrivalDistribution = firstElement(simulationInfo, QBP_NS_URI, 'arrivalRateDistribution');
    const processInstances = integerAttribute(simulationInfo, 'processInstances');
    const defaultTimetable = [...timetables.values()].find((timetable) => timetable.isDefault);
    const rootStartEvents = directChildElements(process, BPMN_NS_URI, 'startEvent');

    if (rootStartEvents.length > 1) {
      warnings.push(
        `QBP process "${attribute(process, 'id') ?? 'unknown'}" has multiple root start events; arrival data was assigned to the first one.`
      );
    }

    if (rootStartEvents[0] && arrivalDistribution) {
      const arrival = mapArrivalDistribution(arrivalDistribution, warnings);

      arrival.numberOfCases = processInstances;
      arrival.weekdays = defaultTimetable?.weekdays;
      arrival.hourRanges = defaultTimetable?.hourRanges;
      writeStartEventConfig(document, rootStartEvents[0], arrival);
    }

    for (const qbpElement of elementsByName(simulationInfo, QBP_NS_URI, 'element')) {
      const elementId = attribute(qbpElement, 'elementId');
      const bpmnElement = elementId ? findElementById(document, elementId) : undefined;
      const durationDistribution = firstElement(qbpElement, QBP_NS_URI, 'durationDistribution');

      if (!bpmnElement || !durationDistribution) {
        continue;
      }

      const duration = mapDurationDistribution(durationDistribution, warnings);
      const resourceIds = elementsByName(qbpElement, QBP_NS_URI, 'resourceId')
        .map((element) => element.textContent?.trim())
        .filter((value): value is string => Boolean(value));

      if (resourceIds.length > 1) {
        warnings.push(
          `QBP element "${elementId}" references multiple resources; only "${resourceIds[0]}" was imported.`
        );
      }

      writeTaskConfig(document, bpmnElement, duration, resourceIds[0]);
      result.summary.taskConfigurations += 1;
    }

    for (const qbpFlow of elementsByName(simulationInfo, QBP_NS_URI, 'sequenceFlow')) {
      const elementId = attribute(qbpFlow, 'elementId');
      const probability = numberAttribute(qbpFlow, 'executionProbability');
      const bpmnFlow = elementId ? findElementById(document, elementId) : undefined;

      if (!bpmnFlow || probability === undefined) {
        continue;
      }

      writeSequenceFlowConfig(document, bpmnFlow, probability);
      removeNumericProbabilityCondition(bpmnFlow);
      result.summary.sequenceFlows += 1;
    }

    if (
      attribute(simulationInfo, 'currency') ||
      elementsByName(simulationInfo, QBP_NS_URI, 'resource').some((resource) => numberAttribute(resource, 'costPerHour'))
    ) {
      warnings.push('QBP currency, hourly resource costs and fixed element costs were not imported because cost simulation is not supported.');
    }

    simulationInfo.parentNode?.removeChild(simulationInfo);
  }

  documentElement.removeAttributeNS(XMLNS_NS_URI, 'qbp');
  documentElement.removeAttribute('xmlns:qbp');
  result.xml = new XMLSerializer().serializeToString(document);

  return result;
}

function removeInvalidAssociations(document: XmlDocument, warnings: string[]): number {
  const removedIds = new Set<string>();

  for (const association of elementsByName(document, BPMN_NS_URI, 'association')) {
    if (attribute(association, 'sourceRef') && attribute(association, 'targetRef')) {
      continue;
    }

    const id = attribute(association, 'id') ?? 'unknown';

    removedIds.add(id);
    association.parentNode?.removeChild(association);
    warnings.push(
      `Removed invalid BPMN association "${id}" because sourceRef or targetRef was missing.`
    );
  }

  if (!removedIds.size) {
    return 0;
  }

  for (const edge of elementsByName(document, BPMNDI_NS_URI, 'BPMNEdge')) {
    if (removedIds.has(attribute(edge, 'bpmnElement') ?? '')) {
      edge.parentNode?.removeChild(edge);
    }
  }

  return removedIds.size;
}

function readTimetables(
  simulationInfo: XmlElement,
  warnings: string[]
): Map<string, QbpTimetable> {
  const timetables = new Map<string, QbpTimetable>();

  for (const timetableElement of elementsByName(simulationInfo, QBP_NS_URI, 'timetable')) {
    const id = attribute(timetableElement, 'id');

    if (!id) {
      continue;
    }

    const weekdays: Weekday[] = [];
    const hourRanges: HourRange[] = [];

    for (const rule of elementsByName(timetableElement, QBP_NS_URI, 'rule')) {
      weekdays.push(...weekdayRange(
        attribute(rule, 'fromWeekDay'),
        attribute(rule, 'toWeekDay')
      ));

      const fromTime = parseClockTime(attribute(rule, 'fromTime'));
      const toTime = parseClockTime(attribute(rule, 'toTime'));

      if (!fromTime || !toTime) {
        continue;
      }

      const start = Math.floor(fromTime.hours + fromTime.minutes / 60);
      const end = Math.ceil(toTime.hours + toTime.minutes / 60);

      if (fromTime.minutes || toTime.minutes) {
        warnings.push(`QBP timetable "${id}" contains partial hours and was rounded to hourly calendar slots.`);
      }

      if (start < end) {
        hourRanges.push({ start, end });
      } else if (start > end) {
        hourRanges.push({ start, end: 24 }, { start: 0, end });
      }
    }

    timetables.set(id, {
      id,
      isDefault: attribute(timetableElement, 'default') === 'true',
      weekdays: normalizeWeekdays(weekdays),
      hourRanges: normalizeHourRanges(hourRanges)
    });
  }

  return timetables;
}

function readResources(
  simulationInfo: XmlElement,
  timetables: Map<string, QbpTimetable>
): SimulationResource[] {
  return elementsByName(simulationInfo, QBP_NS_URI, 'resource')
    .map((resource): SimulationResource | undefined => {
      const id = attribute(resource, 'id');

      if (!id) {
        return undefined;
      }

      const timetable = timetables.get(attribute(resource, 'timetableId') ?? '');

      return {
        id,
        name: attribute(resource, 'name') ?? id,
        capacity: integerAttribute(resource, 'totalAmount'),
        weekdays: timetable?.weekdays,
        hourRanges: timetable?.hourRanges
      };
    })
    .filter((resource): resource is SimulationResource => Boolean(resource));
}

function mapDurationDistribution(element: XmlElement, warnings: string[]): DurationConfig {
  const type = (attribute(element, 'type') ?? '').toLowerCase();
  const scale = timeUnitScale(element);
  const mean = scaledParameter(element, 'mean', scale);
  const arg1 = scaledParameter(element, 'arg1', scale);
  const arg2 = scaledParameter(element, 'arg2', scale);

  if (type === 'fixed' || type === 'constant') {
    return { type: 'fixed', mean: arg1 ?? mean ?? 0 };
  }

  if (type === 'uniform') {
    return { type: 'uniform', min: arg1 ?? 0, max: arg2 ?? arg1 ?? 0 };
  }

  if (type === 'normal') {
    return { type: 'normal', mean: arg1 ?? mean ?? 0, stddev: arg2 ?? 0 };
  }

  if (type === 'exponential') {
    return { type: 'exponential', mean: arg1 ?? mean ?? 1 };
  }

  if (type === 'triangular') {
    const min = arg1 ?? 0;
    const max = arg2 ?? min;
    const mode = mean !== undefined && mean >= min && mean <= max
      ? mean
      : (min + max) / 2;

    return { type: 'triangular', min, mode, max };
  }

  warnings.push(`Unsupported QBP distribution "${type || 'unknown'}" was imported as a fixed duration.`);

  return { type: 'fixed', mean: mean ?? arg1 ?? 0 };
}

function mapArrivalDistribution(element: XmlElement, warnings: string[]): ArrivalConfig {
  const duration = mapDurationDistribution(element, warnings);

  if (duration.type === 'exponential') {
    return { type: 'exponential', mean: duration.mean };
  }

  if (duration.type === 'normal') {
    return {
      type: 'normal',
      mean: duration.mean,
      stddev: duration.stddev,
      min: duration.min,
      max: duration.max
    };
  }

  if (duration.type === 'fixed') {
    return { type: 'fixed', interval: duration.mean };
  }

  const interval = duration.type === 'uniform'
    ? ((duration.min ?? 0) + (duration.max ?? 0)) / 2
    : ((duration.min ?? 0) + (duration.mode ?? 0) + (duration.max ?? 0)) / 3;

  warnings.push(`QBP arrival distribution "${duration.type}" was converted to a fixed mean interval.`);

  return { type: 'fixed', interval };
}

function writeProcessConfig(document: XmlDocument, process: XmlElement, startDateTime: string): void {
  const extensionElements = ensureExtensionElements(document, process);
  const processConfig = ensureSimChild(document, extensionElements, 'processConfig');

  processConfig.setAttribute('startDateTime', startDateTime);
}

function writeResourceCatalog(
  document: XmlDocument,
  process: XmlElement,
  resources: SimulationResource[]
): void {
  const extensionElements = ensureExtensionElements(document, process);
  const existing = directChildElement(extensionElements, SIM_NS_URI, 'resourceCatalog');

  existing?.parentNode?.removeChild(existing);

  const catalog = createSimElement(document, 'resourceCatalog');

  for (const resource of resources) {
    const resourceElement = createSimElement(document, 'resource');

    resourceElement.setAttribute('id', resource.id);
    resourceElement.setAttribute('name', resource.name);
    setOptionalAttribute(resourceElement, 'capacity', resource.capacity);
    setOptionalAttribute(resourceElement, 'weekdays', serializeWeekdays(resource.weekdays));
    setOptionalAttribute(resourceElement, 'hourRanges', serializeHourRanges(resource.hourRanges));
    catalog.appendChild(resourceElement);
  }

  extensionElements.appendChild(catalog);
}

function writeStartEventConfig(document: XmlDocument, startEvent: XmlElement, arrival: ArrivalConfig): void {
  const extensionElements = ensureExtensionElements(document, startEvent);
  const config = ensureSimChild(document, extensionElements, 'startEventConfig');
  const arrivalElement = replaceSimChild(document, config, 'arrival');

  arrivalElement.setAttribute('type', arrival.type ?? 'fixed');
  setOptionalAttribute(arrivalElement, 'interval', arrival.interval);
  setOptionalAttribute(arrivalElement, 'mean', arrival.mean);
  setOptionalAttribute(arrivalElement, 'stddev', arrival.stddev);
  setOptionalAttribute(arrivalElement, 'min', arrival.min);
  setOptionalAttribute(arrivalElement, 'max', arrival.max);
  setOptionalAttribute(arrivalElement, 'lambda', arrival.lambda);
  setOptionalAttribute(arrivalElement, 'numberOfCases', arrival.numberOfCases);
  setOptionalAttribute(arrivalElement, 'weekdays', serializeWeekdays(arrival.weekdays));
  setOptionalAttribute(arrivalElement, 'hourRanges', serializeHourRanges(arrival.hourRanges));
}

function writeTaskConfig(
  document: XmlDocument,
  task: XmlElement,
  duration: DurationConfig,
  resourceId: string | undefined
): void {
  const extensionElements = ensureExtensionElements(document, task);
  const config = ensureSimChild(document, extensionElements, 'taskConfig');
  const durationElement = replaceSimChild(document, config, 'duration');

  durationElement.setAttribute('type', duration.type ?? 'fixed');
  setOptionalAttribute(durationElement, 'mean', duration.mean);
  setOptionalAttribute(durationElement, 'stddev', duration.stddev);
  setOptionalAttribute(durationElement, 'min', duration.min);
  setOptionalAttribute(durationElement, 'max', duration.max);
  setOptionalAttribute(durationElement, 'mode', duration.mode);
  setOptionalAttribute(durationElement, 'lambda', duration.lambda);

  if (resourceId) {
    const resourceElement = replaceSimChild(document, config, 'resource');

    resourceElement.setAttribute('id', resourceId);
  }
}

function writeSequenceFlowConfig(
  document: XmlDocument,
  sequenceFlow: XmlElement,
  probability: number
): void {
  const extensionElements = ensureExtensionElements(document, sequenceFlow);
  const config = ensureSimChild(document, extensionElements, 'sequenceFlowConfig');
  const branch = replaceSimChild(document, config, 'branch');

  branch.setAttribute('probability', String(probability));
}

function removeNumericProbabilityCondition(sequenceFlow: XmlElement): void {
  const condition = directChildElement(sequenceFlow, BPMN_NS_URI, 'conditionExpression');
  const body = condition?.textContent?.trim();

  if (body && Number.isFinite(Number(body))) {
    condition?.parentNode?.removeChild(condition);
  }
}

function findOwningProcess(document: XmlDocument, simulationInfo: XmlElement): XmlElement | undefined {
  for (const qbpElement of elementsByName(simulationInfo, QBP_NS_URI, 'element')) {
    const referenced = findElementById(document, attribute(qbpElement, 'elementId'));
    const process = referenced ? closestAncestor(referenced, BPMN_NS_URI, 'process') : undefined;

    if (process) {
      return process;
    }
  }

  return elementsByName(document, BPMN_NS_URI, 'process')[0];
}

function findElementById(document: XmlDocument, id: string | undefined): XmlElement | undefined {
  if (!id) {
    return undefined;
  }

  return elementsByName(document, '*', '*').find((element) => attribute(element, 'id') === id);
}

function closestAncestor(element: XmlElement, namespace: string, localName: string): XmlElement | undefined {
  let current: XmlNode | null = element;

  while (current) {
    if (current.nodeType === 1) {
      const currentElement = current as XmlElement;

      if (currentElement.namespaceURI === namespace && currentElement.localName === localName) {
        return currentElement;
      }
    }

    current = current.parentNode;
  }

  return undefined;
}

function ensureExtensionElements(document: XmlDocument, owner: XmlElement): XmlElement {
  const existing = directChildElement(owner, BPMN_NS_URI, 'extensionElements');

  if (existing) {
    return existing;
  }

  const extensionElements = document.createElementNS(BPMN_NS_URI, qualifiedBpmnName(owner, 'extensionElements'));
  const firstChild = owner.firstChild;

  if (firstChild) {
    owner.insertBefore(extensionElements, firstChild);
  } else {
    owner.appendChild(extensionElements);
  }

  return extensionElements;
}

function qualifiedBpmnName(owner: XmlElement, localName: string): string {
  return owner.prefix ? `${owner.prefix}:${localName}` : localName;
}

function ensureSimChild(document: XmlDocument, parent: XmlElement, localName: string): XmlElement {
  const existing = directChildElement(parent, SIM_NS_URI, localName);

  if (existing) {
    return existing;
  }

  const child = createSimElement(document, localName);

  parent.appendChild(child);

  return child;
}

function replaceSimChild(document: XmlDocument, parent: XmlElement, localName: string): XmlElement {
  const existing = directChildElement(parent, SIM_NS_URI, localName);

  existing?.parentNode?.removeChild(existing);

  const child = createSimElement(document, localName);

  parent.appendChild(child);

  return child;
}

function createSimElement(document: XmlDocument, localName: string): XmlElement {
  return document.createElementNS(SIM_NS_URI, `sim:${localName}`);
}

function directChildElement(
  parent: XmlElement,
  namespace: string,
  localName: string
): XmlElement | undefined {
  return directChildElements(parent, namespace, localName)[0];
}

function directChildElements(
  parent: XmlElement,
  namespace: string,
  localName: string
): XmlElement[] {
  const elements: XmlElement[] = [];

  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes.item(index);

    if (
      child?.nodeType === 1 &&
      (namespace === '*' || (child as XmlElement).namespaceURI === namespace) &&
      (localName === '*' || (child as XmlElement).localName === localName)
    ) {
      elements.push(child as XmlElement);
    }
  }

  return elements;
}

function elementsByName(
  parent: XmlDocument | XmlElement,
  namespace: string,
  localName: string
): XmlElement[] {
  const elements = namespace === '*'
    ? parent.getElementsByTagName(localName)
    : parent.getElementsByTagNameNS(namespace, localName);

  return Array.from({ length: elements.length }, (_, index) => elements.item(index))
    .filter((element): element is XmlElement => Boolean(element));
}

function firstElement(parent: XmlElement, namespace: string, localName: string): XmlElement | undefined {
  return elementsByName(parent, namespace, localName)[0];
}

function setOptionalAttribute(element: XmlElement, name: string, value: unknown): void {
  if (value !== undefined && value !== '') {
    element.setAttribute(name, String(value));
  }
}

function attribute(element: XmlElement, name: string): string | undefined {
  const value = element.getAttribute(name)?.trim();

  return value || undefined;
}

function numberAttribute(element: XmlElement, name: string): number | undefined {
  const value = attribute(element, name);
  const number = value === undefined ? undefined : Number(value);

  return number !== undefined && Number.isFinite(number) ? number : undefined;
}

function integerAttribute(element: XmlElement, name: string): number | undefined {
  const number = numberAttribute(element, name);

  return number === undefined ? undefined : Math.max(0, Math.floor(number));
}

function scaledParameter(element: XmlElement, name: string, scale: number): number | undefined {
  const value = numberAttribute(element, name);

  return value === undefined ? undefined : value * scale;
}

function timeUnitScale(distribution: XmlElement): number {
  const unit = firstElement(distribution, QBP_NS_URI, 'timeUnit')?.textContent?.trim().toLowerCase();

  if (unit?.startsWith('second')) {
    return 1 / 60;
  }

  if (unit?.startsWith('hour')) {
    return 60;
  }

  if (unit?.startsWith('day')) {
    return 1440;
  }

  return 1;
}

function weekdayRange(from: string | undefined, to: string | undefined): Weekday[] {
  const start = parseWeekday(from);
  const end = parseWeekday(to) ?? start;

  if (!start || !end) {
    return [];
  }

  const days: Weekday[] = [];
  let current = start;

  for (let count = 0; count < 7; count += 1) {
    days.push(current);

    if (current === end) {
      break;
    }

    current = ((current % 7) + 1) as Weekday;
  }

  return days;
}

function parseWeekday(value: string | undefined): Weekday | undefined {
  const weekdays: Record<string, Weekday> = {
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6,
    SUNDAY: 7
  };

  return value ? weekdays[value.toUpperCase()] : undefined;
}

function parseClockTime(value: string | undefined): { hours: number; minutes: number } | undefined {
  const match = value?.match(/^(\d{1,2}):(\d{2})/);

  if (!match) {
    return undefined;
  }

  return {
    hours: Math.max(0, Math.min(24, Number(match[1]))),
    minutes: Math.max(0, Math.min(59, Number(match[2])))
  };
}
