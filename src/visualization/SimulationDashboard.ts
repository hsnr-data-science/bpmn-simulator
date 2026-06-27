import type { ElementMetrics, ResourceMetrics, SimulationLogEntry, SimulationResult } from '../types/simulation';
import { workingTimeBetween } from '../simulation/ResourceCalendar';
import {
  serviceTimeSamples,
  type TimeAccountingMode,
  waitTimeSamples
} from '../simulation/TimeAccounting';

type DashboardScope = 'all' | 'process' | 'task' | 'resource';
type DistributionPlotType = 'box' | 'violin';

export type DashboardSeries = {
  id: string;
  label: string;
  scope: Exclude<DashboardScope, 'all'>;
  serviceSamples: number[];
  waitSamples: number[];
};

type PlotlyApi = {
  react(
    element: HTMLElement,
    data: Array<Record<string, unknown>>,
    layout: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<void>;
  purge(element: HTMLElement): void;
  Plots: {
    resize(element: HTMLElement): void;
  };
};

const BAR_COLORS = [
  '#176b5b',
  '#4fa68d',
  '#8bc6b3',
  '#c7e7dc',
  '#265b8a',
  '#5e8fbd',
  '#9abadd',
  '#d2e1f0'
];

export class SimulationDashboard {
  private readonly root: HTMLElement;
  private readonly scopeSelect: HTMLSelectElement;
  private readonly plotTypeButtons: HTMLButtonElement[];
  private readonly summary: HTMLElement;
  private readonly barChart: HTMLElement;
  private readonly serviceBoxPlot: HTMLElement;
  private readonly waitBoxPlot: HTMLElement;
  private result?: SimulationResult;
  private plotly?: PlotlyApi;
  private plotType: DistributionPlotType = 'violin';
  private timeAccountingMode: TimeAccountingMode = 'includingOffTimetable';

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <header class="dashboard-header">
        <div>
          <h1>Simulation Dashboard</h1>
          <p>Service and wait time analysis in minutes</p>
        </div>
        <div class="dashboard-controls">
          <label class="dashboard-scope-control">
            <span>Scope</span>
            <select>
              <option value="all">All</option>
              <option value="process">Process</option>
              <option value="task">Tasks</option>
              <option value="resource">Resources</option>
            </select>
          </label>
          <div class="dashboard-plot-control">
            <span>Distribution</span>
            <div class="dashboard-segmented-control" role="group" aria-label="Distribution plot type">
              <button type="button" data-plot-type="box" aria-pressed="false">Box</button>
              <button type="button" class="is-active" data-plot-type="violin" aria-pressed="true">Violin</button>
            </div>
          </div>
        </div>
      </header>
      <div class="dashboard-summary"></div>
      <section class="dashboard-chart-section">
        <h2>Service and Wait Time Statistics</h2>
        <div class="dashboard-chart dashboard-bar-chart"></div>
      </section>
      <div class="dashboard-distribution-grid">
        <section class="dashboard-chart-section">
          <h2>Service Time Distribution</h2>
          <div class="dashboard-chart dashboard-service-box"></div>
        </section>
        <section class="dashboard-chart-section">
          <h2>Wait Time Distribution</h2>
          <div class="dashboard-chart dashboard-wait-box"></div>
        </section>
      </div>
    `;

    this.scopeSelect = requireElement(this.root, 'select');
    this.plotTypeButtons = [...this.root.querySelectorAll<HTMLButtonElement>('[data-plot-type]')];
    this.summary = requireElement(this.root, '.dashboard-summary');
    this.barChart = requireElement(this.root, '.dashboard-bar-chart');
    this.serviceBoxPlot = requireElement(this.root, '.dashboard-service-box');
    this.waitBoxPlot = requireElement(this.root, '.dashboard-wait-box');

    this.scopeSelect.addEventListener('change', () => {
      void this.renderCharts();
    });
    for (const button of this.plotTypeButtons) {
      button.addEventListener('click', () => {
        this.setPlotType(button.dataset.plotType === 'violin' ? 'violin' : 'box');
      });
    }

    this.renderEmpty();
  }

  async render(result: SimulationResult): Promise<void> {
    this.result = result;
    this.plotly = this.plotly ?? await loadPlotly();
    await this.renderCharts();
  }

  clear(): void {
    this.result = undefined;

    if (this.plotly) {
      this.plotly.purge(this.barChart);
      this.plotly.purge(this.serviceBoxPlot);
      this.plotly.purge(this.waitBoxPlot);
    }

    this.renderEmpty();
  }

  resize(): void {
    if (!this.plotly || !this.result) {
      return;
    }

    this.plotly.Plots.resize(this.barChart);
    this.plotly.Plots.resize(this.serviceBoxPlot);
    this.plotly.Plots.resize(this.waitBoxPlot);
  }

  setTimeAccountingMode(mode: TimeAccountingMode): void {
    this.timeAccountingMode = mode;
    void this.renderCharts();
  }

  private async renderCharts(): Promise<void> {
    if (!this.result || !this.plotly) {
      this.renderEmpty();
      return;
    }

    const allSeries = buildDashboardSeries(this.result, this.timeAccountingMode);
    const scope = this.scopeSelect.value as DashboardScope;
    const series = scope === 'all'
      ? allSeries
      : allSeries.filter((entry) => entry.scope === scope);

    this.renderSummary(series, processInstanceCount(this.result));
    this.clearEmptyPlaceholders();

    await Promise.all([
      this.plotly.react(
        this.barChart,
        createBarTraces(series),
        createBarLayout(series),
        PLOT_CONFIG
      ),
      this.plotly.react(
        this.serviceBoxPlot,
        createDistributionTraces(series, 'serviceSamples', this.plotType),
        createBoxLayout('Service time (minutes)'),
        PLOT_CONFIG
      ),
      this.plotly.react(
        this.waitBoxPlot,
        createDistributionTraces(series, 'waitSamples', this.plotType),
        createBoxLayout('Wait time (minutes)'),
        PLOT_CONFIG
      )
    ]);
  }

  private renderSummary(series: DashboardSeries[], processInstances: number): void {
    const serviceSamples = series.flatMap((entry) => entry.serviceSamples);
    const waitSamples = series.flatMap((entry) => entry.waitSamples);
    const serviceStats = sampleStats(serviceSamples);
    const waitStats = sampleStats(waitSamples);

    this.summary.innerHTML = `
      <div>
        <span>Process Instances</span>
        <strong>${processInstances}</strong>
      </div>
      <div>
        <span>Service Samples</span>
        <strong>${serviceSamples.length}</strong>
      </div>
      <div>
        <span>Service Median</span>
        <strong>${formatMinutes(serviceStats.median)}</strong>
      </div>
      <div>
        <span>Wait Median</span>
        <strong>${formatMinutes(waitStats.median)}</strong>
      </div>
    `;
  }

  private renderEmpty(): void {
    this.summary.innerHTML = `
      <div>
        <span>Status</span>
        <strong>No simulation results</strong>
      </div>
    `;
    this.barChart.innerHTML = '<p class="dashboard-empty">Run a simulation to populate the dashboard.</p>';
    this.serviceBoxPlot.innerHTML = '<p class="dashboard-empty">No service-time samples available.</p>';
    this.waitBoxPlot.innerHTML = '<p class="dashboard-empty">No wait-time samples available.</p>';
  }

  private clearEmptyPlaceholders(): void {
    for (const chart of [this.barChart, this.serviceBoxPlot, this.waitBoxPlot]) {
      chart.querySelector('.dashboard-empty')?.remove();
    }
  }

  private setPlotType(plotType: DistributionPlotType): void {
    this.plotType = plotType;

    for (const button of this.plotTypeButtons) {
      const active = button.dataset.plotType === plotType;

      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    void this.renderCharts();
  }
}

export function buildDashboardSeries(
  result: SimulationResult,
  mode: TimeAccountingMode = 'includingOffTimetable'
): DashboardSeries[] {
  const processSeries = buildProcessSeries(result, mode);
  const taskSeries = result.elementMetrics
    .filter((metric) => isActivityMetric(metric))
    .map((metric) => metricSeries(metric, mode));
  const resourceSeries = result.resourceMetrics.map((metric) => resourceSeriesEntry(metric, mode));

  return [...processSeries, ...taskSeries, ...resourceSeries];
}

function buildProcessSeries(result: SimulationResult, mode: TimeAccountingMode): DashboardSeries[] {
  const samples = buildProcessSamples(result, mode);
  const processMetrics = result.processMetrics?.length
    ? result.processMetrics
    : [{
        processId: 'process',
        name: result.processName || 'Process',
        instanceCount: result.cases.length,
        completedInstances: result.completedCases,
        failedInstances: result.failedCases
      }];

  return processMetrics
    .map((metric) => {
      const sample = samples.get(metric.processId);

      return {
        id: `process:${metric.processId}`,
        label: `Process: ${metric.name || metric.processId}`,
        scope: 'process' as const,
        serviceSamples: sample?.serviceSamples ?? [],
        waitSamples: sample?.waitSamples ?? []
      };
    })
    .filter((series) => series.serviceSamples.length || series.waitSamples.length);
}

function metricSeries(metric: ElementMetrics, mode: TimeAccountingMode): DashboardSeries {
  return {
    id: metric.elementId,
    label: `Task: ${metric.name || metric.elementId}`,
    scope: 'task',
    serviceSamples: [...serviceTimeSamples(metric, mode)],
    waitSamples: [...waitTimeSamples(metric, mode)]
  };
}

function resourceSeriesEntry(metric: ResourceMetrics, mode: TimeAccountingMode): DashboardSeries {
  return {
    id: metric.resourceId,
    label: `Resource: ${metric.name || metric.resourceId}`,
    scope: 'resource',
    serviceSamples: [...serviceTimeSamples(metric, mode)],
    waitSamples: [...waitTimeSamples(metric, mode)]
  };
}

function buildProcessSamples(
  result: SimulationResult,
  mode: TimeAccountingMode
): Map<string, { serviceSamples: number[]; waitSamples: number[] }> {
  const serviceByCase = new Map<number, number>();
  const waitByCase = new Map<number, number>();
  const enterQueues = new Map<string, number[]>();
  const startQueues = new Map<string, number[]>();
  const resources = new Map(result.resourceMetrics.map((metric) => [metric.resourceId, metric]));
  const caseProcessIds = new Map<number, string>();
  const casesByProcess = new Map<string, number[]>();
  const currentTime = currentSimulationTime(result);

  for (const caseTrace of result.cases) {
    if (caseTrace.startTime > currentTime) {
      continue;
    }

    const processId = processMetricIdForCase(result, caseTrace);
    const caseIds = casesByProcess.get(processId) ?? [];

    caseIds.push(caseTrace.id);
    casesByProcess.set(processId, caseIds);
    caseProcessIds.set(caseTrace.id, processId);
  }

  for (const entry of result.log) {
    if (
      entry.caseId === undefined ||
      !entry.elementId ||
      !caseProcessIds.has(entry.caseId)
    ) {
      continue;
    }

    const key = `${entry.caseId}:${entry.elementId}`;
    const time = entry.time ?? 0;

    if (entry.eventType === 'TOKEN_ENTER_ELEMENT') {
      pushQueue(enterQueues, key, time);
      continue;
    }

    if (entry.eventType === 'TASK_START') {
      const enterTime = shiftQueue(enterQueues, key) ?? time;
      const resource = entry.resourceId ? resources.get(entry.resourceId) : undefined;
      const waitTime = mode === 'excludingOffTimetable'
        ? entry.waitTimeExcludingOffTimetable ??
          workingTimeBetween(enterTime, time, resource) * 60
        : entry.waitTime ?? Math.max(0, time - enterTime) * 60;

      waitByCase.set(
        entry.caseId,
        normalizeMinutes((waitByCase.get(entry.caseId) ?? 0) + waitTime)
      );
      pushQueue(startQueues, key, time);
      continue;
    }

    if (entry.eventType === 'TASK_COMPLETE') {
      const startTime = shiftQueue(startQueues, key) ?? time;
      const resource = entry.resourceId ? resources.get(entry.resourceId) : undefined;
      const serviceTime = mode === 'excludingOffTimetable'
        ? entry.serviceTimeExcludingOffTimetable ??
          workingTimeBetween(startTime, time, resource) * 60
        : entry.serviceTime ?? Math.max(0, time - startTime) * 60;

      serviceByCase.set(
        entry.caseId,
        normalizeMinutes((serviceByCase.get(entry.caseId) ?? 0) + serviceTime)
      );
    }
  }

  return new Map([...casesByProcess.entries()].map(([processId, caseIds]) => [
    processId,
    {
      serviceSamples: caseIds.map((caseId) => serviceByCase.get(caseId) ?? 0),
      waitSamples: caseIds.map((caseId) => waitByCase.get(caseId) ?? 0)
    }
  ]));
}

function createBarTraces(series: DashboardSeries[]): Array<Record<string, unknown>> {
  const labels = series.map((entry) => entry.label);
  const definitions: Array<{
    name: string;
    sampleKey: 'serviceSamples' | 'waitSamples';
    statKey: keyof SampleStats;
  }> = [
    { name: 'Service Min', sampleKey: 'serviceSamples', statKey: 'min' },
    { name: 'Service Max', sampleKey: 'serviceSamples', statKey: 'max' },
    { name: 'Service Avg', sampleKey: 'serviceSamples', statKey: 'avg' },
    { name: 'Service Median', sampleKey: 'serviceSamples', statKey: 'median' },
    { name: 'Wait Min', sampleKey: 'waitSamples', statKey: 'min' },
    { name: 'Wait Max', sampleKey: 'waitSamples', statKey: 'max' },
    { name: 'Wait Avg', sampleKey: 'waitSamples', statKey: 'avg' },
    { name: 'Wait Median', sampleKey: 'waitSamples', statKey: 'median' }
  ];

  return definitions.map((definition, index) => ({
    type: 'bar',
    name: definition.name,
    x: labels,
    y: series.map((entry) => sampleStats(entry[definition.sampleKey])[definition.statKey]),
    marker: {
      color: BAR_COLORS[index]
    },
    hovertemplate: '%{x}<br>%{fullData.name}: %{y:.2f} min<extra></extra>'
  }));
}

function createDistributionTraces(
  series: DashboardSeries[],
  sampleKey: 'serviceSamples' | 'waitSamples',
  plotType: DistributionPlotType
): Array<Record<string, unknown>> {
  return series
    .filter((entry) => entry[sampleKey].length)
    .map((entry, index) => {
      const color = index % 2 ? '#5e8fbd' : '#176b5b';
      const lineColor = index % 2 ? '#265b8a' : '#0e5144';
      const common = {
        name: entry.label,
        y: entry[sampleKey],
        marker: {
          color,
          size: 4
        },
        line: {
          color: lineColor
        },
        hovertemplate: `${entry.label}<br>%{y:.2f} min<extra></extra>`
      };

      if (plotType === 'violin') {
        return {
          ...common,
          type: 'violin',
          points: 'outliers',
          box: {
            visible: true
          },
          meanline: {
            visible: true
          },
          spanmode: 'hard',
          scalemode: 'width'
        };
      }

      return {
        ...common,
        type: 'box',
        boxpoints: 'outliers',
        jitter: 0.25,
        pointpos: 0
      };
    });
}

function createBarLayout(series: DashboardSeries[]): Record<string, unknown> {
  return {
    autosize: true,
    height: Math.max(430, Math.min(720, 340 + series.length * 14)),
    barmode: 'group',
    bargap: 0.18,
    margin: {
      l: 60,
      r: 20,
      t: 20,
      b: series.length > 5 ? 150 : 100
    },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    font: {
      family: 'Inter, ui-sans-serif, system-ui, sans-serif',
      color: '#26302c',
      size: 12
    },
    xaxis: {
      tickangle: series.length > 3 ? -32 : 0,
      automargin: true,
      gridcolor: '#edf1ef'
    },
    yaxis: {
      title: 'Minutes',
      rangemode: 'tozero',
      gridcolor: '#dfe6e3',
      zerolinecolor: '#aebbb6'
    },
    legend: {
      orientation: 'h',
      y: 1.12,
      x: 0
    },
    hovermode: 'closest'
  };
}

function createBoxLayout(yAxisTitle: string): Record<string, unknown> {
  return {
    autosize: true,
    height: 430,
    margin: {
      l: 58,
      r: 18,
      t: 18,
      b: 130
    },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    showlegend: false,
    font: {
      family: 'Inter, ui-sans-serif, system-ui, sans-serif',
      color: '#26302c',
      size: 11
    },
    xaxis: {
      tickangle: -32,
      automargin: true,
      gridcolor: '#edf1ef'
    },
    yaxis: {
      title: yAxisTitle,
      rangemode: 'tozero',
      gridcolor: '#dfe6e3',
      zerolinecolor: '#aebbb6'
    }
  };
}

type SampleStats = {
  min: number;
  max: number;
  avg: number;
  median: number;
};

export function sampleStats(values: number[]): SampleStats {
  if (!values.length) {
    return {
      min: 0,
      max: 0,
      avg: 0,
      median: 0
    };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2
  };
}

function isActivityMetric(metric: ElementMetrics): boolean {
  return /Task$/.test(metric.type) ||
    ['bpmn:SubProcess', 'bpmn:CallActivity', 'bpmn:Transaction'].includes(metric.type);
}

function processInstanceCount(result: SimulationResult): number {
  const currentTime = currentSimulationTime(result);

  return result.cases.filter((caseTrace) => caseTrace.startTime <= currentTime).length;
}

function processMetricIdForCase(
  result: SimulationResult,
  caseTrace: SimulationResult['cases'][number]
): string {
  if (caseTrace.trigger === 'subProcess' && caseTrace.triggerElementId) {
    return caseTrace.triggerElementId;
  }

  if (caseTrace.processId) {
    return caseTrace.processId;
  }

  return result.processMetrics?.[0]?.processId ?? 'process';
}

function currentSimulationTime(result: SimulationResult): number {
  if (result.currentTime !== undefined && Number.isFinite(result.currentTime)) {
    return result.currentTime;
  }

  return result.log.reduce((time, entry) => Math.max(time, entry.time ?? 0), 0);
}

function pushQueue(map: Map<string, number[]>, key: string, value: number): void {
  const values = map.get(key) ?? [];

  values.push(value);
  map.set(key, values);
}

function shiftQueue(map: Map<string, number[]>, key: string): number | undefined {
  return map.get(key)?.shift();
}

function formatMinutes(value: number): string {
  return Number.isFinite(value) ? `${formatNumber(value)}m` : '-';
}

function normalizeMinutes(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function formatNumber(value: number): string {
  if (value >= 100) {
    return value.toFixed(0);
  }

  if (value >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Dashboard element "${selector}" not found.`);
  }

  return element;
}

const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d']
};

let plotlyPromise: Promise<PlotlyApi> | undefined;

async function loadPlotly(): Promise<PlotlyApi> {
  plotlyPromise = plotlyPromise ?? import('plotly.js-dist-min').then((module) => {
    return (module.default ?? module) as unknown as PlotlyApi;
  });

  return plotlyPromise;
}
