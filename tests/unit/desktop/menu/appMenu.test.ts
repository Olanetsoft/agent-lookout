import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, test, vi } from "vitest";

import { appMenuTemplate, GUIDE_URL } from "@desktop/menu/appMenu";

function menus(development = false) {
  const openSettings = vi.fn();
  const openGuide = vi.fn();
  const template = appMenuTemplate({ development, openSettings, openGuide });
  return { template, openSettings, openGuide };
}

/** A menu's items, each by its role, its label or a dash for a separator. */
function itemsOf(menu: MenuItemConstructorOptions | undefined): (string | undefined)[] {
  const submenu = (menu?.submenu ?? []) as MenuItemConstructorOptions[];
  return submenu.map((item) => item.role ?? (item.type === "separator" ? "-" : item.label));
}

/** Clicks a menu item as Electron would. */
function click(item: MenuItemConstructorOptions | undefined): void {
  (item?.click as (() => void) | undefined)?.();
}

describe("the app's menus", () => {
  test("are the ones a Mac app has, in their order", () => {
    const { template } = menus();
    expect(template.map((menu) => menu.role ?? menu.label)).toEqual([
      "appMenu",
      "fileMenu",
      "editMenu",
      "View",
      "windowMenu",
      "help",
    ]);
  });

  test("the app's own menu has About, Settings…, Services, Hide and Quit", () => {
    const { template, openSettings } = menus();
    const appMenu = template[0];
    expect(itemsOf(appMenu)).toEqual([
      "about",
      "-",
      "Settings…",
      "-",
      "services",
      "-",
      "hide",
      "hideOthers",
      "unhide",
      "-",
      "quit",
    ]);
    const settings = (appMenu?.submenu as MenuItemConstructorOptions[])[2];
    expect(settings?.accelerator).toBe("CmdOrCtrl+,");
    click(settings);
    expect(openSettings).toHaveBeenCalledOnce();
  });

  test("Help opens the guide", () => {
    const { template, openGuide } = menus();
    const help = template[5];
    expect(itemsOf(help)).toEqual(["Agent Lookout Guide"]);
    click((help?.submenu as MenuItemConstructorOptions[])[0]);
    expect(openGuide).toHaveBeenCalledOnce();
    expect(GUIDE_URL).toBe("https://github.com/Olanetsoft/agent-lookout/blob/main/docs/GUIDE.md");
  });

  test("only a development run may reload the page or open the developer tools", () => {
    expect(itemsOf(menus(false).template[3])).toEqual(["togglefullscreen"]);
    expect(itemsOf(menus(true).template[3])).toEqual([
      "reload",
      "forceReload",
      "toggleDevTools",
      "-",
      "togglefullscreen",
    ]);
  });
});
