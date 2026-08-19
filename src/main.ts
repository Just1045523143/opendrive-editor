import './ui/styles.css';
import { App } from './editor/app.ts';

function boot(): void {
  try {
    // 挂到 window 便于在浏览器控制台排查
    (window as unknown as { app: App }).app = new App();
  } catch (e) {
    const msg = (e as Error).message;
    document.body.innerHTML = `<pre style="padding:24px;color:#e86b6b;font:13px ui-monospace,monospace">启动失败：${msg}\n\n${(e as Error).stack ?? ''}</pre>`;
    throw e;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
