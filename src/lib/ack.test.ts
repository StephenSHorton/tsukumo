import { describe, expect, test } from "bun:test";
import { parseAckRequest } from "./ack.ts";

describe("parseAckRequest", () => {
  test("accepts a channel and message snowflake", () => {
    expect(
      parseAckRequest('{"channelId":"100000000000000001","messageId":"100000000000000012"}'),
    ).toEqual({ channelId: "100000000000000001", messageId: "100000000000000012" });
  });

  test("rejects anything else", () => {
    expect(parseAckRequest("not json")).toBeNull();
    expect(parseAckRequest('{"channelId":"100000000000000001"}')).toBeNull();
    expect(parseAckRequest('{"channelId":"x","messageId":"100000000000000012"}')).toBeNull();
  });
});
