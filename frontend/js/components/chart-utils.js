let libraryPromise = null;

/** Keep plot surfaces, labels and grid lines in the same semantic theme as cards. */
export function chartThemeColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    bgColor: styles.getPropertyValue('--color-bg-elevated').trim(),
    textColor: styles.getPropertyValue('--color-text-secondary').trim(),
    gridColor: styles.getPropertyValue('--color-divider').trim(),
  };
}

/** A shared in-flight library load prevents duplicate downloads during mode/screen switches. */
export function ensureLightCharts() {
  if (typeof LightweightCharts !== 'undefined') return Promise.resolve();
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise(resolve => {
    const existing = document.querySelector('script[src*="lightweight-charts"]');
    const script = existing || document.createElement('script');
    const finish = () => {
      clearTimeout(timeout);
      script.removeEventListener('load', finish);
      script.removeEventListener('error', finish);
      if (typeof LightweightCharts === 'undefined') {
        script.remove();
        libraryPromise = null;
        console.error('[Chart] Unable to load LightweightCharts');
      }
      resolve();
    };
    const timeout = setTimeout(finish, 20000);
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', finish, { once: true });
    if (!existing) {
      script.src = 'https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js';
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return libraryPromise;
}

export function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
