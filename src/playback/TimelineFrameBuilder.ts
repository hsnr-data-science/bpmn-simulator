import type { SimulationEvent, TimelineFrame } from '../types/timeline';

export class TimelineFrameBuilder {
  buildFrames(events: SimulationEvent[], epsilon = 0): TimelineFrame[] {
    const tolerance = Math.max(0, epsilon);
    const sorted = events
      .map((event, index) => ({ event, index }))
      .sort((left, right) => {
        const timeDiff = left.event.simulationTime - right.event.simulationTime;

        if (Math.abs(timeDiff) > Number.EPSILON) {
          return timeDiff;
        }

        const sequenceDiff = left.event.sequence - right.event.sequence;

        return sequenceDiff || left.index - right.index;
      })
      .map((entry) => entry.event);
    const frames: TimelineFrame[] = [];

    for (const event of sorted) {
      const current = frames.at(-1);

      if (current && event.simulationTime - current.simulationTime <= tolerance) {
        current.events.push(event);
        current.sequenceStart = Math.min(current.sequenceStart, event.sequence);
        current.sequenceEnd = Math.max(current.sequenceEnd, event.sequence);
        continue;
      }

      frames.push({
        simulationTime: event.simulationTime,
        events: [event],
        sequenceStart: event.sequence,
        sequenceEnd: event.sequence
      });
    }

    return frames;
  }
}
