/** Compresses `text` the way a server answering with this `Content-Encoding` would. */
const FORMATS = { gzip: "gzip", deflate: "deflate", br: "brotli" } as const;

export function compress(encoding: keyof typeof FORMATS, text: string): Promise<Uint8Array> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(
      new CompressionStream(
        FORMATS[encoding] as ConstructorParameters<typeof CompressionStream>[0],
      ),
    );
  return new Response(stream).bytes();
}
