import { expect, test } from "vitest";

import { projectOf } from "@core/project";

test("a project is the last folder of the working directory", () => {
  expect(projectOf("/Users/example/code/demo")).toBe("demo");
  expect(projectOf("/Users/example/code/demo/")).toBe("demo");
  expect(projectOf("/Users/example/code//demo-api")).toBe("demo-api");
  expect(projectOf("C:\\Users\\example\\code\\demo")).toBe("demo");
  expect(projectOf("demo")).toBe("demo");
});

test("no working directory, or only a root, has no project", () => {
  expect(projectOf("/")).toBeNull();
  expect(projectOf("\\")).toBeNull();
  expect(projectOf("")).toBeNull();
  expect(projectOf(null)).toBeNull();
  expect(projectOf(undefined)).toBeNull();
});
