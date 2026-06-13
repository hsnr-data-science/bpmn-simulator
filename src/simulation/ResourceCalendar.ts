import type { HourRange, ResourceConfig, SimulationResource, Weekday } from '../types/simulation';

export const WEEKDAY_OPTIONS: Array<{ value: Weekday; label: string; longLabel: string }> = [
  { value: 1, label: 'Mo', longLabel: 'Montag' },
  { value: 2, label: 'Di', longLabel: 'Dienstag' },
  { value: 3, label: 'Mi', longLabel: 'Mittwoch' },
  { value: 4, label: 'Do', longLabel: 'Donnerstag' },
  { value: 5, label: 'Fr', longLabel: 'Freitag' },
  { value: 6, label: 'Sa', longLabel: 'Samstag' },
  { value: 7, label: 'So', longLabel: 'Sonntag' }
];

export const ALL_WEEKDAYS = WEEKDAY_OPTIONS.map((option) => option.value);
export const DEFAULT_WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];
export const DEFAULT_HOUR_RANGES: HourRange[] = [{ start: 8, end: 17 }];

const DAY_LABELS = new Map<string, Weekday>([
  ['mo', 1],
  ['mon', 1],
  ['montag', 1],
  ['di', 2],
  ['die', 2],
  ['tue', 2],
  ['dienstag', 2],
  ['mi', 3],
  ['wed', 3],
  ['mittwoch', 3],
  ['do', 4],
  ['don', 4],
  ['thu', 4],
  ['donnerstag', 4],
  ['fr', 5],
  ['fri', 5],
  ['freitag', 5],
  ['sa', 6],
  ['sat', 6],
  ['samstag', 6],
  ['so', 7],
  ['sun', 7],
  ['sonntag', 7]
]);

export function normalizeWeekdays(value: Array<number | Weekday> | undefined): Weekday[] {
  return [...new Set((value ?? [])
    .map((day) => Math.floor(Number(day)))
    .filter((day): day is Weekday => day >= 1 && day <= 7))]
    .sort((a, b) => a - b);
}

