import type { SimulationResult } from '../des/types';

type Overlays = {
  add(elementId: string, overlay: { position: Record<string, number>; html: string }): string;
  remove(overlayId: string): void;
};

type Canvas = {
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
};

export class SimulationOverlays {
  private readonly overlays: Overlays;
  private readonly canvas: Canvas;
  private overlayIds: string[] = [];
  private markedElements = new Set<string>();

  constructor(overlays: Overlays, canvas: Canvas) {
    this.overlays = overlays;
    this.canvas = canvas;
  }

  clear(): void {
    for (const overlayId of this.overlayIds) {
      this.overlays.remove(overlayId);
    }

    this.overlayIds = [];

    for (const elementId of this.markedElements) {
      this.canvas.removeMarker(elementId, 'des-bottleneck');
      this.canvas.removeMarker(elementId, 'des-error-risk');
      this.canvas.removeMarker(elementId, 'des-active-path');
    }

    this.markedElements.clear();
  }

  render(result: SimulationResult): void {
    this.clear();

    const maxWait = Math.max(...result.elementMetrics.map((metric) => metric.waitTime), 0);
    const maxVisits = Math.max(...result.elementMetrics.map((metric) => metric.visits), 0);

    for (const metric of result.elementMetrics) {
      if (!metric.visits) {
        continue;
      }

      const errorRate = metric.visits ? metric.errors / metric.visits : 0;
      const avgWait = metric.visits ? metric.waitTime / metric.visits : 0;
      const intensity = maxVisits ? metric.visits / maxVisits : 0;

      if (maxWait > 0 && metric.waitTime / maxWait > 0.55) {
        this.addMarker(metric.elementId, 'des-bottleneck');
      }

      if (errorRate > 0.05 || metric.errors > 0) {
        this.addMarker(metric.elementId, 'des-error-risk');
      }

      this.addMarker(metric.elementId, 'des-active-path');
      this.addOverlay(metric.elementId, metric.visits, avgWait, errorRate, intensity);
    }
  }

  private addOverlay(elementId: string, visits: number, avgWait: number, errorRate: number, intensity: number): void {
    const heat = Math.round(35 + intensity * 65);
    const html = [
      `<div class="des-overlay" style="--heat:${heat}%">`,
      `<strong>${visits}</strong>`,
      `<span>${formatNumber(avgWait)}</span>`,
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
      // Some BPMN elements, for example collapsed internals, may not have a rendered shape.
    }
  }

  private addMarker(elementId: string, marker: string): void {
    try {
      this.canvas.addMarker(elementId, marker);
      this.markedElements.add(elementId);
    } catch {
      // Ignore model elements that are present semantically but not rendered on the canvas.
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
