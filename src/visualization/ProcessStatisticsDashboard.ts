import {
  serviceTimeSamples,
  type TimeAccountingMode,
  waitTimeSamples
} from '../simulation/TimeAccounting';
import type { EventLogDataset, EventLogRecord } from '../types/eventLog';
import type { ElementMetrics, SimulationResult } from '../types/simulation';
import {
  buildDashboardSeries,
  buildDashboardSeriesFromEventLog,
  eventLogProcessInstanceCount,
  type DashboardSeries
} from './SimulationDashboard';

export class ProcessStatisticsDashboard {
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.clear();
  }

  render(result: SimulationResult, mode: TimeAccountingMode): void {
    this.root.innerHTML = `
      <header class="dashboard-header">
        <div>
          <h1>Process Statistics</h1>
          <p>Simulation summary, process metrics, activity metrics and resource utilization</p>
        </div>
      </header>
      <div class="process-statistics-layout">
        <section class="process-statistics-section">
          <h2>Simulation</h2>
          ${createFacts([
            ['Start', simulationStartLabel(result)],
            ['End', simulationEndLabel(result)],
            ['Process Instances', result.cases.length],
            ['Completed', result.completedCases],
            ['Failed', result.failedCases],
            ['Avg Cycle Time', formatDurationHours(result.cycleTimeAverage)],
            ['P90 Cycle Time', formatDurationHours(result.cycleTimeP90)],
            ['Unconsumed Tokens', result.unconsumedTokens]
          ])}
        </section>
        <section class="process-statistics-section">
          <h2>Processes</h2>
          ${createSeriesTable(processRows(result, mode))}
        </section>
        <section class="process-statistics-section">
          <h2>Activities</h2>
          ${createActivityTable(activityRows(result, mode))}
        </section>
        <section class="process-statistics-section">
          <h2>Resources</h2>
          ${createResourceTable(resourceRows(result, mode))}
        </section>
        <section class="process-statistics-section">
          <h2>Bottlenecks</h2>
          ${createBottlenecks(result, mode)}
        </section>
        <section class="process-statistics-section">
          <h2>Paths</h2>
          ${createPaths(result)}
        </section>
      </div>
    `;
  }

  renderEventLog(dataset: EventLogDataset): void {
    const series = buildDashboardSeriesFromEventLog(dataset);
    const counts = eventLogCounts(dataset);
    const recordsWithDuration = dataset.records.filter(hasDuration);

    this.root.innerHTML = `
      <header class="dashboard-header">
        <div>
          <h1>Process Statistics</h1>
          <p>Event-log summary, process metrics, activity metrics and resource metrics</p>
        </div>
      </header>
      <div class="process-statistics-layout">
        <section class="process-statistics-section">
          <h2>Event Log</h2>
          ${createFacts([
            ['Source', dataset.sourceName],
            ['Imported', formatDateTime(dataset.importedAt)],
            ['Records', dataset.records.length],
            ['Activities', counts.activityLabels.size],
            ['Resources', counts.resourceLabels.size],
            ['Process Instances', eventLogProcessInstanceCount(dataset)],
            ['Start', eventLogStartLabel(dataset)],
            ['End', eventLogEndLabel(dataset)]
          ])}
        </section>
        <section class="process-statistics-section">
          <h2>Processes</h2>
          ${createSeriesTable(eventLogSeriesRows(series, 'process', counts.processCounts))}
        </section>
        <section class="process-statistics-section">
          <h2>Activities</h2>
          ${createActivityTable(eventLogSeriesRows(series, 'task', counts.activityCounts))}
        </section>
        <section class="process-statistics-section">
          <h2>Resources</h2>
          ${createResourceTable(eventLogSeriesRows(series, 'resource', counts.resourceCounts))}
        </section>
        <section class="process-statistics-section">
          <h2>Bottlenecks</h2>
          ${createSeriesBottlenecks(series.filter((entry) => entry.scope === 'task'))}
        </section>
        <section class="process-statistics-section">
          <h2>Paths</h2>
          ${createEventLogPaths(recordsWithDuration)}
        </section>
      </div>
    `;
  }

  clear(): void {
    this.root.innerHTML = `
      <header class="dashboard-header">
        <div>
          <h1>Process Statistics</h1>
          <p>Simulation summary, process metrics, activity metrics and resource utilization</p>
        </div>
      </header>
      <p class="dashboard-empty">Run a simulation to populate process statistics.</p>
    `;
  }
}

type SeriesRow = {
  id: string;
  label: string;
  count: number | string;
  errors?: number | string;
  utilization?: string;
  service: StatSummary;
  wait: StatSummary;
};

