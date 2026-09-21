import { describe, expect, it } from "vitest";
import { parsePullRequestJson } from "./gh";

const fields = {
  number: 42,
  url: "https://github.com/acme/widget/pull/42",
  title: "Add the thing",
  author: { login: "octocat" },
  baseRefName: "main",
  headRefName: "feat",
  headRefOid: "abc123",
  isDraft: false,
};

describe("parsePullRequestJson", () => {
  it("takes owner and repo from the PR url", () => {
    expect(parsePullRequestJson(JSON.stringify(fields))).toEqual({
      owner: "acme",
      repo: "widget",
      number: 42,
      url: fields.url,
      title: "Add the thing",
      author: "octocat",
      baseRefName: "main",
      headRefName: "feat",
      headRefOid: "abc123",
      isDraft: false,
    });
  });

  it("returns null without a usable identity", () => {
    // `gh` prints nothing useful when it is not installed, logged out, or has no PR.
    expect(parsePullRequestJson("")).toBeNull();
    expect(parsePullRequestJson(JSON.stringify({ ...fields, url: "" }))).toBeNull();
    expect(parsePullRequestJson(JSON.stringify({ ...fields, number: "42" }))).toBeNull();
  });
});
