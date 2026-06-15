import BpmnModeler from 'bpmn-js/lib/Modeler';
import { BpmnPropertiesPanelModule, BpmnPropertiesProviderModule } from 'bpmn-js-properties-panel';
import { createIcons, Download, File, FilePlus, Play, Plus, RotateCcw, Square, Trash2, Upload } from 'lucide';
import { buildBpmnGraph } from '../bpmn/BpmnGraphBuilder';
import { defaultDiagram } from '../bpmn/defaultDiagram';
import { emptyDiagram } from '../bpmn/emptyDiagram';
import { readResourceCatalog } from '../bpmn/ExtensionElementReader';
import { updateResourceCatalog } from '../bpmn/ExtensionElementWriter';
import simulationModdle from '../bpmn/simulationModdle.json';
import {
  DEFAULT_HOUR_RANGES,
  DEFAULT_WEEKDAYS,
  hoursToRanges,
  normalizeResourceSchedule,
  rangesToHours,
  WEEKDAY_OPTIONS
} from '../simulation/ResourceCalendar';
import { SimulationRunner } from '../simulation/SimulationRunner';
import type { BpmnBusinessObject, BpmnDefinitions, BpmnElement, BpmnFactory, Modeling } from '../types/bpmn';
import type { ElementMetrics, ResourceMetrics, SimulationResource, SimulationResult, Weekday } from '../types/simulation';
import { SimulationPropertiesProviderModule } from '../properties/SimulationPropertiesProvider';
import { DesTokenSimulationModule } from '../visualization/DesTokenSimulationModule';
import { DesTokenAnimator } from '../visualization/DesTokenAnimator';
import { HeatmapOverlayManager } from '../visualization/HeatmapOverlayManager';
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
  emptyDiagram: HTMLButtonElement;
  importDiagram: HTMLButtonElement;
  exportDiagram: HTMLButtonElement;
  runSimulation: HTMLButtonElement;
  stopSimulation: HTMLButtonElement;
  resetSimulation: HTMLButtonElement;
  addResource: HTMLButtonElement;
  exportJson: HTMLButtonElement;
  exportResultsCsv: HTMLButtonElement;
  exportEventLogCsv: HTMLButtonElement;
  workspace: HTMLElement;
  leftResizer: HTMLElement;
  rightResizer: HTMLElement;
  fileInput: HTMLInputElement;
  caseCount: HTMLInputElement;
  seed: HTMLInputElement;
  simulationStartTime: HTMLInputElement;
  simulationEndTime: HTMLInputElement;
  simulationCurrentTime: HTMLInputElement;
  animationSpeed: HTMLInputElement;
  animationSpeedValue: HTMLElement;
  statusLine: HTMLElement;
  metricCompleted: HTMLElement;
  metricFailed: HTMLElement;
  metricAvgCycle: HTMLElement;
  metricP90Cycle: HTMLElement;
  resourceList: HTMLElement;
  bottleneckList: HTMLOListElement;
  pathList: HTMLOListElement;
  statsTable: HTMLTableSectionElement;
  resourceStatsTable: HTMLTableSectionElement;
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
  private readonly eventLogPanel: SimulationLogPanel;
  private readonly warningPanel: SimulationLogPanel;
  private readonly elements: AppElements;
  private readonly runner = new SimulationRunner();
  private lastResult: SimulationResult | undefined;
  private displayedResult: SimulationResult | undefined;
  private selectedTaskId: string | undefined;
  private tokenSimulationActive = false;
  private simulationRunId = 0;

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
    await this.importDiagram(defaultDiagram, 'Demo model loaded');
  }

  private bindEvents(): void {
    this.elements.newDiagram.addEventListener('click', () => {
      void this.importDiagram(defaultDiagram, 'Demo model loaded');
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

    this.elements.runSimulation.addEventListener('click', () => {
      void this.runSimulation();
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

    this.elements.simulationStartTime.addEventListener('change', () => {
      this.updateCurrentSimulationTime();
    });

    this.elements.simulationEndTime.addEventListener('change', () => {
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

  private async importDiagram(xml: string, successMessage = 'Diagram loaded'): Promise<void> {
    this.simulationRunId += 1;
    this.clearSimulationState();
    this.elements.resourceList.replaceChildren();
    this.dispatchResourceCatalogChanged();

    try {
      await this.modeler.importXML(xml);
      this.canvas.zoom('fit-viewport');
      this.selectedTaskId = undefined;
      this.renderResources();
      this.updateCurrentSimulationTime();
      this.dispatchResourceCatalogChanged();
      this.setStatus(successMessage);
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
      const simulationEnd = readOptionalDateTimeLocal(this.elements.simulationEndTime);
      const startTime = simulationOffsetHours(simulationStart);
      const maxSimulationTime = simulationEnd && simulationEnd.getTime() > simulationStart.getTime()
        ? startTime + hoursBetween(simulationStart, simulationEnd)
        : undefined;
      const numberOfRuns = readInteger(this.elements.caseCount, 250);

      this.updateCurrentSimulationTime();

      const result = this.runner.run(simModel, {
        numberOfRuns,
        randomSeed: readInteger(this.elements.seed, 42),
        maxSimulationTime,
        startTime,
        startDateTime: this.elements.simulationStartTime.value,
        endDateTime: this.elements.simulationEndTime.value || undefined,
        animationSpeed,
        collectTraces: true
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
            this.heatmapOverlays.render(progressResult);
            lastOverlayRender = now;
          }

          if (now - lastStatusRender >= LIVE_STATUS_RENDER_INTERVAL_MS) {
            this.setStatus(
              `Token visualization t=${formatDurationHours(currentSimulationTime(progressResult))}, ${progressResult.completedCases}/${result.cases.length} cases`
            );
            lastStatusRender = now;
          }
        });

        if (runId !== this.simulationRunId) {
          return;
        }

        this.renderResults(result);
        this.heatmapOverlays.render(result);
        this.setStatus(`${result.completedCases} cases completed and visualized`);
        return;
      }

      this.renderResults(result);
      this.heatmapOverlays.render(result);
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
  }

  private renderBottlenecks(metrics: ElementMetrics[]): void {
    const top = metrics
      .filter((metric) => metric.visits > 0 && isActivityMetricType(metric.type))
      .map((metric) => ({
        ...metric,
        avgWait: metric.visits ? metric.waitTime / metric.visits : 0,
        avgService: metric.completions ? metric.serviceTime / metric.completions : 0
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
        const row = document.createElement('tr');
        const nameCell = document.createElement('td');
        const valueCell = document.createElement('td');
        const service = describeSamples(metric.serviceTimeSamples ?? [], formatDurationMinutes);
        const wait = describeSamples(metric.waitTimeSamples ?? [], formatDurationMinutes);

        nameCell.textContent = metric.name || metric.resourceId;
        valueCell.innerHTML = `
          <strong>${metric.taskCount} tasks, ${metric.errors} errors · Utilization ${formatPercent(metric.utilization ?? 0)}</strong>
          <small>Service ${formatSampleDescription(service)}<br>Wait ${formatSampleDescription(wait)}</small>
        `;
        row.append(nameCell, valueCell);

        return row;
      })
    );
  }

  private renderStatsTable(result: SimulationResult): void {
    const selectedTaskMetric = this.selectedTaskId
      ? result.elementMetrics.find((metric) => metric.elementId === this.selectedTaskId)
      : undefined;
    const rows = this.selectedTaskId
      ? this.createTaskStatsRows(result, selectedTaskMetric)
      : createProcessStatsRows(result);

    this.elements.statsTable.replaceChildren(
      ...rows.map(([name, value]) => {
        const row = document.createElement('tr');
        const nameCell = document.createElement('td');
        const valueCell = document.createElement('td');

        nameCell.textContent = name;
        valueCell.textContent = String(value);
        row.append(nameCell, valueCell);

        return row;
      })
    );
  }

  private createTaskStatsRows(
    result: SimulationResult,
    metric: ElementMetrics | undefined
  ): Array<[string, string | number]> {
    const taskName = metric?.name ?? this.getElementLabel(this.selectedTaskId) ?? this.selectedTaskId ?? 'Task';
    const service = describeSamples(metric?.serviceTimeSamples ?? [], formatDurationMinutes);
    const wait = describeSamples(metric?.waitTimeSamples ?? [], formatDurationMinutes);
    const outputVariables = this.selectedTaskId ? collectOutputVariables(result, this.selectedTaskId) : [];

    return [
      ['Scope', `Task: ${taskName}`],
      ['Executions', metric?.visits ?? 0],
      ['Service times', formatSampleDescription(service)],
      ['Wait times', formatSampleDescription(wait)],
      ['Errors', metric?.errors ?? 0],
      ['Output variables', outputVariables.length ? outputVariables.join(', ') : '-']
    ];
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

  private updateCurrentSimulationTime(result?: SimulationResult): void {
    const startDate = this.readSimulationStartDate();

    if (!result) {
      this.elements.simulationCurrentTime.value = formatDateTimeDisplay(startDate);
      return;
    }

    const startTime = result.options.startTime ?? simulationOffsetHours(startDate);
    const elapsed = Math.max(0, currentSimulationTime(result) - startTime);
    this.elements.simulationCurrentTime.value = formatDateTimeDisplay(addHours(startDate, elapsed));
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
      emptyDiagram: getElement('empty-diagram'),
      importDiagram: getElement('import-diagram'),
      exportDiagram: getElement('export-diagram'),
      runSimulation: getElement('run-simulation'),
      stopSimulation: getElement('stop-simulation'),
      resetSimulation: getElement('reset-simulation'),
      addResource: getElement('add-resource'),
      exportJson: getElement('export-json'),
      exportResultsCsv: getElement('export-results-csv'),
      exportEventLogCsv: getElement('export-event-log-csv'),
      workspace: getElement('workspace'),
      leftResizer: getElement('left-sidebar-resizer'),
      rightResizer: getElement('right-sidebar-resizer'),
      fileInput: getElement('file-input'),
      caseCount: getElement('case-count'),
      seed: getElement('seed'),
      simulationStartTime: getElement('simulation-start-time'),
      simulationEndTime: getElement('simulation-end-time'),
      simulationCurrentTime: getElement('simulation-current-time'),
      animationSpeed: getElement('animation-speed'),
      animationSpeedValue: getElement('animation-speed-value'),
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
}

const ANIMATION_SPEEDS = [1, 2, 4, 8, 16] as const;
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
          <button id="new-diagram" class="icon-button" title="Load demo model" aria-label="Load demo model">
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
            <span>Cases</span>
            <input id="case-count" type="number" min="1" max="50000" step="1" value="250" />
          </label>
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
          <label class="datetime-control current-time-control">
            <span>Sim Time</span>
            <input id="simulation-current-time" class="datetime-input current-time-input" type="text" readonly />
          </label>
          <button id="run-simulation" class="primary-button">
            <i data-lucide="play"></i>
            <span>Start</span>
          </button>
          <button id="stop-simulation" class="icon-button" title="Stop" aria-label="Stop">
            <i data-lucide="square"></i>
          </button>
          <button id="reset-simulation" class="icon-button" title="Reset" aria-label="Reset">
            <i data-lucide="rotate-ccw"></i>
          </button>
          <label class="speed-control">
            <span>Speed</span>
            <input id="animation-speed" type="range" min="0" max="4" step="1" value="0" list="animation-speed-marks" />
            <strong id="animation-speed-value">1x</strong>
          </label>
          <datalist id="animation-speed-marks">
            <option value="0" label="1x"></option>
            <option value="1" label="2x"></option>
            <option value="2" label="4x"></option>
            <option value="3" label="8x"></option>
            <option value="4" label="16x"></option>
          </datalist>
        </div>
      </header>
      <section id="workspace" class="workspace">
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
              <table class="stats-table">
                <tbody id="stats-table"></tbody>
              </table>
            </details>
          </section>
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Resource Utilization</h2>
              </summary>
              <table class="stats-table resource-stats-table">
                <tbody id="resource-stats-table"></tbody>
              </table>
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
      Play,
      Plus,
      RotateCcw,
      Square,
      Trash2,
      Upload
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

function createProcessStatsRows(result: SimulationResult): Array<[string, string | number]> {
  return [
    ['Scope', 'Process'],
    ['Completed', result.completedCases],
    ['Failed', result.failedCases],
    ['Avg cycle time', formatDurationHours(result.cycleTimeAverage)],
    ['P90 cycle time', formatDurationHours(result.cycleTimeP90)],
    ['Throughput', formatNumber(result.throughputPerTimeUnit)],
    ['Deadlock suspicion', result.deadlockSuspicions],
    ['Unconsumed tokens', result.unconsumedTokens]
  ];
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

function formatSampleDescription(samples: Record<'min' | 'max' | 'median' | 'avg', string>): string {
  return `Min ${samples.min} Max ${samples.max} Median ${samples.median} Avg ${samples.avg}`;
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
  const row = document.createElement('article');
  const schedule = normalizeResourceSchedule(resource, 'businessHours');

  row.className = 'resource-row';
  row.dataset.index = String(index);
  row.innerHTML = `
    <div class="resource-row-header">
      <strong>${escapeHtml(resource.name || resource.id)}</strong>
      <button class="icon-button compact-button" type="button" title="Remove resource" aria-label="Remove resource" data-action="remove-resource" data-index="${index}">
        <i data-lucide="trash-2"></i>
      </button>
    </div>
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