type StatSummary = Record<'min' | 'max' | 'avg' | 'median', string>;

function processRows(result: SimulationResult, mode: TimeAccountingMode): SeriesRow[] {
  const series = buildDashboardSeries(result, mode).filter((entry) => entry.scope === 'process');
  const metrics = new Map(result.processMetrics.map((metric) => [metric.processId, metric]));

  return series.map((entry) => {
    const processId = entry.id.replace(/^process:/, '');
    const metric = metrics.get(processId);

    return {
      id: entry.id,
      label: entry.label.replace(/^Process:\s*/, ''),
      count: metric?.instanceCount ?? entry.serviceSamples.length,
      errors: metric ? metric.failedInstances : '-',
      service: summarize(entry.serviceSamples, formatDurationMinutes),
      wait: summarize(entry.waitSamples, formatDurationMinutes)
    };
  });
}

function activityRows(result: SimulationResult, mode: TimeAccountingMode): SeriesRow[] {
  return result.elementMetrics
    .filter((metric) => isActivityMetric(metric))
    .map((metric) => ({
      id: metric.elementId,
      label: metric.name || metric.elementId,
      count: metric.visits,
      errors: metric.errors,
      service: summarize(serviceTimeSamples(metric, mode), formatDurationMinutes),
      wait: summarize(waitTimeSamples(metric, mode), formatDurationMinutes)
    }));
}

function resourceRows(result: SimulationResult, mode: TimeAccountingMode): SeriesRow[] {
  return result.resourceMetrics.map((metric) => ({
    id: metric.resourceId,
    label: metric.name || metric.resourceId,
    count: metric.taskCount,
    errors: metric.errors,
    utilization: formatPercent(metric.utilization ?? 0),
    service: summarize(serviceTimeSamples(metric, mode), formatDurationMinutes),
    wait: summarize(waitTimeSamples(metric, mode), formatDurationMinutes)
  }));
}

function eventLogSeriesRows(
  series: DashboardSeries[],
  scope: DashboardSeries['scope'],
  counts: Map<string, number>
): SeriesRow[] {
  return series
    .filter((entry) => entry.scope === scope)
    .map((entry) => ({
      id: entry.id,
      label: entry.label.replace(/^(Process|Task|Resource):\s*/, ''),
      count: counts.get(entry.id) ?? entry.serviceSamples.length,
      errors: '-',
      utilization: scope === 'resource' ? '-' : undefined,
      service: summarize(entry.serviceSamples, formatDurationMinutes),
      wait: summarize(entry.waitSamples, formatDurationMinutes)
    }));
}

function createSeriesTable(rows: SeriesRow[]): string {
  if (!rows.length) {
    return '<p class="dashboard-empty compact-empty">No process metrics available.</p>';
  }

  return createMetricTable(rows, ['Name', 'Instances', 'Errors']);
}

function createActivityTable(rows: SeriesRow[]): string {
  if (!rows.length) {
    return '<p class="dashboard-empty compact-empty">No activity metrics available.</p>';
  }

  return createMetricTable(rows, ['Activity', 'Executions', 'Errors']);
}

function createResourceTable(rows: SeriesRow[]): string {
  if (!rows.length) {
    return '<p class="dashboard-empty compact-empty">No resource metrics available.</p>';
  }

  return createMetricTable(rows, ['Resource', 'Tasks', 'Errors', 'Utilization']);
}

function createMetricTable(rows: SeriesRow[], labels: string[]): string {
  const includeUtilization = labels.includes('Utilization');

  return `
    <div class="process-statistics-table-wrap">
      <table class="process-statistics-table">
        <thead>
          <tr>
            <th>${labels[0]}</th>
            <th>${labels[1]}</th>
            <th>${labels[2]}</th>
            ${includeUtilization ? '<th>Utilization</th>' : ''}
            <th colspan="4">Service Time</th>
            <th colspan="4">Waiting Time</th>
          </tr>
          <tr>
            <th></th>
            <th></th>
            <th></th>
            ${includeUtilization ? '<th></th>' : ''}
            <th>Min</th>
            <th>Max</th>
            <th>Avg</th>
            <th>Median</th>
            <th>Min</th>
            <th>Max</th>
            <th>Avg</th>
            <th>Median</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <th title="${escapeHtml(row.id)}">${escapeHtml(row.label)}</th>
              <td>${escapeHtml(String(row.count))}</td>
              <td>${escapeHtml(String(row.errors ?? '-'))}</td>
              ${includeUtilization ? `<td>${escapeHtml(row.utilization ?? '-')}</td>` : ''}
              <td>${row.service.min}</td>
              <td>${row.service.max}</td>
              <td>${row.service.avg}</td>
              <td>${row.service.median}</td>
              <td>${row.wait.min}</td>
              <td>${row.wait.max}</td>
              <td>${row.wait.avg}</td>
              <td>${row.wait.median}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function createFacts(facts: Array<[string, string | number]>): string {
  return `
    <dl class="stat-facts process-statistics-facts">
      ${facts.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(String(value))}</dd>
        </div>
      `).join('')}
    </dl>
  `;
}

