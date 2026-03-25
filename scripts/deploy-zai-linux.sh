#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND="${1:-deploy}"
APP_NAME="zai-openai-compatible"
APP_DIR="${ZAI_DEPLOY_APP_DIR:-${ROOT_DIR}/.zai-linux}"
RUNTIME_DIR="${APP_DIR}/runtime"
LOG_DIR="${APP_DIR}/logs"
RUN_DIR="${APP_DIR}/run"
CACHE_DIR="${APP_DIR}/cache"
ENV_FILE="${APP_DIR}/zai-openai.env"
PID_FILE="${RUN_DIR}/${APP_NAME}.pid"
LAUNCH_FILE="${RUN_DIR}/${APP_NAME}.launch.sh"
LOG_FILE="${LOG_DIR}/${APP_NAME}.log"
NODE_INSTALL_DIR="${RUNTIME_DIR}/node"
NODE_DOWNLOAD_DIR="${CACHE_DIR}/node"
PNPM_PREFIX_DIR="${RUNTIME_DIR}/pnpm"
DEFAULT_PORT="${ZAI_OPENAI_PORT:-8788}"
DEFAULT_HOST="${ZAI_OPENAI_HOST:-0.0.0.0}"
NODE_MAJOR="${ZAI_DEPLOY_NODE_MAJOR:-22}"
START_TIMEOUT_SECONDS="${ZAI_DEPLOY_START_TIMEOUT_SECONDS:-60}"
FORCE_LOCAL_NODE="${ZAI_DEPLOY_FORCE_LOCAL_NODE:-0}"
ALLOW_NON_LINUX="${ZAI_DEPLOY_ALLOW_NON_LINUX:-0}"

NODE_BIN=""
NPM_BIN=""
PNPM_CLI=""
PNPM_PACKAGE=""
BIND_HOST="${DEFAULT_HOST}"
BIND_PORT="${DEFAULT_PORT}"
HEALTH_HOST="127.0.0.1"
HEALTH_URL=""
BUILD_VERSION=""

log() {
  printf '[deploy-zai-linux] %s\n' "$*"
}

fail() {
  printf '[deploy-zai-linux] ERROR: %s\n' "$*" >&2
  exit 1
}

require_linux() {
  local platform
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
  if [[ "${ALLOW_NON_LINUX}" == "1" ]]; then
    log "检测到非 Linux 平台 ${platform}，因 ZAI_DEPLOY_ALLOW_NON_LINUX=1 继续执行（仅用于本地联调）"
    return
  fi
  if [[ "${platform}" != "linux" ]]; then
    fail "该脚本只支持 Linux，当前系统是 ${platform}"
  fi
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    fail "缺少命令：${name}"
  fi
}

fetch_url() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
    return
  fi
  fail "需要 curl 或 wget 才能下载部署依赖"
}

health_response_is_expected() {
  local response_body
  response_body="$(fetch_url "${HEALTH_URL}" 2>/dev/null || true)"
  [[ -n "${response_body}" ]] || return 1
  [[ "${response_body}" == *'"service":"zai-openai-compatible"'* ]] || return 1
  [[ "${response_body}" == *'"status":"ok"'* ]] || return 1
}

ensure_port_available() {
  local output=""

  if command -v lsof >/dev/null 2>&1; then
    output="$(lsof -iTCP:${BIND_PORT} -sTCP:LISTEN -n -P 2>/dev/null || true)"
    if [[ -n "${output}" ]]; then
      fail "端口 ${BIND_PORT} 已被其他进程占用，请更换 ZAI_OPENAI_PORT 或先释放端口"
    fi
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    output="$(ss -ltn "sport = :${BIND_PORT}" 2>/dev/null | tail -n +2 || true)"
    if [[ -n "${output//[[:space:]]/}" ]]; then
      fail "端口 ${BIND_PORT} 已被其他进程占用，请更换 ZAI_OPENAI_PORT 或先释放端口"
    fi
    return
  fi

  if command -v netstat >/dev/null 2>&1; then
    output="$(netstat -lnt 2>/dev/null | awk -v port=\":${BIND_PORT}\" '$4 ~ port { print $0 }' || true)"
    if [[ -n "${output}" ]]; then
      fail "端口 ${BIND_PORT} 已被其他进程占用，请更换 ZAI_OPENAI_PORT 或先释放端口"
    fi
    return
  fi

  log "未找到 lsof/ss/netstat，跳过端口占用预检查"
}

