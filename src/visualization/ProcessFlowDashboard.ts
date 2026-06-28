import type { EventLogDataset, EventLogRecord } from '../types/eventLog';
import { bindDashboardFullscreen } from './DashboardFullscreen';

type Matrix = {
  rows: string[];
  columns: string[];
  values: number[][];
};

type ProcessFlowModel = {
  records: EventLogRecord[];
  sourceRecordCount: number;
  hiddenInstantEventCount: number;
  cases: string[];
  activities: string[];
  resources: string[];
  resourceActivityMatrix: Matrix;
  resourceTransitionMatrix: Matrix;
  activityTransitionMatrix: Matrix;
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

type ProcessFlowModelOptions = {
  includeInstantEvents?: boolean;
};

const UNASSIGNED_RESOURCE = '(unassigned)';
const GANTT_RECORD_LIMIT = 5_000;
const GRAPH_COLORS = {
  resourceNode: '#cfe0f5',
  resourceStroke: '#4675ab',
  activityNode: '#cfe9d1',
  activityStroke: '#4f9458',
  edge: '#25332e'
};

export class ProcessFlowDashboard {
  private readonly root: HTMLElement;
  private readonly includeInstantEventsInput: HTMLInputElement;
  private readonly resourceInstancesInput: HTMLInputElement;
  private readonly summary: HTMLElement;
  private readonly warnings: HTMLElement;
  private readonly clearWarningsButton: HTMLButtonElement;
  private readonly caseGantt: HTMLElement;
  private readonly resourceGantt: HTMLElement;
  private readonly resourceActivityHeatmap: HTMLElement;
  private readonly resourceGraph: HTMLElement;
  private readonly resourceTransitionHeatmap: HTMLElement;
  private readonly activityGraph: HTMLElement;
  private readonly activityTransitionHeatmap: HTMLElement;
  private plotly?: PlotlyApi;
  private dataset?: EventLogDataset;
  private visibleWarnings: string[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <header class="dashboard-header">
        <div>
          <h1>Process Flow</h1>
          <p>Event-log views for process data science</p>
        </div>
        <div class="dashboard-controls">
          <label class="process-flow-event-toggle">
            <input type="checkbox" class="process-flow-include-events" />
            <span>Include events without duration</span>
          </label>
          <label class="process-flow-event-toggle">
            <input type="checkbox" class="process-flow-resource-instances" />
            <span>Resource timeline by instance</span>
          </label>
        </div>
      </header>
      <div class="dashboard-summary process-flow-summary"></div>
      <section class="process-flow-warnings">
        <div class="dashboard-section-header">
          <h2>Import Warnings</h2>
          <button type="button" class="text-button compact-text-button process-flow-clear-warnings">Clear</button>
        </div>
        <ul></ul>
      </section>
      <div class="process-flow-grid">
        <section class="dashboard-chart-section process-flow-panel process-flow-wide">
          <div class="dashboard-section-header">
            <h2>Activity Timeline by Process Instance</h2>
            <button type="button" class="dashboard-fullscreen-button" data-dashboard-fullscreen>Full screen</button>
          </div>
          <div class="dashboard-chart process-flow-chart process-flow-case-gantt"></div>
        </section>
        <section class="dashboard-chart-section process-flow-panel process-flow-wide">
          <div class="dashboard-section-header">
            <h2>Activity Timeline by Resource</h2>
            <button type="button" class="dashboard-fullscreen-button" data-dashboard-fullscreen>Full screen</button>
          </div>
          <div class="dashboard-chart process-flow-chart process-flow-resource-gantt"></div>
        </section>
        <section class="dashboard-chart-section process-flow-panel">
          <div class="dashboard-section-header">
            <h2>Resource-Activity Matrix</h2>
            <button type="button" class="dashboard-fullscreen-button" data-dashboard-fullscreen>Full screen</button>
          </div>
          <div class="dashboard-chart process-flow-chart process-flow-resource-activity"></div>
        </section>
        <section class="dashboard-chart-section process-flow-panel">
          <div class="dashboard-section-header">
            <h2>Resource Graph</h2>
            <button type="button" class="dashboard-fullscreen-button" data-dashboard-fullscreen>Full screen</button>
          </div>
          <div class="process-flow-graph process-flow-resource-graph"></div>
        </section>
        <section class="dashboard-chart-section process-flow-panel">
          <div class="dashboard-section-header">
            <h2>Resource Transition Matrix</h2>
            <button type="button" class="dashboard-fullscreen-button" data-dashboard-fullscreen>Full screen</button>
          </div>
          <div class="dashboard-chart process-flow-chart process-flow-resource-transition"></div>
        </section>
        <section class="dashboard-chart-section process-flow-panel">
          <div class="dashboard-section-header">
            <h2>Activity Graph</h2>
            <button type="button" class="dashboard-fullscreen-button" data-dashboard-fullscreen>Full screen</button>
          </div>
          <div class="process-flow-graph process-flow-activity-graph"></div>
        </section>
        <section class="dashboard-chart-section process-flow-panel">
          <div class="dashboard-section-header">
            <h2>Activity Transition Matrix</h2>
            <button type="button" class="dashboard-fullscreen-button" data-dashboard-fullscreen>Full screen</button>
          </div>
          <div class="dashboard-chart process-flow-chart process-flow-activity-transition"></div>
        </section>
      </div>
    `;

    this.includeInstantEventsInput = requireElement(this.root, '.process-flow-include-events');
    this.resourceInstancesInput = requireElement(this.root, '.process-flow-resource-instances');
    this.summary = requireElement(this.root, '.process-flow-summary');
    this.warnings = requireElement(this.root, '.process-flow-warnings');
    this.clearWarningsButton = requireElement(this.root, '.process-flow-clear-warnings');
    this.caseGantt = requireElement(this.root, '.process-flow-case-gantt');
    this.resourceGantt = requireElement(this.root, '.process-flow-resource-gantt');
    this.resourceActivityHeatmap = requireElement(this.root, '.process-flow-resource-activity');
    this.resourceGraph = requireElement(this.root, '.process-flow-resource-graph');
    this.resourceTransitionHeatmap = requireElement(this.root, '.process-flow-resource-transition');
    this.activityGraph = requireElement(this.root, '.process-flow-activity-graph');
    this.activityTransitionHeatmap = requireElement(this.root, '.process-flow-activity-transition');

    this.includeInstantEventsInput.addEventListener('change', () => {
      if (this.dataset) {
        void this.render(this.dataset);
      }
    });
    this.resourceInstancesInput.addEventListener('change', () => {
      if (this.dataset) {
        void this.render(this.dataset);
      }
    });
    this.clearWarningsButton.addEventListener('click', () => {
      this.setImportWarnings([]);
    });
    bindDashboardFullscreen(this.root, () => this.resize());

    this.renderEmpty();
  }

  async render(dataset: EventLogDataset): Promise<void> {
    if (this.dataset !== dataset) {
      this.visibleWarnings = [...dataset.warnings];
    }

    this.dataset = dataset;
    this.plotly = this.plotly ?? await loadPlotly();

    if (!dataset.records.length) {
      this.renderEmpty(dataset);
      return;
    }

    const model = buildProcessFlowModel(dataset, {
      includeInstantEvents: this.includeInstantEventsInput.checked
    });

    if (!model.records.length) {
      this.renderEmpty(dataset, model.hiddenInstantEventCount);
      return;
    }

    const visibleGanttRecords = model.records.slice(0, GANTT_RECORD_LIMIT);
    const clippedCount = Math.max(0, model.records.length - visibleGanttRecords.length);

    this.renderSummary(dataset, model, clippedCount);
    this.renderWarnings(this.visibleWarnings);

    await Promise.all([
      this.renderGantt(
        this.caseGantt,
        visibleGanttRecords,
        (record) => record.caseId,
        'Process instance',
        clippedCount
      ),
      this.renderGantt(
        this.resourceGantt,
        visibleGanttRecords,
        (record) => this.resourceInstancesInput.checked ? resourceInstanceLabel(record) : resourceLabel(record),
        this.resourceInstancesInput.checked ? 'Resource instance' : 'Resource',
        clippedCount
      ),
      this.renderHeatmap(
        this.resourceActivityHeatmap,
        model.resourceActivityMatrix,
        'Activity',
        'Resource',
        'Events'
      ),
      this.renderHeatmap(
        this.resourceTransitionHeatmap,
        model.resourceTransitionMatrix,
        'To resource',
        'From resource',
        'Transitions'
      ),
      this.renderHeatmap(
        this.activityTransitionHeatmap,
        model.activityTransitionMatrix,
        'To activity',
        'From activity',
        'Transitions'
      )
    ]);

    renderDirectedGraph(this.resourceGraph, {
      labels: model.resources,
      matrix: model.resourceTransitionMatrix,
      kind: 'resource'
    });
    renderDirectedGraph(this.activityGraph, {
      labels: model.activities,
      matrix: model.activityTransitionMatrix,
      kind: 'activity'
    });
    await nextAnimationFrame();
    this.resize();
  }

  clear(): void {
    this.dataset = undefined;
    this.visibleWarnings = [];

    if (this.plotly) {
      for (const chart of [
        this.caseGantt,
        this.resourceGantt,
        this.resourceActivityHeatmap,
        this.resourceTransitionHeatmap,
        this.activityTransitionHeatmap
      ]) {
        this.plotly.purge(chart);
      }
    }

    this.renderEmpty();
  }

  setImportWarnings(warnings: string[]): void {
    this.visibleWarnings = [...warnings];
    this.renderWarnings(this.visibleWarnings);
  }

  resize(): void {
    if (!this.plotly || !this.dataset?.records.length) {
      return;
    }

    for (const chart of [
      this.caseGantt,
      this.resourceGantt,
      this.resourceActivityHeatmap,
      this.resourceTransitionHeatmap,
      this.activityTransitionHeatmap
    ]) {
      this.plotly.Plots.resize(chart);
    }
  }

  private renderSummary(dataset: EventLogDataset, model: ProcessFlowModel, clippedCount: number): void {
    this.summary.innerHTML = `
      <div>
        <span>Source</span>
        <strong>${escapeHtml(dataset.sourceName)}</strong>
      </div>
      <div>
        <span>Process Instances</span>
        <strong>${model.cases.length}</strong>
      </div>
      <div>
        <span>Activities</span>
        <strong>${model.activities.length}</strong>
      </div>
      <div>
        <span>Resources</span>
        <strong>${model.resources.length}</strong>
      </div>
      <div>
        <span>Records</span>
        <strong>${recordCountLabel(model, clippedCount)}</strong>
      </div>
      <div>
        <span>Hidden Events</span>
        <strong>${model.hiddenInstantEventCount}</strong>
      </div>
    `;
  }

  private renderWarnings(warnings: string[]): void {
    const list = requireElement<HTMLUListElement>(this.warnings, 'ul');

    list.innerHTML = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
    this.warnings.hidden = warnings.length === 0;
  }

  private renderEmpty(dataset?: EventLogDataset, hiddenInstantEventCount = 0): void {
    this.summary.innerHTML = `
      <div>
        <span>Status</span>
        <strong>${dataset ? 'No displayed event-log records' : 'No event log loaded'}</strong>
      </div>
      ${dataset ? `
        <div>
          <span>Source Records</span>
          <strong>${dataset.records.length}</strong>
        </div>
        <div>
          <span>Hidden Events</span>
          <strong>${hiddenInstantEventCount}</strong>
        </div>
      ` : ''}
    `;
    if (dataset && this.dataset !== dataset) {
      this.visibleWarnings = [...dataset.warnings];
    }

    this.renderWarnings(this.visibleWarnings);

    for (const chart of [
      this.caseGantt,
      this.resourceGantt,
      this.resourceActivityHeatmap,
      this.resourceTransitionHeatmap,
      this.activityTransitionHeatmap
    ]) {
      chart.innerHTML = '<p class="dashboard-empty">Run a simulation or import an event log.</p>';
    }

    this.resourceGraph.innerHTML = '<p class="dashboard-empty">No resource transitions available.</p>';
    this.activityGraph.innerHTML = '<p class="dashboard-empty">No activity transitions available.</p>';
  }

  private async renderGantt(
    element: HTMLElement,
    records: EventLogRecord[],
    yValue: (record: EventLogRecord) => string,
    yAxisTitle: string,
    clippedCount: number
  ): Promise<void> {
    if (!this.plotly) {
      return;
    }

    const traces = createGanttTraces(records, yValue);
    const yLabels = unique(records.map(yValue));
    const title = clippedCount
      ? `Showing first ${GANTT_RECORD_LIMIT.toLocaleString()} records; ${clippedCount.toLocaleString()} more records are included in matrices.`
      : '';

    await this.plotly.react(
      element,
      traces,
      {
        autosize: true,
        height: chartHeight(yLabels.length, 430, 900),
        margin: { l: 120, r: 20, t: title ? 34 : 14, b: 70 },
        paper_bgcolor: '#ffffff',
        plot_bgcolor: '#ffffff',
        barmode: 'overlay',
        title: title ? { text: title, font: { size: 12, color: '#68716d' } } : undefined,
        font: dashboardFont(),
        xaxis: {
          type: 'date',
          title: 'Time',
          gridcolor: '#dfe6e3'
        },
        yaxis: {
          title: yAxisTitle,
          automargin: true,
          categoryorder: 'array',
          categoryarray: yLabels
        },
        legend: {
          orientation: 'h',
          y: -0.2
        },
        hovermode: 'closest'
      },
      PLOT_CONFIG
    );
  }

  private async renderHeatmap(
    element: HTMLElement,
    matrix: Matrix,
    xTitle: string,
    yTitle: string,
    unit: string
  ): Promise<void> {
    if (!this.plotly) {
      return;
    }

    await this.plotly.react(
      element,
      [{
        type: 'heatmap',
        x: matrix.columns,
        y: matrix.rows,
        z: matrix.values,
        text: matrix.values.map((row) => row.map((value) => String(value || ''))),
        texttemplate: '%{text}',
        colorscale: [
          [0, '#f6faf8'],
          [0.35, '#c9dcef'],
          [0.7, '#5c8fc9'],
          [1, '#0b4da2']
        ],
        hovertemplate: `${yTitle}: %{y}<br>${xTitle}: %{x}<br>${unit}: %{z}<extra></extra>`,
        colorbar: {
          title: unit
        }
      }],
      {
        autosize: true,
        height: chartHeight(matrix.rows.length, 380, 640),
        margin: { l: 110, r: 24, t: 14, b: 110 },
        paper_bgcolor: '#ffffff',
        plot_bgcolor: '#ffffff',
        font: dashboardFont(),
        xaxis: {
          title: xTitle,
          automargin: true
        },
        yaxis: {
          title: yTitle,
          automargin: true
        }
      },
      PLOT_CONFIG
    );
  }
}

export function buildProcessFlowModel(
  dataset: EventLogDataset,
  options: ProcessFlowModelOptions = {}
): ProcessFlowModel {
  const hiddenInstantEventCount = dataset.records.filter(isInstantEventRecord).length;
  const records = dataset.records
    .filter((record) => options.includeInstantEvents || !isInstantEventRecord(record))
    .sort(compareRecords);
  const cases = unique(records.map((record) => record.caseId));
  const resources = orderedByFirstOccurrence(records, resourceLabel);
  const recordsByCase = groupBy(records, (record) => record.caseId);
  const activities = orderedByFirstOccurrence(records, activityLabel);

  return {
    records,
    sourceRecordCount: dataset.records.length,
    hiddenInstantEventCount: options.includeInstantEvents ? 0 : hiddenInstantEventCount,
    cases,
    activities,
    resources,
    resourceActivityMatrix: buildMatrix(resources, activities, (increment) => {
      for (const record of records) {
        increment(resourceLabel(record), activityLabel(record));
      }
    }),
    resourceTransitionMatrix: buildTransitionMatrix(resources, recordsByCase, resourceLabel),
    activityTransitionMatrix: buildTransitionMatrix(activities, recordsByCase, activityLabel)
  };
}

function buildTransitionMatrix(
  labels: string[],
  recordsByCase: Map<string, EventLogRecord[]>,
  labelFor: (record: EventLogRecord) => string
): Matrix {
  return buildMatrix(labels, labels, (increment) => {
    for (const records of recordsByCase.values()) {
      const sorted = [...records].sort(compareRecords);

      for (let index = 0; index < sorted.length - 1; index += 1) {
        increment(labelFor(sorted[index]), labelFor(sorted[index + 1]));
      }
    }
  });
}

function buildMatrix(
  rows: string[],
  columns: string[],
  fill: (increment: (row: string, column: string) => void) => void
): Matrix {
  const rowIndex = new Map(rows.map((row, index) => [row, index]));
  const columnIndex = new Map(columns.map((column, index) => [column, index]));
  const values = rows.map(() => columns.map(() => 0));

  fill((row, column) => {
    const y = rowIndex.get(row);
    const x = columnIndex.get(column);

    if (y === undefined || x === undefined) {
      return;
    }

    values[y][x] += 1;
  });

  return {
    rows,
    columns,
    values
  };
}

function orderedByFirstOccurrence(
  records: EventLogRecord[],
  labelFor: (record: EventLogRecord) => string
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const label = labelFor(record);

    if (!label || seen.has(label)) {
      continue;
    }

    seen.add(label);
    labels.push(label);
  }

  return labels;
}

function createGanttTraces(
  records: EventLogRecord[],
  yValue: (record: EventLogRecord) => string
): Array<Record<string, unknown>> {
  const recordsByActivity = groupBy(records, activityLabel);

  return [...recordsByActivity.entries()].map(([activity, activityRecords], index) => ({
    type: 'bar',
    orientation: 'h',
    name: activity,
    x: activityRecords.map(durationMilliseconds),
    base: activityRecords.map((record) => record.startTime.toISOString()),
    y: activityRecords.map(yValue),
    customdata: activityRecords.map((record) => [
      record.caseId,
      displayResourceLabel(record),
      formatDate(record.startTime),
      record.endTime ? formatDate(record.endTime) : '',
      formatDuration(durationMilliseconds(record))
    ]),
    marker: {
      color: activityColor(index)
    },
    hovertemplate: [
      `<b>${escapePlotlyText(activity)}</b>`,
      'Case: %{customdata[0]}',
      'Resource: %{customdata[1]}',
      'Start: %{customdata[2]}',
      'End: %{customdata[3]}',
      'Duration: %{customdata[4]}'
    ].join('<br>') + '<extra></extra>'
  }));
}

function renderDirectedGraph(
  element: HTMLElement,
  options: {
    labels: string[];
    matrix: Matrix;
    kind: 'resource' | 'activity';
  }
): void {
  const edges = matrixEdges(options.matrix);

  if (!options.labels.length || !edges.length) {
    element.innerHTML = '<p class="dashboard-empty">No direct transitions available.</p>';
    return;
  }

  const width = 760;
  const height = 440;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.34;
  const positions = new Map(options.labels.map((label, index) => {
    const angle = -Math.PI / 2 + (index / options.labels.length) * Math.PI * 2;

    return [
      label,
      {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      }
    ] as const;
  }));
  const maxEdge = Math.max(...edges.map((edge) => edge.count), 1);
  const edgeKeys = new Set(edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  const nodeFill = options.kind === 'resource' ? GRAPH_COLORS.resourceNode : GRAPH_COLORS.activityNode;
  const nodeStroke = options.kind === 'resource' ? GRAPH_COLORS.resourceStroke : GRAPH_COLORS.activityStroke;

  const edgeMarkup = edges.map((edge) => {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);

    if (!source || !target) {
      return '';
    }

    const widthScale = edgeStrokeWidth(edge.count, maxEdge);
    const sourceAttr = escapeHtml(edge.from);
    const targetAttr = escapeHtml(edge.to);

    if (edge.from === edge.to) {
      return `
        <g class="process-flow-edge" data-source="${sourceAttr}" data-target="${targetAttr}" data-self="true">
          <path class="process-flow-edge-path" d="${selfEdgePath(source)}"
            fill="none" stroke="${GRAPH_COLORS.edge}" stroke-width="${widthScale.toFixed(2)}" marker-end="url(#process-flow-arrow)" opacity="0.72" />
          <text class="process-flow-edge-label" x="${source.x}" y="${source.y - 74}" text-anchor="middle">${edge.count}</text>
        </g>
      `;
    }

    const line = edgeLinePoints(source, target);
    const hasOpposite = edgeKeys.has(`${edge.to}\u0000${edge.from}`);
    const curveSign = 1;

    if (hasOpposite) {
      const label = curvedEdgeLabelPoint(line, curveSign);

      return `
        <g class="process-flow-edge" data-source="${sourceAttr}" data-target="${targetAttr}" data-curved="true" data-curve-sign="${curveSign}">
          <path class="process-flow-edge-path" d="${curvedEdgePath(line, curveSign)}"
            fill="none" stroke="${GRAPH_COLORS.edge}" stroke-width="${widthScale.toFixed(2)}" marker-end="url(#process-flow-arrow)" opacity="0.72" />
          <text class="process-flow-edge-label" x="${label.x}" y="${label.y - 6}" text-anchor="middle">${edge.count}</text>
        </g>
      `;
    }

    return `
      <g class="process-flow-edge" data-source="${sourceAttr}" data-target="${targetAttr}">
        <line class="process-flow-edge-line" x1="${line.sx}" y1="${line.sy}" x2="${line.tx}" y2="${line.ty}"
          stroke="${GRAPH_COLORS.edge}" stroke-width="${widthScale.toFixed(2)}" marker-end="url(#process-flow-arrow)" opacity="0.72" />
        <text class="process-flow-edge-label" x="${line.mx}" y="${line.my - 6}" text-anchor="middle">${edge.count}</text>
      </g>
    `;
  }).join('');
  const nodeMarkup = options.labels.map((label) => {
    const position = positions.get(label);

    if (!position) {
      return '';
    }

    return `
      <g class="process-flow-node" data-node="${escapeHtml(label)}" data-x="${position.x}" data-y="${position.y}" transform="translate(${position.x} ${position.y})">
        <ellipse cx="0" cy="0" rx="58" ry="24" fill="${nodeFill}" stroke="${nodeStroke}" stroke-width="1.4" />
        <text x="0" y="4" text-anchor="middle">${escapeSvgText(truncateLabel(label, 18))}</text>
        <title>${escapeSvgText(label)}</title>
      </g>
    `;
  }).join('');

  element.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${options.kind} directly-follows graph">
      <defs>
        <marker id="process-flow-arrow" markerWidth="12" markerHeight="12" refX="11" refY="5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 0 0 L 11 5 L 0 10 z" fill="${GRAPH_COLORS.edge}"></path>
        </marker>
      </defs>
      <g class="process-flow-viewport">
        <g class="process-flow-edges">${edgeMarkup}</g>
        <g class="process-flow-nodes">${nodeMarkup}</g>
      </g>
    </svg>
  `;
  bindInteractiveDirectedGraph(element);
}

type GraphPoint = {
  x: number;
  y: number;
};

function edgeStrokeWidth(count: number, maxEdge: number): number {
  if (maxEdge <= 0) {
    return 0.5;
  }

  return 0.5 + (count / maxEdge) * 3.5;
}

function edgeLinePoints(source: GraphPoint, target: GraphPoint): {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  mx: number;
  my: number;
} {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const sx = source.x + (dx / length) * 42;
  const sy = source.y + (dy / length) * 24;
  const tx = target.x - (dx / length) * 42;
  const ty = target.y - (dy / length) * 24;

  return {
    sx,
    sy,
    tx,
    ty,
    mx: (sx + tx) / 2,
    my: (sy + ty) / 2
  };
}

function selfEdgePath(source: GraphPoint): string {
  return `M ${source.x - 12} ${source.y - 24} C ${source.x - 62} ${source.y - 72}, ${source.x + 62} ${source.y - 72}, ${source.x + 12} ${source.y - 24}`;
}

function curvedEdgePath(
  points: ReturnType<typeof edgeLinePoints>,
  sign: number
): string {
  const control = curvedEdgeControlPoint(points, sign);

  return `M ${points.sx} ${points.sy} Q ${control.x} ${control.y} ${points.tx} ${points.ty}`;
}

function curvedEdgeLabelPoint(
  points: ReturnType<typeof edgeLinePoints>,
  sign: number
): GraphPoint {
  const control = curvedEdgeControlPoint(points, sign);

  return {
    x: 0.25 * points.sx + 0.5 * control.x + 0.25 * points.tx,
    y: 0.25 * points.sy + 0.5 * control.y + 0.25 * points.ty
  };
}

function curvedEdgeControlPoint(
  points: ReturnType<typeof edgeLinePoints>,
  sign: number
): GraphPoint {
  const dx = points.tx - points.sx;
  const dy = points.ty - points.sy;
  const length = Math.hypot(dx, dy) || 1;
  const offset = 34 * Math.sign(sign || 1);

  return {
    x: points.mx + (-dy / length) * offset,
    y: points.my + (dx / length) * offset
  };
}

function bindInteractiveDirectedGraph(element: HTMLElement): void {
  const svg = element.querySelector<SVGSVGElement>('svg');
  const viewport = element.querySelector<SVGGElement>('.process-flow-viewport');

  if (!svg || !viewport) {
    return;
  }

  const positions = readGraphNodePositions(svg);
  let scale = 1;
  let translateX = 0;
  let translateY = 0;

  const applyViewport = () => {
    viewport.setAttribute('transform', `translate(${translateX} ${translateY}) scale(${scale})`);
  };

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const before = viewportPoint(svg, event, translateX, translateY, scale);
    const nextScale = clamp(scale * (event.deltaY < 0 ? 1.12 : 0.88), 0.35, 4);
    const afterScale = nextScale || 1;
    const raw = svgPoint(svg, event);

    translateX = raw.x - before.x * afterScale;
    translateY = raw.y - before.y * afterScale;
    scale = afterScale;
    applyViewport();
  }, { passive: false });

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as Element;
    const node = target.closest<SVGGElement>('.process-flow-node');

    if (node) {
      event.preventDefault();
      dragGraphNode(svg, node, positions, event, () => updateGraphEdges(svg, positions), translateX, translateY, scale);
      return;
    }

    event.preventDefault();
    panGraph(svg, event, (nextX, nextY) => {
      translateX = nextX;
      translateY = nextY;
      applyViewport();
    }, translateX, translateY);
  });
}