function createBottlenecks(result: SimulationResult, mode: TimeAccountingMode): string {
  const top = result.elementMetrics
    .filter((metric) => metric.visits > 0 && isActivityMetric(metric))
    .map((metric) => {
      const waits = waitTimeSamples(metric, mode);
      const services = serviceTimeSamples(metric, mode);
      const avgWait = average(waits);
      const avgService = average(services);

      return {
        name: metric.name || metric.elementId,
        visits: metric.visits,
        errors: metric.errors,
        avgWait,
        avgService,
        total: avgWait + avgService
      };
    })
    .sort((left, right) => right.total - left.total)
    .slice(0, 10);

  if (!top.length) {
    return '<p class="dashboard-empty compact-empty">No bottleneck candidates available.</p>';
  }

  return `
    <ol class="rank-list process-statistics-rank-list">
      ${top.map((metric) => `
        <li>
          <span>${escapeHtml(metric.name)}</span>
          <strong>${formatDurationMinutes(metric.total)}</strong>
          <small>Wait avg ${formatDurationMinutes(metric.avgWait)}, service avg ${formatDurationMinutes(metric.avgService)}, ${metric.visits} executions, ${metric.errors} errors</small>
        </li>
      `).join('')}
    </ol>
  `;
}

function createPaths(result: SimulationResult): string {
  if (!result.flowMetrics.length) {
    return '<p class="dashboard-empty compact-empty">No path metrics available.</p>';
  }

  return `
    <ol class="rank-list process-statistics-rank-list">
      ${result.flowMetrics.slice(0, 20).map((metric) => `
        <li>
          <span>${escapeHtml(metric.name)}</span>
          <strong>${metric.count}</strong>
          <small>Sequence flow ${escapeHtml(metric.flowId)}</small>
        </li>
      `).join('')}
    </ol>
  `;
}

function createSeriesBottlenecks(series: DashboardSeries[]): string {
  const top = series
    .map((entry) => {
      const avgWait = average(entry.waitSamples);
      const avgService = average(entry.serviceSamples);

      return {
        name: entry.label.replace(/^Task:\s*/, ''),
        visits: entry.serviceSamples.length,
        avgWait,
        avgService,
        total: avgWait + avgService
      };
    })
    .sort((left, right) => right.total - left.total)
    .slice(0, 10);

  if (!top.length) {
    return '<p class="dashboard-empty compact-empty">No bottleneck candidates available.</p>';
  }

  return `
    <ol class="rank-list process-statistics-rank-list">
      ${top.map((metric) => `
        <li>
          <span>${escapeHtml(metric.name)}</span>
          <strong>${formatDurationMinutes(metric.total)}</strong>
          <small>Wait avg ${formatDurationMinutes(metric.avgWait)}, service avg ${formatDurationMinutes(metric.avgService)}, ${metric.visits} executions</small>
        </li>
      `).join('')}
    </ol>
  `;
}

function createEventLogPaths(records: EventLogRecord[]): string {
  const transitions = new Map<string, { name: string; count: number }>();
  const recordsByCase = groupBy(records, (record) => record.caseId);

  for (const entries of recordsByCase.values()) {
    const sorted = [...entries].sort(compareEventLogRecords);

    for (let index = 0; index < sorted.length - 1; index += 1) {
      const from = sorted[index].activityName || sorted[index].activityId;
      const to = sorted[index + 1].activityName || sorted[index + 1].activityId;
      const key = `${from}\u0000${to}`;
      const current = transitions.get(key) ?? {
        name: `${from} -> ${to}`,
        count: 0
      };

      current.count += 1;
      transitions.set(key, current);
    }
  }

  const top = [...transitions.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 20);

  if (!top.length) {
    return '<p class="dashboard-empty compact-empty">No path metrics available.</p>';
  }

  return `
    <ol class="rank-list process-statistics-rank-list">
      ${top.map((metric) => `
        <li>
          <span>${escapeHtml(metric.name)}</span>
          <strong>${metric.count}</strong>
          <small>Directly-follows relation</small>
        </li>
      `).join('')}
    </ol>
  `;
}