version_major() {
  local version="$1"
  printf '%s' "$version" | sed -E 's/^v?([0-9]+).*/\1/'
}

read_package_manager() {
  PNPM_PACKAGE="$(grep -m1 '"packageManager"' "${ROOT_DIR}/package.json" | sed -E 's/.*"([^"]+)".*/\1/')"
  if [[ -z "${PNPM_PACKAGE}" ]]; then
    fail '无法从 package.json 读取 packageManager'
  fi
}

resolve_build_version() {
  if command -v git >/dev/null 2>&1 && git -C "${ROOT_DIR}" rev-parse --short HEAD >/dev/null 2>&1; then
    BUILD_VERSION="$(git -C "${ROOT_DIR}" rev-parse --short HEAD)"
    return
  fi
  BUILD_VERSION="unknown"
}

ensure_dirs() {
  mkdir -p "${APP_DIR}" "${RUNTIME_DIR}" "${LOG_DIR}" "${RUN_DIR}" "${CACHE_DIR}" "${NODE_DOWNLOAD_DIR}"
}

ensure_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    return
  fi

  cat >"${ENV_FILE}" <<ENVEOF
# Z.ai OpenAI Compatible Linux 部署配置
# 首次部署会自动生成此文件，后续可按需修改，然后执行：
#   bash scripts/deploy-zai-linux.sh restart

ZAI_OPENAI_HOST=${DEFAULT_HOST}
ZAI_OPENAI_PORT=${DEFAULT_PORT}
ZAI_OPENAI_API_KEY=
ZAI_DEFAULT_MODEL=glm-5
ZAI_LOCALE=zh-CN
ZAI_TIMEZONE=Asia/Shanghai
ZAI_BROWSER_NAME=Chrome
ZAI_OS_NAME=Linux
ZAI_SCREEN_WIDTH=1440
ZAI_SCREEN_HEIGHT=960
ZAI_VIEWPORT_WIDTH=1440
ZAI_VIEWPORT_HEIGHT=960
ZAI_PIXEL_RATIO=1
ZAI_COLOR_DEPTH=24
ZAI_MAX_TOUCH_POINTS=0
ZAI_DOCUMENT_TITLE=Z.ai
ZAI_REQUEST_TIMEOUT_MS=180000
ZAI_AUTH_CACHE_TTL_MS=600000
ZAI_MODELS_CACHE_TTL_MS=300000
ZAI_FE_VERSION_CACHE_TTL_MS=1800000
ZAI_ENABLE_THINKING=true
ZAI_PREVIEW_MODE=true
ENVEOF

  log "已生成默认环境文件：${ENV_FILE}"
}

load_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    fail "环境文件不存在：${ENV_FILE}"
  fi

  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a

  BIND_HOST="${ZAI_OPENAI_HOST:-${DEFAULT_HOST}}"
  BIND_PORT="${ZAI_OPENAI_PORT:-${DEFAULT_PORT}}"
  if [[ "${BIND_HOST}" == "0.0.0.0" ]]; then
    HEALTH_HOST="127.0.0.1"
  else
    HEALTH_HOST="${BIND_HOST}"
  fi
  HEALTH_URL="http://${HEALTH_HOST}:${BIND_PORT}/health"
}

resolve_arch() {
  local machine
  machine="$(uname -m)"
  case "${machine}" in
    x86_64|amd64)
      printf 'x64'
      ;;
    aarch64|arm64)
      printf 'arm64'
      ;;
    *)
      fail "不支持的 CPU 架构：${machine}"
      ;;
  esac
}

