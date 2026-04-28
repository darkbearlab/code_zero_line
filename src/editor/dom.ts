/** Tiny DOM helpers — keep editor code free of framework dependencies. */

export interface ElAttrs {
  className?: string;
  id?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  placeholder?: string;
  text?: string;
  style?: Partial<CSSStyleDeclaration>;
  children?: ReadonlyArray<Node | string>;
  onclick?: (e: Event) => void;
  onchange?: (e: Event) => void;
  oninput?: (e: Event) => void;
}

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: ElAttrs,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (!attrs) return node;
  if (attrs.className !== undefined) node.className = attrs.className;
  if (attrs.id !== undefined) node.id = attrs.id;
  if (attrs.type !== undefined)
    (node as unknown as { type: string }).type = attrs.type;
  if (attrs.value !== undefined)
    (node as unknown as { value: string }).value = attrs.value;
  if (attrs.checked !== undefined)
    (node as unknown as { checked: boolean }).checked = attrs.checked;
  if (attrs.placeholder !== undefined)
    (node as unknown as { placeholder: string }).placeholder = attrs.placeholder;
  if (attrs.style) Object.assign(node.style, attrs.style);
  if (attrs.text !== undefined) node.textContent = attrs.text;
  if (attrs.children) {
    for (const c of attrs.children) {
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  if (attrs.onclick) node.addEventListener('click', attrs.onclick);
  if (attrs.onchange) node.addEventListener('change', attrs.onchange);
  if (attrs.oninput) node.addEventListener('input', attrs.oninput);
  return node;
};

/**
 * Pill-style multi-string input. Renders existing values as chips with an
 * `x` to remove; an inline text input adds new values on Enter or comma.
 * Calls `onChange` whenever the list mutates.
 */
export const pillInput = (
  initial: ReadonlyArray<string>,
  onChange: (next: string[]) => void,
  placeholder = '',
): HTMLDivElement => {
  const root = el('div', { className: 'pill-input' });
  let current = [...initial];

  const render = (): void => {
    root.innerHTML = '';
    for (const v of current) {
      const x = el('span', {
        className: 'x',
        text: '×',
        onclick: () => {
          current = current.filter((c) => c !== v);
          onChange(current);
          render();
        },
      });
      const pill = el('span', {
        className: 'pill',
        children: [document.createTextNode(v + ' '), x],
      });
      root.appendChild(pill);
    }
    const input = el('input', {
      type: 'text',
      placeholder,
    }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const v = input.value.trim();
        if (v && !current.includes(v)) {
          current = [...current, v];
          onChange(current);
          render();
        } else {
          input.value = '';
        }
      } else if (e.key === 'Backspace' && input.value === '' && current.length > 0) {
        current = current.slice(0, -1);
        onChange(current);
        render();
      }
    });
    root.appendChild(input);
  };

  render();
  return root;
};
