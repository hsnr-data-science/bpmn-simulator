import type { SimulationLogEntry } from '../types/simulation';

export class SimulationLogPanel {
  private readonly list: HTMLUListElement;
  private readonly emptyMessage: string;
  private readonly maxEntries: number;

  constructor(list: HTMLUListElement, emptyMessage = 'No entries', maxEntries = 250) {
    this.list = list;
    this.emptyMessage = emptyMessage;
    this.maxEntries = maxEntries;
  }

  render(entries: SimulationLogEntry[]): void {
    const visibleEntries = (entries.length
      ? entries
      : [
          {
            level: 'info' as const,
            message: this.emptyMessage
          }
        ]).slice(-this.maxEntries);

    this.list.replaceChildren(
      ...visibleEntries.map((entry) => {
        const item = document.createElement('li');
        const prefix = [
          entry.time === undefined ? undefined : `t=${formatTime(entry.time)}`,
          entry.eventType,
          entry.caseId === undefined ? undefined : `case=${entry.caseId}`,
          entry.elementName ?? entry.elementId
        ]
          .filter(Boolean)
          .join(' | ');

        item.dataset.level = entry.level;
        item.textContent = prefix ? `${prefix}: ${entry.message}` : entry.message;

        return item;
      })
    );
  }
}

function formatTime(value: number): string {
  const minutes = Math.round(Math.max(0, value) * 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  const parts = [
    days ? `${days}d` : undefined,
    hours ? `${hours}h` : undefined,
    remainingMinutes || (!days && !hours) ? `${remainingMinutes}m` : undefined
  ].filter(Boolean);

  return parts.join(' ');
}
