# Gemini 轮询组（GeminiLB / Key Pool RR）设计说明

本文档面向维护者与二次开发者，解释本项目中 **Google Gemini “轮询组”**（多 API Key 轮询、失败冷却与自动切换）的配置结构、运行时行为、可观察性与故障排查方式，便于团队成员快速理解并接受这部分实现。

> 背景：Gemini 在本项目中通过 OpenAI SDK 以 OpenAI-compatible 方式调用（`base_url=https://generativelanguage.googleapis.com/v1beta/openai/`）。轮询组的目标是：当你拥有多把同厂商/同模型的 Key 时，自动轮询可用 Key，遇到限流/鉴权/服务端错误时进行冷却并切换，提升稳定性。

> 说明：本文档里涉及的 `profile/model_profiles.json/model_profiles.py` 等结构更偏“设计草案/伪代码”，用于描述轮询组应具备的行为。当前仓库的可运行实现以 Node 的 [server.js](file:///Users/sun/Desktop/llm-key-lb/server.js) 为准（Key 由 UI 写入 `DATA_FILE`，默认 `./data/state.json`）。

---

## 1. 名词与目标

### 1.1 名词

- **模型档案（profile）**：一条可用的 LLM 连接配置（Base URL、Model、Key 等），持久化在 `data/config/model_profiles.json`。
- **普通模式（single-key）**：profile 使用 `api_key`（单 Key）。
- **轮询组（key pool / RR）**：profile 使用 `api_keys`（多 Key），每次请求选取一个 Key，失败按错误类型进入冷却并切换。
- **provider**
  - `gemini`：普通 Gemini 档案（单 Key）
  - `gemini_rr`：Gemini 轮询组档案（多 Key）
- **冷却（cooldown）**：某把 Key 最近失败，暂时不再被选中，过一段时间后恢复参与轮询。

### 1.2 设计目标

- 最小侵入：轮询组不改动业务 Agent，只在 LLM 连接层处理。
- 单请求自愈：单次调用内部可尝试切换 Key（最多尝试 `len(api_keys)` 次）。
- 失败隔离：429/5xx/401/403 等错误触发冷却，避免持续撞墙。
- 可观察：错误与成功均有结构化日志与 metrics 计数（不记录 API Key）。

---

## 2. 配置结构（model_profiles.json）

配置由 UI 写入，文件位置为：

- `data/config/model_profiles.json`（运行时创建，JSON 配置落盘文件）
- 配置管理与修复入口：`model_profiles.py`

### 2.1 Profile 字段

每个 profile 是一个 dict，核心字段如下：

- `id`：档案唯一 ID（uuid hex）
- `name`：显示名
- `enabled`：是否启用
- `provider`：
  - 普通 Gemini：`gemini`（根据 base_url 推断）
  - 轮询组：`gemini_rr`（UI 强制）
- `base_url`：OpenAI-compatible Base URL（Gemini 建议为 `https://generativelanguage.googleapis.com/v1beta/openai/`）
- `model_name`：模型名（例如 `gemini-2.5-flash`）
- `api_key`：单 Key（普通模式使用；轮询组也会保留首 Key 作为 primary 便于展示/兜底）
- `api_keys`：Key 池（轮询组使用，list of string）

轮询组是否生效由运行时判断函数决定：

源码（`model_profiles.py`）：

```python
def is_lb_profile(profile):
    if not isinstance(profile, dict):
        return False
    return (profile.get("provider") or "").strip() in ("gemini_rr", "openai_rr", "lb")
```

### 2.2 自动规范化（重要）

为避免“粘贴格式/URL 细节”导致的隐性错误，项目对以下内容做了自动修复（在 UI 保存与配置加载时都会做）：

1) **API Key 规范化**

- 允许用户粘贴包含引号的 key：`"AIza..."` / `'AIza...'`
- 允许粘贴带 Bearer 前缀：`Bearer AIza...`
- 规范化规则：去掉引号、去掉 `Bearer ` 前缀、trim 空白

实现：

- UI 与配置加载/修复使用相同规则（分别在 `app.py` / `model_profiles.py` 中各自实现一份）：

