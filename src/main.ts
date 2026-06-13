import BpmnModeler from 'bpmn-js/lib/Modeler';
import TokenSimulationModule from 'bpmn-js-token-simulation';
import {
  BpmnPropertiesPanelModule,
  BpmnPropertiesProviderModule
} from 'bpmn-js-properties-panel';
import { createIcons, Download, FileJson, FilePlus, Play, RefreshCcw, Upload } from 'lucide';

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';
import 'bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css';
import '@bpmn-io/properties-panel/assets/properties-panel.css';
import './style.css';

import { defaultDiagram } from './bpmn/defaultDiagram';
import simulationModdle from './bpmn/simulationModdle.json';
import { DiscreteEventSimulator } from './des/engine';
import { compileModel } from './des/model';
import type { ElementMetrics, SimulationResult } from './des/types';
import { SimulationPropertiesProviderModule } from './properties/SimulationPropertiesProvider';
import { SimulationOverlays } from './visualization/SimulationOverlays';

type Canvas = {
  zoom(mode: string): void;
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
};

type Overlays = ConstructorParameters<typeof SimulationOverlays>[0];

type ModelerWithDefinitions = BpmnModeler & {
  getDefinitions(): unknown;
};

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App root not found.');
}

app.innerHTML = `
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
          <span>DES Run</span>
        </button>
        <button id="clear-overlays" class="icon-button" title="Overlays zuruecksetzen" aria-label="Overlays zuruecksetzen">
          <i data-lucide="refresh-ccw"></i>
        </button>
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
            <h2>Warnings</h2>
          </div>
          <ul id="warning-list" class="warning-list"></ul>
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

createIcons({
  icons: {
    Download,
    FileJson,
    FilePlus,
    Play,
    RefreshCcw,
    Upload
  }
});

const modeler = new BpmnModeler({
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

const canvas = modeler.get<Canvas>('canvas');
const overlays = new SimulationOverlays(modeler.get<Overlays>('overlays'), canvas);

let lastResult: SimulationResult | undefined;

const elements = {
  newDiagram: getElement<HTMLButtonElement>('new-diagram'),
  importDiagram: getElement<HTMLButtonElement>('import-diagram'),
  exportDiagram: getElement<HTMLButtonElement>('export-diagram'),
  exportResults: getElement<HTMLButtonElement>('export-results'),
  runSimulation: getElement<HTMLButtonElement>('run-simulation'),
  clearOverlays: getElement<HTMLButtonElement>('clear-overlays'),
  fileInput: getElement<HTMLInputElement>('file-input'),
  caseCount: getElement<HTMLInputElement>('case-count'),
  seed: getElement<HTMLInputElement>('seed'),
  untilTime: getElement<HTMLInputElement>('until-time'),
  statusLine: getElement<HTMLElement>('status-line'),
  metricCompleted: getElement<HTMLElement>('metric-completed'),
  metricFailed: getElement<HTMLElement>('metric-failed'),
  metricAvgCycle: getElement<HTMLElement>('metric-avg-cycle'),
  metricP90Cycle: getElement<HTMLElement>('metric-p90-cycle'),
  bottleneckList: getElement<HTMLOListElement>('bottleneck-list'),
  pathList: getElement<HTMLOListElement>('path-list'),
  warningList: getElement<HTMLUListElement>('warning-list')
};

elements.newDiagram.addEventListener('click', () => {
  void importDiagram(defaultDiagram);
});

elements.importDiagram.addEventListener('click', () => {
  elements.fileInput.click();
});

elements.fileInput.addEventListener('change', async () => {
  const file = elements.fileInput.files?.[0];

  if (!file) {
    return;
  }

  await importDiagram(await file.text());
  elements.fileInput.value = '';
});

elements.exportDiagram.addEventListener('click', async () => {
  const { xml } = await modeler.saveXML({ format: true });

  download('diagram.bpmn', xml, 'application/bpmn20-xml;charset=utf-8');
});

elements.exportResults.addEventListener('click', () => {
  if (!lastResult) {
    return;
  }

  download(
    'des-simulation-results.json',
    JSON.stringify(lastResult, null, 2),
    'application/json;charset=utf-8'
  );
});

elements.runSimulation.addEventListener('click', () => {
  runSimulation();
});

elements.clearOverlays.addEventListener('click', () => {
  overlays.clear();
  setStatus('Overlays zurueckgesetzt');
});

void importDiagram(defaultDiagram);

async function importDiagram(xml: string): Promise<void> {
  try {
    await modeler.importXML(xml);
    canvas.zoom('fit-viewport');
    overlays.clear();
    lastResult = undefined;
    elements.exportResults.disabled = true;
    renderEmptyResults();
    setStatus('Diagramm geladen');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Import fehlgeschlagen');
  }
}

function runSimulation(): void {
  try {
    const definitions = modeler.getDefinitions();
    const simModel = compileModel(definitions as never);
    const simulator = new DiscreteEventSimulator(simModel, {
      cases: readInteger(elements.caseCount, 250),
      seed: readInteger(elements.seed, 42),
      untilTime: readOptionalNumber(elements.untilTime)
    });

    lastResult = simulator.run();
    overlays.render(lastResult);
    renderResults(lastResult);
    elements.exportResults.disabled = false;
    setStatus(`${lastResult.completedCases} Cases abgeschlossen`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Simulation fehlgeschlagen');
  }
}

function renderEmptyResults(): void {
  elements.metricCompleted.textContent = '-';
  elements.metricFailed.textContent = '-';
  elements.metricAvgCycle.textContent = '-';
  elements.metricP90Cycle.textContent = '-';
  elements.bottleneckList.replaceChildren();
  elements.pathList.replaceChildren();
  elements.warningList.replaceChildren();
}

function renderResults(result: SimulationResult): void {
  elements.metricCompleted.textContent = `${result.completedCases}`;
  elements.metricFailed.textContent = `${result.failedCases}`;
  elements.metricAvgCycle.textContent = formatNumber(result.cycleTimeAverage);
  elements.metricP90Cycle.textContent = formatNumber(result.cycleTimeP90);

  renderBottlenecks(result.elementMetrics);
  renderPaths(result);
  renderWarnings(result.warnings);
}

function renderBottlenecks(metrics: ElementMetrics[]): void {
  const top = metrics
    .filter((metric) => metric.visits > 0)
    .map((metric) => ({
      ...metric,
      avgWait: metric.visits ? metric.waitTime / metric.visits : 0,
      avgService: metric.completions ? metric.serviceTime / metric.completions : 0
    }))
    .sort((a, b) => b.avgWait + b.avgService - (a.avgWait + a.avgService))
    .slice(0, 6);

  elements.bottleneckList.replaceChildren(
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

function renderPaths(result: SimulationResult): void {
  const top = result.flowMetrics.slice(0, 6);

  elements.pathList.replaceChildren(
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

function renderWarnings(warnings: string[]): void {
  elements.warningList.replaceChildren(
    ...(warnings.length ? warnings : ['Keine Warnungen']).map((warning) => {
      const item = document.createElement('li');
      item.textContent = warning;
      return item;
    })
  );
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

function setStatus(message: string): void {
  elements.statusLine.textContent = message;
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
