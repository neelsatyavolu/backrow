import { describe, expect, it } from "vitest";
import { activeCues, decodeCaptions, parseCaptions } from "../shared/captions";

describe("parseCaptions", () => {
  it("reads SRT with comma milliseconds, CRLF and markup", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> there\r\n{\\an8}second line\r\n\r\n2\r\n01:02:03,004 --> 01:02:04,000\r\nBye\r\n";
    expect(parseCaptions(srt)).toEqual([
      { start: 1, end: 2.5, text: "Hello there\nsecond line" },
      { start: 3723.004, end: 3724, text: "Bye" },
    ]);
  });

  it("reads WebVTT with short timestamps, cue settings, ids and notes", () => {
    const vtt = "﻿WEBVTT\n\nNOTE skipped\n\nintro\n00:05.000 --> 00:06.250 align:start line:0\n<v Bob>Hi &amp; bye</v>\n\n00:07.000 --> 00:08.000\n\n";
    expect(parseCaptions(vtt)).toEqual([{ start: 5, end: 6.25, text: "Hi & bye" }]);
  });

  it("returns no cues for files that are not captions", () => {
    expect(parseCaptions("just some text\nwithout timing")).toEqual([]);
  });

  it("sorts cues by start time", () => {
    const srt = "00:00:05,000 --> 00:00:06,000\nB\n\n00:00:01,000 --> 00:00:02,000\nA\n";
    expect(parseCaptions(srt).map((c) => c.text)).toEqual(["A", "B"]);
  });
});

describe("activeCues", () => {
  const cues = parseCaptions("00:00:01,000 --> 00:00:03,000\nA\n\n00:00:02,000 --> 00:00:04,000\nB\n");
  it("shows every cue covering the position", () => {
    expect(activeCues(cues, 0.5)).toEqual([]);
    expect(activeCues(cues, 1.5).map((c) => c.text)).toEqual(["A"]);
    expect(activeCues(cues, 2.5).map((c) => c.text)).toEqual(["A", "B"]);
    expect(activeCues(cues, 4)).toEqual([]);
  });
});

describe("decodeCaptions", () => {
  it("decodes UTF-8 and falls back to Windows-1252", () => {
    expect(decodeCaptions(new TextEncoder().encode("café"))).toBe("café");
    expect(decodeCaptions(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
  });
});