```python
def _normalize_api_key(key):
    k = (key or "").strip()
    if not k:
        return ""
    if (k.startswith('"') and k.endswith('"')) or (k.startswith("'") and k.endswith("'")):
        k = k[1:-1].strip()
    if k.lower().startswith("bearer "):
        k = k[7:].strip()
    return k
```

2) **Gemini Base URL 尾斜杠补齐**

Gemini OpenAI-compatible base_url 推荐带尾部 `/`，即：

- ✅ `https://generativelanguage.googleapis.com/v1beta/openai/`
- ⚠️ `https://generativelanguage.googleapis.com/v1beta/openai`

部分 SDK/拼接逻辑下，尾斜杠缺失可能造成路径拼接异常，因此保存/加载时会自动补齐：

```python
def _normalize_base_url(url):
    u = (url or "").strip()
    if not u:
        return ""
    s = u.lower()
    if "generativelanguage.googleapis.com" in s and s.endswith("/openai") and not u.endswith("/"):
        return u + "/"
    return u
```

配置加载时也会自动修复历史存量配置（节选，`model_profiles.py`）：

```python
old_api_key = p.get("api_key") or ""
new_api_key = _normalize_api_key(old_api_key)
if new_api_key != old_api_key:
    p["api_key"] = new_api_key
    changed = True

old_api_keys = p.get("api_keys")
new_api_keys = []
seen = set()
if isinstance(old_api_keys, list):
    for x in old_api_keys:
        k = _normalize_api_key(x)
        if not k or k in seen:
            continue
        seen.add(k)
        new_api_keys.append(k)
if new_api_keys != _normalize_key_list(old_api_keys):
    p["api_keys"] = new_api_keys
    changed = True

old_base_url = p.get("base_url") or ""
new_base_url = _normalize_base_url(old_base_url)
if new_base_url != old_base_url:
    p["base_url"] = new_base_url
    changed = True
```

---

## 3. UI：如何创建 Gemini（轮询组）

入口页面：模型管理（“模型档案管理”）：

- UI 实现：`app.py` 中的 `_render_llm_advanced_page()`

### 3.1 创建步骤（推荐流程）

1) 选择 “＋ 新建模型档案”
2) 厂商/类型选择 **Google Gemini（轮询组）**
3) Base URL 使用默认（应为 `.../v1beta/openai/`）
4) 在 “API Keys（每行一个）” 粘贴多行 Key（每行一把）
5) 模型名称（Model）填写一个可用模型（推荐先查询可用模型列表）
6) 保存 → 设为默认（或绑定到某个 Agent）

### 3.2 “Gemini 可用模型列表”查询

为解决 “模型名不可用导致 404” 的常见问题，UI 提供了 Gemini 的 ListModels 查询能力：

- 展开 “Gemini 可用模型列表” → 点击 “查询可用模型”
- 会请求 `GET https://generativelanguage.googleapis.com/v1beta/models?key=...`
- 返回会自动去掉 `models/` 前缀，输出可直接填写到 `model_name` 的值

实现源码（`app.py`）：

```python
def _list_gemini_models(api_key, base_url):
    k = _normalize_api_key(api_key)
    if not k:
        return [], "请先填写 Gemini API Key 后再查询。"
    b = _normalize_base_url(base_url)
    if not b or "generativelanguage.googleapis.com" not in (b or "").lower():
        return [], "Base URL 不是 Gemini（generativelanguage.googleapis.com），无法查询模型列表。"
    root = b
    low = root.lower()
    if "/openai/" in low:
        root = root[: low.rfind("/openai/") + 1]
    elif low.endswith("/openai"):
        root = root[: low.rfind("/openai")] + "/"
    if not root.endswith("/"):
        root += "/"
    url = f"{root}models?key={k}"
    try:
        import httpx
        r = httpx.get(url, timeout=10.0)
        if r.status_code >= 400:
            return [], f"查询失败：HTTP {r.status_code}：{(r.text or '')[:400]}"
        data = r.json()
        items = data.get("models") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return [], "查询失败：返回格式不符合预期。"
        out = []
        for m in items:
            if not isinstance(m, dict):
                continue
            name = (m.get("name") or "").strip()
            if not name:
                continue
            if name.startswith("models/"):
                name = name[len("models/") :]
            out.append(name)
        seen = set()
        dedup = []
        for x in out:
            if x in seen:
                continue
            seen.add(x)
            dedup.append(x)
        return dedup, None
    except Exception as e:
        return [], f"查询异常：{str(e)[:400]}"
```

