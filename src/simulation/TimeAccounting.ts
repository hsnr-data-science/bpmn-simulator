import type { ElementMetrics, ResourceMetrics } from '../types/simulation';

export type TimeAccountingMode =
  | 'includingOffTimetable'
  | 'excludingOffTimetable';

type TimeMetric = ElementMetrics | ResourceMetrics;

export function serviceTimeSamples(
  metric: TimeMetric,
  mode: TimeAccountingMode
): number[] {
  return mode === 'excludingOffTimetable'
    ? metric.serviceTimeSamplesExcludingOffTimetable ?? []
    : metric.serviceTimeSamples ?? [];
}

export function waitTimeSamples(
  metric: TimeMetric,
  mode: TimeAccountingMode
): number[] {
  return mode === 'excludingOffTimetable'
    ? metric.waitTimeSamplesExcludingOffTimetable ?? []
    : metric.waitTimeSamples ?? [];
}

export function totalServiceTime(
  metric: TimeMetric,
  mode: TimeAccountingMode
): number {
  return mode === 'excludingOffTimetable'
    ? metric.serviceTimeExcludingOffTimetable
    : metric.serviceTime;
}

export function totalWaitTime(
  metric: TimeMetric,
  mode: TimeAccountingMode
): number {
  return mode === 'excludingOffTimetable'
    ? metric.waitTimeExcludingOffTimetable
    : metric.waitTime;
}
