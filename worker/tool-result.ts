// Successful MCP tool result carrying the same data as text and structured content.
export function toolResult(data: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}
