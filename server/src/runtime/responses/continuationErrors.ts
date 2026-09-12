/**
 * 上游拒绝 previous_response_id 的判定。
 * - 火山 Ark：HTTP 400 `{"error":{"code":"InvalidParameter.PreviousResponseNotFound","param":"previous_response_id",...}}`
 * - OpenAI：HTTP 400/404 `Previous response with id 'resp_x' not found`
 * 仅在请求确实带了 previous_response_id 时调用（调用方保证），无误伤面。
 */
export function isPreviousResponseNotFound(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return /previous[_\s]?response/i.test(bodyText);
}
