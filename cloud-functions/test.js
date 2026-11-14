/**
 * 最小连通性测试函数 · /test
 * 零依赖、零 import，用于隔离「函数是否被注册」的问题。
 * 若 /test 返回 200 OK 而复杂函数 404，则问题在复杂函数的构建；
 * 若 /test 也 404，则说明 cloud-functions 整体未被注册。
 */
export function onRequest(context) {
  return new Response(
    JSON.stringify({ ok: true, fn: 'test', ts: Date.now() }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}
