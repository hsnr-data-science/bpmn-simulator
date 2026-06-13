import BpmnModeler from 'bpmn-js/lib/Modeler';
import TokenSimulationModule from 'bpmn-js-token-simulation';
import { BpmnPropertiesPanelModule, BpmnPropertiesProviderModule } from 'bpmn-js-properties-panel';
import { createIcons, Download, FileJson, FilePlus, Pause, Play, Plus, RefreshCcw, RotateCcw, SkipForward, Square, Trash2, Upload } from 'lucide';
import { buildBpmnGraph } from '../bpmn/BpmnGraphBuilder';
import { defaultDiagram } from '../bpmn/defaultDiagram';
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
import type { ElementMetrics, SimulationResource, SimulationResult, Weekday } from '../types/simulation';
import { SimulationPropertiesProviderModule } from '../properties/SimulationPropertiesProvider';
import { HeatmapOverlayManager } from '../visualization/HeatmapOverlayManager';
import { SimulationLogPanel } from '../visualization/SimulationLogPanel';
import { TokenOverlayManager } from '../visualization/TokenOverlayManager';

type Canvas = {
  zoom(mode: string): void;
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
  getRootElement(): BpmnElement;
};

type Overlays = ConstructorParameters<typeof HeatmapOverlayManager>[0];

type ModelerWithDefinitions = BpmnModeler & {
  getDefinitions(): unknown;
};

type AppElements = {
  newDiagram: HTMLButtonElement;
  importDiagram: HTMLButtonElement;
  exportDiagram: HTMLButtonElement;
  exportResults: HTMLButtonElement;
  runSimulation: HTMLButtonElement;
  pauseSimulation: HTMLButtonElement;
  stepSimulation: HTMLButtonElement;
  stopSimulation: HTMLButtonElement;
  resetSimulation: HTMLButtonElement;
  monteCarlo: HTMLButtonElement;
  clearOverlays: HTMLButtonElement;
  addResource: HTMLButtonElement;
  exportJson: HTMLButtonElement;
  exportCsv: HTMLButtonElement;
  exportXes: HTMLButtonElement;
  fileInput: HTMLInputElement;
  caseCount: HTMLInputElement;
  seed: HTMLInputElement;
  untilTime: HTMLInputElement;
  animationSpeed: HTMLInputElement;
  statusLine: HTMLElement;
  metricCompleted: HTMLElement;
  metricFailed: HTMLElement;
  metricAvgCycle: HTMLElement;
  metricP90Cycle: HTMLElement;
  resourceList: HTMLElement;
  bottleneckList: HTMLOListElement;
  pathList: HTMLOListElement;
  statsTable: HTMLTableSectionElement;
  eventLogList: HTMLUListElement;
  warningList: HTMLUListElement;
  logList: HTMLUListElement;
};

export class ModelerApp {
  private readonly root: HTMLElement;
  private readonly modeler: ModelerWithDefinitions;
  private readonly canvas: Canvas;
  private readonly heatmapOverlays: HeatmapOverlayManager;
  private readonly eventLogPanel: SimulationLogPanel;
  private readonly warningPanel: SimulationLogPanel;
  private readonly elements: AppElements;
  private readonly runner = new SimulationRunner();
  private lastResult: SimulationResult | undefined;

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
        TokenSimulationModule,
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

