import BpmnModeler from 'bpmn-js/lib/Modeler';
import { BpmnPropertiesPanelModule, BpmnPropertiesProviderModule } from 'bpmn-js-properties-panel';
import { ChartNoAxesCombined, createIcons, Download, File, FilePlus, Pause, Play, Plus, RotateCcw, Square, StepBack, StepForward, Trash2, Upload, Workflow } from 'lucide';
import { buildBpmnGraph } from '../bpmn/BpmnGraphBuilder';
import { DEMO_MODELS, getDemoModel } from '../bpmn/demoModels';
import { emptyDiagram } from '../bpmn/emptyDiagram';
import { readResourceCatalog } from '../bpmn/ExtensionElementReader';
import { updateResourceCatalog } from '../bpmn/ExtensionElementWriter';
import { importQbpSimulationInfo } from '../bpmn/QbpSimulationImporter';
import simulationModdle from '../bpmn/simulationModdle.json';
import {
  DEFAULT_HOUR_RANGES,
  DEFAULT_WEEKDAYS,
  hoursToRanges,
  nextResourceAvailability,
  normalizeResourceSchedule,
  rangesToHours,
  WEEKDAY_OPTIONS
} from '../simulation/ResourceCalendar';
import { SimulationRunner } from '../simulation/SimulationRunner';
import {
  serviceTimeSamples,
  totalServiceTime,
  totalWaitTime,
  type TimeAccountingMode,
  waitTimeSamples
} from '../simulation/TimeAccounting';
import type { BpmnBusinessObject, BpmnDefinitions, BpmnElement, BpmnFactory, Modeling, SimModel, SimNode } from '../types/bpmn';
import type { ElementMetrics, ResourceMetrics, SimulationResource, SimulationResult, Weekday } from '../types/simulation';
import { SimulationPropertiesProviderModule } from '../properties/SimulationPropertiesProvider';
import { DesTokenSimulationModule } from '../visualization/DesTokenSimulationModule';
import { DesTokenAnimator } from '../visualization/DesTokenAnimator';
import { HeatmapOverlayManager } from '../visualization/HeatmapOverlayManager';
import { buildDashboardSeries, SimulationDashboard } from '../visualization/SimulationDashboard';
import { SimulationLogPanel } from '../visualization/SimulationLogPanel';
import { TokenOverlayManager } from '../visualization/TokenOverlayManager';

type Canvas = {
  zoom(mode: string): void;
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
  getRootElement(): BpmnElement;
  getContainer(): HTMLElement;
};

type Overlays = ConstructorParameters<typeof HeatmapOverlayManager>[0];

type EventBus = {
  on(event: string, callback: (event: { active?: boolean; newSelection?: BpmnElement[] }) => void): void;
  fire(event: string, payload?: Record<string, unknown>): void;
};

type ElementRegistry = {
  get(elementId: string): BpmnElement | undefined;
};

type ToggleMode = {
  _active?: boolean;
};

type ModelerWithDefinitions = BpmnModeler & {
  getDefinitions(): unknown;
};

type AppElements = {
  newDiagram: HTMLButtonElement;
  demoModel: HTMLSelectElement;
  emptyDiagram: HTMLButtonElement;
  importDiagram: HTMLButtonElement;
  exportDiagram: HTMLButtonElement;
  runSimulation: HTMLButtonElement;
  pauseSimulation: HTMLButtonElement;
  stepBackSimulation: HTMLButtonElement;
  stepForwardSimulation: HTMLButtonElement;
  stopSimulation: HTMLButtonElement;
  resetSimulation: HTMLButtonElement;
  addResource: HTMLButtonElement;
  exportJson: HTMLButtonElement;
  exportResultsCsv: HTMLButtonElement;
  exportEventLogCsv: HTMLButtonElement;
  modelerTab: HTMLButtonElement;
  dashboardTab: HTMLButtonElement;
  workspace: HTMLElement;
  dashboardView: HTMLElement;
  dashboardRoot: HTMLElement;
  leftResizer: HTMLElement;
  rightResizer: HTMLElement;
  fileInput: HTMLInputElement;
  seed: HTMLInputElement;
  simulationStartTime: HTMLInputElement;
  simulationEndTime: HTMLInputElement;
  simulationTimeDisplay: HTMLElement;
  simulationTimeMeta: HTMLElement;
  simulationTimeProgressFill: HTMLElement;
  simulationTimeProgressTicks: HTMLElement;
  simulationTimeStartLabel: HTMLElement;
  simulationTimeEndLabel: HTMLElement;
  animationSpeed: HTMLInputElement;
  animationSpeedValue: HTMLElement;
  timeAccountingButtons: HTMLButtonElement[];
  statusLine: HTMLElement;
  metricCompleted: HTMLElement;
  metricFailed: HTMLElement;
  metricAvgCycle: HTMLElement;
  metricP90Cycle: HTMLElement;
  resourceList: HTMLElement;
  bottleneckList: HTMLOListElement;
  pathList: HTMLOListElement;
  statsTable: HTMLElement;
  resourceStatsTable: HTMLElement;
  eventLogList: HTMLUListElement;
  warningList: HTMLUListElement;
  logList: HTMLUListElement;
};

export class ModelerApp {
  private readonly root: HTMLElement;
  private readonly modeler: ModelerWithDefinitions;
  private readonly canvas: Canvas;
  private readonly heatmapOverlays: HeatmapOverlayManager;
  private readonly tokenAnimator: DesTokenAnimator;
  private readonly dashboard: SimulationDashboard;
  private readonly eventLogPanel: SimulationLogPanel;
  private readonly warningPanel: SimulationLogPanel;
  private readonly elements: AppElements;
  private readonly runner = new SimulationRunner();
  private lastResult: SimulationResult | undefined;
  private displayedResult: SimulationResult | undefined;
  private selectedTaskId: string | undefined;
  private tokenSimulationActive = false;
  private simulationRunId = 0;
  private activeView: 'modeler' | 'dashboard' = 'modeler';
  private timeAccountingMode: TimeAccountingMode = 'includingOffTimetable';
  private estimatedSimulationEndTime: number | undefined;
  private simulationEndTimeExplicit = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = createShellMarkup();
    createAppIcons();

    this.modeler = new BpmnModeler({
      container: '#canvas',
      propertiesPanel: {
        parent: '#properties'
      },
      additionalModules: [
        DesTokenSimulationModule,
        BpmnPropertiesPanelModule,
        BpmnPropertiesProviderModule,
        SimulationPropertiesProviderModule
      ],
      moddleExtensions: {
        sim: simulationModdle
      }
    }) as ModelerWithDefinitions;

    this.canvas = this.modeler.get<Canvas>('canvas');

    const tokenOverlays = new TokenOverlayManager(this.canvas);
    this.heatmapOverlays = new HeatmapOverlayManager(
      this.modeler.get<Overlays>('overlays'),
      this.canvas,
      tokenOverlays
    );
    this.tokenAnimator = new DesTokenAnimator(
      this.canvas,
      this.modeler.get<ConstructorParameters<typeof DesTokenAnimator>[1]>('elementRegistry')
    );

