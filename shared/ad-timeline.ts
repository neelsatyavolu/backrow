// Converts between a stream clock that includes stitched-in ad breaks and the
// shared content clock everyone in the party syncs on (Peacock).

/** [content position where the break plays, break length], sorted by position. */
export type AdBreaks = ReadonlyArray<readonly [number, number]>;

export interface StreamPoint {
  content: number;
  inAd: boolean;
}

export function streamToContent(stream: number, breaks: AdBreaks): StreamPoint {
  let adTime = 0;
  for (const [position, length] of breaks) {
    const start = position + adTime;
    if (stream < start) break;
    if (stream < start + length) return { content: position, inAd: true };
    adTime += length;
  }
  return { content: stream - adTime, inAd: false };
}

/** Where content time lands in the stream; a break at exactly `content` plays first. */
export function contentToStream(content: number, breaks: AdBreaks): number {
  let adTime = 0;
  for (const [position, length] of breaks) {
    if (position > content) break;
    adTime += length;
  }
  return content + adTime;
}