---

## 4. 运行时：轮询组如何选 Key、如何重试

LLM 实际调用入口在 Agent 基类：

- `base_agent.py` 中的 `BaseAgent._get_response()`

关键源码（节选，包含：读取 profile → 判断轮询组 → 选 Key → 失败冷却 → 重试）：

```python
    def _get_response(self, system_prompt, user_message, temperature=0.7):
        """Helper to call OpenAI API."""
        # Reload config to check for runtime updates
        # 1. Load profiles state
        model_state = ensure_state()
        
        # 2. Check agent binding first, then global active_id
        bound_pid = get_agent_binding(model_state, self.name)
        active_pid = bound_pid if bound_pid else model_state.get("active_id")
        
        # 3. Get profile data
        profile = get_profile(model_state, active_pid)
        
        api_key = ""
        base_url = ""
        model_name = ""
        
        if profile:
            api_key = (profile.get("api_key") or "").strip()
            base_url = (profile.get("base_url") or "").strip()
            model_name = (profile.get("model_name") or "").strip()
        else:
            # Fallback to env config (legacy)
            self.config = Config()
            api_key = self.config.api_key
            base_url = self.config.base_url
            model_name = self.config.model_name
            
        lb_keys = []
        if profile and is_lb_profile(profile):
            lb_keys = get_profile_api_keys(profile)
        if not api_key and not lb_keys:
            return "Error: API Key is missing. Please configure it in the sidebar."

        attempts = 1
        if lb_keys:
            attempts = max(1, len(lb_keys))
        last_err = None
        for _ in range(attempts):
            use_key = api_key
            if lb_keys:
                use_key = pick_lb_key(active_pid, lb_keys) or ""
            if not use_key:
                last_err = "轮询组未配置任何可用 API Key"
                break

            # Always re-init client to catch Base URL changes
            self.client = OpenAI(
                api_key=use_key,
                base_url=base_url,
                http_client=httpx.Client(trust_env=False, timeout=120.0),
            )

            try:
                _t0 = time.monotonic()
                response = self.client.chat.completions.create(
                    model=model_name,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_message}
                    ],
                    temperature=temperature
                )
                
                if response.usage:
                    track_usage(
                        model_name=model_name,
                        prompt_tokens=response.usage.prompt_tokens,
                        completion_tokens=response.usage.completion_tokens,
                        total_tokens=response.usage.total_tokens
                    )
                    record_llm_call(
                        agent=self.name,
                        model=model_name,
                        base_url=base_url,
                        status="success",
                        latency_s=time.monotonic() - _t0,
                        prompt_tokens=response.usage.prompt_tokens,
                        completion_tokens=response.usage.completion_tokens,
                        total_tokens=response.usage.total_tokens,
                    )
                else:
                    record_llm_call(
                        agent=self.name,
                        model=model_name,
                        base_url=base_url,
                        status="success",
                        latency_s=time.monotonic() - _t0,
                    )

                if lb_keys:
                    report_lb_result(active_pid, use_key, True, None)
                return response.choices[0].message.content
            except Exception as e:
                err = str(e)
                last_err = err
                try:
                    record_llm_call(
                        agent=self.name,
                        model=model_name,
                        base_url=base_url,
                        status="error",
                        latency_s=(time.monotonic() - _t0) if "_t0" in locals() else 0.0,
                    )
                except Exception:
                    pass
                log_event(
                    "llm_error",
                    agent=self.name,
                    model=model_name,
                    base_url=base_url,
                    error=err[:800],
                )
                if lb_keys:
                    report_lb_result(active_pid, use_key, False, err)
                    continue
                base_url_lower = (base_url or "").lower()
                if (
                    "generativelanguage.googleapis.com" in base_url_lower
                    and ("error code: 404" in err.lower() or "status code: 404" in err.lower() or " 404" in err.lower())
                    and ("not found" in err.lower() or "call listmodels" in err.lower())
                ):
                    return (
                        "Gemini 模型不可用（404）。\n\n"
                        "这通常不是 URL 或 Key 的格式问题，而是：\n"
                        "1) 你填写的模型名在当前 API Key 下不可用（模型下线/权限未开通/区域限制）；或\n"
                        "2) 模型名写错。\n\n"
                        "解决：到侧边栏“模型管理”里把“模型名称 (Model)”改成可用的模型。你也可以在模型管理页展开“Gemini 可用模型列表”，点击“查询可用模型”直接获取可用列表。\n\n"
                        "常见可尝试：gemini-2.5-flash、gemini-2.5-pro、gemini-3-flash-preview。\n\n"
                        f"原始错误：{err}"
                    )
                if "generativelanguage.googleapis.com" in base_url_lower and ("api_key_invalid" in err.lower() or "api key not valid" in err.lower()):
                    return (
                        "Gemini API Key 无效。\n\n"
                        "请检查：\n"
                        "1) 你填的是 Google AI Studio 生成的 Gemini API Key（通常以 AIza 开头），不是 OpenAI 的 sk-。\n"
                        "2) Key 复制粘贴时不要带引号/不要带 Bearer 前缀。\n"
                        "3) 该 Key 所属项目已启用 Gemini API（Generative Language API）。\n\n"
                        f"原始错误：{err}"
                    )
                if "api key not valid" in err.lower() or "api_key_invalid" in err.lower():
                    return "API Key 无效，请在侧边栏“模型管理”里更新后重试。\n\n原始错误：" + err
                if "insufficient balance" in err.lower() or "402" in err:
                    return (
                        "API 余额不足 (Error 402)。\n\n"
                        "请检查：\n"
                        "1) 你的 DeepSeek/OpenAI 账户余额是否已用尽。\n"
                        "2) 是否绑定了支付方式。\n\n"
                        f"原始错误：{err}"
                    )
                return f"Error calling API: {err}"

        if lb_keys:
            return (
                f"轮询组请求失败：已尝试 {len(lb_keys)} 个 Key，当前均处于冷却或不可用。\n\n"
                f"最后一次错误：{last_err or '未知错误'}"
            )
        return f"Error calling API: {last_err or '未知错误'}"
```

