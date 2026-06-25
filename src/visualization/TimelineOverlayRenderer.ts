import type { VisualState, VisualTokenState, VisualWarning } from '../types/timeline';

type Canvas = {
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
  getContainer(): HTMLElement;
};

type DiagramElement = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  waypoints?: Array<{ x: number; y: number }>;
};

type ElementRegistry = {
  get(elementId: string): DiagramElement | undefined;
};

type Point = {
  x: number;
  y: number;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_MARKER = 'des-token-current';
const TASK_MARKER = 'des-current-task';
const ACTIVE_FLOW_MARKER = 'des-active-path';
const WARNING_MARKER = 'des-error-risk';

export class TimelineOverlayRenderer {
  private readonly canvas: Canvas;
  private readonly elementRegistry: ElementRegistry;
  private tokenLayer?: SVGGElement;
  private markedElements = new Map<string, Set<string>>();

  constructor(canvas: Canvas, elementRegistry: ElementRegistry) {
    this.canvas = canvas;
    this.elementRegistry = elementRegistry;
  }

  render(state: VisualState): void {
    this.clear();
    this.renderMarkers(state);
    this.renderTokens(state);
  }

  clear(): void {
    this.tokenLayer?.replaceChildren();

    for (const [elementId, markers] of this.markedElements.entries()) {
      for (const marker of markers) {
        try {
          this.canvas.removeMarker(elementId, marker);
        } catch {
          // Some semantic BPMN elements have no rendered diagram shape.
        }
      }
    }

    this.markedElements.clear();
  }

  private renderMarkers(state: VisualState): void {
    for (const elementId of state.activeElements) {
      this.mark(elementId, NODE_MARKER);

      if (isTaskLike(this.elementRegistry.get(elementId))) {
        this.mark(elementId, TASK_MARKER);
      }
    }

    for (const token of state.tokens) {
      if (token.status === 'moving' && token.sequenceFlowId) {
        this.mark(token.sequenceFlowId, ACTIVE_FLOW_MARKER);
      }

      if (token.status === 'waiting' && token.elementId) {
        this.mark(token.elementId, NODE_MARKER);
      }
    }

    for (const warning of state.warnings) {
      if (warning.elementId) {
        this.mark(warning.elementId, WARNING_MARKER);
      }
    }
  }

  private renderTokens(state: VisualState): void {
    const layer = this.getTokenLayer();

    if (!layer) {
      return;
    }

    layer.replaceChildren();

    for (const group of groupNodeTokens(state.tokens)) {
      const element = this.elementRegistry.get(group.elementId);
      const center = centerOf(element);

      if (!center) {
        continue;
      }

      const offset = group.status === 'waiting' ? { x: 0, y: 16 } : { x: 0, y: 0 };

      layer.appendChild(createTokenGroup({
        className: tokenClass('des-node-token', group.tokens, group.status),
        point: {
          x: center.x + offset.x,
          y: center.y + offset.y
        },
        label: tokenLabel(group.tokens),
        tokenIds: group.tokens.map((token) => token.tokenId)
      }));
    }

    for (const group of groupMovingTokens(state.tokens)) {
      const point = movementPoint(group.tokens[0], this.elementRegistry);

      if (!point) {
        continue;
      }

      layer.appendChild(createTokenGroup({
        className: tokenClass('des-flow-token', group.tokens),
        point,
        label: tokenLabel(group.tokens),
        tokenIds: group.tokens.map((token) => token.tokenId)
      }));
    }

    for (const warning of latestWarningsByElement(state.warnings)) {
      const element = warning.elementId ? this.elementRegistry.get(warning.elementId) : undefined;
      const center = centerOf(element);

      if (!center) {
        continue;
      }

      layer.appendChild(createWarningGroup(warning, {
        x: center.x + ((element?.width ?? 0) / 2) - 2,
        y: center.y - ((element?.height ?? 0) / 2) + 2
      }));
    }
  }

  private getTokenLayer(): SVGGElement | undefined {
    if (this.tokenLayer?.isConnected) {
      return this.tokenLayer;
    }

    const viewport = this.canvas.getContainer().querySelector<SVGGElement>('svg .viewport');

    if (!viewport) {
      return undefined;
    }

    this.tokenLayer = document.createElementNS(SVG_NS, 'g');
    this.tokenLayer.setAttribute('class', 'des-timeline-tokens');
    viewport.appendChild(this.tokenLayer);

    return this.tokenLayer;
  }

  private mark(elementId: string, marker: string): void {
    try {
      this.canvas.addMarker(elementId, marker);
      const markers = this.markedElements.get(elementId) ?? new Set<string>();

      markers.add(marker);
      this.markedElements.set(elementId, markers);
    } catch {
      // Some semantic BPMN elements have no rendered diagram shape.
    }
  }
}

function groupNodeTokens(tokens: VisualTokenState[]): Array<{
  elementId: string;
  status: VisualTokenState['status'];
  tokens: VisualTokenState[];
}> {
  const groups = new Map<string, { elementId: string; status: VisualTokenState['status']; tokens: VisualTokenState[] }>();
  const movingDestinations = new Set(
    tokens
      .filter((token) => token.status === 'moving' && token.targetElementId)
      .map((token) => `${token.processInstanceId}:${token.targetElementId}`)
  );

  for (const token of tokens) {
    if (!token.elementId || token.status === 'moving' || token.status === 'completed' || token.status === 'terminated') {
      continue;
    }

    if (movingDestinations.has(`${token.processInstanceId}:${token.elementId}`)) {
      continue;
    }

    const key = `${token.elementId}:${token.status}`;
    const group = groups.get(key) ?? {
      elementId: token.elementId,
      status: token.status,
      tokens: []
    };

    group.tokens.push(token);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function groupMovingTokens(tokens: VisualTokenState[]): Array<{ key: string; tokens: VisualTokenState[] }> {
  const groups = new Map<string, { key: string; tokens: VisualTokenState[] }>();

  for (const token of tokens) {
    if (token.status !== 'moving' || !token.movement) {
      continue;
    }

    const key = [
      token.sequenceFlowId,
      token.sourceElementId,
      token.targetElementId,
      Math.round(token.movement.progress * 100) / 100
    ].join(':');
    const group = groups.get(key) ?? { key, tokens: [] };

    group.tokens.push(token);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function movementPoint(token: VisualTokenState, elementRegistry: ElementRegistry): Point | undefined {
  const movement = token.movement;

  if (!movement) {
    return undefined;
  }

  if (movement.sequenceFlowId) {
    const flow = elementRegistry.get(movement.sequenceFlowId);

    if (flow?.waypoints?.length) {
      return pointAt(createPolylinePath(flow.waypoints), movement.progress);
    }
  }

  const source = centerOf(elementRegistry.get(movement.sourceElementId));
  const target = centerOf(elementRegistry.get(movement.targetElementId));

  if (!source || !target) {
    return source ?? target;
  }

  return {
    x: source.x + (target.x - source.x) * movement.progress,
    y: source.y + (target.y - source.y) * movement.progress
  };
}

function createTokenGroup(options: {
  className: string;
  point: Point;
  label: string;
  tokenIds: string[];
}): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g');
  const circle = document.createElementNS(SVG_NS, 'circle');
  const text = document.createElementNS(SVG_NS, 'text');

  group.setAttribute('class', options.className);
  group.setAttribute('transform', `translate(${formatCoordinate(options.point.x)}, ${formatCoordinate(options.point.y)})`);
  group.dataset.tokenIds = options.tokenIds.join(' ');
  circle.setAttribute('r', '11');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.textContent = options.label;
  group.append(circle, text);

  return group;
}

function tokenClass(
  baseClass: string,
  tokens: VisualTokenState[],
  status?: VisualTokenState['status']
): string {
  return [
    baseClass,
    tokens.length === 1 ? 'des-token-single' : 'des-token-aggregate',
    status === 'waiting' ? 'des-token-waiting' : undefined
  ].filter(Boolean).join(' ');
}

function tokenLabel(tokens: VisualTokenState[]): string {
  if (tokens.length === 1) {
    return tokens[0]?.processInstanceId ?? tokens[0]?.tokenId ?? '1';
  }

  return String(tokens.length);
}

function createWarningGroup(warning: VisualWarning, point: Point): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g');
  const rect = document.createElementNS(SVG_NS, 'rect');
  const text = document.createElementNS(SVG_NS, 'text');

  group.setAttribute('class', 'des-warning-token');
  group.setAttribute('transform', `translate(${formatCoordinate(point.x)}, ${formatCoordinate(point.y)})`);
  group.dataset.warningId = warning.id;
  rect.setAttribute('x', '-9');
  rect.setAttribute('y', '-9');
  rect.setAttribute('width', '18');
  rect.setAttribute('height', '18');
  rect.setAttribute('rx', '4');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.textContent = '!';
  group.append(rect, text);

  return group;
}

function latestWarningsByElement(warnings: VisualWarning[]): VisualWarning[] {
  const warningsByElement = new Map<string, VisualWarning>();

  for (const warning of warnings) {
    if (!warning.elementId) {
      continue;
    }

    warningsByElement.set(warning.elementId, warning);
  }

  return [...warningsByElement.values()];
}

function centerOf(element: DiagramElement | undefined): Point | undefined {
  if (!element) {
    return undefined;
  }

  if (element.x !== undefined && element.y !== undefined && element.width !== undefined && element.height !== undefined) {
    return {
      x: element.x + element.width / 2,
      y: element.y + element.height / 2
    };
  }

  if (element.waypoints?.length) {
    return element.waypoints[Math.floor(element.waypoints.length / 2)];
  }

  return undefined;
}

type PolylineSegment = {
  start: Point;
  end: Point;
  length: number;
  startLength: number;
};

function createPolylinePath(waypoints: Point[]): { segments: PolylineSegment[]; totalLength: number } {
  const segments: PolylineSegment[] = [];
  let totalLength = 0;

  for (let index = 1; index < waypoints.length; index += 1) {
    const start = waypoints[index - 1];
    const end = waypoints[index];
    const length = Math.hypot(end.x - start.x, end.y - start.y);

    segments.push({
      start,
      end,
      length,
      startLength: totalLength
    });
    totalLength += length;
  }

  return {
    segments,
    totalLength
  };
}

function pointAt(path: { segments: PolylineSegment[]; totalLength: number }, progress: number): Point {
  const targetLength = path.totalLength * Math.max(0, Math.min(1, progress));
  const segment = path.segments.find((candidate) => {
    return candidate.startLength + candidate.length >= targetLength;
  }) ?? path.segments.at(-1);

  if (!segment || segment.length === 0) {
    return {
      x: 0,
      y: 0
    };
  }

  const localProgress = Math.max(0, Math.min(1, (targetLength - segment.startLength) / segment.length));

  return {
    x: segment.start.x + (segment.end.x - segment.start.x) * localProgress,
    y: segment.start.y + (segment.end.y - segment.start.y) * localProgress
  };
}

function isTaskLike(element: DiagramElement | undefined): boolean {
  return Boolean(element && element.width && element.height && element.width >= 80 && element.height >= 50);
}

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0';
}
