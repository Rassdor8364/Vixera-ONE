import { describe, expect, it } from "vitest";
import { PRAXION_CONTRACT_MAJOR, PRAXION_CONTRACT_VERSION } from "./contract.ts";
import { contractMajor, isContractCompatible, parseSemver } from "./version.ts";

describe("parseSemver", () => {
  it("parses MAJOR.MINOR.PATCH with optional prerelease/build", () => {
    expect(parseSemver("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseSemver("12.34.56-beta.1+build.7")).toEqual({ major: 12, minor: 34, patch: 56 });
    expect(parseSemver(" 2.1.0 ")).toEqual({ major: 2, minor: 1, patch: 0 });
  });

  it("rejects malformed versions", () => {
    for (const bad of ["", "1", "1.0", "v1.0.0", "1.0.0.0", "01.0.0", "a.b.c", "1.x.0"]) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });

  it("PRAXION_CONTRACT_VERSION is well-formed and its major matches PRAXION_CONTRACT_MAJOR", () => {
    expect(contractMajor(PRAXION_CONTRACT_VERSION)).toBe(PRAXION_CONTRACT_MAJOR);
  });
});

describe("isContractCompatible(server, client)", () => {
  const matrix: ReadonlyArray<readonly [server: string, client: string, expected: boolean]> = [
    ["1.0.0", "1.0.0", true], // exact
    ["1.2.0", "1.0.0", true], // server newer minor: additive, fine
    ["1.0.9", "1.0.0", true], // patch ignored
    ["1.0.0", "1.0.9", true], // patch ignored both ways
    ["1.0.0", "1.1.0", false], // client needs a minor the server lacks
    ["2.0.0", "1.0.0", false], // server major ahead
    ["1.0.0", "2.0.0", false], // client major ahead
    ["0.9.0", "1.0.0", false], // pre-1.0 server
    ["1.0.0-rc.1", "1.0.0", true], // prerelease tag tolerated
    ["", "1.0.0", false],
    ["1.0.0", "", false],
    ["garbage", "1.0.0", false],
    ["1.0.0", "1.0", false],
  ];

  it.each(matrix)("server %s / client %s -> %s", (server, client, expected) => {
    expect(isContractCompatible(server, client)).toBe(expected);
  });
});
