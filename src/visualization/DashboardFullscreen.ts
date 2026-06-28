export function bindDashboardFullscreen(root: HTMLElement, resize: () => void): void {
  root.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-dashboard-fullscreen]');

    if (!button) {
      return;
    }

    const section = button.closest<HTMLElement>('.dashboard-chart-section');

    if (!section) {
      return;
    }

    void toggleFullscreen(section, resize);
  });

  document.addEventListener('fullscreenchange', () => {
    requestAnimationFrame(() => resize());
  });
}

async function toggleFullscreen(section: HTMLElement, resize: () => void): Promise<void> {
  if (document.fullscreenElement === section) {
    await document.exitFullscreen();
    requestAnimationFrame(() => resize());
    return;
  }

  await section.requestFullscreen();
  requestAnimationFrame(() => resize());
}
