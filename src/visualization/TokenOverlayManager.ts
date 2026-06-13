type Canvas = {
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
};

export class TokenOverlayManager {
  private readonly canvas: Canvas;
  private markedElements = new Map<string, Set<string>>();

  constructor(canvas: Canvas) {
    this.canvas = canvas;
  }

  markActive(elementId: string): void {
    this.addMarker(elementId, 'des-active-path');
  }

  markUnsupported(elementId: string): void {
    this.addMarker(elementId, 'des-unsupported');
  }

  markCurrentTask(elementId: string): void {
    this.addMarker(elementId, 'des-current-task');
  }

  clear(): void {
    for (const [elementId, markers] of this.markedElements.entries()) {
      for (const marker of markers) {
        this.canvas.removeMarker(elementId, marker);
      }
    }

    this.markedElements.clear();
  }

  private addMarker(elementId: string, marker: string): void {
    try {
      this.canvas.addMarker(elementId, marker);
      const markers = this.markedElements.get(elementId) ?? new Set<string>();
      markers.add(marker);
      this.markedElements.set(elementId, markers);
    } catch {
      // Semantic BPMN elements do not always have rendered diagram shapes.
    }
  }
}
