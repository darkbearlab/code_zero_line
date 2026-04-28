import { mountWeaponEditor } from './weaponEditor';
import { mountUnitEditor } from './unitEditor';
import { mountMapEditor } from './mapEditor';

type Tab = 'weapons' | 'units' | 'maps';

const main = document.getElementById('editor-main')!;
const tabs = document.querySelectorAll<HTMLButtonElement>('header .tab');

const setActive = (tab: Tab): void => {
  tabs.forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  main.innerHTML = '';
  if (tab === 'weapons') mountWeaponEditor(main);
  else if (tab === 'units') mountUnitEditor(main);
  else mountMapEditor(main);
  // Persist last tab selection.
  try {
    localStorage.setItem('czl.editor.lastTab', tab);
  } catch {
    /* ignore */
  }
};

tabs.forEach((b) => {
  b.addEventListener('click', () => setActive(b.dataset.tab as Tab));
});

const initialTab =
  (localStorage.getItem('czl.editor.lastTab') as Tab | null) ?? 'weapons';
setActive(initialTab);
