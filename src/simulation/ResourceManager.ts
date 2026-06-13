import type { SimNode } from '../types/bpmn';
import type { Token } from '../types/simulation';

export type QueuedTask = {
  token: Token;
  node: SimNode;
  arrivedAt: number;
};

export type ResourceStart = {
  started: boolean;
  resourceId?: string;
};

type ResourceState = {
  id: string;
  capacity: number;
  busy: number;
  queue: QueuedTask[];
};

export class ResourceManager {
  private resources = new Map<string, ResourceState>();

  request(node: SimNode, token: Token, time: number): ResourceStart {
    const resource = this.getResource(node);

    if (!resource) {
      return { started: true };
    }

    if (resource.busy < resource.capacity) {
      resource.busy += 1;

      return {
        started: true,
        resourceId: resource.id
      };
    }

    resource.queue.push({
      token,
      node,
      arrivedAt: time
    });

    return {
      started: false,
      resourceId: resource.id
    };
  }

  release(resourceId: string | undefined): QueuedTask[] {
    if (!resourceId) {
      return [];
    }

    const resource = this.resources.get(resourceId);

    if (!resource) {
      return [];
    }

    resource.busy = Math.max(0, resource.busy - 1);

    const released: QueuedTask[] = [];

    while (resource.queue.length && resource.busy < resource.capacity) {
      const next = resource.queue.shift();

      if (!next) {
        break;
      }

      resource.busy += 1;
      released.push(next);
    }

    return released;
  }

  private getResource(node: SimNode): ResourceState | undefined {
    const resourceId = node.params.resource?.resourceId?.trim();
    const capacity = node.params.resource?.capacity ?? (resourceId ? 1 : undefined);

    if (!resourceId || !capacity || capacity <= 0) {
      return undefined;
    }

    const existing = this.resources.get(resourceId);

    if (existing) {
      return existing;
    }

    const resource = {
      id: resourceId,
      capacity,
      busy: 0,
      queue: []
    };

    this.resources.set(resourceId, resource);

    return resource;
  }
}