ensure_local_node() {
  local arch version metadata_url archive_name archive_url archive_path extracted_dir
  arch="$(resolve_arch)"
  metadata_url="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt"
  archive_name=""
  archive_name="$(fetch_url "${metadata_url}" | awk -v target="linux-${arch}.tar.xz" '$2 ~ target { print $2; exit }')"
  if [[ -z "${archive_name}" ]]; then
    fail "无法从 ${metadata_url} 解析 Linux Node.js 包名"
  fi

  version="${archive_name%%-linux-*}"
  version="${version#node-}"
  archive_url="https://nodejs.org/dist/v${version}/${archive_name}"
  archive_path="${NODE_DOWNLOAD_DIR}/${archive_name}"
  extracted_dir="${NODE_DOWNLOAD_DIR}/node-v${version}-linux-${arch}"

  if [[ ! -f "${archive_path}" ]]; then
    log "下载 Node.js v${version} (${arch})"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "${archive_url}" -o "${archive_path}"
    else
      wget -q "${archive_url}" -O "${archive_path}"
    fi
  fi

  if [[ ! -d "${extracted_dir}" ]]; then
    log "解压 Node.js 到 ${NODE_DOWNLOAD_DIR}"
    tar -xJf "${archive_path}" -C "${NODE_DOWNLOAD_DIR}"
  fi

  rm -rf "${NODE_INSTALL_DIR}"
  mkdir -p "${NODE_INSTALL_DIR}"
  cp -R "${extracted_dir}"/. "${NODE_INSTALL_DIR}"

  NODE_BIN="${NODE_INSTALL_DIR}/bin/node"
  NPM_BIN="${NODE_INSTALL_DIR}/bin/npm"
  [[ -x "${NODE_BIN}" ]] || fail "本地 Node 安装失败：${NODE_BIN} 不存在"
  [[ -x "${NPM_BIN}" ]] || fail "本地 npm 安装失败：${NPM_BIN} 不存在"
}

ensure_node_and_npm() {
  local system_node_major
  if [[ "${FORCE_LOCAL_NODE}" != "1" ]] && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    system_node_major="$(node -p 'process.versions.node' | sed -E 's/^([0-9]+).*/\1/')"
    if [[ "${system_node_major}" -ge 20 ]]; then
      NODE_BIN="$(command -v node)"
      NPM_BIN="$(command -v npm)"
      log "使用系统 Node.js：$(${NODE_BIN} -v)"
      return
    fi
    log "系统 Node.js 版本过低（$(node -v)），改用本地免 root 安装"
  fi

  ensure_local_node
  log "使用本地 Node.js：$(${NODE_BIN} -v)"
}

ensure_pnpm() {
  local installed_version desired_version
  desired_version="${PNPM_PACKAGE#pnpm@}"
  if [[ -f "${PNPM_PREFIX_DIR}/lib/node_modules/pnpm/bin/pnpm.cjs" ]]; then
    PNPM_CLI="${PNPM_PREFIX_DIR}/lib/node_modules/pnpm/bin/pnpm.cjs"
    installed_version="$(${NODE_BIN} "${PNPM_CLI}" --version 2>/dev/null || true)"
    if [[ "${installed_version}" == "${desired_version}" ]]; then
      log "复用本地 pnpm ${installed_version}"
      return
    fi
  fi

  rm -rf "${PNPM_PREFIX_DIR}"
  mkdir -p "${PNPM_PREFIX_DIR}"
  log "安装本地 ${PNPM_PACKAGE}"
  "${NPM_BIN}" install --global "${PNPM_PACKAGE}" --prefix "${PNPM_PREFIX_DIR}" --loglevel warn >/dev/null
  PNPM_CLI="${PNPM_PREFIX_DIR}/lib/node_modules/pnpm/bin/pnpm.cjs"
  [[ -f "${PNPM_CLI}" ]] || fail "pnpm 安装失败：${PNPM_CLI} 不存在"
}

pnpm_exec() {
  "${NODE_BIN}" "${PNPM_CLI}" "$@"
}

install_dependencies() {
  log '安装项目依赖（pnpm install --frozen-lockfile）'
  (cd "${ROOT_DIR}" && pnpm_exec install --frozen-lockfile)
}

write_launch_script() {
  cat >"${LAUNCH_FILE}" <<LAUNCHEOF
#!/usr/bin/env bash
set -euo pipefail
cd "${ROOT_DIR}"
set -a
source "${ENV_FILE}"
set +a
export ZAI_BUILD_VERSION="${BUILD_VERSION}"
exec "${NODE_BIN}" "${PNPM_CLI}" exec tsx scripts/zai-openai-compatible.ts
LAUNCHEOF
  chmod +x "${LAUNCH_FILE}"
}

