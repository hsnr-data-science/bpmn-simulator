import type { SimulationResult } from '../types/simulation';
import { TokenOverlayManager } from './TokenOverlayManager';

type Overlays = {
  add(elementId: string, overlay: { position: Record<string, number>; html: string }): string;
  add(elementId: string, type: string, overlay: { position: Record<string, number>; html: string }): string;
  remove(overlayId: string): void;
};

type Canvas = {
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
  getContainer(): HTMLElement;
};

export class HeatmapOverlayManager {
  private readonly overlays: Overlays;
  private readonly canvas: Canvas;
  private readonly tokenOverlays: TokenOverlayManager;
  private overlayIds: string[] = [];
  private heatmapMarkers = new Map<string, Set<string>>();
  private styledFlowIds = new Set<string>();

  constructor(overlays: Overlays, canvas: Canvas, tokenOverlays: TokenOverlayManager) {
    this.overlays = overlays;
    this.canvas = canvas;
    this.tokenOverlays = tokenOverlays;
  }

  clear(): void {
    for (const overlayId of this.overlayIds) {
      this.overlays.remove(overlayId);
    }

    this.overlayIds = [];

    for (const flowId of this.styledFlowIds) {
      this.setFlowStrokeWidth(flowId);
    }

    this.styledFlowIds.clear();

    for (const [elementId, markers] of this.heatmapMarkers.entries()) {
      for (const marker of markers) {
        this.canvas.removeMarker(elementId, marker);
      }
    }

    this.heatmapMarkers.clear();
    this.tokenOverlays.clear();
  }

  render(result: SimulationResult): void {
    this.clear();

    const taskMetrics = result.elementMetrics.filter((metric) => isActivityMetric(metric.type));
    const maxAverageWait = Math.max(...taskMetrics.map((metric) => averageWait(metric)), 0);
    const caseTotal = Math.max(1, result.options.numberOfRuns, result.cases.length);
    const maxEventGatewayVisits = Math.max(
      ...result.elementMetrics
        .filter((metric) => isEventOrGatewayMetric(metric.type))
        .map((metric) => metric.visits),
      0
    );

    for (const unsupportedId of result.unsupportedElementIds) {
      this.tokenOverlays.markUnsupported(unsupportedId);
    }

    for (const metric of result.flowMetrics) {
      if (!metric.count) {
        continue;
      }

      this.addFlowFrequencyMarker(metric.flowId, metric.count / caseTotal);
    }

    for (const metric of result.elementMetrics) {
      if (!metric.visits) {
        continue;
      }

      const errorRate = metric.visits ? metric.errors / metric.visits : 0;
      const avgWait = metric.visits ? metric.waitTime / metric.visits : 0;
      const waitIntensity = maxAverageWait ? avgWait / maxAverageWait : 0;

      if (metric.unsupported) {
        this.tokenOverlays.markUnsupported(metric.elementId);
      }

      if (errorRate > 0.05 || metric.errors > 0) {
        this.addMarker(metric.elementId, 'des-error-risk');
      }

      if (isActivityMetric(metric.type)) {
        this.addActivityWaitMarker(metric.elementId, waitIntensity);
        this.addTaskStatisticsOverlay(metric);
        this.addTaskErrorOverlay(metric.elementId, metric.errors);
        continue;
      }

      if (isEventOrGatewayMetric(metric.type)) {
        this.addFrequencyOverlay(
          metric.elementId,
          metric.visits,
          maxEventGatewayVisits ? metric.visits / maxEventGatewayVisits : 0
        );
      }
    }
  }

  private addTaskStatisticsOverlay(metric: SimulationResult['elementMetrics'][number]): void {
    const avgWait = average(metric.waitTimeSamples ?? []);
    const waitStddev = metric.waitTimeStddev;
    const html = [
      '<div class="des-task-stat-overlay">',
      `<span title="Mittlere Wartezeit in Minuten">W ${formatNumber(avgWait)}m</span>`,
      `<span title="Standardabweichung Wartezeit in Minuten">Std ${formatNumber(waitStddev)}m</span>`,
      '</div>'
    ].join('');

    try {
      const overlayId = this.overlays.add(metric.elementId, 'bts-token-count', {
        position: {
          bottom: 0,
          left: 0
        },
        html
      });

      this.overlayIds.push(overlayId);
    } catch {
      // Some semantic elements are intentionally invisible on the BPMN canvas.
    }
  }

