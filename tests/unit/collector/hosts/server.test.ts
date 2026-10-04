import { describe, expect, test } from "vitest";

import {
  DEFAULT_PORT,
  isLoopbackAddress,
  resolveBindHost,
  resolvePort,
  urlFor,
} from "@collector/hosts/server";

describe("where it listens", () => {
  test("only the loopback addresses count as this machine", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    for (const address of ["0.0.0.0", "::", "192.168.1.20", "10.0.0.5", "localhost", "", "*"]) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });

  test("the address defaults to 127.0.0.1 and may be another loopback address", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
    expect(resolveBindHost({ AGENT_LOOKOUT_HOST: "" })).toBe("127.0.0.1");
    expect(resolveBindHost({ AGENT_LOOKOUT_HOST: "localhost" })).toBe("127.0.0.1");
    expect(resolveBindHost({ AGENT_LOOKOUT_HOST: "127.0.0.1" })).toBe("127.0.0.1");
    expect(resolveBindHost({ AGENT_LOOKOUT_HOST: "::1" })).toBe("::1");
    expect(resolveBindHost({ AGENT_LOOKOUT_HOST: "[::1]" })).toBe("::1");
  });

  test.each(["0.0.0.0", "::", "192.168.1.20", "example.com", "*"])(
    "asking for %s is refused with a sentence that says why",
    (host) => {
      expect(() => resolveBindHost({ AGENT_LOOKOUT_HOST: host })).toThrow(
        /only listens on this machine/,
      );
    },
  );

  test("the port comes from AGENT_LOOKOUT_PORT or is 4777", () => {
    expect(DEFAULT_PORT).toBe(4777);
    expect(resolvePort({})).toBe(4777);
    expect(resolvePort({ AGENT_LOOKOUT_PORT: "" })).toBe(4777);
    expect(resolvePort({ AGENT_LOOKOUT_PORT: "5050" })).toBe(5050);
    expect(resolvePort({ AGENT_LOOKOUT_PORT: " 5050 " })).toBe(5050);
    for (const port of ["http", "-1", "70000", "50.5", "5050; rm -rf /"]) {
      expect(() => resolvePort({ AGENT_LOOKOUT_PORT: port })).toThrow(/AGENT_LOOKOUT_PORT/);
    }
  });

  test("urlFor writes IPv6 addresses in brackets", () => {
    expect(urlFor({ address: "::1", family: "IPv6", port: 4777 })).toBe("http://[::1]:4777");
    expect(urlFor({ address: "127.0.0.1", family: "IPv4", port: 4777 })).toBe(
      "http://127.0.0.1:4777",
    );
  });
});
