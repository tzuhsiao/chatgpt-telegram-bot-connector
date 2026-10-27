// Successful MCP tool result carrying the same data as text and structured content.
// Callers may append further content blocks (e.g. images) and set isError.
export function toolResult(data: unknown): {
  content: Record<string, unknown>[];
  structuredContent: unknown;
  isError: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}