  private addFrequencyOverlay(elementId: string, visits: number, intensity: number): void {
    const heat = Math.round(30 + intensity * 70);
    const html = [
      `<div class="des-frequency-overlay" style="--heat:${heat}%">`,
      `<strong title="Ausfuehrungshaeufigkeit">${visits}</strong>`,
      '</div>'
    ].join('');

    try {
      const overlayId = this.overlays.add(elementId, 'bts-token-count', {
        position: {
          top: 0,
          right: 0
        },
        html
      });

      this.overlayIds.push(overlayId);
    } catch {
      // Some semantic elements are intentionally invisible on the BPMN canvas.
    }
  }

  private addTaskErrorOverlay(elementId: string, errors: number): void {
    const html = [
      '<div class="des-task-error-overlay">',
      `<strong title="Fehleranzahl">${errors}</strong>`,
      '</div>'
    ].join('');

    try {
      const overlayId = this.overlays.add(elementId, 'bts-token-count', {
        position: {
          top: 0,
          right: 0
        },
        html
      });

      this.overlayIds.push(overlayId);
    } catch {
      // Some semantic elements are intentionally invisible on the BPMN canvas.
    }
  }

  private addActivityWaitMarker(elementId: string, intensity: number): void {
    this.addMarker(elementId, waitMarkerForIntensity(intensity));
  }

  private addFlowFrequencyMarker(flowId: string, intensity: number): void {
    this.addMarker(flowId, flowMarkerForIntensity(intensity));
    this.setFlowStrokeWidth(flowId, flowWidthForIntensity(intensity));
  }

  private addMarker(elementId: string, marker: string): void {
    try {
      this.canvas.addMarker(elementId, marker);
      const markers = this.heatmapMarkers.get(elementId) ?? new Set<string>();
      markers.add(marker);
      this.heatmapMarkers.set(elementId, markers);
    } catch {
      // Ignore non-rendered semantic elements.
    }
  }

  private setFlowStrokeWidth(flowId: string, width?: number): void {
    const selector = `.djs-connection[data-element-id="${cssEscape(flowId)}"] .djs-visual > path`;
    const path = this.canvas.getContainer().querySelector<SVGPathElement>(selector);

    if (!path) {
      return;
    }

    if (width === undefined) {
      path.style.removeProperty('stroke-width');
      return;
    }

    path.style.setProperty('stroke-width', `${width.toFixed(2)}pt`, 'important');
    this.styledFlowIds.add(flowId);
  }
}

function averageWait(metric: { visits: number; waitTime: number }): number {
  return metric.visits ? metric.waitTime / metric.visits : 0;
}

function isActivityMetric(type: string): boolean {
  return /Task$/.test(type) || ['bpmn:SubProcess', 'bpmn:CallActivity', 'bpmn:Transaction'].includes(type);
}

function isEventOrGatewayMetric(type: string): boolean {
  return /Event$/.test(type) || /Gateway$/.test(type);
}

function waitMarkerForIntensity(intensity: number): string {
  if (intensity >= 0.75) {
    return 'des-wait-critical';
  }

  if (intensity >= 0.5) {
    return 'des-wait-high';
  }

  if (intensity >= 0.25) {
    return 'des-wait-medium';
  }

  return 'des-wait-low';
}

function flowMarkerForIntensity(intensity: number): string {
  if (intensity >= 0.75) {
    return 'des-flow-critical';
  }

  if (intensity >= 0.5) {
    return 'des-flow-high';
  }

  if (intensity >= 0.25) {
    return 'des-flow-medium';
  }

  return 'des-flow-low';
}

function flowWidthForIntensity(intensity: number): number {
  return 0.5 + Math.max(0, Math.min(1, intensity)) * 2.5;
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

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function cssEscape(value: string): string {
  const css = globalThis.CSS as { escape?: (input: string) => string } | undefined;

  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, '\\$&');
}