export function normalizeHourRanges(value: HourRange[] | undefined): HourRange[] {
  const ranges = (value ?? [])
    .map((range) => ({
      start: Math.max(0, Math.min(24, Math.floor(Number(range.start)))),
      end: Math.max(0, Math.min(24, Math.floor(Number(range.end))))
    }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start);

  const merged: HourRange[] = [];

  for (const range of ranges) {
    const last = merged.at(-1);

    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

export function parseWeekdays(value: string | undefined): Weekday[] {
  if (!value?.trim()) {
    return [];
  }

  const days: Weekday[] = [];

  for (const token of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const [start, end] = token.split('-').map((part) => parseWeekdayToken(part.trim()));

    if (start && end) {
      const from = Math.min(start, end);
      const to = Math.max(start, end);

      for (let day = from; day <= to; day += 1) {
        days.push(day as Weekday);
      }
    } else if (start) {
      days.push(start);
    }
  }

  return normalizeWeekdays(days);
}

export function parseHourRanges(value: string | undefined): HourRange[] {
  if (!value?.trim()) {
    return [];
  }

  const ranges: HourRange[] = [];
  const regex = /(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?/g;
  let match = regex.exec(value);

  while (match) {
    ranges.push({
      start: Number(match[1]),
      end: Number(match[2])
    });
    match = regex.exec(value);
  }

  return normalizeHourRanges(ranges);
}

export function serializeWeekdays(value: Weekday[] | undefined): string | undefined {
  const days = normalizeWeekdays(value);

  return days.length ? days.join(',') : undefined;
}

export function serializeHourRanges(value: HourRange[] | undefined): string | undefined {
  const ranges = normalizeHourRanges(value);

  return ranges.length ? ranges.map((range) => `${range.start}-${range.end}`).join(',') : undefined;
}

export function hoursToRanges(hours: number[]): HourRange[] {
  const sorted = [...new Set(hours
    .map((hour) => Math.floor(Number(hour)))
    .filter((hour) => hour >= 0 && hour <= 23))]
    .sort((a, b) => a - b);
  const ranges: HourRange[] = [];

  for (const hour of sorted) {
    const last = ranges.at(-1);

    if (last && hour === last.end) {
      last.end += 1;
    } else {
      ranges.push({ start: hour, end: hour + 1 });
    }
  }

  return ranges;
}

export function rangesToHours(ranges: HourRange[] | undefined): number[] {
  const hours: number[] = [];

  for (const range of normalizeHourRanges(ranges)) {
    for (let hour = range.start; hour < range.end; hour += 1) {
      hours.push(hour);
    }
  }

  return hours;
}

export function normalizeResourceSchedule(
  resource: Pick<SimulationResource, 'weekdays' | 'hourRanges'>,
  fallback: 'always' | 'businessHours' = 'always'
): Pick<SimulationResource, 'weekdays' | 'hourRanges'> {
  const weekdays = normalizeWeekdays(resource.weekdays).length
    ? normalizeWeekdays(resource.weekdays)
    : undefined;
  const hourRanges = normalizeHourRanges(resource.hourRanges).length
    ? normalizeHourRanges(resource.hourRanges)
    : undefined;
  const fallbackWeekdays = fallback === 'businessHours' ? DEFAULT_WEEKDAYS : ALL_WEEKDAYS;
  const fallbackHours = fallback === 'businessHours' ? DEFAULT_HOUR_RANGES : [{ start: 0, end: 24 }];
  const normalizedWeekdays = weekdays?.length ? weekdays : fallbackWeekdays;
  const normalizedHourRanges = hourRanges?.length ? hourRanges : fallbackHours;

  return {
    weekdays: normalizedWeekdays,
    hourRanges: normalizedHourRanges
  };
}

export function formatResourceCalendar(
  weekdays: Weekday[] | undefined,
  hourRanges: HourRange[] | undefined
): string {
  const days = normalizeWeekdays(weekdays);
  const ranges = normalizeHourRanges(hourRanges);

  return `${formatWeekdayList(days)} ${formatHourRangeList(ranges)}`.trim();
}

export function nextResourceAvailability(
  resource: Pick<ResourceConfig, 'weekdays' | 'hourRanges'> | undefined,
  time: number
): number {
  if (!resource || !hasCalendar(resource)) {
    return time;
  }

  if (isResourceAvailable(resource, time)) {
    return time;
  }

  const weekdays = getEffectiveWeekdays(resource);
  const hourRanges = getEffectiveHourRanges(resource);
  const baseDay = Math.floor(time / 24);

  for (let offset = 0; offset <= 14; offset += 1) {
    const absoluteDay = baseDay + offset;
    const weekday = dayOfWeek(absoluteDay * 24);

    if (!weekdays.includes(weekday)) {
      continue;
    }

    for (const range of hourRanges) {
      const candidate = absoluteDay * 24 + range.start;

      if (candidate >= time) {
        return candidate;
      }
    }
  }

  return time;
}

export function addWorkingTime(
  startTime: number,
  duration: number,
  resource: Pick<ResourceConfig, 'weekdays' | 'hourRanges'> | undefined
): number {
  if (!resource || !hasCalendar(resource) || duration <= 0) {
    return startTime + Math.max(0, duration);
  }

  let current = nextResourceAvailability(resource, startTime);
  let remaining = duration;

  while (remaining > 0) {
    const rangeEnd = currentAvailabilityEnd(resource, current);

    if (rangeEnd <= current) {
      current = nextResourceAvailability(resource, Math.floor(current / 24) * 24 + 24);
      continue;
    }

    const usable = Math.min(remaining, rangeEnd - current);
    current += usable;
    remaining -= usable;

    if (remaining > 0) {
      current = nextResourceAvailability(resource, current);
    }
  }

  return current;
}

export function isResourceAvailable(
  resource: Pick<ResourceConfig, 'weekdays' | 'hourRanges'>,
  time: number
): boolean {
  const weekday = dayOfWeek(time);
  const hour = hourOfDay(time);

  return getEffectiveWeekdays(resource).includes(weekday) &&
    getEffectiveHourRanges(resource).some((range) => hour >= range.start && hour < range.end);
}

function hasCalendar(resource: Pick<ResourceConfig, 'weekdays' | 'hourRanges'>): boolean {
  return Boolean(
    normalizeWeekdays(resource.weekdays).length ||
    normalizeHourRanges(resource.hourRanges).length
  );
}

function currentAvailabilityEnd(
  resource: Pick<ResourceConfig, 'weekdays' | 'hourRanges'>,
  time: number
): number {
  const weekday = dayOfWeek(time);
  const hour = hourOfDay(time);

  if (!getEffectiveWeekdays(resource).includes(weekday)) {
    return time;
  }

  const range = getEffectiveHourRanges(resource).find((item) => hour >= item.start && hour < item.end);

  return range ? Math.floor(time / 24) * 24 + range.end : time;
}

function getEffectiveWeekdays(
  resource: Pick<ResourceConfig, 'weekdays'>
): Weekday[] {
  const weekdays = normalizeWeekdays(resource.weekdays);

  if (weekdays.length) {
    return weekdays;
  }

  return ALL_WEEKDAYS;
}

function getEffectiveHourRanges(
  resource: Pick<ResourceConfig, 'hourRanges'>
): HourRange[] {
  const ranges = normalizeHourRanges(resource.hourRanges);

  if (ranges.length) {
    return ranges;
  }

  return [{ start: 0, end: 24 }];
}

function parseWeekdayToken(value: string | undefined): Weekday | undefined {
  if (!value) {
    return undefined;
  }

  const numeric = Number(value);

  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 7) {
    return numeric as Weekday;
  }

  return DAY_LABELS.get(value.toLowerCase());
}

function dayOfWeek(time: number): Weekday {
  const absoluteDay = Math.floor(Math.max(0, time) / 24);

  return ((absoluteDay % 7) + 1) as Weekday;
}

function hourOfDay(time: number): number {
  return ((time % 24) + 24) % 24;
}

function formatWeekdayList(weekdays: Weekday[]): string {
  const days = weekdays.length ? weekdays : ALL_WEEKDAYS;
  const ranges: string[] = [];
  let index = 0;

  while (index < days.length) {
    const start = days[index];
    let end = start;

    while (index + 1 < days.length && days[index + 1] === end + 1) {
      index += 1;
      end = days[index];
    }

    const startLabel = WEEKDAY_OPTIONS[start - 1].label;
    const endLabel = WEEKDAY_OPTIONS[end - 1].label;

    ranges.push(start === end ? startLabel : `${startLabel}-${endLabel}`);
    index += 1;
  }

  return ranges.join(',');
}

function formatHourRangeList(ranges: HourRange[]): string {
  const normalized = ranges.length ? ranges : [{ start: 0, end: 24 }];

  return normalized
    .map((range) => `${formatHour(range.start)}:00-${formatHour(range.end)}:00`)
    .join(',');
}

function formatHour(hour: number): string {
  return String(hour).padStart(2, '0');
}