运行时逻辑（简化版）：

1) 每次请求前读取最新 profiles（支持热更新）
2) 先看“Agent 绑定”，再看全局默认 `active_id`
3) 若 profile 为轮询组：
   - 从 `api_keys`（或回退 `api_key`）得到 key pool
   - 进入 for-loop，最多尝试 `len(api_keys)` 次
   - 每次选取一把 key 初始化 OpenAI client 进行请求
   - 成功：清除该 key 的冷却
   - 失败：按错误类型给该 key 进入冷却，然后换下一把继续尝试
4) 全部 Key 都不可用：返回“轮询组请求失败：已尝试 N 个 Key...”

### 4.1 Key 选择算法（Round-Robin + 冷却）

核心函数：

- 选 Key：`model_profiles.py` 的 `pick_lb_key(profile_id, keys)`
- 上报结果/冷却：`model_profiles.py` 的 `report_lb_result(profile_id, api_key, ok, err=None)`

实现源码（`model_profiles.py`）：

```python
_lb_runtime = {}

def _lb_state(profile_id):
    if profile_id not in _lb_runtime or not isinstance(_lb_runtime.get(profile_id), dict):
        _lb_runtime[profile_id] = {"rr_index": 0, "cooldown_until": {}}
    st = _lb_runtime[profile_id]
    if "rr_index" not in st:
        st["rr_index"] = 0
    if "cooldown_until" not in st or not isinstance(st.get("cooldown_until"), dict):
        st["cooldown_until"] = {}
    return st

def pick_lb_key(profile_id, keys):
    keys = _normalize_key_list(keys)
    if not keys:
        return None
    st = _lb_state(profile_id)
    now = time.time()
    cd = st["cooldown_until"]
    start = int(st.get("rr_index") or 0) % len(keys)
    for i in range(len(keys)):
        idx = (start + i) % len(keys)
        k = keys[idx]
        until = float(cd.get(k) or 0.0)
        if until <= now:
            st["rr_index"] = (idx + 1) % len(keys)
            return k
    soonest_key = None
    soonest_until = None
    for k in keys:
        until = float(cd.get(k) or 0.0)
        if soonest_until is None or until < soonest_until:
            soonest_until = until
            soonest_key = k
    return soonest_key or keys[start]
```

