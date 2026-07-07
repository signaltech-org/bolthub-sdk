/**
 * ALL logging goes to stderr, always — stdout is the MCP JSON-RPC channel
 * and a single stray line corrupts the stream.
 */
export function log(message: string): void {
  console.error(`[bolthub-mcp] ${message}`);
}
