// script.run（任意コード実行）の関所
// 役割: 「スクリプトモードを許可して起動したか」を判定し、許可されていなければ script.run を 403 で止める。
//   server.js から使う。判定だけの純粋な関数にしてあるので、test/ から単体で確かめられる。

// 関所を通す必要があるメソッド（任意コードを実行するもの）
const SCRIPT_METHODS = new Set(["script.run"]);

// プラグイン側の既定タイムアウト・最大値と揃える（plugin/code.js の SCRIPT_TIMEOUT_MS / MAX_SCRIPT_TIMEOUT_MS）
const SCRIPT_DEFAULT_TIMEOUT_MS = 60000;
const SCRIPT_MAX_TIMEOUT_MS = 600000;
const SCRIPT_WAIT_MARGIN_MS = 5000;   // プラグインが script_timeout を返すまでの余裕

// 起動引数 --allow-script か 環境変数 BRIDGE_ALLOW_SCRIPT=1 のときだけ許可
function resolveAllowScript(argv, env) {
  return (argv || []).includes("--allow-script") || (env || {}).BRIDGE_ALLOW_SCRIPT === "1";
}

// RPC を通してよいか判定する。止めるときは {status, body} を返し、通すときは null
function gateRpc(method, allowScript) {
  if (SCRIPT_METHODS.has(method) && !allowScript) {
    return {
      status: 403,
      body: {
        ok: false,
        error: "script_disabled",
        message: "start the broker with --allow-script or BRIDGE_ALLOW_SCRIPT=1"
      }
    };
  }
  return null;
}

// ブローカーがプラグインの返事を待つ時間（ms）
//   既存メソッドは従来どおり baseMs（30秒）。script.run だけは timeoutMs + 余裕 まで待つ
//   （プラグイン側のタイムアウトより先にブローカーが諦めないように）
function rpcWaitMs(method, params, baseMs) {
  if (!SCRIPT_METHODS.has(method)) return baseMs;
  const t = params && typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? Math.min(params.timeoutMs, SCRIPT_MAX_TIMEOUT_MS)
    : SCRIPT_DEFAULT_TIMEOUT_MS;
  return Math.max(baseMs, t + SCRIPT_WAIT_MARGIN_MS);
}

module.exports = { SCRIPT_METHODS, resolveAllowScript, gateRpc, rpcWaitMs };
