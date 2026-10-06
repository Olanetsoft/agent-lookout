// Brings the app's one window forward, making it again if it was closed. With
// an address of the app's own, the window shows that page: Settings, its
// Updates card, or a session's details, which the menu bar opens.
//
// It imports nothing from Electron, so it is tested in plain Node with a
// stand-in for the window. `main.ts` hands it `createMainWindow`.

/** What it needs of Electron's `BrowserWindow`. */
export interface ShowableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  loadURL(url: string): Promise<void>;
  on(event: "closed", listener: () => void): unknown;
}

export interface WindowShowerOptions<Window extends ShowableWindow> {
  /** Whether the app is ready to make a window. Before then nothing is shown. */
  ready: () => boolean;
  /** Makes the window, opening the address, or the dashboard's start when there is none. */
  create: (address: string | undefined) => Window;
}

export interface WindowShower<Window extends ShowableWindow> {
  /** Brings the window forward, at an address of the app's own when one is given. */
  show(address?: string): void;
  /** The window, while it is open. */
  current(): Window | null;
}

export function createWindowShower<Window extends ShowableWindow>(
  options: WindowShowerOptions<Window>,
): WindowShower<Window> {
  let window: Window | null = null;

  return {
    current: () => (window !== null && !window.isDestroyed() ? window : null),
    show(address) {
      if (!options.ready()) return;
      if (window === null || window.isDestroyed()) {
        const made = options.create(address);
        window = made;
        made.on("closed", () => {
          if (window === made) window = null;
        });
        return;
      }
      if (address !== undefined) {
        // Only the address's fragment differs, so the page changes view without loading again.
        window.loadURL(address).catch(() => {
          // The page stays where it was.
        });
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
  };
}
