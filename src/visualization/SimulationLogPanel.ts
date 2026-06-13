import type { SimulationLogEntry } from '../types/simulation';

export class SimulationLogPanel {
  private readonly list: HTMLUListElement;

  constructor(list: HTMLUListElement) {
    this.list = list;
  }

  render(entries: SimulationLogEntry[]): void {
    const visibleEntries = entries.length
      ? entries
      : [
          {
            level: 'info' as const,
            message: 'Keine Warnungen'
          }
        ];

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
  if (value >= 100) {
    return value.toFixed(0);
  }

  if (value >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}
