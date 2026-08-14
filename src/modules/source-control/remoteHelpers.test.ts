import { describe, expect, it } from "vitest";
import {
  isRejectedPushError,
  parseUpstreamRemote,
  pushTagsValue,
} from "./remoteHelpers";

describe("parseUpstreamRemote", () => {
  it("splits the remote off a tracking ref", () => {
    expect(parseUpstreamRemote("origin/main")).toBe("origin");
    expect(parseUpstreamRemote("upstream/feature/x")).toBe("upstream");
  });

  it("keeps a bare name intact", () => {
    expect(parseUpstreamRemote("origin")).toBe("origin");
  });

  it("keeps the remote name case as written", () => {
    expect(parseUpstreamRemote("ORIGIN/main")).toBe("ORIGIN");
  });

  it("keeps a leading-slash ref intact instead of collapsing to empty", () => {
    expect(parseUpstreamRemote("/main")).toBe("/main");
  });

  it("returns null for missing upstreams", () => {
    expect(parseUpstreamRemote(null)).toBeNull();
    expect(parseUpstreamRemote(undefined)).toBeNull();
    expect(parseUpstreamRemote("")).toBeNull();
  });
});

describe("isRejectedPushError", () => {
  it("flags the classic non-fast-forward rejection", () => {
    expect(
      isRejectedPushError(
        "! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs",
      ),
    ).toBe(true);
  });

  it("flags the modern rejection wording", () => {
    expect(
      isRejectedPushError(
        "Updates were rejected because the remote contains work that you do not have locally.",
      ),
    ).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isRejectedPushError("Could not resolve host: github.com")).toBe(
      false,
    );
    expect(isRejectedPushError("Authentication failed")).toBe(false);
  });

  it("matches the rejection wording case-insensitively", () => {
    expect(
      isRejectedPushError(
        "! [REJECTED] main -> main (NON-FAST-FORWARD)",
      ),
    ).toBe(true);
    expect(
      isRejectedPushError(
        "updates were rejected because the remote contains work",
      ),
    ).toBe(true);
  });

  it("flags the fetch-style remote rejection wording", () => {
    expect(
      isRejectedPushError("! [remote rejected] main -> main (stale info)"),
    ).toBe(true);
    expect(
      isRejectedPushError("! [remote rejected] main -> main (fetch first)"),
    ).toBe(true);
  });

  it("does not treat a bare 'failed to push some refs' line as rejection", () => {
    expect(isRejectedPushError("error: failed to push some refs")).toBe(false);
  });
});

describe("pushTagsValue", () => {
  it("maps the three dialog choices onto the native value", () => {
    expect(pushTagsValue("none")).toBeUndefined();
    expect(pushTagsValue("current")).toBe("current");
    expect(pushTagsValue("all")).toBe("all");
  });
});