function readGraphNodePositions(svg: SVGSVGElement): Map<string, GraphPoint> {
  const positions = new Map<string, GraphPoint>();

  for (const node of svg.querySelectorAll<SVGGElement>('.process-flow-node')) {
    const label = node.dataset.node;

    if (!label) {
      continue;
    }

    positions.set(label, {
      x: Number(node.dataset.x) || 0,
      y: Number(node.dataset.y) || 0
    });
  }

  return positions;
}

function dragGraphNode(
  svg: SVGSVGElement,
  node: SVGGElement,
  positions: Map<string, GraphPoint>,
  startEvent: PointerEvent,
  onMove: () => void,
  translateX: number,
  translateY: number,
  scale: number
): void {
  const label = node.dataset.node;

  if (!label) {
    return;
  }

  const startPosition = positions.get(label) ?? { x: 0, y: 0 };
  const pointer = viewportPoint(svg, startEvent, translateX, translateY, scale);
  const offset = {
    x: pointer.x - startPosition.x,
    y: pointer.y - startPosition.y
  };

  svg.setPointerCapture(startEvent.pointerId);

  const handleMove = (event: PointerEvent) => {
    const point = viewportPoint(svg, event, translateX, translateY, scale);
    const next = {
      x: point.x - offset.x,
      y: point.y - offset.y
    };

    positions.set(label, next);
    node.dataset.x = String(next.x);
    node.dataset.y = String(next.y);
    node.setAttribute('transform', `translate(${next.x} ${next.y})`);
    onMove();
  };
  const handleUp = () => {
    svg.removeEventListener('pointermove', handleMove);
    svg.removeEventListener('pointerup', handleUp);
    svg.removeEventListener('pointercancel', handleUp);
  };

  svg.addEventListener('pointermove', handleMove);
  svg.addEventListener('pointerup', handleUp);
  svg.addEventListener('pointercancel', handleUp);
}

