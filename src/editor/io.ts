/**
 * Browser file IO helpers for the editor's Export / Import buttons.
 *
 * `downloadJson` triggers a one-click download. `pickJsonFile` opens the
 * native file picker and resolves with the parsed JSON. Both are framework-
 * free DOM glue — kept in one place so the three editor tabs can share it.
 */
export const downloadJson = (filename: string, data: unknown): void => {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick — Firefox needs the URL alive long enough for the
  // click to register.
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/**
 * Open a hidden <input type="file"> picker. Resolves with the JSON-parsed
 * file content, or `null` if the user cancelled.
 */
export const pickJsonFile = (): Promise<unknown | null> => {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.onchange = (): void => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = (): void => {
        try {
          const text = String(reader.result ?? '');
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e);
        } finally {
          input.remove();
        }
      };
      reader.onerror = (): void => {
        reject(reader.error);
        input.remove();
      };
      reader.readAsText(file);
    };
    // Cancel — the picker doesn't fire change. Detect by polling on focus
    // returning to the document; resolve null so the caller can ignore.
    const onFocus = (): void => {
      window.removeEventListener('focus', onFocus);
      // Give the change handler a chance to fire first.
      setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          resolve(null);
          input.remove();
        }
      }, 200);
    };
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
};

export const timestampForFilename = (): string => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
};
