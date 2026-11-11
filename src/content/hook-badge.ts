/** Safari prototype only: an on-screen readout of what the MSE hook has seen (no web inspector on a phone). */
export function mountHookBadge(lines: () => string[]): void {
  let el: HTMLDivElement | null = null;
  setInterval(() => {
    if (!el) {
      if (!document.body) return;
      el = document.createElement('div');
      el.style.cssText =
        'position:fixed;left:4px;bottom:4px;z-index:2147483647;max-width:96vw;padding:4px 6px;border-radius:6px;' +
        'background:rgba(0,0,0,.8);color:#7CFC00;font:10px/1.3 ui-monospace,monospace;white-space:pre-wrap;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = lines().join('\n');
  }, 500);
}