    this.elements = this.collectElements();
    this.eventLogPanel = new SimulationLogPanel(this.elements.eventLogList);
    this.warningPanel = new SimulationLogPanel(this.elements.warningList);
    this.bindEvents();
  }

  async start(): Promise<void> {
    await this.importDiagram(defaultDiagram);
  }

  private bindEvents(): void {
    this.elements.newDiagram.addEventListener('click', () => {
      void this.importDiagram(defaultDiagram);
    });

    this.elements.importDiagram.addEventListener('click', () => {
      this.elements.fileInput.click();
    });

    this.elements.fileInput.addEventListener('change', async () => {
      const file = this.elements.fileInput.files?.[0];

      if (!file) {
        return;
      }

      await this.importDiagram(await file.text());
      this.elements.fileInput.value = '';
    });

    this.elements.exportDiagram.addEventListener('click', async () => {
      const { xml } = await this.modeler.saveXML({ format: true });

      download('diagram.bpmn', xml, 'application/bpmn20-xml;charset=utf-8');
    });

    this.elements.exportResults.addEventListener('click', () => {
      this.exportResult('json');
    });

    this.elements.exportJson.addEventListener('click', () => {
      this.exportResult('json');
    });

    this.elements.exportCsv.addEventListener('click', () => {
      this.exportResult('csv');
    });

    this.elements.exportXes.addEventListener('click', () => {
      this.exportResult('xes');
    });

    this.elements.runSimulation.addEventListener('click', () => {
      this.runSimulation();
    });

    this.elements.monteCarlo.addEventListener('click', () => {
      this.runSimulation();
    });

    this.elements.stepSimulation.addEventListener('click', () => {
      this.runSimulation(1);
      this.setStatus('Ein Simulationsschritt als 1-Case-Run ausgefuehrt');
    });

    this.elements.pauseSimulation.addEventListener('click', () => {
      this.setStatus('Pause ist vorbereitet; der aktuelle Runner arbeitet synchron.');
    });

    this.elements.stopSimulation.addEventListener('click', () => {
      this.setStatus('Stop ist vorbereitet; laufende synchrone Runs enden sofort nach Abschluss.');
    });

    this.elements.resetSimulation.addEventListener('click', () => {
      this.heatmapOverlays.clear();
      this.lastResult = undefined;
      this.setExportButtons(false);
      this.renderEmptyResults();
      this.setStatus('Simulation zurueckgesetzt');
    });

    this.elements.clearOverlays.addEventListener('click', () => {
      this.heatmapOverlays.clear();
      this.setStatus('Overlays zurueckgesetzt');
    });

    this.elements.addResource.addEventListener('click', () => {
      this.addResource();
    });

    this.elements.resourceList.addEventListener('input', (event) => {
      if ((event.target as HTMLInputElement).type === 'checkbox') {
        return;
      }

      this.persistResources(this.readResourcesFromEditor());
      this.setStatus('Ressourcen gespeichert');
    });

    this.elements.resourceList.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;

      if (target.type === 'checkbox') {
        ensureAtLeastOneSelection(target);
      }

      this.persistResources(this.readResourcesFromEditor());
      this.setStatus('Ressourcen gespeichert');
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

      resources.splice(index, 1);
      this.persistResources(resources);
      this.renderResources(resources);
      this.setStatus('Ressource entfernt');
    });
  }

  private exportResult(kind: 'json' | 'csv' | 'xes'): void {
    if (!this.lastResult) {
      return;
    }

    if (kind === 'csv') {
      download('des-simulation-results.csv', this.lastResult.exports.csv, 'text/csv;charset=utf-8');
      return;
    }

    if (kind === 'xes') {
      download('des-simulation-event-log.json', this.lastResult.exports.xesLike, 'application/json;charset=utf-8');
      return;
    }

    download('des-simulation-results.json', this.lastResult.exports.json, 'application/json;charset=utf-8');
  }

  private async importDiagram(xml: string): Promise<void> {
    try {
      await this.modeler.importXML(xml);
      this.canvas.zoom('fit-viewport');
      this.heatmapOverlays.clear();
      this.lastResult = undefined;
      this.setExportButtons(false);
      this.renderEmptyResults();
      this.renderResources();
      this.setStatus('Diagramm geladen');
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Import fehlgeschlagen');
    }
  }

  private runSimulation(numberOfRunsOverride?: number): void {
    try {
      const definitions = this.modeler.getDefinitions();
      const simModel = buildBpmnGraph(definitions as never);
      const result = this.runner.run(simModel, {
        numberOfRuns: numberOfRunsOverride ?? readInteger(this.elements.caseCount, 250),
        randomSeed: readInteger(this.elements.seed, 42),
        maxSimulationTime: readOptionalNumber(this.elements.untilTime),
        animationSpeed: readOptionalNumber(this.elements.animationSpeed) ?? 1,
        collectTraces: true
      });

      this.lastResult = result;
      this.heatmapOverlays.render(result);
      this.renderResults(result);
      this.setExportButtons(true);
      this.setStatus(`${result.completedCases} Cases abgeschlossen`);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Simulation fehlgeschlagen');
    }
  }

  private renderEmptyResults(): void {
    this.elements.metricCompleted.textContent = '-';
    this.elements.metricFailed.textContent = '-';
    this.elements.metricAvgCycle.textContent = '-';
    this.elements.metricP90Cycle.textContent = '-';
    this.elements.bottleneckList.replaceChildren();
    this.elements.pathList.replaceChildren();
    this.elements.statsTable.replaceChildren();
    this.eventLogPanel.render([]);
    this.warningPanel.render([]);
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
    this.setStatus('Ressource hinzugefuegt');
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
      return;
    }

    updateResourceCatalog(
      this.canvas.getRootElement(),
      process,
      resources,
      this.modeler.get<BpmnFactory>('bpmnFactory'),
      this.modeler.get<Modeling>('modeling')
    );
  }

  private getProcess(): BpmnBusinessObject | undefined {
    const definitions = this.modeler.getDefinitions() as BpmnDefinitions;

    return definitions.rootElements?.find((root) => root.$type === 'bpmn:Process');
  }

  private renderResults(result: SimulationResult): void {
    this.elements.metricCompleted.textContent = `${result.completedCases}`;
    this.elements.metricFailed.textContent = `${result.failedCases}`;
    this.elements.metricAvgCycle.textContent = formatNumber(result.cycleTimeAverage);
    this.elements.metricP90Cycle.textContent = formatNumber(result.cycleTimeP90);

    this.renderBottlenecks(result.elementMetrics);
    this.renderPaths(result);
    this.renderStatsTable(result);
    this.eventLogPanel.render(result.log);
    this.warningPanel.render(result.log.filter((entry) => entry.level !== 'info'));
  }

  private renderBottlenecks(metrics: ElementMetrics[]): void {
    const top = metrics
      .filter((metric) => metric.visits > 0)
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
          <strong>${formatNumber(metric.avgWait + metric.avgService)}</strong>
          <small>${metric.visits} visits, ${metric.errors} errors</small>
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

  private renderStatsTable(result: SimulationResult): void {
    const rows: Array<[string, string | number]> = [
      ['Completed', result.completedCases],
      ['Failed', result.failedCases],
      ['Avg cycle time', formatNumber(result.cycleTimeAverage)],
      ['P90 cycle time', formatNumber(result.cycleTimeP90)],
      ['Throughput', formatNumber(result.throughputPerTimeUnit)],
      ['Deadlock suspicion', result.deadlockSuspicions],
      ['Unconsumed tokens', result.unconsumedTokens]
    ];

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

  private collectElements(): AppElements {
    return {
      newDiagram: getElement('new-diagram'),
      importDiagram: getElement('import-diagram'),
      exportDiagram: getElement('export-diagram'),
      exportResults: getElement('export-results'),
      runSimulation: getElement('run-simulation'),
      pauseSimulation: getElement('pause-simulation'),
      stepSimulation: getElement('step-simulation'),
      stopSimulation: getElement('stop-simulation'),
      resetSimulation: getElement('reset-simulation'),
      monteCarlo: getElement('monte-carlo'),
      clearOverlays: getElement('clear-overlays'),
      addResource: getElement('add-resource'),
      exportJson: getElement('export-json'),
      exportCsv: getElement('export-csv'),
      exportXes: getElement('export-xes'),
      fileInput: getElement('file-input'),
      caseCount: getElement('case-count'),
      seed: getElement('seed'),
      untilTime: getElement('until-time'),
      animationSpeed: getElement('animation-speed'),
      statusLine: getElement('status-line'),
      metricCompleted: getElement('metric-completed'),
      metricFailed: getElement('metric-failed'),
      metricAvgCycle: getElement('metric-avg-cycle'),
      metricP90Cycle: getElement('metric-p90-cycle'),
      resourceList: getElement('resource-list'),
      bottleneckList: getElement('bottleneck-list'),
      pathList: getElement('path-list'),
      statsTable: getElement('stats-table'),
      eventLogList: getElement('event-log-list'),
      warningList: getElement('warning-list'),
      logList: getElement('log-list')
    };
  }

  private setStatus(message: string): void {
    this.elements.statusLine.textContent = message;
  }

  private setExportButtons(enabled: boolean): void {
    this.elements.exportResults.disabled = !enabled;
    this.elements.exportJson.disabled = !enabled;
    this.elements.exportCsv.disabled = !enabled;
    this.elements.exportXes.disabled = !enabled;
  }
}

function createShellMarkup(): string {
  return `
    <main class="app-shell">
      <header class="toolbar">
        <div class="toolbar-group">
          <button id="new-diagram" class="icon-button" title="Demo-Modell laden" aria-label="Demo-Modell laden">
            <i data-lucide="file-plus"></i>
          </button>
          <button id="import-diagram" class="icon-button" title="BPMN importieren" aria-label="BPMN importieren">
            <i data-lucide="upload"></i>
          </button>
          <button id="export-diagram" class="icon-button" title="BPMN exportieren" aria-label="BPMN exportieren">
            <i data-lucide="download"></i>
          </button>
          <button id="export-results" class="icon-button" title="Ergebnisse exportieren" aria-label="Ergebnisse exportieren" disabled>
            <i data-lucide="file-json"></i>
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
          <label>
            <span>Horizon</span>
            <input id="until-time" type="number" min="0" step="1" placeholder="offen" />
          </label>
          <button id="run-simulation" class="primary-button">
            <i data-lucide="play"></i>
            <span>Start</span>
          </button>
          <button id="pause-simulation" class="icon-button" title="Pause" aria-label="Pause">
            <i data-lucide="pause"></i>
          </button>
          <button id="step-simulation" class="icon-button" title="Step" aria-label="Step">
            <i data-lucide="skip-forward"></i>
          </button>
          <button id="stop-simulation" class="icon-button" title="Stop" aria-label="Stop">
            <i data-lucide="square"></i>
          </button>
          <button id="reset-simulation" class="icon-button" title="Reset" aria-label="Reset">
            <i data-lucide="rotate-ccw"></i>
          </button>
          <button id="monte-carlo" class="primary-button secondary-button">
            <i data-lucide="play"></i>
            <span>Monte Carlo</span>
          </button>
          <button id="clear-overlays" class="icon-button" title="Overlays zuruecksetzen" aria-label="Overlays zuruecksetzen">
            <i data-lucide="refresh-ccw"></i>
          </button>
          <label>
            <span>Speed</span>
            <input id="animation-speed" type="number" min="0.1" step="0.1" value="1" />
          </label>
        </div>
      </header>
      <section class="workspace">
        <aside class="simulation-panel">
          <div class="panel-header">
            <h1>BPMN DES</h1>
            <p id="status-line">Bereit</p>
          </div>
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
          <section class="panel-section collapsible-section">
            <details open>
              <summary class="section-title">
                <h2>Resources</h2>
              </summary>
              <div class="section-actions">
                <button id="add-resource" class="icon-button compact-button" title="Ressource hinzufuegen" aria-label="Ressource hinzufuegen">
                  <i data-lucide="plus"></i>
                </button>
              </div>
              <div id="resource-list" class="resource-list"></div>
            </details>
          </section>
          <section class="panel-section">
            <div class="section-title">
              <h2>Bottlenecks</h2>
            </div>
            <ol id="bottleneck-list" class="rank-list"></ol>
          </section>
          <section class="panel-section">
            <div class="section-title">
              <h2>Paths</h2>
            </div>
            <ol id="path-list" class="rank-list"></ol>
          </section>
          <section class="panel-section">
            <div class="section-title">
              <h2>Statistics</h2>
            </div>
            <table class="stats-table">
              <tbody id="stats-table"></tbody>
            </table>
          </section>
          <section class="panel-section">
            <div class="section-title">
              <h2>Event Log</h2>
            </div>
            <ul id="event-log-list" class="warning-list event-log-list"></ul>
          </section>
          <section class="panel-section">
            <div class="section-title">
              <h2>Warnings</h2>
            </div>
            <ul id="warning-list" class="warning-list"></ul>
          </section>
          <section class="panel-section">
            <div class="section-title">
              <h2>Export</h2>
            </div>
            <div class="export-buttons">
              <button id="export-json" class="text-button" disabled>JSON</button>
              <button id="export-csv" class="text-button" disabled>CSV</button>
              <button id="export-xes" class="text-button" disabled>XES-like</button>
            </div>
            <ul id="log-list" class="warning-list hidden-log"></ul>
          </section>
        </aside>
        <section class="diagram-shell">
          <div id="canvas"></div>
        </section>
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
      FileJson,
      FilePlus,
      Pause,
      Play,
      Plus,
      RefreshCcw,
      RotateCcw,
      SkipForward,
      Square,
      Trash2,
      Upload
    }
  });
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Element #${id} nicht gefunden.`);
  }

  return element as T;
}

function readInteger(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readOptionalNumber(input: HTMLInputElement): number | undefined {
  if (!input.value) {
    return undefined;
  }

  const value = Number(input.value);

  return Number.isFinite(value) && value >= 0 ? value : undefined;
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

function createResourceRow(resource: SimulationResource, index: number): HTMLElement {
  const row = document.createElement('article');
  const schedule = normalizeResourceSchedule(resource, 'businessHours');

  row.className = 'resource-row';
  row.dataset.index = String(index);
  row.innerHTML = `
    <div class="resource-row-header">
      <strong>${escapeHtml(resource.name || resource.id)}</strong>
      <button class="icon-button compact-button" type="button" title="Ressource entfernen" aria-label="Ressource entfernen" data-action="remove-resource" data-index="${index}">
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
