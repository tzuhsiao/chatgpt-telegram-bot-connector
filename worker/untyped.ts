// Untyped external data as walked by code extracted from the original
// JavaScript Worker: raw Telegram Bot API JSON, MCP params and D1 rows. This
// alias is deliberately `any`: it carries NO type guarantee. The runtime checks at each use site are the only validation, and
// they must never be removed because a value "has a type".
//
// New code must not use this alias. It should take `unknown` and narrow with
// runtime checks (see AGENTS.md, TypeScript).
export type UntypedJson = any;
