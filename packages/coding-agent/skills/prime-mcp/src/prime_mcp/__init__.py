"""Generic host-owned MCP broker API for the Prime Agent kernel."""

from __future__ import annotations

from typing import Any

from rlm import host_request

__all__ = ["Mcp", "McpServer", "mcp"]


class McpServer:
    """A configured MCP server. Credentials and transport remain host-owned."""

    def __init__(self, name: str) -> None:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("MCP server name must be a non-empty string")
        self.name = name.strip()

    async def list_tools(self) -> list[dict[str, Any]]:
        """Return the current untrusted tool inventory and JSON Schemas."""
        response = await host_request("mcp.list_tools", {"server": self.name})
        tools = response.get("tools")
        if not isinstance(tools, list):
            raise RuntimeError("mcp.list_tools returned an invalid tool inventory")
        return [tool for tool in tools if isinstance(tool, dict)]

    async def call(self, tool: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call one exact user-approved tool with JSON-object arguments."""
        if not isinstance(tool, str) or not tool.strip():
            raise ValueError("MCP tool name must be a non-empty string")
        if arguments is not None and not isinstance(arguments, dict):
            raise TypeError("MCP tool arguments must be a dict or None")
        response = await host_request(
            "mcp.call_tool",
            {"server": self.name, "tool": tool.strip(), "arguments": arguments or {}},
        )
        if "result" not in response:
            raise RuntimeError("mcp.call_tool returned no result")
        return response["result"]


class Mcp:
    """Factory for generic server handles; no server-specific Python skill is needed."""

    def server(self, name: str) -> McpServer:
        return McpServer(name)


mcp = Mcp()