is_running() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "${PID_FILE}")"
  if [[ -z "${pid}" ]]; then
    return 1
  fi
  if kill -0 "${pid}" >/dev/null 2>&1; then
    return 0
  fi
  rm -f "${PID_FILE}"
  return 1
}

wait_for_health() {
  local waited=0
  while [[ "${waited}" -lt "${START_TIMEOUT_SECONDS}" ]]; do
    if health_response_is_expected; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

start_service() {
  write_launch_script
  if is_running; then
    log "服务已在运行，PID=$(cat "${PID_FILE}")"
    return
  fi
  ensure_port_available

  : >"${LOG_FILE}"
  nohup "${LAUNCH_FILE}" >>"${LOG_FILE}" 2>&1 &
  local pid=$!
  echo "${pid}" >"${PID_FILE}"
  log "已启动后台进程，PID=${pid}，等待健康检查"

  if wait_for_health; then
    log "部署完成，健康检查通过：${HEALTH_URL}"
    return
  fi

  log '健康检查超时，输出最近日志：'
  tail -n 80 "${LOG_FILE}" || true
  fail '服务启动失败，请查看日志'
}

stop_service() {
  if ! is_running; then
    log '服务当前未运行'
    return
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  kill "${pid}" >/dev/null 2>&1 || true
  local waited=0
  while kill -0 "${pid}" >/dev/null 2>&1 && [[ "${waited}" -lt 20 ]]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "${pid}" >/dev/null 2>&1; then
    kill -9 "${pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${PID_FILE}"
  log "服务已停止，PID=${pid}"
}

status_service() {
  if is_running; then
    local pid health='down'
    pid="$(cat "${PID_FILE}")"
    if health_response_is_expected; then
      health='up'
    fi
    log "运行中 | PID=${pid} | health=${health} | ${HEALTH_URL}"
    return
  fi
  log '未运行'
}

logs_service() {
  touch "${LOG_FILE}"
  tail -n "${ZAI_DEPLOY_LOG_LINES:-80}" -f "${LOG_FILE}"
}

print_usage() {
  cat <<USAGE
用法：bash scripts/deploy-zai-linux.sh [deploy|start|stop|restart|status|logs|install]

默认命令：deploy
一条命令部署：
  bash scripts/deploy-zai-linux.sh

常用命令：
  bash scripts/deploy-zai-linux.sh status
  bash scripts/deploy-zai-linux.sh logs
  bash scripts/deploy-zai-linux.sh restart

运行目录：${APP_DIR}
环境文件：${ENV_FILE}
日志文件：${LOG_FILE}
USAGE
}

deploy_service() {
  require_linux
  ensure_dirs
  ensure_env_file
  load_env_file
  resolve_build_version
  read_package_manager
  ensure_node_and_npm
  ensure_pnpm
  install_dependencies
  start_service
  status_service
}

main() {
  case "${COMMAND}" in
    deploy)
      deploy_service
      ;;
    install)
      require_linux
      ensure_dirs
      ensure_env_file
      load_env_file
      resolve_build_version
      read_package_manager
      ensure_node_and_npm
      ensure_pnpm
      install_dependencies
      log '依赖安装完成，尚未启动服务'
      ;;
    start)
      require_linux
      ensure_dirs
      ensure_env_file
      load_env_file
      resolve_build_version
      read_package_manager
      ensure_node_and_npm
      ensure_pnpm
      start_service
      status_service
      ;;
    stop)
      ensure_dirs
      ensure_env_file
      load_env_file
      stop_service
      ;;
    restart)
      ensure_dirs
      ensure_env_file
      load_env_file
      resolve_build_version
      read_package_manager
      ensure_node_and_npm
      ensure_pnpm
      stop_service
      start_service
      status_service
      ;;
    status)
      ensure_dirs
      ensure_env_file
      load_env_file
      status_service
      ;;
    logs)
      ensure_dirs
      ensure_env_file
      load_env_file
      logs_service
      ;;
    help|-h|--help)
      print_usage
      ;;
    *)
      fail "未知命令：${COMMAND}"
      ;;
  esac
}

main