function summarize(
  samples: number[],
  formatter: (value: number) => string
): StatSummary {
  if (!samples.length) {
    return {
      min: '-',
      max: '-',
      avg: '-',
      median: '-'
    };
  }

  const sorted = [...samples].sort((left, right) => left - right);

  return {
    min: formatter(sorted[0]),
    max: formatter(sorted[sorted.length - 1]),
    avg: formatter(average(sorted)),
    median: formatter(median(sorted))
  };
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(sortedValues: number[]): number {
  if (!sortedValues.length) {
    return 0;
  }

  const middle = Math.floor(sortedValues.length / 2);

  return sortedValues.length % 2
    ? sortedValues[middle]
    : (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

function isActivityMetric(metric: ElementMetrics): boolean {
  return /Task$/.test(metric.type) ||
    ['bpmn:SubProcess', 'bpmn:CallActivity', 'bpmn:Transaction'].includes(metric.type);
}

function eventLogCounts(dataset: EventLogDataset): {
  processCounts: Map<string, number>;
  activityCounts: Map<string, number>;
  resourceCounts: Map<string, number>;
  activityLabels: Set<string>;
  resourceLabels: Set<string>;
} {
  const processCounts = new Map<string, number>();
  const activityCounts = new Map<string, number>();
  const resourceCounts = new Map<string, number>();
  const activityLabels = new Set<string>();
  const resourceLabels = new Set<string>();

  for (const record of dataset.records.filter(hasDuration)) {
    const processId = record.processId || 'event-log';
    const resource = record.resource;

    increment(processCounts, `process:${processId}`);
    increment(activityCounts, `task:${record.activityId}`);
    activityLabels.add(record.activityName || record.activityId);

    if (resource) {
      increment(resourceCounts, `resource:${resource}`);
      resourceLabels.add(resource);
    }
  }

  return {
    processCounts,
    activityCounts,
    resourceCounts,
    activityLabels,
    resourceLabels
  };
}

function hasDuration(record: EventLogRecord): boolean {
  return Boolean(record.endTime && record.endTime.getTime() !== record.startTime.getTime());
}

function eventLogStartLabel(dataset: EventLogDataset): string {
  const first = dataset.records
    .map((record) => record.startTime)
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime())[0];

  return first ? formatDateTime(first) : '-';
}

function eventLogEndLabel(dataset: EventLogDataset): string {
  const last = dataset.records
    .map((record) => record.endTime ?? record.startTime)
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime())[0];

  return last ? formatDateTime(last) : '-';
}

function compareEventLogRecords(left: EventLogRecord, right: EventLogRecord): number {
  const startDifference = left.startTime.getTime() - right.startTime.getTime();

  if (startDifference) {
    return startDifference;
  }

  return left.sequence - right.sequence;
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const value of values) {
    const key = keyFor(value);
    const entries = grouped.get(key) ?? [];

    entries.push(value);
    grouped.set(key, entries);
  }

  return grouped;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function simulationStartLabel(result: SimulationResult): string {
  return formatDateTime(result.options.startDateTime ? new Date(result.options.startDateTime) : result.startedAt);
}

function simulationEndLabel(result: SimulationResult): string {
  const start = result.options.startDateTime ? new Date(result.options.startDateTime) : result.startedAt;
  const startOffset = result.options.startTime ?? 0;
  const currentTime = result.currentTime ?? result.timeline.at(-1)?.simulationTime ?? startOffset;

  return formatDateTime(new Date(start.getTime() + Math.max(0, currentTime - startOffset) * 60 * 60 * 1000));
}

function formatDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

function formatDurationHours(hours: number): string {
  return formatDurationMinutes(hours * 60);
}

function formatDurationMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) {
    return '-';
  }

  const sign = minutes < 0 ? '-' : '';
  const absolute = Math.abs(minutes);

  if (absolute === 0) {
    return '0m';
  }

  if (absolute < 10 && !Number.isInteger(absolute)) {
    return `${sign}${formatNumber(absolute)}m`;
  }

  const totalMinutes = Math.round(absolute);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const remainingMinutes = totalMinutes % 60;
  const parts = [
    days ? `${days}d` : undefined,
    hours ? `${hours}h` : undefined,
    remainingMinutes || (!days && !hours) ? `${remainingMinutes}m` : undefined
  ].filter(Boolean);

  return `${sign}${parts.join(' ')}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '-';
  }

  return `${formatNumber(value * 100)}%`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '-';
  }

  if (value >= 100) {
    return value.toFixed(0);
  }

  if (value >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