    this.elements = this.collectElements();
    this.dashboard = new SimulationDashboard(this.elements.dashboardRoot);
    this.eventLogPanel = new SimulationLogPanel(this.elements.eventLogList, 'No events');
    this.warningPanel = new SimulationLogPanel(this.elements.warningList, 'No warnings');
    this.initializeSimulationTimes();
    this.bindEvents();
    this.bindTokenSimulationMode();
    this.bindSelection();
    this.bindCanvasSelectionFallback();
    this.bindSidebarResizers();
    this.updateAnimationSpeedLabel();
  }

  async start(): Promise<void> {
    await this.loadSelectedDemo();
  }

  private bindEvents(): void {
    this.elements.newDiagram.addEventListener('click', () => {
      void this.loadSelectedDemo();
    });

    this.elements.emptyDiagram.addEventListener('click', () => {
      void this.importDiagram(emptyDiagram, 'Empty model created');
    });

    this.elements.importDiagram.addEventListener('click', () => {
      this.elements.fileInput.click();
    });

    this.elements.fileInput.addEventListener('change', async () => {
      const file = this.elements.fileInput.files?.[0];

      if (!file) {
        return;
      }

      try {
        await this.importDiagram(await file.text(), `Model "${file.name}" loaded`);
      } catch (error) {
        this.showApplicationError(`File "${file.name}" could not be read`, error);
      } finally {
        this.elements.fileInput.value = '';
      }
    });

    this.elements.exportDiagram.addEventListener('click', async () => {
      try {
        const { xml } = await this.modeler.saveXML({ format: true });

        download('diagram.bpmn', xml, 'application/bpmn20-xml;charset=utf-8');
      } catch (error) {
        this.showApplicationError('BPMN export failed', error);
      }
    });

    this.elements.exportJson.addEventListener('click', () => {
      this.exportResult('json');
    });

    this.elements.exportResultsCsv.addEventListener('click', () => {
      this.exportResult('resultsCsv');
    });

    this.elements.exportEventLogCsv.addEventListener('click', () => {
      this.exportResult('eventLogCsv');
    });

    this.elements.modelerTab.addEventListener('click', () => {
      void this.switchView('modeler');
    });

    this.elements.dashboardTab.addEventListener('click', () => {
      void this.switchView('dashboard');
    });

    this.elements.runSimulation.addEventListener('click', () => {
      if (this.tokenAnimator.isRunning() && !this.tokenAnimator.isPlaying()) {
        this.tokenAnimator.resume();
        this.setStatus('Playback resumed');
        return;
      }

      void this.runSimulation();
    });

    this.elements.pauseSimulation.addEventListener('click', () => {
      this.tokenAnimator.pause();
      this.setStatus('Playback paused');
    });

    this.elements.stepBackSimulation.addEventListener('click', () => {
      this.tokenAnimator.stepBackward();
      this.setStatus('Playback stepped backward');
    });

    this.elements.stepForwardSimulation.addEventListener('click', () => {
      this.tokenAnimator.stepForward();
      this.setStatus('Playback stepped forward');
    });

    this.elements.stopSimulation.addEventListener('click', () => {
      this.simulationRunId += 1;
      this.tokenAnimator.stop();
      this.setStatus('Simulation stopped');
    });

    this.elements.resetSimulation.addEventListener('click', () => {
      this.simulationRunId += 1;
      this.clearSimulationState();
      this.updateCurrentSimulationTime();
      this.setStatus('Simulation reset');
    });

    this.elements.animationSpeed.addEventListener('input', () => {
      const speed = readAnimationSpeed(this.elements.animationSpeed);

      this.updateAnimationSpeedLabel();
      this.tokenAnimator.setSpeed(speed);
    });

    for (const button of this.elements.timeAccountingButtons) {
      button.addEventListener('click', () => {
        this.setTimeAccountingMode(
          button.dataset.timeAccounting === 'excludingOffTimetable'
            ? 'excludingOffTimetable'
            : 'includingOffTimetable'
        );
      });
    }

    this.elements.simulationStartTime.addEventListener('change', () => {
      this.estimatedSimulationEndTime = this.estimateCurrentSimulationEndTime();
      this.updateCurrentSimulationTime();
    });

    this.elements.simulationEndTime.addEventListener('change', () => {
      this.simulationEndTimeExplicit = Boolean(this.elements.simulationEndTime.value);
      this.estimatedSimulationEndTime = this.estimateCurrentSimulationEndTime();
      this.updateCurrentSimulationTime(this.displayedResult ?? this.lastResult);
    });

    this.elements.addResource.addEventListener('click', () => {
      try {
        this.addResource();
      } catch (error) {
        this.showApplicationError('Resource could not be added', error);
      }
    });

    this.elements.resourceList.addEventListener('input', (event) => {
      if ((event.target as HTMLInputElement).type === 'checkbox') {
        return;
      }

      try {
        this.persistResources(this.readResourcesFromEditor());
        this.setStatus('Resources saved');
      } catch (error) {
        this.showApplicationError('Resources could not be saved', error);
      }
    });

    this.elements.resourceList.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;

      if (target.type === 'checkbox') {
        ensureAtLeastOneSelection(target);
      }

      try {
        this.persistResources(this.readResourcesFromEditor());
        this.setStatus('Resources saved');
      } catch (error) {
        this.showApplicationError('Resources could not be saved', error);
      }
    });

    this.elements.resourceList.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-action="remove-resource"]');

      if (!button) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const index = Number(button.dataset.index);
      const resources = this.readResourcesFromEditor();

      if (!Number.isInteger(index) || index < 0 || index >= resources.length) {
        return;
      }

      try {
        resources.splice(index, 1);
        this.persistResources(resources);
        this.renderResources(resources);
        this.setStatus('Resource removed');
      } catch (error) {
        this.showApplicationError('Resource could not be removed', error);
      }
    });
  }

  private exportResult(kind: 'json' | 'resultsCsv' | 'eventLogCsv'): void {
    if (!this.lastResult) {
      return;
    }

    try {
      if (kind === 'resultsCsv') {
        download('des-simulation-results.csv', this.lastResult.exports.simulationResultsCsv, 'text/csv;charset=utf-8');
        return;
      }

      if (kind === 'eventLogCsv') {
        download('des-simulation-event-log.csv', this.lastResult.exports.eventLogCsv, 'text/csv;charset=utf-8');
        return;
      }

      download('des-simulation-results.json', this.lastResult.exports.json, 'application/json;charset=utf-8');
    } catch (error) {
      this.showApplicationError('Result export failed', error);
    }
  }

  private async loadSelectedDemo(): Promise<void> {
    const demo = getDemoModel(this.elements.demoModel.value);

    await this.importDiagram(demo.xml, `Demo model "${demo.name}" loaded`);
  }

  private async importDiagram(xml: string, successMessage = 'Diagram loaded'): Promise<void> {
    if (this.activeView === 'dashboard') {
      await this.switchView('modeler');
    }

    this.simulationRunId += 1;
    this.clearSimulationState();
    this.elements.resourceList.replaceChildren();
    this.elements.simulationEndTime.value = '';
    this.simulationEndTimeExplicit = false;
    this.dispatchResourceCatalogChanged();

    try {
      const qbpImport = importQbpSimulationInfo(xml);
      const importResult = await this.modeler.importXML(qbpImport.xml);
      this.canvas.zoom('fit-viewport');
      this.selectedTaskId = undefined;

      if (qbpImport.startDateTime) {
        const importedStart = new Date(qbpImport.startDateTime);

        if (!Number.isNaN(importedStart.getTime())) {
          this.elements.simulationStartTime.value = formatDateTimeLocal(importedStart);
        }
      }

      this.renderResources();
      this.estimatedSimulationEndTime = this.estimateCurrentSimulationEndTime();
      this.updateCurrentSimulationTime();
      this.dispatchResourceCatalogChanged();
      const importWarnings = [
        ...qbpImport.warnings,
        ...importResult.warnings.map(formatImportWarning)
      ];

      this.warningPanel.render(importWarnings.map((message) => ({
        level: 'warning',
        message
      })));
      this.setStatus(qbpImport.imported
        ? `${successMessage}; QBP simulation data imported (${qbpImport.summary.resources} resources, ${qbpImport.summary.taskConfigurations} activities, ${qbpImport.summary.sequenceFlows} flows)`
        : successMessage);
    } catch (error) {
      this.elements.resourceList.replaceChildren();
      this.dispatchResourceCatalogChanged();
      this.showApplicationError('BPMN import failed', error);
    }
  }

  private async runSimulation(): Promise<void> {
    const runId = ++this.simulationRunId;

    try {
      this.tokenAnimator.stop();
      const definitions = this.modeler.getDefinitions();
      const simModel = buildBpmnGraph(definitions as never);
      const animationSpeed = readAnimationSpeed(this.elements.animationSpeed);
      const simulationStart = this.readSimulationStartDate();
      const simulationEnd = this.readExplicitSimulationEndDate();
      const startTime = simulationOffsetHours(simulationStart);
      const maxSimulationTime = simulationEnd && simulationEnd.getTime() > simulationStart.getTime()
        ? startTime + hoursBetween(simulationStart, simulationEnd)
        : undefined;

      this.estimatedSimulationEndTime = estimateSimulationEndTime(simModel, startTime, maxSimulationTime);
      this.updateCurrentSimulationTime();

      const result = this.runner.run(simModel, {
        numberOfRuns: 1,
        randomSeed: readInteger(this.elements.seed, 42),
        maxSimulationTime,
        startTime,
        startDateTime: this.elements.simulationStartTime.value,
        endDateTime: simulationEnd ? this.elements.simulationEndTime.value : undefined,
        animationSpeed,
        collectTraces: this.isTokenSimulationActive()
      });

      this.lastResult = result;
      this.heatmapOverlays.clear();
      this.setExportButtons(true);

      if (this.isTokenSimulationActive()) {
        let lastResultRender = 0;
        let lastOverlayRender = 0;
        let lastStatusRender = 0;

        this.renderEmptyResults();
        this.setStatus(`Token visualization running at ${animationSpeed}x`);
        await this.tokenAnimator.play(result, animationSpeed, (progressResult) => {
          const now = performance.now();

          if (now - lastResultRender >= LIVE_RESULT_RENDER_INTERVAL_MS) {
            this.renderResults(progressResult);
            lastResultRender = now;
          }

          if (now - lastOverlayRender >= LIVE_OVERLAY_RENDER_INTERVAL_MS) {
            this.heatmapOverlays.render(progressResult, this.timeAccountingMode);
            lastOverlayRender = now;
          }

          if (now - lastStatusRender >= LIVE_STATUS_RENDER_INTERVAL_MS) {
            this.setStatus(
              `Token visualization t=${formatDurationHours(currentSimulationTime(progressResult))}, ${progressResult.completedCases}/${rootCaseCount(result)} cases`
            );
            lastStatusRender = now;
          }
        });

        if (runId !== this.simulationRunId) {
          return;
        }

        this.renderResults(result);
        this.heatmapOverlays.render(result, this.timeAccountingMode);
        this.setStatus(`${result.completedCases} cases completed and visualized`);
        return;
      }

      this.renderResults(result);
      this.heatmapOverlays.render(result, this.timeAccountingMode);
      this.setStatus(`${result.completedCases} cases completed`);
    } catch (error) {
      this.clearSimulationState();
      this.showApplicationError('Simulation failed', error);
    }
  }

  private clearSimulationState(): void {
    this.tokenAnimator.stop();
    this.heatmapOverlays.clear();
    this.lastResult = undefined;
    this.displayedResult = undefined;
    this.selectedTaskId = undefined;
    this.dashboard.clear();
    this.setExportButtons(false);
    this.renderEmptyResults();
  }

  private renderEmptyResults(): void {
    this.displayedResult = undefined;
    this.elements.metricCompleted.textContent = '-';
    this.elements.metricFailed.textContent = '-';
    this.elements.metricAvgCycle.textContent = '-';
    this.elements.metricP90Cycle.textContent = '-';
    this.elements.bottleneckList.replaceChildren();
    this.elements.pathList.replaceChildren();
    this.elements.statsTable.replaceChildren();
    this.elements.resourceStatsTable.replaceChildren();
    this.eventLogPanel.render([]);
    this.warningPanel.render([]);
    this.elements.logList.replaceChildren();
  }

  private addResource(): void {
    const resources = this.readResourcesFromModel();
    const nextIndex = getNextResourceIndex(resources);

    resources.push({
      id: `Resource_${nextIndex}`,
      name: `Resource ${nextIndex}`,
      capacity: 1,
      weekdays: [...DEFAULT_WEEKDAYS],
      hourRanges: [...DEFAULT_HOUR_RANGES]
    });

    this.persistResources(resources);
    this.renderResources(resources);
    this.setStatus('Resource added');
  }

  private renderResources(resources = this.readResourcesFromModel()): void {
    this.elements.resourceList.replaceChildren(
      ...resources.map((resource, index) => createResourceRow(resource, index))
    );
    createAppIcons();
  }

  private readResourcesFromModel(): SimulationResource[] {
    const process = this.getProcess();

    return readResourceCatalog(process);
  }

  private readResourcesFromEditor(): SimulationResource[] {
    return [...this.elements.resourceList.querySelectorAll<HTMLElement>('.resource-row')]
      .map((row) => ({
        id: readResourceField(row, 'id'),
        name: readResourceField(row, 'name'),
        capacity: readPositiveIntegerField(row, 'capacity'),
        weekdays: readSelectedWeekdays(row),
        hourRanges: hoursToRanges(readSelectedHours(row))
      }));
  }

  private persistResources(resources: SimulationResource[]): void {
    const process = this.getProcess();

    if (!process) {
      throw new Error('No bpmn:Process found in the current model. Resources cannot be saved.');
    }

    updateResourceCatalog(
      this.canvas.getRootElement(),
      process,
      resources,
      this.modeler.get<BpmnFactory>('bpmnFactory'),
      this.modeler.get<Modeling>('modeling')
    );
    this.dispatchResourceCatalogChanged();
  }

  private getProcess(): BpmnBusinessObject | undefined {
    const definitions = this.modeler.getDefinitions() as BpmnDefinitions;

    return definitions.rootElements?.find((root) => root.$type === 'bpmn:Process');
  }

  private renderResults(result: SimulationResult): void {
    this.displayedResult = result;
    this.elements.metricCompleted.textContent = `${result.completedCases}`;
    this.elements.metricFailed.textContent = `${result.failedCases}`;
    this.elements.metricAvgCycle.textContent = formatDurationHours(result.cycleTimeAverage);
    this.elements.metricP90Cycle.textContent = formatDurationHours(result.cycleTimeP90);

    this.renderBottlenecks(result.elementMetrics);
    this.renderPaths(result);
    this.renderResourceStats(result.resourceMetrics);
    this.renderStatsTable(result);
    this.updateCurrentSimulationTime(result);
    this.eventLogPanel.render(result.log);
    this.warningPanel.render(result.log.filter((entry) => entry.level !== 'info'));

    if (this.activeView === 'dashboard' && !this.tokenAnimator.isPlaying()) {
      void this.renderDashboard(result);
    }
  }

  private async switchView(view: 'modeler' | 'dashboard'): Promise<void> {
    this.activeView = view;
    const dashboardActive = view === 'dashboard';

    this.elements.workspace.hidden = dashboardActive;
    this.elements.dashboardView.hidden = !dashboardActive;
    this.elements.modelerTab.classList.toggle('is-active', !dashboardActive);
    this.elements.dashboardTab.classList.toggle('is-active', dashboardActive);
    this.elements.modelerTab.setAttribute('aria-selected', String(!dashboardActive));
    this.elements.dashboardTab.setAttribute('aria-selected', String(dashboardActive));

    if (dashboardActive) {
      const result = this.displayedResult ?? this.lastResult;

      if (result) {
        await this.renderDashboard(result);
      }

      requestAnimationFrame(() => this.dashboard.resize());
      return;
    }

    requestAnimationFrame(() => this.canvas.zoom('fit-viewport'));
  }

  private async renderDashboard(result: SimulationResult): Promise<void> {
    try {
      await this.dashboard.render(result);
    } catch (error) {
      this.showApplicationError('Dashboard rendering failed', error);
    }
  }

  private renderBottlenecks(metrics: ElementMetrics[]): void {
    const top = metrics
      .filter((metric) => metric.visits > 0 && isActivityMetricType(metric.type))
      .map((metric) => ({
        ...metric,
        avgWait: metric.visits
          ? totalWaitTime(metric, this.timeAccountingMode) / metric.visits
          : 0,
        avgService: metric.completions
          ? totalServiceTime(metric, this.timeAccountingMode) / metric.completions
          : 0
      }))
      .sort((a, b) => b.avgWait + b.avgService - (a.avgWait + a.avgService))
      .slice(0, 6);

    this.elements.bottleneckList.replaceChildren(
      ...top.map((metric) => {
        const item = document.createElement('li');
        item.innerHTML = `
          <span>${escapeHtml(metric.name)}</span>
          <strong>${formatDurationMinutes(metric.avgWait + metric.avgService)}</strong>
          <small>Wait+Service avg: W ${formatDurationMinutes(metric.avgWait)}, S ${formatDurationMinutes(metric.avgService)} · ${metric.visits} visits, ${metric.errors} errors</small>
        `;
        return item;
      })
    );
  }

  private renderPaths(result: SimulationResult): void {
    const top = result.flowMetrics.slice(0, 6);

    this.elements.pathList.replaceChildren(
      ...top.map((metric) => {
        const item = document.createElement('li');
        item.innerHTML = `
          <span>${escapeHtml(metric.name)}</span>
          <strong>${metric.count}</strong>
          <small>sequence flow</small>
        `;
        return item;
      })
    );
  }

  private renderResourceStats(metrics: ResourceMetrics[]): void {
    this.elements.resourceStatsTable.replaceChildren(
      ...metrics.map((metric) => {
        const card = document.createElement('article');
        const service = describeSamples(
          serviceTimeSamples(metric, this.timeAccountingMode),
          formatDurationMinutes
        );
        const wait = describeSamples(
          waitTimeSamples(metric, this.timeAccountingMode),
          formatDurationMinutes
        );

        card.className = 'sidebar-stat-card';
        card.innerHTML = `
          <header>
            <strong>${escapeHtml(metric.name || metric.resourceId)}</strong>
            <span>${formatPercent(metric.utilization ?? 0)} utilization</span>
          </header>
          ${createStatFactsHtml([
            ['Tasks', metric.taskCount],
            ['Errors', metric.errors]
          ])}
          ${createTimeStatisticsTable(service, wait)}
        `;

        return card;
      })
    );
  }

  private renderStatsTable(result: SimulationResult): void {
    const selectedTaskMetric = this.selectedTaskId
      ? result.elementMetrics.find((metric) => metric.elementId === this.selectedTaskId)
      : undefined;
    const processSeries = buildDashboardSeries(result, this.timeAccountingMode)
      .filter((series) => series.scope === 'process');
    const taskName = selectedTaskMetric?.name ??
      this.getElementLabel(this.selectedTaskId) ??
      this.selectedTaskId ??
      'Task';
    const serviceSamples = selectedTaskMetric
      ? serviceTimeSamples(selectedTaskMetric, this.timeAccountingMode)
      : processSeries.flatMap((series) => series.serviceSamples);
    const waitingSamples = selectedTaskMetric
      ? waitTimeSamples(selectedTaskMetric, this.timeAccountingMode)
      : processSeries.flatMap((series) => series.waitSamples);
    const service = describeSamples(serviceSamples, formatDurationMinutes);
    const wait = describeSamples(waitingSamples, formatDurationMinutes);
    const outputVariables = this.selectedTaskId
      ? collectOutputVariables(result, this.selectedTaskId)
      : [];
    const facts: Array<[string, string | number]> = selectedTaskMetric
      ? [
          ['Scope', `Task: ${taskName}`],
          ['Executions', selectedTaskMetric.visits],
          ['Errors', selectedTaskMetric.errors],
          ['Outputs', outputVariables.length ? outputVariables.join(', ') : '-']
        ]
      : [
          ['Scope', 'All processes'],
          ['Instances', result.cases.length],
          ['Completed', result.completedCases],
          ['Failed', result.failedCases],
          ['Avg cycle', formatDurationHours(result.cycleTimeAverage)],
          ['P90 cycle', formatDurationHours(result.cycleTimeP90)]
        ];

    this.elements.statsTable.innerHTML = `
      ${createStatFactsHtml(facts)}
      ${createTimeStatisticsTable(service, wait)}
    `;
  }

  private bindSelection(): void {
    const eventBus = this.modeler.get<EventBus>('eventBus');

    eventBus.on('selection.changed', (event) => {
      const selected = event.newSelection?.[0];

      this.selectedTaskId = selected && isTaskElement(selected) ? selected.id : undefined;
      this.renderCurrentStatsTable();
    });
  }

  private bindCanvasSelectionFallback(): void {
    const container = this.canvas.getContainer();
    const elementRegistry = this.modeler.get<ElementRegistry>('elementRegistry');

    container.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      const diagramElement = target?.closest<HTMLElement>('.djs-element[data-element-id]');

      if (!diagramElement) {
        if (target?.closest('#canvas')) {
          this.selectedTaskId = undefined;
          this.renderCurrentStatsTable();
        }

        return;
      }

      const element = elementRegistry.get(diagramElement.dataset.elementId ?? '');
      this.selectedTaskId = element && isTaskElement(element) ? element.id : undefined;
      this.renderCurrentStatsTable();
    });
  }

  private renderCurrentStatsTable(): void {
    const result = this.displayedResult ?? this.lastResult;

    if (result) {
      this.renderStatsTable(result);
    } else {
      this.elements.statsTable.replaceChildren();
    }
  }

  private bindSidebarResizers(): void {
    this.bindSidebarResizer(this.elements.leftResizer, 'left');
    this.bindSidebarResizer(this.elements.rightResizer, 'right');
  }

  private bindSidebarResizer(handle: HTMLElement, side: 'left' | 'right'): void {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();

      const panel = side === 'left' ? this.elements.workspace.querySelector<HTMLElement>('.simulation-panel') : this.elements.workspace.querySelector<HTMLElement>('.properties-panel');
      const startX = event.clientX;
      const startWidth = panel?.getBoundingClientRect().width ?? (side === 'left' ? 300 : 340);
      const minWidth = side === 'left' ? 220 : 260;
      const maxWidth = side === 'left' ? 560 : 620;

      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('is-resizing-sidebar');

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = side === 'left'
          ? clamp(startWidth + delta, minWidth, maxWidth)
          : clamp(startWidth - delta, minWidth, maxWidth);

        this.elements.workspace.style.setProperty(
          side === 'left' ? '--left-sidebar-width' : '--right-sidebar-width',
          `${Math.round(nextWidth)}px`
        );
      };
      const onUp = () => {
        document.body.classList.remove('is-resizing-sidebar');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  private initializeSimulationTimes(): void {
    this.elements.simulationStartTime.value = formatDateTimeLocal(getDefaultSimulationStart());
    this.elements.simulationEndTime.value = '';
    this.simulationEndTimeExplicit = false;
    this.updateCurrentSimulationTime();
  }

  private readSimulationStartDate(): Date {
    const parsed = readOptionalDateTimeLocal(this.elements.simulationStartTime);

    if (parsed) {
      return parsed;
    }

    const fallback = getDefaultSimulationStart();
    this.elements.simulationStartTime.value = formatDateTimeLocal(fallback);

    return fallback;
  }

  private estimateCurrentSimulationEndTime(): number | undefined {
    try {
      const model = buildBpmnGraph(this.modeler.getDefinitions() as never);
      const simulationStart = this.readSimulationStartDate();
      const simulationEnd = this.readExplicitSimulationEndDate();
      const startTime = simulationOffsetHours(simulationStart);
      const maxSimulationTime = simulationEnd && simulationEnd.getTime() > simulationStart.getTime()
        ? startTime + hoursBetween(simulationStart, simulationEnd)
        : undefined;

      return estimateSimulationEndTime(model, startTime, maxSimulationTime);
    } catch {
      return undefined;
    }
  }

  private readExplicitSimulationEndDate(): Date | undefined {
    if (!this.simulationEndTimeExplicit) {
      return undefined;
    }

    return readOptionalDateTimeLocal(this.elements.simulationEndTime);
  }

  private updateCurrentSimulationTime(result?: SimulationResult): void {
    const startDate = this.readSimulationStartDate();
    const configuredStartTime = result?.options.startTime ?? simulationOffsetHours(startDate);
    const firstTimelineTime = result?.timeline[0]?.simulationTime;
    const progressStartTime = firstTimelineTime !== undefined && Number.isFinite(firstTimelineTime)
      ? firstTimelineTime
      : configuredStartTime;
    const currentTime = result ? currentSimulationTime(result) : progressStartTime;
    const actualLastTime = result?.timeline.at(-1)?.simulationTime;
    const progressEndTime = Math.max(
      progressStartTime,
      currentTime,
      this.estimatedSimulationEndTime ?? configuredStartTime,
      actualLastTime ?? Number.NEGATIVE_INFINITY
    );
    const elapsedFromConfiguredStart = Math.max(0, currentTime - configuredStartTime);
    const startLabelElapsed = Math.max(0, progressStartTime - configuredStartTime);
    const endLabelElapsed = Math.max(0, progressEndTime - configuredStartTime);
    const range = Math.max(0.000001, progressEndTime - progressStartTime);
    const progress = Math.max(0, Math.min(1, (currentTime - progressStartTime) / range));

    this.elements.simulationTimeDisplay.textContent = formatDateTimeDisplay(addHours(startDate, elapsedFromConfiguredStart));
    this.elements.simulationTimeStartLabel.textContent = `Start: ${formatDateTimeDisplay(addHours(startDate, startLabelElapsed))}`;
    this.elements.simulationTimeEndLabel.textContent = `${this.simulationEndTimeExplicit ? 'End' : 'Estimated end'}: ${formatDateTimeDisplay(addHours(startDate, endLabelElapsed))}`;
    this.elements.simulationTimeMeta.textContent = result
      ? `${formatDurationHours(Math.max(0, currentTime - progressStartTime))} of ${formatDurationHours(range)} playback horizon`
      : 'Estimated horizon from Start Event arrivals plus 20% buffer';
    this.elements.simulationTimeProgressFill.style.width = `${progress * 100}%`;
    this.elements.simulationTimeProgressTicks.replaceChildren(
      ...createProgressTicks(progressStartTime, progressEndTime)
    );
  }

  private getElementLabel(elementId: string | undefined): string | undefined {
    if (!elementId) {
      return undefined;
    }

    const element = this.modeler.get<ElementRegistry>('elementRegistry').get(elementId);

    return element?.businessObject?.name || element?.businessObject?.id || element?.id;
  }

  private collectElements(): AppElements {
    return {
      newDiagram: getElement('new-diagram'),
      demoModel: getElement('demo-model'),
      emptyDiagram: getElement('empty-diagram'),
      importDiagram: getElement('import-diagram'),
      exportDiagram: getElement('export-diagram'),
      runSimulation: getElement('run-simulation'),
      pauseSimulation: getElement('pause-simulation'),
      stepBackSimulation: getElement('step-back-simulation'),
      stepForwardSimulation: getElement('step-forward-simulation'),
      stopSimulation: getElement('stop-simulation'),
      resetSimulation: getElement('reset-simulation'),
      addResource: getElement('add-resource'),
      exportJson: getElement('export-json'),
      exportResultsCsv: getElement('export-results-csv'),
      exportEventLogCsv: getElement('export-event-log-csv'),
      modelerTab: getElement('modeler-tab'),
      dashboardTab: getElement('dashboard-tab'),
      workspace: getElement('workspace'),
      dashboardView: getElement('dashboard-view'),
      dashboardRoot: getElement('dashboard-root'),
      leftResizer: getElement('left-sidebar-resizer'),
      rightResizer: getElement('right-sidebar-resizer'),
      fileInput: getElement('file-input'),
      seed: getElement('seed'),
      simulationStartTime: getElement('simulation-start-time'),
      simulationEndTime: getElement('simulation-end-time'),
      simulationTimeDisplay: getElement('simulation-time-display'),
      simulationTimeMeta: getElement('simulation-time-meta'),
      simulationTimeProgressFill: getElement('simulation-time-progress-fill'),
      simulationTimeProgressTicks: getElement('simulation-time-progress-ticks'),
      simulationTimeStartLabel: getElement('simulation-time-start-label'),
      simulationTimeEndLabel: getElement('simulation-time-end-label'),
      animationSpeed: getElement('animation-speed'),
      animationSpeedValue: getElement('animation-speed-value'),
      timeAccountingButtons: [
        ...this.root.querySelectorAll<HTMLButtonElement>('[data-time-accounting]')
      ],
      statusLine: getElement('status-line'),
      metricCompleted: getElement('metric-completed'),
      metricFailed: getElement('metric-failed'),
      metricAvgCycle: getElement('metric-avg-cycle'),
      metricP90Cycle: getElement('metric-p90-cycle'),
      resourceList: getElement('resource-list'),
      bottleneckList: getElement('bottleneck-list'),
      pathList: getElement('path-list'),
      statsTable: getElement('stats-table'),
      resourceStatsTable: getElement('resource-stats-table'),
      eventLogList: getElement('event-log-list'),
      warningList: getElement('warning-list'),
      logList: getElement('log-list')
    };
  }

  private setStatus(message: string): void {
    this.elements.statusLine.textContent = message;
  }

  private setExportButtons(enabled: boolean): void {
    this.elements.exportJson.disabled = !enabled;
    this.elements.exportResultsCsv.disabled = !enabled;
    this.elements.exportEventLogCsv.disabled = !enabled;
  }

  private showApplicationError(context: string, error: unknown): void {
    const detail = formatErrorDetail(error);

    console.error(context, error);
    this.setStatus(`${context}: ${detail.summary}`);
    this.warningPanel.render([
      {
        level: 'error',
        message: `${context}: ${detail.message}`
      }
    ]);
  }

  private dispatchResourceCatalogChanged(): void {
    const eventBus = this.modeler.get<EventBus>('eventBus');

    eventBus.fire('propertiesPanel.providersChanged');

    try {
      eventBus.fire('elements.changed', {
        elements: [this.canvas.getRootElement()]
      });
    } catch {
      // No root is available during the very first import.
    }
  }

  private bindTokenSimulationMode(): void {
    const eventBus = this.modeler.get<EventBus>('eventBus');
    const toggleMode = this.modeler.get<ToggleMode>('toggleMode');

    this.tokenSimulationActive = Boolean(toggleMode._active);

    eventBus.on('tokenSimulation.toggleMode', (event) => {
      this.tokenSimulationActive = Boolean(event.active);

      if (!this.tokenSimulationActive) {
        this.tokenAnimator.stop();
      }
    });
  }

  private isTokenSimulationActive(): boolean {
    return this.tokenSimulationActive;
  }

  private updateAnimationSpeedLabel(): void {
    this.elements.animationSpeedValue.textContent = `${readAnimationSpeed(this.elements.animationSpeed)}x`;
  }

  private setTimeAccountingMode(mode: TimeAccountingMode): void {
    this.timeAccountingMode = mode;

    for (const button of this.elements.timeAccountingButtons) {
      const active = button.dataset.timeAccounting === mode;

      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    this.dashboard.setTimeAccountingMode(mode);

    const result = this.displayedResult ?? this.lastResult;

    if (result) {
      this.renderResults(result);
      this.heatmapOverlays.render(result, mode);
    }
  }
}

const ANIMATION_SPEEDS = [1, 2, 4, 8, 16, 64, 256, 1024] as const;
const LIVE_RESULT_RENDER_INTERVAL_MS = 450;
const LIVE_OVERLAY_RENDER_INTERVAL_MS = 700;
const LIVE_STATUS_RENDER_INTERVAL_MS = 250;

function createShellMarkup(): string {
  return `
    <main class="app-shell">
      <header class="toolbar">
        <div class="toolbar-group">
          <button id="empty-diagram" class="icon-button" title="Create empty model" aria-label="Create empty model">
            <i data-lucide="file"></i>
          </button>
          <label class="demo-model-control">
            <span>Demo</span>
            <select id="demo-model">
              ${DEMO_MODELS.map((model) => `<option value="${model.id}">${model.name}</option>`).join('')}
            </select>
          </label>
          <button id="new-diagram" class="icon-button" title="Load selected demo model" aria-label="Load selected demo model">
            <i data-lucide="file-plus"></i>
          </button>
          <button id="import-diagram" class="icon-button" title="Import BPMN" aria-label="Import BPMN">
            <i data-lucide="upload"></i>
          </button>
          <button id="export-diagram" class="icon-button" title="Export BPMN" aria-label="Export BPMN">
            <i data-lucide="download"></i>
          </button>
        </div>
        <div class="toolbar-group run-controls">
          <label>
            <span>Seed</span>
            <input id="seed" type="number" min="1" step="1" value="42" />
          </label>
          <label class="datetime-control">
            <span>Start Time</span>
            <input id="simulation-start-time" class="datetime-input" type="datetime-local" />
          </label>
          <label class="datetime-control">
            <span>End Time</span>
            <input id="simulation-end-time" class="datetime-input" type="datetime-local" />
          </label>
          <button id="run-simulation" class="primary-button">
            <i data-lucide="play"></i>
            <span>Start</span>
          </button>
          <button id="pause-simulation" class="icon-button" title="Pause" aria-label="Pause">
            <i data-lucide="pause"></i>
          </button>
          <button id="step-back-simulation" class="icon-button" title="Step backward" aria-label="Step backward">
            <i data-lucide="step-back"></i>
          </button>
          <button id="step-forward-simulation" class="icon-button" title="Step forward" aria-label="Step forward">
            <i data-lucide="step-forward"></i>
          </button>
          <button id="stop-simulation" class="icon-button" title="Stop" aria-label="Stop">
            <i data-lucide="square"></i>
          </button>
          <button id="reset-simulation" class="icon-button" title="Reset" aria-label="Reset">
            <i data-lucide="rotate-ccw"></i>
          </button>
          <label class="speed-control">
            <span>Speed</span>
            <input id="animation-speed" type="range" min="0" max="7" step="1" value="0" list="animation-speed-marks" />
            <strong id="animation-speed-value">1x</strong>
          </label>
          <datalist id="animation-speed-marks">
            <option value="0" label="1x"></option>
            <option value="1" label="2x"></option>
            <option value="2" label="4x"></option>
            <option value="3" label="8x"></option>
            <option value="4" label="16x"></option>
            <option value="5" label="64x"></option>
            <option value="6" label="256x"></option>
            <option value="7" label="1024x"></option>
          </datalist>
          <div class="time-accounting-control" role="group" aria-label="Time accounting">
            <button type="button" class="is-active" data-time-accounting="includingOffTimetable" aria-pressed="true">
              Including off-hours
            </button>
            <button type="button" data-time-accounting="excludingOffTimetable" aria-pressed="false">
              Working hours only
            </button>
          </div>
        </div>
      </header>
      <section class="simulation-timebar" aria-label="Simulation time progress">
        <div class="simulation-timebar-main">
          <span class="simulation-timebar-caption">Simulation Time</span>
          <strong id="simulation-time-display">-</strong>
          <span id="simulation-time-meta">Estimated horizon from Start Event arrivals</span>
        </div>
        <div class="simulation-timebar-track" aria-hidden="true">
          <div id="simulation-time-progress-fill" class="simulation-timebar-fill"></div>
          <div id="simulation-time-progress-ticks" class="simulation-timebar-ticks"></div>
        </div>
        <div class="simulation-timebar-labels">
          <span id="simulation-time-start-label">-</span>
          <span id="simulation-time-end-label">-</span>
        </div>
      </section>
      <nav class="view-tabs" role="tablist" aria-label="Application views">
        <button id="modeler-tab" class="view-tab is-active" role="tab" aria-selected="true" aria-controls="workspace">
          <i data-lucide="workflow"></i>
          <span>Modeler</span>
        </button>
        <button id="dashboard-tab" class="view-tab" role="tab" aria-selected="false" aria-controls="dashboard-view">
          <i data-lucide="chart-no-axes-combined"></i>
          <span>Dashboard</span>
        </button>
      </nav>
      <section id="workspace" class="workspace view-panel" role="tabpanel" aria-labelledby="modeler-tab">
        <aside class="simulation-panel">
          <div class="panel-header">
            <h1>BPMN DES</h1>
            <p id="status-line">Ready</p>
          </div>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Overview</h2>
              </summary>
              <div class="metric-grid">
                <article>
                  <span>Completed</span>
                  <strong id="metric-completed">-</strong>
                </article>
                <article>
                  <span>Failed</span>
                  <strong id="metric-failed">-</strong>
                </article>
                <article>
                  <span>Avg CT</span>
                  <strong id="metric-avg-cycle">-</strong>
                </article>
                <article>
                  <span>P90 CT</span>
                  <strong id="metric-p90-cycle">-</strong>
                </article>
              </div>
            </details>
          </section>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Resources</h2>
              </summary>
              <div class="section-actions">
                <button id="add-resource" class="icon-button compact-button" title="Add resource" aria-label="Add resource">
                  <i data-lucide="plus"></i>
                </button>
              </div>
              <div id="resource-list" class="resource-list"></div>
            </details>
          </section>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Bottlenecks</h2>
              </summary>
              <ol id="bottleneck-list" class="rank-list"></ol>
            </details>
          </section>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Paths</h2>
              </summary>
              <ol id="path-list" class="rank-list"></ol>
            </details>
          </section>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Statistics</h2>
              </summary>
              <div id="stats-table" class="sidebar-stat-list"></div>
            </details>
          </section>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Resource Utilization</h2>
              </summary>
              <div id="resource-stats-table" class="sidebar-stat-list resource-stats-table"></div>
            </details>
          </section>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Event Log</h2>
              </summary>
              <ul id="event-log-list" class="warning-list event-log-list"></ul>
            </details>
          </section>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Warnings</h2>
              </summary>
              <ul id="warning-list" class="warning-list"></ul>
            </details>
          </section>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Export</h2>
              </summary>
              <div class="export-buttons">
                <button id="export-json" class="text-button" disabled>Full Simulation Log JSON</button>
                <button id="export-results-csv" class="text-button" disabled>Simulation Results CSV</button>
                <button id="export-event-log-csv" class="text-button" disabled>Event Log CSV</button>
              </div>
              <ul id="log-list" class="warning-list hidden-log"></ul>
            </details>
          </section>
        </aside>
        <div id="left-sidebar-resizer" class="sidebar-resizer left-sidebar-resizer" role="separator" aria-label="Resize left sidebar"></div>
        <section class="diagram-shell">
          <div id="canvas"></div>
        </section>
        <div id="right-sidebar-resizer" class="sidebar-resizer right-sidebar-resizer" role="separator" aria-label="Resize right sidebar"></div>
        <aside id="properties" class="properties-panel"></aside>
      </section>
      <section id="dashboard-view" class="dashboard-view view-panel" role="tabpanel" aria-labelledby="dashboard-tab" hidden>
        <div id="dashboard-root" class="dashboard-root"></div>
      </section>
      <input id="file-input" class="hidden-input" type="file" accept=".bpmn,.xml" />
    </main>
  `;
}

function createAppIcons(): void {
  createIcons({
    icons: {
      Download,
      File,
      FilePlus,
      ChartNoAxesCombined,
      Pause,
      Play,
      Plus,
      RotateCcw,
      Square,
      StepBack,
      StepForward,
      Trash2,
      Upload,
      Workflow
    }
  });
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Element #${id} not found.`);
  }

  return element as T;
}

