import type { SimulationEvent, SimulationEventType } from '../types/simulation';

export class EventQueue {
  private heap: SimulationEvent[] = [];
  private sequence = 0;

  get length(): number {
    return this.heap.length;
  }

  schedule<TPayload>(type: SimulationEventType, time: number, payload: TPayload): SimulationEvent<TPayload> {
    const event: SimulationEvent<TPayload> = {
      id: this.sequence++,
      type,
      time,
      payload
    };

    this.heap.push(event);
    this.bubbleUp(this.heap.length - 1);

    return event;
  }

  pop(): SimulationEvent | undefined {
    if (!this.heap.length) {
      return undefined;
    }

    const first = this.heap[0];
    const last = this.heap.pop();

    if (last && this.heap.length) {
      this.heap[0] = last;
      this.sinkDown(0);
    }

    return first;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);

      if (compare(this.heap[parentIndex], this.heap[index]) <= 0) {
        break;
      }

      this.swap(parentIndex, index);
      index = parentIndex;
    }
  }

  private sinkDown(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      if (left < this.heap.length && compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }

      if (right < this.heap.length && compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }

      if (smallest === index) {
        break;
      }

      this.swap(index, smallest);
      index = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a];
    this.heap[a] = this.heap[b];
    this.heap[b] = tmp;
  }
}

function compare(a: SimulationEvent, b: SimulationEvent): number {
  if (a.time !== b.time) {
    return a.time - b.time;
  }

  return a.id - b.id;
}
