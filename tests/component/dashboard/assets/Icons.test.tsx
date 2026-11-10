import type { ComponentType } from "react";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import {
  AlertIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  CommandIcon,
  InfoIcon,
  OverviewIcon,
  SearchIcon,
  SettingsIcon,
  SourcesIcon,
  type IconProps,
} from "@dashboard/assets/Icons";

/** Every icon drawn at the rail's weight, with the size it is shown at. */
const DRAWN: [string, ComponentType<IconProps>, number][] = [
  ["Overview", OverviewIcon, 20],
  ["Sources", SourcesIcon, 20],
  ["Settings", SettingsIcon, 20],
  ["tick", CheckIcon, 12],
  ["close mark", CloseIcon, 16],
  ["magnifier", SearchIcon, 16],
  ["note", InfoIcon, 18],
  ["error", AlertIcon, 18],
  ["up arrow", ArrowUpIcon, 14],
  ["down arrow", ArrowDownIcon, 14],
  ["left arrow", ArrowLeftIcon, 14],
  ["right arrow", ArrowRightIcon, 14],
  ["⌘", CommandIcon, 14],
];

test.each(DRAWN)(
  "the %s icon is a 1.5px line in the current colour, on a grid as wide as it is shown",
  async (_name, Icon, size) => {
    const screen = await render(<Icon />);
    const svg = screen.container.querySelector("svg") as SVGSVGElement;

    const box = svg.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([size, size]);
    // A grid of one unit to the pixel, so the line is as wide as written.
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${size} ${size}`);
    expect(svg.getAttribute("stroke-width")).toBe("1.5");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  },
);

test("a data attribute given to an icon goes on to its drawing", async () => {
  const screen = await render(<CommandIcon data-sign='⌘' />);
  const svg = screen.container.querySelector("svg") as SVGSVGElement;

  expect(svg.dataset.sign).toBe("⌘");
  expect(svg.dataset.slot).toBe("icon");
});
