import type { SimulationResult } from '../types/simulation';
import { TokenOverlayManager } from './TokenOverlayManager';

type Overlays = {
  add(elementId: string, overlay: { position: Record<string, number>; html: string }): string;
  remove(overlayId: string): void;
};

type Canvas = {
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
};

export class HeatmapOverlayManager {
  private readonly overlays: Overlays;
  private readonly canvas: Canvas;
  private readonly tokenOverlays: TokenOverlayManager;
  private overlayIds: string[] = [];
  private heatmapMarkers = new Map<string, Set<string>>();

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

    const maxWait = Math.max(...result.elementMetrics.map((metric) => metric.waitTime), 0);
    const maxService = Math.max(...result.elementMetrics.map((metric) => metric.serviceTime), 0);
    const maxVisits = Math.max(...result.elementMetrics.map((metric) => metric.visits), 0);

    for (const unsupportedId of result.unsupportedElementIds) {
      this.tokenOverlays.markUnsupported(unsupportedId);
    }

    for (const metric of result.elementMetrics) {
      if (!metric.visits) {
        continue;
      }

      const errorRate = metric.visits ? metric.errors / metric.visits : 0;
      const avgWait = metric.visits ? metric.waitTime / metric.visits : 0;
      const avgService = metric.completions ? metric.serviceTime / metric.completions : 0;
      const intensity = maxVisits ? metric.visits / maxVisits : 0;

      if (maxWait > 0 && metric.waitTime / maxWait > 0.55) {
        this.addMarker(metric.elementId, 'des-bottleneck');
      }

      if (maxService > 0 && metric.serviceTime / maxService > 0.55) {
        this.tokenOverlays.markCurrentTask(metric.elementId);
      }

      if (metric.unsupported) {
        this.tokenOverlays.markUnsupported(metric.elementId);
      }

      if (errorRate > 0.05 || metric.errors > 0) {
        this.addMarker(metric.elementId, 'des-error-risk');
      }

      this.tokenOverlays.markActive(metric.elementId);
      this.addOverlay(metric.elementId, metric.visits, avgWait, avgService, errorRate, intensity);
    }
  }

  private addOverlay(
    elementId: string,
    visits: number,
    avgWait: number,
    avgService: number,
    errorRate: number,
    intensity: number
  ): void {
    const heat = Math.round(35 + intensity * 65);
    const html = [
      `<div class="des-overlay" style="--heat:${heat}%">`,
      `<strong title="Token count">${visits}</strong>`,
      `<span title="Mean wait">W ${formatNumber(avgWait)}</span>`,
      `<span title="Mean service">S ${formatNumber(avgService)}</span>`,
      errorRate ? `<em>${Math.round(errorRate * 100)}%</em>` : '',
      '</div>'
    ].join('');

    try {
      const overlayId = this.overlays.add(elementId, {
        position: {
          top: -18,
          right: -12
        },
        html
      });

      this.overlayIds.push(overlayId);
    } catch {
      // Some semantic elements are intentionally invisible on the BPMN canvas.
    }
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