function readInteger(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readAnimationSpeed(input: HTMLInputElement): number {
  const index = Math.max(0, Math.min(ANIMATION_SPEEDS.length - 1, Math.round(Number(input.value) || 0)));

  return ANIMATION_SPEEDS[index];
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

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '-';
  }

  return `${formatNumber(value * 100)}%`;
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

function currentSimulationTime(result: SimulationResult): number {
  if (result.currentTime !== undefined && Number.isFinite(result.currentTime)) {
    return result.currentTime;
  }

  return result.log.reduce((time, entry) => Math.max(time, entry.time ?? 0), 0);
}

function estimateSimulationEndTime(
  model: SimModel,
  startTime: number,
  configuredEndTime?: number
): number {
  if (configuredEndTime !== undefined && Number.isFinite(configuredEndTime)) {
    return Math.max(startTime, configuredEndTime);
  }

  const windows = model.startNodeIds
    .map((startNodeId) => model.nodes.get(startNodeId))
    .filter((node): node is SimNode => Boolean(node))
    .map((startNode) => estimateStartEventArrivalWindow(startNode, startTime))
    .filter((window): window is { first: number; last: number } => Boolean(window));

  if (!windows.length) {
    return startTime;
  }

  const first = Math.min(...windows.map((window) => window.first));
  const last = Math.max(...windows.map((window) => window.last));
  const span = Math.max(0, last - first);

  return first + span * 1.2;
}

function estimateStartEventArrivalWindow(
  startNode: SimNode,
  startTime: number
): { first: number; last: number } | undefined {
  const arrival = startNode.params.arrival;
  const eventTriggered = startNode.eventDefinitions?.some((definition) => {
    return definition.type === 'message' || definition.type === 'signal' || definition.type === 'timer';
  }) ?? false;

  if (
    startNode.kind !== 'startEvent' ||
    startNode.params.enabled === false ||
    arrival?.type === 'none' ||
    (eventTriggered && !arrival)
  ) {
    return undefined;
  }

  const numberOfCases = Math.max(1, Math.floor(arrival?.numberOfCases ?? 1));
  let first = nextResourceAvailability(normalizeResourceSchedule(arrival ?? {}, 'businessHours'), startTime);
  let last = first;

  for (let index = 1; index < numberOfCases; index += 1) {
    last = nextResourceAvailability(
      normalizeResourceSchedule(arrival ?? {}, 'businessHours'),
      last + arrivalDelayEstimateHours(arrival)
    );
  }

  return {
    first,
    last
  };
}

function arrivalDelayEstimateHours(arrival: SimNode['params']['arrival']): number {
  if (!arrival || arrival.type === 'none') {
    return 0;
  }

  if (arrival.type === 'fixed') {
    return minutesToHours(arrival.interval ?? arrival.mean ?? 1);
  }

  return minutesToHours(arrival.mean ?? arrival.interval ?? 1);
}

function createProgressTicks(startTime: number, endTime: number): HTMLElement[] {
  const duration = Math.max(0, endTime - startTime);

  if (duration <= 0) {
    return [];
  }

  const step = chooseProgressTickStep(duration);
  const ticks: HTMLElement[] = [];
  let offset = 0;

  while (offset <= duration + 1e-9) {
    ticks.push(createProgressTick(offset / duration, formatProgressTickLabel(offset, duration)));
    offset += step;
  }

  if (!ticks.length || Math.abs((offset - step) - duration) > step * 0.35) {
    ticks.push(createProgressTick(1, formatProgressTickLabel(duration, duration)));
  }

  return ticks;
}

function createProgressTick(position: number, label: string): HTMLElement {
  const tick = document.createElement('span');

  tick.className = 'simulation-timebar-tick';
  tick.style.left = `${Math.max(0, Math.min(1, position)) * 100}%`;
  tick.textContent = label;

  return tick;
}

function chooseProgressTickStep(durationHours: number): number {
  const candidates = durationHours <= 72
    ? [1, 2, 4, 6, 8, 12, 24]
    : [24, 48, 72, 168, 336, 720];

  return candidates.find((candidate) => durationHours / candidate <= 8) ?? candidates.at(-1) ?? 24;
}

function formatProgressTickLabel(offsetHours: number, durationHours: number): string {
  if (durationHours <= 72) {
    return formatDurationHours(offsetHours);
  }

  const days = Math.round(offsetHours / 24);

  return `${days}d`;
}

function minutesToHours(minutes: number): number {
  return Math.max(0, minutes) / 60;
}

function rootCaseCount(result: SimulationResult): number {
  return result.cases.filter((caseTrace) => caseTrace.trigger !== 'subProcess').length;
}

function collectOutputVariables(result: SimulationResult, elementId: string): string[] {
  const variables = new Set<string>();

  for (const caseTrace of result.cases) {
    const output = caseTrace.outputs[elementId];

    if (!output) {
      continue;
    }

    if (typeof output === 'object' && !Array.isArray(output)) {
      for (const key of Object.keys(output)) {
        variables.add(key);
      }
    } else {
      variables.add('value');
    }
  }

  return [...variables].sort();
}

function describeSamples(
  samples: number[],
  formatter: (value: number) => string = formatNumber
): Record<'min' | 'max' | 'median' | 'avg', string> {
  if (!samples.length) {
    return {
      min: '-',
      max: '-',
      median: '-',
      avg: '-'
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);

  return {
    min: formatter(sorted[0]),
    max: formatter(sorted[sorted.length - 1]),
    median: formatter(median(sorted)),
    avg: formatter(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
  };
}

function createStatFactsHtml(facts: Array<[string, string | number]>): string {
  return `
    <dl class="stat-facts">
      ${facts.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(String(value))}</dd>
        </div>
      `).join('')}
    </dl>
  `;
}

function createTimeStatisticsTable(
  service: Record<'min' | 'max' | 'median' | 'avg', string>,
  wait: Record<'min' | 'max' | 'median' | 'avg', string>
): string {
  const rows: Array<[string, keyof typeof service]> = [
    ['Min', 'min'],
    ['Max', 'max'],
    ['Average', 'avg'],
    ['Median', 'median']
  ];

  return `
    <table class="time-stat-table">
      <thead>
        <tr>
          <th>Statistic</th>
          <th>Service</th>
          <th>Waiting</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(([label, key]) => `
          <tr>
            <th>${label}</th>
            <td>${service[key]}</td>
            <td>${wait[key]}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function median(sortedValues: number[]): number {
  if (!sortedValues.length) {
    return 0;
  }

  const middle = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2) {
    return sortedValues[middle];
  }

  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getDefaultSimulationStart(now = new Date()): Date {
  const start = new Date(now);
  const day = start.getDay();
  const daysUntilNextMonday = (8 - day) % 7 || 7;

  start.setDate(start.getDate() + daysUntilNextMonday);
  start.setHours(8, 0, 0, 0);

  return start;
}

function readOptionalDateTimeLocal(input: HTMLInputElement): Date | undefined {
  if (!input.value) {
    return undefined;
  }

  const date = new Date(input.value);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDateTimeLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatDateTimeDisplay(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function hoursBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / (60 * 60 * 1000));
}

function simulationOffsetHours(date: Date): number {
  const weekdayIndex = (date.getDay() + 6) % 7;

  return weekdayIndex * 24 + date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

function isTaskElement(element: BpmnElement): boolean {
  const type = element.businessObject?.$type ?? '';

  return isActivityMetricType(type);
}

function isActivityMetricType(type: string): boolean {
  return /Task$/.test(type) || ['bpmn:SubProcess', 'bpmn:CallActivity', 'bpmn:Transaction'].includes(type);
}

function createResourceRow(resource: SimulationResource, index: number): HTMLElement {
  const row = document.createElement('details');
  const schedule = normalizeResourceSchedule(resource, 'businessHours');

  row.className = 'resource-row';
  row.dataset.index = String(index);
  row.innerHTML = `
    <summary class="resource-row-header">
      <strong>${escapeHtml(resource.name || resource.id)}</strong>
      <button class="icon-button compact-button" type="button" title="Remove resource" aria-label="Remove resource" data-action="remove-resource" data-index="${index}">
        <i data-lucide="trash-2"></i>
      </button>
    </summary>
    <div class="resource-row-body">
      <label>
        <span>ID</span>
        <input data-field="id" type="text" value="${escapeHtml(resource.id)}" />
      </label>
      <label>
        <span>Name</span>
        <input data-field="name" type="text" value="${escapeHtml(resource.name)}" />
      </label>
      <label>
        <span>Capacity</span>
        <input data-field="capacity" type="number" min="1" step="1" value="${resource.capacity ?? 1}" />
      </label>
      <div class="resource-calendar-block">
        <span>Days</span>
        <div class="weekday-selector">
          ${createWeekdaySelector(schedule.weekdays)}
        </div>
      </div>
      <div class="resource-calendar-block">
        <span>Hours</span>
        <div class="hour-selector">
          ${createHourSelector(schedule.hourRanges)}
        </div>
      </div>
    </div>
  `;

  return row;
}

function readResourceField(row: HTMLElement, field: keyof SimulationResource): string {
  const input = row.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);

  return input?.value.trim() ?? '';
}

function readPositiveIntegerField(row: HTMLElement, field: string): number | undefined {
  const input = row.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
  const value = Number(input?.value);

  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function createWeekdaySelector(selectedWeekdays = DEFAULT_WEEKDAYS): string {
  const selected = new Set(selectedWeekdays);

  return WEEKDAY_OPTIONS
    .map((day) => `
      <label class="calendar-chip">
        <input data-field="weekday" type="checkbox" value="${day.value}" ${selected.has(day.value) ? 'checked' : ''} />
        <span>${day.label}</span>
      </label>
    `)
    .join('');
}

function createHourSelector(selectedRanges = DEFAULT_HOUR_RANGES): string {
  const selected = new Set(rangesToHours(selectedRanges));

  return Array.from({ length: 24 }, (_, hour) => `
    <label class="calendar-chip hour-chip">
      <input data-field="hour" type="checkbox" value="${hour}" ${selected.has(hour) ? 'checked' : ''} />
      <span>${formatHourLabel(hour)}</span>
    </label>
  `).join('');
}

function readSelectedWeekdays(row: HTMLElement): Weekday[] {
  return [...row.querySelectorAll<HTMLInputElement>('input[data-field="weekday"]:checked')]
    .map((input) => Number(input.value) as Weekday);
}

function readSelectedHours(row: HTMLElement): number[] {
  return [...row.querySelectorAll<HTMLInputElement>('input[data-field="hour"]:checked')]
    .map((input) => Number(input.value));
}

function ensureAtLeastOneSelection(target: HTMLInputElement): void {
  const row = target.closest<HTMLElement>('.resource-row');
  const field = target.dataset.field;

  if (!row || (field !== 'weekday' && field !== 'hour')) {
    return;
  }

  const checked = row.querySelectorAll<HTMLInputElement>(`input[data-field="${field}"]:checked`);

  if (!checked.length) {
    target.checked = true;
  }
}

function formatHourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}-${String(hour + 1).padStart(2, '0')}`;
}

function getNextResourceIndex(resources: SimulationResource[]): number {
  const used = new Set(resources.map((resource) => resource.id));
  let index = resources.length + 1;

  while (used.has(`Resource_${index}`)) {
    index += 1;
  }

  return index;
}

function download(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = fileName;
  anchor.click();

  URL.revokeObjectURL(url);
}

function formatErrorDetail(error: unknown): { summary: string; message: string } {
  if (error instanceof Error) {
    const stackLine = error.stack
      ?.split('\n')
      .map((line) => line.trim())
      .find((line) => line && line !== error.name && !line.startsWith(`${error.name}: ${error.message}`));
    const summary = error.message || error.name || 'Unknown error';

    return {
      summary,
      message: stackLine ? `${error.name}: ${summary} (${stackLine})` : `${error.name}: ${summary}`
    };
  }

  if (typeof error === 'string') {
    return {
      summary: error,
      message: error
    };
  }

  try {
    const message = JSON.stringify(error);

    return {
      summary: message || 'Unknown error',
      message: message || 'Unknown error'
    };
  } catch {
    return {
      summary: 'Unknown error',
      message: String(error)
    };
  }
}

function formatImportWarning(warning: unknown): string {
  if (warning && typeof warning === 'object') {
    const message = (warning as { message?: unknown }).message;

    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }

  return formatErrorDetail(warning).message;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
