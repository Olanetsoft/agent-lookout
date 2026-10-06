/**
 * A `Storage` held in memory, put in the place of the frame's `localStorage`.
 *
 * The landing page and its dashboard share an address, so they would share
 * local storage, and the dashboard keeps its own choices under keys the page
 * reads too, the theme's among them. Kept in memory, nothing a visitor does in
 * the dashboard outlasts the page, and the page's own choices are never
 * touched.
 */

export class MemoryStorage implements Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem" | "clear"
> {
  #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#items.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.#items.delete(String(key));
  }

  clear(): void {
    this.#items.clear();
  }

  /** Puts back exactly these items, and nothing else. */
  fill(items: Readonly<Record<string, string>>): void {
    this.#items = new Map(Object.entries(items));
  }
}

/**
 * Puts a `MemoryStorage` in the place of `window.localStorage`, before
 * anything reads it, and gives it back.
 */
export function installMemoryStorage(
  target: Window = window,
  items: Readonly<Record<string, string>> = {},
): MemoryStorage {
  const storage = new MemoryStorage();
  storage.fill(items);
  Object.defineProperty(target, "localStorage", { value: storage, configurable: true });
  return storage;
}
