/**
 * 安全地把 fetch Response 解析为 JSON。
 *
 * 与直接 `res.json()` 的区别：
 * - content-type 不是 JSON 时（典型场景：服务端把请求落到 SPA 兜底
 *   返回 index.html），抛出带上下文的 Error，避免 "Unexpected token '<'"
 *   这种对用户毫无信息的解析报错。
 * - 当 `res.ok=false` 且 body 含 `error` 字段时，抛出该字段；否则抛
 *   `HTTP {status}`。
 *
 * @param res    fetch / authFetch 返回的 Response
 * @param feature 用于错误提示的可选业务名（如「定时任务」「MCP」），
 *                出现在最前面便于用户辨认是哪个模块出了问题
 */
export async function parseJsonResponse<T = unknown>(
  res: Response,
  feature?: string,
): Promise<T> {
  const ct = res.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");

  if (!isJson) {
    // 非 JSON：通常是路由未注册导致 SPA 兜底 / 网关错误页 / 反向代理超时
    const text = await res.text().catch(() => "");
    const snippet = text.slice(0, 80).replace(/\s+/g, " ").trim();
    const featurePart = feature ? `${feature}：` : "";
    const hint =
      res.status === 404
        ? "对应 API 路由未挂载（可能后端功能未启用），"
        : res.status === 502 || res.status === 503 || res.status === 504
          ? "上游网关或后端服务不可达，"
          : res.status >= 500
            ? "服务端错误，"
            : "";
    throw new Error(
      `${featurePart}${hint}收到非 JSON 响应（HTTP ${res.status}, ${
        ct || "无 content-type"
      }）${snippet ? `\n响应片段：${snippet}` : ""}`,
    );
  }

  const data = (await res.json()) as unknown;
  if (!res.ok) {
    const errMsg =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data as T;
}
