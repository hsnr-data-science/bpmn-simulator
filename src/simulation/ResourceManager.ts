import type { SimNode } from '../types/bpmn';
import type { ResourceConfig, Token } from '../types/simulation';
import { nextResourceAvailability } from './ResourceCalendar';

export type QueuedTask = {
  token: Token;
  node: SimNode;
  arrivedAt: number;
  preferredResourceInstanceId?: string;
};

export type ResourceStart = {
  started: boolean;
  resourceId?: string;
  resourceInstanceId?: string;
  delayedUntil?: number;
};

type ResourceState = {
  id: string;
  capacity: number;
  schedule?: ResourceConfig;
  busy: number;
  instances: string[];
  busyInstances: Set<string>;
  queue: QueuedTask[];
};

export class ResourceManager {
  private resources = new Map<string, ResourceState>();

  request(
    node: SimNode,
    token: Token,
    time: number,
    preferredResourceInstanceId?: string,
    arrivedAt = time
  ): ResourceStart {
    const resource = this.getResource(node);

    if (!resource) {
      return { started: true };
    }

    const availableAt = nextResourceAvailability(resource.schedule, time);

    if (availableAt > time) {
      return {
        started: false,
        resourceId: resource.id,
        delayedUntil: availableAt
      };
    }

    if (resource.busy < resource.capacity && isPreferredInstanceAvailable(resource, preferredResourceInstanceId)) {
      resource.busy += 1;
      const resourceInstanceId = allocateResourceInstance(resource, preferredResourceInstanceId);

      return {
        started: true,
        resourceId: resource.id,
        resourceInstanceId
      };
    }

    resource.queue.push({
      token,
      node,
      arrivedAt,
      preferredResourceInstanceId
    });

    return {
      started: false,
      resourceId: resource.id
    };
  }

  release(resourceId: string | undefined, resourceInstanceId?: string): QueuedTask[] {
    if (!resourceId) {
      return [];
    }

    const resource = this.resources.get(resourceId);

    if (!resource) {
      return [];
    }

    resource.busy = Math.max(0, resource.busy - 1);

    if (resourceInstanceId) {
      resource.busyInstances.delete(resourceInstanceId);
    } else {
      const firstBusy = resource.busyInstances.values().next().value as string | undefined;

      if (firstBusy) {
        resource.busyInstances.delete(firstBusy);
      }
    }

    const released: QueuedTask[] = [];

    const freeSlots = Math.max(0, resource.capacity - resource.busy);

    while (resource.queue.length && released.length < freeSlots) {
      const nextIndex = resource.queue.findIndex((candidate) => {
        return isPreferredInstanceAvailable(resource, candidate.preferredResourceInstanceId);
      });

      if (nextIndex < 0) {
        break;
      }

      const next = resource.queue.splice(nextIndex, 1)[0];

      if (!next) {
        break;
      }

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
      schedule: node.params.resource,
      busy: 0,
      instances: createResourceInstances(resourceId, node.params.resource?.resourceName, capacity),
      busyInstances: new Set<string>(),
      queue: []
    };

    this.resources.set(resourceId, resource);

    return resource;
  }
}

function isPreferredInstanceAvailable(
  resource: ResourceState,
  preferredResourceInstanceId: string | undefined
): boolean {
  return !preferredResourceInstanceId || (
    resource.instances.includes(preferredResourceInstanceId) &&
    !resource.busyInstances.has(preferredResourceInstanceId)
  );
}

function allocateResourceInstance(
  resource: ResourceState,
  preferredResourceInstanceId?: string
): string | undefined {
  const instance = preferredResourceInstanceId && isPreferredInstanceAvailable(resource, preferredResourceInstanceId)
    ? preferredResourceInstanceId
    : resource.instances.find((candidate) => !resource.busyInstances.has(candidate));

  if (!instance) {
    return undefined;
  }

  resource.busyInstances.add(instance);

  return instance;
}

function createResourceInstances(
  resourceId: string,
  resourceName: string | undefined,
  capacity: number
): string[] {
  const count = Math.max(1, Math.floor(capacity));
  const label = (resourceName || resourceId).trim() || resourceId;

  if (count === 1) {
    return [label];
  }

  return Array.from({ length: count }, (_, index) => `${label} #${index + 1}`);
}