```python
def _err_to_status_hint(err):
    s = (err or "").lower()
    if " 429" in s or "status code: 429" in s or "too many requests" in s or "rate limit" in s:
        return 429
    for code in (401, 403, 500, 502, 503, 504):
        if f" {code}" in s or f"status code: {code}" in s:
            return code
    if "api key not valid" in s or "api_key_invalid" in s:
        return 401
    return None

def report_lb_result(profile_id, api_key, ok, err=None):
    if not profile_id or not api_key:
        return
    st = _lb_state(profile_id)
    cd = st["cooldown_until"]
    if ok:
        cd.pop(api_key, None)
        return
    hint = _err_to_status_hint(err or "")
    cooldown_s = 20
    if hint == 429:
        cooldown_s = 45
    elif hint in (500, 502, 503, 504):
        cooldown_s = 10
    elif hint in (401, 403):
        cooldown_s = 600
    cd[api_key] = time.time() + cooldown_s
```

算法要点：

- 维护 per-profile 的运行时状态（进程内内存，不落盘）：
  - `rr_index`：轮询游标
  - `cooldown_until{api_key -> unix_ts}`：每把 key 的冷却截止时间
- 选 Key 时优先选择“未在冷却”的 key；若全部在冷却，选择最早解除冷却的 key（避免死等）

### 4.2 冷却时间策略（按错误码/提示推断）

从错误字符串中提取 status hint：

- 见上文 `model_profiles.py` 的 `_err_to_status_hint(err)` 实现

冷却时长：

- 429（限流/Rate limit）：45s
- 5xx（500/502/503/504）：10s
- 401/403（鉴权/权限）：600s
- 其他：20s

注意：

- 该策略是“工程兜底”而不是严格的 API 语义解析，适合应对 SDK 的不同错误信息格式。
- 冷却是“进程内状态”，服务重启后会重置。

---

## 5. 调用方式：为什么轮询组和普通模式“请求形态一样”

本项目不直接调用 Gemini 原生 SDK，而是统一走 OpenAI SDK：

- 构造：`OpenAI(api_key=use_key, base_url=base_url, ...)`
- 请求：`client.chat.completions.create(model=model_name, messages=[...])`

对应实现：

- 已包含在上文 `BaseAgent._get_response()` 节选中的 `OpenAI(...)` 与 `chat.completions.create(...)`

因此“轮询组 vs 普通模式”的区别主要是：

- 普通模式：`use_key = api_key`
- 轮询组：`use_key = pick_lb_key(profile_id, api_keys)`

而 `base_url` 与 `model_name` 的语义完全一致。

官方 OpenAI-compatible 端点参考（用于理解，不要求代码改动）：Gemini API 文档的 “OpenAI 兼容性”。（例如：`base_url=https://generativelanguage.googleapis.com/v1beta/openai/`，`model=gemini-3-flash-preview`）

---

## 6. 可观察性：如何看轮询组是否工作

### 6.1 结构化日志（JSON 行）

LLM 调用失败会记录：

- event=`llm_error`（包含 agent/model/base_url/error 摘要）
- 记录位置：`base_agent.py` 中的 `log_event("llm_error", ...)`（见上文 `BaseAgent._get_response()` 节选）

注意：日志不会打印 API Key。

### 6.2 Metrics（Prometheus）

LLM 调用计数与耗时：

- `fna_llm_requests_total{agent,model,provider,status}`
- `fna_llm_latency_seconds_bucket{agent,model,provider,status}`

埋点：

- `observability.py` 中的 `record_llm_call(...)`，源码如下：

```python
def record_llm_call(agent, model, base_url, status, latency_s, prompt_tokens=None, completion_tokens=None, total_tokens=None):
    if not _ensure_metrics():
        return
    prov = _provider_from_base_url(base_url)
    a = (agent or "unknown").strip() or "unknown"
    m = (model or "unknown").strip() or "unknown"
    st = (status or "unknown").strip() or "unknown"
    _C_LLM_REQ.labels(a, m, prov, st).inc()
    try:
        _H_LLM_LAT.labels(a, m, prov, st).observe(float(latency_s or 0))
    except Exception:
        pass
    if isinstance(prompt_tokens, int):
        _C_LLM_TOK.labels(a, m, prov, "prompt").inc(prompt_tokens)
    if isinstance(completion_tokens, int):
        _C_LLM_TOK.labels(a, m, prov, "completion").inc(completion_tokens)
    if isinstance(total_tokens, int):
        _C_LLM_TOK.labels(a, m, prov, "total").inc(total_tokens)
```