function panGraph(
  svg: SVGSVGElement,
  startEvent: PointerEvent,
  onMove: (translateX: number, translateY: number) => void,
  startTranslateX: number,
  startTranslateY: number
): void {
  const start = svgPoint(svg, startEvent);

  svg.setPointerCapture(startEvent.pointerId);

  const handleMove = (event: PointerEvent) => {
    const point = svgPoint(svg, event);

    onMove(
      startTranslateX + point.x - start.x,
      startTranslateY + point.y - start.y
    );
  };
  const handleUp = () => {
    svg.removeEventListener('pointermove', handleMove);
    svg.removeEventListener('pointerup', handleUp);
    svg.removeEventListener('pointercancel', handleUp);
  };

  svg.addEventListener('pointermove', handleMove);
  svg.addEventListener('pointerup', handleUp);
  svg.addEventListener('pointercancel', handleUp);
}

function updateGraphEdges(svg: SVGSVGElement, positions: Map<string, GraphPoint>): void {
  for (const edge of svg.querySelectorAll<SVGGElement>('.process-flow-edge')) {
    const source = edge.dataset.source ? positions.get(edge.dataset.source) : undefined;
    const target = edge.dataset.target ? positions.get(edge.dataset.target) : undefined;
    const label = edge.querySelector<SVGTextElement>('.process-flow-edge-label');

    if (!source || !target || !label) {
      continue;
    }

    if (edge.dataset.self === 'true') {
      const path = edge.querySelector<SVGPathElement>('.process-flow-edge-path');

      path?.setAttribute('d', selfEdgePath(source));
      label.setAttribute('x', String(source.x));
      label.setAttribute('y', String(source.y - 74));
      continue;
    }

    const points = edgeLinePoints(source, target);
    const curvedPath = edge.querySelector<SVGPathElement>('.process-flow-edge-path');

    if (curvedPath && edge.dataset.curved === 'true') {
      const curveSign = Number(edge.dataset.curveSign) || 1;
      const labelPoint = curvedEdgeLabelPoint(points, curveSign);

      curvedPath.setAttribute('d', curvedEdgePath(points, curveSign));
      label.setAttribute('x', String(labelPoint.x));
      label.setAttribute('y', String(labelPoint.y - 6));
      continue;
    }

    const line = edge.querySelector<SVGLineElement>('.process-flow-edge-line');

    if (line) {
      line.setAttribute('x1', String(points.sx));
      line.setAttribute('y1', String(points.sy));
      line.setAttribute('x2', String(points.tx));
      line.setAttribute('y2', String(points.ty));
    }

    label.setAttribute('x', String(points.mx));
    label.setAttribute('y', String(points.my - 6));
  }
}

