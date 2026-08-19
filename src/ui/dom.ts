/** 轻量 DOM 构建助手。不引框架，避免 canvas 与虚拟 DOM 之间的状态同步开销。 */

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | null | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (k === 'text') {
      node.textContent = String(v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.textContent = '';
}

/** 数值输入行 */
export function numberRow(
  label: string,
  value: number,
  onChange: (v: number) => void,
  opts: { min?: number; max?: number; step?: number; title?: string } = {},
): HTMLElement {
  const input = el('input', {
    type: 'number',
    value: String(round(value)),
    ...(opts.min !== undefined ? { min: String(opts.min) } : {}),
    ...(opts.max !== undefined ? { max: String(opts.max) } : {}),
    step: String(opts.step ?? 'any'),
    onchange: (e: Event) => {
      const raw = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(raw)) onChange(raw);
    },
  });
  return el('div', { class: 'row', ...(opts.title ? { title: opts.title } : {}) },
    el('label', { text: label }),
    input,
  );
}

/** 文本输入行 */
export function textRow(
  label: string,
  value: string,
  onChange: (v: string) => void,
  title?: string,
): HTMLElement {
  const input = el('input', {
    type: 'text',
    value,
    onchange: (e: Event) => onChange((e.target as HTMLInputElement).value),
  });
  return el('div', { class: 'row', ...(title ? { title } : {}) },
    el('label', { text: label }),
    input,
  );
}

/** 下拉选择行 */
export function selectRow<T extends string>(
  label: string,
  value: T,
  options: ReadonlyArray<{ value: T; label: string }>,
  onChange: (v: T) => void,
  title?: string,
): HTMLElement {
  const select = el('select', {
    onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T),
  });
  for (const o of options) {
    select.append(
      el('option', { value: o.value, ...(o.value === value ? { selected: true } : {}) }, o.label),
    );
  }
  return el('div', { class: 'row', ...(title ? { title } : {}) },
    el('label', { text: label }),
    select,
  );
}

/** 复选框行 */
export function checkRow(
  label: string,
  checked: boolean,
  onChange: (v: boolean) => void,
  title?: string,
): HTMLElement {
  const input = el('input', {
    type: 'checkbox',
    ...(checked ? { checked: true } : {}),
    onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
  });
  return el('label', { class: 'check-row', ...(title ? { title } : {}) }, input, label);
}

/** 键值对表格 */
export function kv(pairs: ReadonlyArray<[string, string]>): HTMLElement {
  const box = el('div', { class: 'kv' });
  for (const [k, v] of pairs) {
    box.append(el('span', { text: k }), el('span', { text: v }));
  }
  return box;
}

/** 可折叠面板 */
export function panel(
  title: string,
  body: HTMLElement,
  opts: { collapsed?: boolean; right?: HTMLElement } = {},
): HTMLElement {
  const wrap = el('section', { class: `panel${opts.collapsed ? ' collapsed' : ''}` });
  const head = el('h3', {}, el('span', { text: title }), opts.right ?? null);
  head.addEventListener('click', (e) => {
    // 点击标题右侧的控件时不触发折叠
    if (opts.right && opts.right.contains(e.target as Node)) return;
    wrap.classList.toggle('collapsed');
  });
  wrap.append(head, el('div', { class: 'panel-body' }, body));
  return wrap;
}

export function button(
  label: string,
  onClick: () => void,
  opts: { primary?: boolean; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  return el('button', {
    class: opts.primary ? 'primary' : '',
    ...(opts.disabled ? { disabled: true } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    onclick: onClick,
  }, label);
}

/** 保留 6 位有效小数，避免输入框里出现浮点噪声 */
function round(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1e6) / 1e6;
}

/** 触发文件下载 */
export function downloadText(filename: string, text: string, mime = 'application/xml'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  // 立即释放会在部分浏览器上中断下载，延后回收
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 打开文件选择对话框并读取文本 */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept });
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        input.remove();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        resolve({ name: file.name, text: String(reader.result ?? '') });
        input.remove();
      };
      reader.onerror = () => {
        resolve(null);
        input.remove();
      };
      reader.readAsText(file);
    });
    document.body.append(input);
    input.click();
  });
}