指标端口：

- 默认 `127.0.0.1:9108`
- 若 9108 被占用，会自动尝试 `9108-9138` 端口范围内的可用端口（避免反复刷屏 “Address already in use”）
- 实现源码（`observability.py`）：

```python
def start_metrics_server():
    global _METRICS_STARTED
    if os.environ.get("FNA_METRICS", "1").strip() not in ("1", "true", "TRUE", "yes", "YES", "on", "ON"):
        log_event("metrics_disabled")
        return False
    if not _ensure_metrics():
        log_event("metrics_unavailable")
        return False
    with _LOCK:
        if _METRICS_STARTED:
            return True
        try:
            from prometheus_client import start_http_server
        except Exception:
            return False
        port = int(os.environ.get("FNA_METRICS_PORT", "9108"))
        host = os.environ.get("FNA_METRICS_HOST", "127.0.0.1")
        for i in range(0, 31):
            p = port + i
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                try:
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    s.bind((host, p))
                finally:
                    try:
                        s.close()
                    except Exception:
                        pass
            except Exception:
                continue
            try:
                start_http_server(p, addr=host)
                _METRICS_STARTED = True
                log_event("metrics_started", host=host, port=p)
                return True
            except Exception as e:
                err = str(e)
                if "Address already in use" in err or "[Errno 48]" in err or "EADDRINUSE" in err:
                    continue
                log_event("metrics_start_failed", error=err, host=host, port=p)
                return False
        log_event("metrics_start_failed", error="no available port", host=host, port=port)
        return False
```

---

## 7. 常见故障与排查

### 7.1 404：模型不可用（最常见）

典型日志（示例）：

- `Error code: 404 - ... models/<xxx> is not found ... Call ListModels ...`

结论：

- 通常不是 URL/Key 格式问题
- 是 **模型名在当前 API Key 下不可用**（模型下线/权限/区域限制）或模型名写错

处理：

1) 到模型管理页展开 “Gemini 可用模型列表” → “查询可用模型”
2) 从返回列表选择一个作为 `model_name`

运行时对该错误也给了更明确的提示：

- 见上文 `BaseAgent._get_response()` 节选中对 Gemini 404 的分支返回

### 7.2 401/403：Key 无效或权限不足

现象：

- `api key not valid` / `api_key_invalid` / 401/403

处理建议：

- 确认使用的是 Google AI Studio 的 Gemini API Key（常见为 `AIza...`）
- Key 粘贴不要带引号/不要带 Bearer（即使带了也会被自动 normalize，但建议保持干净）
- 确认 Key 所属项目启用了 Gemini API（Generative Language API）

### 7.3 429：限流

现象：

- `429` / `rate limit` / `too many requests`

行为：

- 触发该 Key 冷却 45 秒，轮询切换下一把 Key

处理建议：

- 增加 Key 数量、降低并发、或降低调用频率（特别是多 Agent 同时请求时）

### 7.4 “轮询组未配置任何可用 API Key”

触发条件：

- 轮询组 profile 的 `api_keys` 为空，且 `api_key` 也为空

处理：

- 在 “Google Gemini（轮询组）”里粘贴至少 1 行 Key 后保存

---

## 8. 安全注意事项

- `data/config/model_profiles.json` 内包含 API Key，属于本地机密文件：
  - 避免提交到公共仓库
  - 团队协作建议通过私有渠道分发或用环境变量/密钥管理方案替代
- 日志与 metrics 不记录 API Key，但仍可能包含 model/base_url 等元信息

---

## 9. 快速验收（给评审/接手同事）

建议用以下检查点快速判断“轮询组功能已集成且可用”：

1) UI 能创建 **Google Gemini（轮询组）**，支持多行 Key
2) 保存后 `model_profiles.json` 中该档案 `provider=gemini_rr`，并包含 `api_keys` list
3) 运行时请求会在失败后切换 key（观察日志 `llm_error` 次数与请求最终成功）
4) 404 模型不可用时有明确提示，并可通过 UI 查询可用模型列表定位可用 model_name
