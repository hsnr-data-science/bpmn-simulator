import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineOverlayRenderer } from '../../src/visualization/TimelineOverlayRenderer';
import type { VisualState } from '../../src/types/timeline';

test('TimelineOverlayRenderer renders idempotently and clears overlays', () => {
  installFakeDocument();

  const viewport = new FakeSvgElement('g');
  const markers = new Map<string, Set<string>>();
  const canvas = {
    getContainer: () => ({
      querySelector: () => viewport
    }) as unknown as HTMLElement,
    addMarker: (elementId: string, marker: string) => {
      const values = markers.get(elementId) ?? new Set<string>();

      values.add(marker);
      markers.set(elementId, values);
    },
    removeMarker: (elementId: string, marker: string) => {
      markers.get(elementId)?.delete(marker);
    }
  };
  const registry = {
    get: (elementId: string) => {
      if (elementId === 'task') {
        return { id: 'task', x: 100, y: 100, width: 100, height: 80 };
      }

      if (elementId === 'task-2') {
        return { id: 'task-2', x: 260, y: 100, width: 100, height: 80 };
      }

      if (elementId === 'flow') {
        return { id: 'flow', waypoints: [{ x: 150, y: 140 }, { x: 260, y: 140 }] };
      }

      if (elementId === 'next') {
        return { id: 'next', x: 260, y: 220, width: 100, height: 80 };
      }

      return undefined;
    }
  };
  const renderer = new TimelineOverlayRenderer(canvas, registry);
  const state: VisualState = {
    simulationTime: 1,
    activeElements: ['task'],
    completedElements: [],
    waitingTokens: [],
    warnings: [
      {
        id: 'warning',
        simulationTime: 1,
        elementId: 'task',
        message: 'Something happened'
      }
    ],
    tokens: [
      {
        tokenId: 't1',
        processInstanceId: 'case-1',
        elementId: 'task',
        status: 'active'
      },
      {
        tokenId: 't3',
        processInstanceId: 'case-3',
        elementId: 'task-2',
        status: 'active'
      },
      {
        tokenId: 't4',
        processInstanceId: 'case-4',
        elementId: 'task-2',
        status: 'active'
      },
      {
        tokenId: 't2',
        processInstanceId: 'case-1',
        status: 'moving',
        sourceElementId: 'task',
        targetElementId: 'next',
        sequenceFlowId: 'flow',
        movement: {
          sourceElementId: 'task',
          targetElementId: 'next',
          sequenceFlowId: 'flow',
          startTime: 1,
          endTime: 2,
          progress: 0.5
        }
      },
      {
        tokenId: 't5',
        processInstanceId: 'case-1',
        elementId: 'next',
        status: 'active'
      }
    ]
  };

  renderer.render(state);

  assert.equal(viewport.children.length, 1);
  const layer = viewport.children[0];

  assert.equal(layer.children.length, 4);
  assert.equal(layer.children[0].children[1].textContent, 'case-1');
  assert.ok(layer.children[0].attributes.get('class')?.includes('des-token-single'));
  assert.equal(layer.children[1].children[1].textContent, '2');
  assert.ok(layer.children[1].attributes.get('class')?.includes('des-token-aggregate'));
  assert.ok(!layer.children.some((child) => child.dataset.tokenIds?.includes('t5')));
  assert.ok(markers.get('task')?.has('des-token-current'));
  assert.ok(markers.get('flow')?.has('des-active-path'));

  renderer.render(state);

  assert.equal(viewport.children.length, 1);
  assert.equal(layer.children.length, 4);

  renderer.clear();

  assert.equal(layer.children.length, 0);
  assert.equal(markers.get('task')?.size ?? 0, 0);
  assert.equal(markers.get('flow')?.size ?? 0, 0);
});

function installFakeDocument(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElementNS: (_namespace: string, tagName: string) => new FakeSvgElement(tagName)
  };
}

class FakeSvgElement {
  readonly children: FakeSvgElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  textContent = '';
  parent: FakeSvgElement | undefined;
  isConnected = true;

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...children: FakeSvgElement[]): void {
    for (const child of children) {
      this.appendChild(child);
    }
  }

  appendChild(child: FakeSvgElement): FakeSvgElement {
    child.parent = this;
    this.children.push(child);

    return child;
  }

  replaceChildren(...children: FakeSvgElement[]): void {
    this.children.splice(0, this.children.length);

    for (const child of children) {
      this.appendChild(child);
    }
  }

  remove(): void {
    if (!this.parent) {
      return;
    }

    const index = this.parent.children.indexOf(this);

    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
  }
}