function viewportPoint(
  svg: SVGSVGElement,
  event: { clientX: number; clientY: number },
  translateX: number,
  translateY: number,
  scale: number
): GraphPoint {
  const point = svgPoint(svg, event);

  return {
    x: (point.x - translateX) / scale,
    y: (point.y - translateY) / scale
  };
}

function svgPoint(
  svg: SVGSVGElement,
  event: { clientX: number; clientY: number }
): GraphPoint {
  const point = svg.createSVGPoint();
  const matrix = svg.getScreenCTM();

  point.x = event.clientX;
  point.y = event.clientY;

  if (!matrix) {
    return {
      x: event.clientX,
      y: event.clientY
    };
  }

  const transformed = point.matrixTransform(matrix.inverse());

  return {
    x: transformed.x,
    y: transformed.y
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function matrixEdges(matrix: Matrix): Array<{ from: string; to: string; count: number }> {
  const edges: Array<{ from: string; to: string; count: number }> = [];

  for (let row = 0; row < matrix.rows.length; row += 1) {
    for (let column = 0; column < matrix.columns.length; column += 1) {
      const count = matrix.values[row]?.[column] ?? 0;

      if (count > 0) {
        edges.push({
          from: matrix.rows[row],
          to: matrix.columns[column],
          count
        });
      }
    }
  }

  return edges.sort((left, right) => right.count - left.count);
}

function activityLabel(record: EventLogRecord): string {
  return record.activityName || record.activityId;
}

function resourceLabel(record: EventLogRecord): string {
  return record.resource || UNASSIGNED_RESOURCE;
}

function resourceInstanceLabel(record: EventLogRecord): string {
  return record.resourceInstance || record.resource || UNASSIGNED_RESOURCE;
}

function displayResourceLabel(record: EventLogRecord): string {
  return record.resourceInstance
    ? `${record.resourceInstance} (${resourceLabel(record)})`
    : resourceLabel(record);
}

function compareRecords(left: EventLogRecord, right: EventLogRecord): number {
  const startDifference = left.startTime.getTime() - right.startTime.getTime();

  if (startDifference) {
    return startDifference;
  }

  const endDifference = (left.endTime?.getTime() ?? left.startTime.getTime()) -
    (right.endTime?.getTime() ?? right.startTime.getTime());

  if (endDifference) {
    return endDifference;
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function isInstantEventRecord(record: EventLogRecord): boolean {
  return !record.endTime || record.endTime.getTime() === record.startTime.getTime();
}

function durationMilliseconds(record: EventLogRecord): number {
  const end = record.endTime?.getTime() ?? record.startTime.getTime();

  return Math.max(60_000, end - record.startTime.getTime());
}

function recordCountLabel(model: ProcessFlowModel, clippedCount: number): string {
  const sourceSuffix = model.sourceRecordCount !== model.records.length
    ? ` / ${model.sourceRecordCount}`
    : '';
  const ganttSuffix = clippedCount
    ? ` (${GANTT_RECORD_LIMIT} in Gantt)`
    : '';

  return `${model.records.length}${sourceSuffix}${ganttSuffix}`;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }

    setTimeout(resolve, 0);
  });
}

function chartHeight(count: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, 260 + count * 24));
}

function activityColor(index: number): string {
  const palette = [
    '#4c78a8',
    '#59a14f',
    '#f28e2b',
    '#b07aa1',
    '#edc949',
    '#76b7b2',
    '#e15759',
    '#8cd17d',
    '#9c755f',
    '#bab0ab'
  ];

  return palette[index % palette.length];
}

function dashboardFont(): Record<string, unknown> {
  return {
    family: 'Inter, ui-sans-serif, system-ui, sans-serif',
    color: '#26302c',
    size: 11
  };
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(date);
}

function truncateLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeSvgText(value: string): string {
  return escapeHtml(value).replace(/'/g, '&apos;');
}

function escapePlotlyText(value: string): string {
  return value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Process Flow dashboard element "${selector}" not found.`);
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
