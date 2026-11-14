/**
 * 最小连通性测试函数 · /test
 * 零依赖、零 import。同时提供 export default 与命名 export onRequest，
 * 用于排查 Makers 函数识别（若 /test 返回 200，则说明导出风格是关键）。
 */
async function onRequest(context) {
  return new Response(
    JSON.stringify({ ok: true, fn: 'test', ts: Date.now() }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}

export default onRequest;
export { onRequest };
