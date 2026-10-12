# dsh-agent-profiles —— 智能体配置

> **English summary** — Multiple AI agent profiles for DSH (DeepSeek Harness): role, avatar, personality, speaking style, ground rules and long-term memory — one global default, plus a per-conversation override with its own instructions and memory.
> **Install:** reference this folder from your DSH profile (`"dsh-agent-profiles": "link:<your dir>/dsh-agent-profiles"`), then restart DSH for the host half and reload the page for the client half.
> **Highlights:** choose the active profile, pin a profile per conversation, memory-injection toggle, import / export, restore defaults.
> **Language:** the settings UI follows the host language setting — Chinese and English dictionaries are both built in. **Model-facing prompts stay in Chinese** by design.
> **License:** MIT.

多套 AI 智能体配置：**角色设定 / 性格特点 / 说话习惯 / 行为准则 / 长期记忆摘要 / 记忆条目**。

两层作用范围：

| 层           | 在哪改            | 作用范围                                  |
| ----------- | -------------- | ------------------------------------- |
| **全局当前配置**  | 设置 →「智能体配置」    | 没做专属设定的对话都用它                          |
| **每个对话的配置** | 输入框左侧下拉 + ⚙ 面板 | 只影响这一个对话；可固定某套配置，还能写**本对话专属**的补充设定与记忆 |

无论哪一层，切换都是**立即生效且只影响之后的对话**，历史记录一个字都不动。

---

## 1. 整体结构与模块划分

```
dsh-agent-profiles/
├── package.json          ── ① 包清单：bundle patch + dsh.client 声明 + meta/icon
├── cordis.patch.yml      ── ① 装配：插入 agent-profiles 行，硬依赖 webServer
├── icon.svg              ── ① 插件卡片图标
├── locale/zh.json,en.json── ② 元数据文案（宿主读插件卡片用）
└── lib/
    ├── store.js          ── ③ 数据模型 + 持久化 + 导入导出 + 变更算子
    ├── prompt.js         ── ④ 配置 → 注入文本（记忆开关、优先级声明、截断）
    ├── routes.js         ── ⑤ Host HTTP API（/__ap/*）+ index.html 脚本注入
    ├── index.js          ── ⑥ Host 入口：装配 store/prompt/routes + 注册提示词段落
    └── client.js         ── ⑦ 浏览器半：设置页（分栏）+ 输入框快速切换器
```

### 数据流

```
                       ┌──────────────── Host 进程 ────────────────┐
  设置页 / 快速切换器   │                                            │
   （浏览器）           │   routes.js  /__ap/state   /__ap/command   │
        │  fetch        │      │            /__ap/preview  /__ap/export
        └──────────────►│      ▼                                     │
                        │   store.js ──► profiles.json（原子写）      │
                        │      │                                     │
                        │      │  每次组装提示词时现算                │
                        │      ▼                                     │
                        │   prompt.js ──► systemPrompt.section(      │
                        │                   text: () => renderActive)│
                        └────────────────────────────────────────────┘
                                         │
                                         ▼
                              模型看到的本轮系统提示词
```

### 为什么这么切

| 模块          | 单独成层的理由                                                |
| ----------- | ------------------------------------------------------ |
| `store.js`  | 「配置长什么样、存哪、坏了怎么办」的生命周期是**磁盘**；与「怎么渲染成提示词」「怎么传给界面」完全不同步 |
| `prompt.js` | 这是**产品文案**层：段落顺序、空字段省略、记忆开关、截断说明都会随反馈反复改；改它不该碰到数据与传输代码 |
| `routes.js` | 传输与鉴权（同源守卫、体积上限、方法限制）是一组独立关注点，与业务算子分开才好测               |
| `index.js`  | 只做装配与降级（缺服务时怎么办），本身不含业务规则                              |
| `client.js` | 浏览器半必须自包含：不能 require 任何 Harness Client 包（见下）           |

---

## 2. 关键设计决策

### ① 提示词段落交的是「函数」，不是「字符串」

```js
systemPrompt.section({
  name: "agent-profiles:persona",
  order: 860,
  text: () => renderActive(store),   // ← 每次组装现算
});
```

字符串在注册那一刻就定死了，之后切换配置不会生效（重复注册同名段落会抛错）。  
交函数则**每次组装读一次当前的 activeId**，于是：

- 切换配置 ⇒ 下一次组装就是新配置 ⇒ **立即生效**；
- 历史消息存在会话日志里，本插件从不写它 ⇒ **历史不受影响**。

这两条不是顺手做到的，是把渲染做成函数直接换来的性质。

### ② `systemPrompt` 不进 `inject`，走 `ctx.get()` 软探测

硬依赖的语义是「缺了就整个插件停在 pending」。缺 `systemPrompt` 会让**设置界面也不出现**，  
用户连「为什么没有界面」都无从判断。所以：注入是增强，界面是本体，本体不该被增强拖死。  
（`webServer` 是硬依赖 —— 没它连界面都发不出去。）

### ③ 「每个对话一套」靠 **agent 作用域的同名段落**，不靠全局开关

全局段落只知道全局配置 —— 它拿不到「现在在跟哪个对话说话」。所以每个对话要有一个  
挂在该 agent 自己 ctx 上的段落：

```js
ctx.on("agent/created", ({ agent }) => {          // agent.id 就是 sessionId
  agentCtx.effect(() => systemPrompt.section({
    name: "agent-profiles:persona",                // ← 与全局段落**同名**
    order: 860,
    text: () => renderForSession(store, sessionId),
  }));
});
```

官方规则是「作用域段落压过同名全局段落」，于是：

- 有 agent 作用域段落 ⇒ 用**这个对话**的绑定与专属设定；
- 没有（非 agent 组装、或 `agent.ctx` 拿不到）⇒ 回落到全局段落的全局配置。

`agent/created` 是 **await 的**（早于第一步组装），所以注册一定赶在第一次注入之前完成；  
拿不到 `agent.ctx` 时**只降级 + 记一条 warning，绝不抛错** ——  
那个事件抛错会让 **agent 创建失败**，比「本对话设定没生效」严重得多。

两层各自的组装次数都会记进诊断（`本对话段 SN 次 / 全局兜底段 GN 次`），  
设置页能直接看到 —— 「每个对话独立注入」不是靠信念，是靠这个计数。

### ④ 出厂默认就带着一套准则

默认启用的「通用助手」是**填好内容**的（用户明确要求）：实事求是、简洁直白、不猜想臆想、  
服从现行的 AI 内容规范与平台审核要求、做没做好都如实说。出厂即生效 —— 新会话里默认助手  
就按这套说话，不用先手动配置。

> 早期版本这里是**刻意留空**的，理由是「装一个插件不该悄悄改变用户助手的行为」。  
> 用户看过实际效果后明确要求给默认助手写准则，于是**有意填上**。  
> 想回到零注入：把这一套的四个内容字段清空即可，`hasContent()` 会自动让它不进提示词  
> （注入与技能目录都会跳过它）。  
> 测试里把「默认准则必须含这五条」钉成了断言 —— 谁清空，谁就要面对红灯。

### ④c 长期记忆的自动化：工具 + 每 5 回合后台提炼 + 超限压缩

用户选择的是**两者都要**：模型能主动存，插件再定期兜底。

```
① 工具 memory_save      模型觉得值得长期记住 → 当场写进「本对话生效的那套配置」
② 后台提炼（每 5 回合）  插件读对话 → 调一次模型 → 把要点存进去
③ 超限压缩             长期记忆 > 5000 字 → 调模型合并成「摘要 + 精简条目」
```

**触发点**是 `agent/status` 变成 `idle`（一个回合跑完）——  
不能挂 `running`，那是回合**开始**，内容还没产生。

**写入目标**按会话 id **当场解析**（会话绑定优先，否则全局当前），  
绝不缓存「当前配置 id」：用户在对话中途切换配置时，缓存会把记忆写错地方。

**为什么压缩必须由插件做、不能交给模型自觉**：模型不知道「记忆满了」。  
预算判断只能由持有数据的一方做。

**四条硬约束（每条都对应一种「把会话弄坏」的形态，都有测试）**：

1. **绝不抛错到调用方**。后台跑的代码，任何异常都不该影响用户正在进行的对话；  
   所有对外调用包 try/catch，失败只记日志。
2. **绝不并发**。同一会话同一时刻只跑一次；否则两次跑起来会重复写同一批记忆。
3. **输入必须有上限**。送进模型的对话摘录截断到 6000 字 —— 那是用户的钱。
4. **输出必须能解析**。要求模型「一行一条」，**不用 JSON**：JSON 一旦格式跑偏整批丢失，  
   行文本最坏只是存进一条废话。压缩结果为空时**保持原样**，绝不冒险覆盖。

**缺服务要在装载时就说清楚**（缺 `sessionQuery` / `llm` / `tools` 各一条告警）：  
静默跳过的现象是「功能好像没生效」，用户分不清是没触发还是没能力。

**顺带修掉的一个真 bug**：`ProfileStore.command()` 原来只回传 `notice`，  
把算子自己的附加字段（`memory.autoAdd` 的 `added`）丢了 ——  
现象是「记忆明明存进去了，日志和诊断里却什么都没有」。现在附加字段原样带出。

### ④b 空配置不注入、且记忆关闭时整块消失

只起了个名字的配置不产生注入（`hasContent()`）。  
关闭记忆注入时是**整块不出现**，而不是出现「（记忆已关闭）」——后者仍占上下文，  
还会暗示模型「有记忆但你看不到」，让它开始猜记忆内容，比不注入更糟。

### ⑤ 客户端不 require 任何 Harness Client 包

官方 `practices.md` 明令禁止：那些包随版本变化、plain-JS 无类型检查，  
一个抛错的组件会**清空整个插槽条目**。所以控件全部自己写，样式只用 `--dsw-alias-*` token  
（token 改名最多让外观退化，不会让渲染炸掉），类名统一 `ap-` 前缀。

### ⑥ 首帧绝不返回 `null`

槽位账本把「渲染出内容的条目」记为 `active`。返回 `null` 的条目停在 `active:false`，  
而首帧**必然**还没有数据（fetch 是异步的）—— 那就等于控件永远不显示。  
所以加载中/失败都渲染占位控件。（这条是实测出来的，见第 5 节。）

### ⑦ 头像：配置项与渲染逻辑

**配置项**：`profile.avatar` —— 一个 data URL（`data:image/(png|jpeg|webp|gif);base64,…`），  
空串表示「没设」。

- **为什么存 data URL 而不是落成图片文件**：配置保持**自包含** —— 导出即带走、  
  导入即完整，删配置不留孤儿文件，也不用再写一套文件清理。代价是体积。
- **所以上传时必须先缩**：客户端用 canvas 把图缩到最长边 **512px**、webp 质量 **0.92**  
  再转 data URL（通常几十 KB）。手机照片 3~8MB 直接 base64 会让 profiles.json 膨胀到  
  几十 MB，而**每次保存都要重写整份 JSON**。
  - 早期是 192px / 0.85：回合头头像从 22px 放大到 44px 之后，192px 的源在高分屏上  
    明显发糊（用户反馈），所以源尺寸、质量、上限一起抬高。
- **服务端再兜一道**：`LIMITS.avatar = 400000` 字符，超长 / 非白名单前缀一律落成空串。
- **明确拒绝 SVG**：SVG 里能带脚本，等于给配置文件开一个 XSS 口子。
- 头像**不进提示词**（base64 不该烧模型上下文），跟着导出走，复制配置时一起复制。

**渲染逻辑**（三种状态必须分得清，这是需求里点名要处理的）：

| 状态        | 判定              | 显示                          |
| --------- | --------------- | --------------------------- |
| ① 设了头像    | `avatar` 非空     | `<img class="ap-avatar">`   |
| ② 没设      | `avatar === ""` | 该配置的 **emoji 图标**（圆形底 + 居中） |
| ③ 设了但加载失败 | `img.onError`   | **同样回落到 emoji 图标**，不留破图     |

③ 记的是「**哪一张**坏了」而不是一个布尔值：否则用户换一张新图，  
旧的失败标记还会把新头像挡掉。

### ⑦b 双通道：配置同时是技能

用户要的是「不要让一整套人设占满每次对话，把它做成技能」。选了 **B：skill + 保留自动注入**。

```
① 系统提示词注入（作用域段落）  →  人设**一定**生效，模型什么都不用做
② 技能目录（skill provider）    →  同一份配置也能按需 `skill` 加载原文，
                                   技能列表里还能看到这台机器上有哪些智能体
```

**为什么用 `registerProvider` 而不是 `register`**：`register({ content })` 的正文是  
**注册那一刻**的字符串快照 —— 用户改完配置，技能里还是旧内容。而 provider 的  
`get()` 是**真正被加载时**才调用，正文按当下配置现算；再配 `control.invalidate()`  
（配置变更时广播）让目录重算名字与描述。

```js
ctx.skills.registerProvider((control) => ({
  name: "agent-profiles",
  async list() { return { candidates: skillCandidates(store), complete: true }; },
  async get(candidate) {
    const profile = store.profileById(candidate?.locator?.profileId);
    return { ...candidate, content: renderProfile(profile) };   // 加载时才渲染
  },
}));
```

**目录只收「有内容」的配置**：空配置加载出来是一段废话，而技能目录会进**每次**会话的  
系统提示词 —— 这条路径上「少即是多」。描述也压到一行 80 字以内（角色设定首句）。

**两条硬约束（都有测试）**：

1. `list()` / `get()` **绝对不能抛错**。技能目录是系统提示词的一部分，它抛错会连累  
   整个目录 —— 那是「一个插件弄坏所有会话」的量级。两个方法内部全部 try/catch，  
   失败就退化成「没有这个技能」；连「候选对象取值就抛错」这种输入也验过。
2. `skills` 走 `ctx.get()` **软探测**：缺这个服务只是没有技能通道，注入与界面照常。

**技能名**：`agent-profile-<slug>`，kebab-case。配置名常是中文，去掉非 ASCII 后会是  
空串 —— 那时退回用配置 id 拼一个**稳定**的名字（技能名会被会话引用，不能这次 A 下次 B）。

**配置变更广播**：`ProfileStore.onChange()` 在**落盘成功后**才广播（失败已回滚，那时广播  
会让目录算出不存在的内容）；每个订阅者单独 try/catch —— 一个订阅者抛错不该让  
「配置存不进去」。

### ⑦c 回合头：[头像] 名称 贴在官方「已完成 …」那一行上方

目标版式（用户给的标注）：

```
[头像] WorkBuddy        ← 本插件加的
已完成 5m42s ›          ← 官方 turn-process 那一行，原样
两个问题都修了……        ← 正文
```

**为什么不能「加个座位」了事**：`conversation.chat.node` 是 **keyed** 槽，  
19 个 key 全被官方占用，那一行是官方的 `turn-process` 渲染器；  
它底下的加法座位只有 4 个（`tool.call.toolview` / `assistant-actions` /  
`commandview` / `turnTail`），**没有一个在那一行里面**，整棵槽位树里也没有任何消息级「左侧/头部」座位（搜过 `avatar` / `leading`）。

**做法：优先级顶替 + 包一层官方渲染器（不是重写）**

槽位系统**明确支持**这件事 —— keyed 槽同 key 同 priority 会直接抛错并告诉你怎么办：

```
keyed slot "conversation.chat.node" already has an entry for key "turn-process"
  at priority 0 — register at a different priority to shadow it (lowest renders)
```

于是：

```js
// ① 拿到官方那个渲染器（公开方法，不是掏私有字段）
const official = ctx.get("slots").entries("conversation.chat.node")
                   .find((e) => e.options?.key === "turn-process" && e.component !== TurnHead)?.component;
// ② 用更小的 priority 顶替（官方是 0）
ctx.slots.register({ name: "conversation.chat.node", key: "turn-process", priority: -10 }, TurnHead);
// ③ 我的组件 = 我的头像头 + 官方组件原样，返回 Fragment（不额外包 div）
return h(Fragment, null,
  h(ApBoundary, { compact: true }, h(TurnHeadBadge, props)),   // 只有我这一块在错误边界里
  h(official, props));                                          // 官方那一行，同一个 props
```

`entries(key)` 是 `SlotRegistry` 上的公开方法（转发到 `SlotCore.entries`，带 JSDoc），  
返回的条目带 `component` —— **不是**去掏 renderer 的私有 `_core`（前一版我就是被这个挡住了）。

**五道保险，失败形态是「没有头像」而不是「那一行没了」**：

1. **能力探测**：取不到官方组件就**根本不注册** → 那一行保持官方原样；
2. **订阅重试**：本插件可能比 ui-chat 先加载，那时官方条目还没出现 ——  
   订阅 `conversation.chat.node` 的注册变化，等它出现再接管  
   （没有这一步，加载顺序会让功能**静默失效**）；
3. **注册时抓一份官方组件的引用做兜底**，渲染时再解析失败也不会渲染出空；
4. **我自己的那部分单独关在错误边界里**，官方渲染器不在边界内 ——  
   我的代码再错也影响不到官方那一行；
5. 返回 **Fragment**：不额外包 div，我的头只是官方行前面多出来的一个兄弟节点，  
   不改动任何既有布局关系。

**可逆**：注销我这条注册，官方 priority 0 那条自动回到渲染位。

**尺寸**：头像 44px、名称 13px。用户明确要求「头像大约两倍大、文字不变」——  
早期是 22px，在高分屏上偏小；44px 也是设置页编辑器里预览的尺寸，两处一致。

**回合尾那一份已去掉**（0.6.0）：早期还在 `conversation.chat.turnTail` 注册过一份  
同样的「头像 + 名称」，用户看完实际效果后明确说「回合尾的就不用了」——  
回合头那份已经把「这条是谁写的」说清楚了，末尾再来一个是重复。  
代码里留了注释说明这是**有意去掉**的，并且测试把「不再注册 turnTail」钉成了断言。

用哪套配置：**本对话当前生效**的那套（会话绑定优先，否则全局当前）。  
不给历史消息记录「当时用的是哪套」——那要写会话日志，而本插件从第一天起  
就不写会话日志（需求：不影响历史记录）。

---

## 3. HTTP API

所有路由挂在宿主的浏览器载体上，带同源守卫。**规则是「硬证据只用于否决，不用于放行」**：  
`Sec-Fetch-Site: cross-site` 拒绝；有 `Origin`/`Referer` 必须与 `Host` 一致；  
都没有则放行（非浏览器上下文，例如 curl 探活）。

| 方法与路径                 | 作用                                       |
| --------------------- | ---------------------------------------- |
| `GET /__ap/state`     | 整份状态 + 元信息（数据目录、计数、注入诊断）                 |
| `POST /__ap/command`  | 所有变更的唯一入口，body 是 `{op, ...}`，返回**整份**新状态 |
| `POST /__ap/preview`  | 渲染一份**草稿**配置（未保存也能看注入长什么样）               |
| `GET /__ap/export`    | 导出信封（可再导入）                               |
| `GET /__ap/client.js` | 客户端 bundle                               |

### 变更算子

| `op`                                                              | 参数                                                   | 说明                             |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `profile.create`                                                  | `profile?`                                           | 新建并**自动设为当前**（下一步必然要编辑它）       |
| `profile.update`                                                  | `id`, `patch`                                        | 保存编辑区内容                        |
| `profile.duplicate`                                               | `id`                                                 | 复制（含记忆，全部换新 id）                |
| `profile.delete`                                                  | `id`                                                 | **至少保留一套**，删当前则自动切到第一套         |
| `profile.activate`                                                | `id`                                                 | 切换当前配置                         |
| `memory.add` / `memory.update` / `memory.remove` / `memory.clear` | `profileId`, …                                       | 记忆条目级操作（配置自带记忆）                |
| `session.set`                                                     | `sessionId`, `patch: {profileId?, note?, memories?}` | **本对话**的设定：绑哪套配置 + 补充设定 + 专属记忆 |
| `session.clear`                                                   | `sessionId`                                          | 清掉本对话的设定，改回跟随全局                |
| `sessions.clearAll`                                               | —                                                    | 清掉所有对话的设定（配置本身不动）              |
| `state.import`                                                    | `payload`, `mode: "merge"｜"replace"`                 | 导入信封或裸状态；合并时撞 id 自动改号          |
| `state.restoreDefaults`                                           | —                                                    | 恢复出厂三套（并清空各对话设定）               |


> 界面上的记忆编辑走**草稿 + `profile.update`/`session.set`**（与其它字段同一套语义：改完点保存）；
> `memory.*` 这一组是给程序化调用准备的等价入口。

### 会话设定的三条语义

1. **空即删除**：`profileId=null` 且补充设定为空且没有记忆 ⇒ 这条记录被删掉。
   否则「有几个对话做了专属设定」这个数字会把所有点开过的对话都算进去，立刻失去意义。
2. **导出不含会话**：`sessionId` 是**本机**的，导出去只是孤儿绑定。
3. **删配置自动解绑**：删掉一套配置时，指向它的对话会改回跟随全局，并在提示里说明影响了几个对话 ——
   否则那些对话会绑到一个不存在的配置，注入静默回落而界面还显示「已固定」。

---

## 4. 持久化

- 位置：`<安装根>/.dsh-agent-profiles-data/profiles.json`（卸载重装插件不丢）。
  可用环境变量 `DSH_AGENT_PROFILES_DATA` 覆盖。
- **原子写**：`tmp` → `rename`。否则崩溃留下半截 JSON，下次读会走「回退默认值」，
  用户所有配置凭空消失。
- **写失败回滚内存**：先落盘、成功才换内存。反过来的话界面显示「已保存」而重启后回退，
  等于骗用户。
- **变更串行**：设置页与快速切换器可能同时写；并发读改写会丢更新，所以所有变更走一条 promise 链。
- **读不出来也必须能起来**：文件损坏 / 字段类型错 / 手改坏了 JSON，一律回退默认值并记下
  `lastError`（界面显示），绝不抛错阻塞会话。

---

## 5. 事故与修复

### 5.1 设置页一片空白（0.1.1）

**症状**：设置里能点开「智能体配置」，但页面是**空的** —— 没有列表、没有表单，
连当前启用的是哪套都看不到；控制台也没有任何报错。

**根因**：客户端把 `react/jsx-runtime` 的 `jsx()` 当 `React.createElement()` 用了。
两者签名完全不同：

```js
createElement(type, props, ...children)   // 子元素是变长参数
jsx(type, props, maybeKey)                // 第三个参数是 key！
```

于是 `h("div", {className:"x"}, childA, childB)` 里的 `childA` 被当成 **key**，
`childB` 直接丢弃 —— 组件照常返回、不抛错、控制台一行提示都没有，
只是渲染出一个空壳。`jsx(Fragment, null, child)` 更直接抛
`TypeError: Cannot convert undefined or null to object`。

**实测证据**（`test/jsx-probe.mjs`，可直接跑）：

```
jsx(type, props, child1, child2):
  props.children = undefined          ← 子元素全没了
  key            = "[object Object]"  ← 被当成了 key
createElement(type, props, child1, child2):
  children 长度 = 2
```

官方模板用的就是 `React.createElement`（`templates/decoration/client.js`），
是我当初偏离了模板。**已改回 `React.createElement`。**

**为什么之前没发现**：这个失败模式**完全静默**。
「渲染出空壳」和「渲染正常但没数据」在界面上长得一模一样，
而当时唯一的验证手段是「插槽里有我的占用者」—— 占用者是注册出来的，空壳也有占用者。
所以补了 `test/client-render.test.mjs`：接管 React 的 hook 派发器 + 一个极简渲染器，
**把组件真的跑一遍**，再按元素树断言内容。

**同时补的防线**：`ApBoundary` 错误边界（class 组件 + `getDerivedStateFromError`）。
官方机制下组件抛错会**清空整个插槽条目**，用户看到的还是一片空白；
有了它，任何渲染异常都会变成界面上一段可读的报错 + 堆栈。

**顺带修的隐性问题**：组件里大量 `tt("field.roleHint", "")` —— 显式兜底是空串。
一旦 locale 注册没成功，`tt` 就返回那个空串，于是**标签还在、说明文字整片消失**。
现在 `tt` 会回落到内置中文词典：最坏情况是显示中文，而不是显示空白。

### 5.2 错误边界包装层把 props 吞了（0.2.0）

为了不让渲染异常清空插槽，两个条目外面各套了一层 `ApBoundary`。但包装层是这么写的：

```js
function QuickSwitcherGuarded() {              // ← 没有形参
  return h(ApBoundary, { compact: true }, h(QuickSwitcher));   // ← 也没往下传
}
```

宿主把标准属性（`conversation.input.left` 的 `sessionId`）当 props 传给注册的组件，
被这层包装吃掉之后，里层组件**永远拿不到会话 id** ——
表现是「每个对话的设定」整个功能静默失效：界面还在、不报错，只是永远显示「跟随全局」。

**已改成 `function QuickSwitcherGuarded(props) { … h(QuickSwitcher, props) }`。**
这个 bug 是 `test/client-render.test.mjs` 逮住的（它给控件传 `sessionId` 并断言下拉的值），
也是「包装组件必须有对应断言」的由来。

### 5.3 让会话不可用：effect 注销器返回了 undefined（0.2.1）

**症状**（用户原话：会话用不了、从左侧列表消失、会话界面显示不可用）：

```
[agent-registry] agent "session-…": agent/disposed listener threw:
  TypeError: Cannot read properties of undefined (reading 'catch')
```

整份日志里**第一次出现**就在 0.2.0 加载后的第 1 秒，此前从未有过。

**根因**：`agent/created` 里我是这么注册 per-agent 段落的：

```js
const dispose = agentCtx.effect(() => systemPrompt.section({ … }));
```

`systemPrompt.section()` 的清理是**同步**的。cordis 的 effect 只有在
「清理链里有 thenable」时才让注销器返回 Promise（`Fiber.effect` 里
`task ? disposeAfter(task) : dispose()`，而 `dispose()` 在没有 thenable 时返回 `undefined`）。
宿主销毁 agent 时对注销器的返回值调 `.catch()`，于是 `undefined.catch(...)` 炸掉，
被记成「agent/disposed listener threw」——**错误信息里一个字都没提插件**。

**修复**：把清理变成异步，注销器就必然返回 thenable：

```js
return () => Promise.resolve().then(() => disposeSection?.());   // ← 别改回同步
```

**用真 cordis 复现宿主的调用姿势**（`test/cordis-effect-probe.mjs`）：

```
旧写法 () => someDisposer()                               → TypeError: Cannot read properties of undefined (reading 'catch')
新写法 () => Promise.resolve().then(() => someDisposer()) → 宿主拿到了 thenable，没抛错 ✓
```

**为什么之前没测出来**：这个 bug 只在**销毁**时炸，注册那一刻一切正常；
store / prompt / routes / client-render 四个套件全都碰不到它。
所以补了 `test/host-wiring.test.mjs`：用假 ctx 把 `apply()` 跑起来，
检查**注册出来的东西长什么样**——尤其是那条「清理函数必须返回 thenable」。

**两道防线**（都在 0.2.1 里）：

- 注册整体包在 `try/catch` 里：注册失败只降级为全局注入 + 记 warning，
  **绝不让它冒泡**（`agent/created` 抛错会让 agent 创建失败，比功能失效严重得多）。
- 逃生开关：环境变量 `DSH_AGENT_PROFILES_NO_SESSION_SCOPE=1` 时**只保留全局注入**，
  不必卸载插件就能关掉这段有风险的注册。

### 5.4 面板透明、字看不清：token 名根本不存在（0.2.2）

**症状**：点开「本对话的智能体」浮层，背景透明，后面的对话正文叠上来，看不清。

**根因不是透明度写错，是 token 名不存在**：我写的是
`background: var(--dsw-alias-bg-base-secondary)`，而这个部署的主题注册表里
**没有这个名字** ⇒ 整条声明被浏览器丢弃 ⇒ 背景透明。

这类错误的可怕之处：**没有任何报错**。CSS 变量名写错，浏览器安静地忽略那一行；
组件照常渲染、测试套件全过，只有人眼在「浮层压在有字的内容上」时才会发现。

**修法**（换成主题里真实存在、语义正确的 token）：

| 用途 | 原来（不存在） | 现在 |
|---|---|---|
| 面板 / 列表这类抬升面 | `bg-base-secondary` | `--dsw-alias-bg-layer-1` |
| 输入框 / 按钮 / 徽标这类嵌套面 | `bg-base-secondary` `-tertiary` | `--dsw-alias-bg-layer-2` |
| 悬停 | `bg-base-tertiary` | `--dsw-alias-interactive-bg-hover` |
| 选中 | `bg-base-tertiary` | `--dsw-alias-interactive-bg-active` |
| **浮层（必须实心）** | `bg-base-secondary` | `background-color: bg-base` **＋** `background-image: linear-gradient(bg-overlay, bg-overlay)` |

浮层那行是两层叠加：不透明的 `bg-base` 打底，再叠主题的浮层色
（`--dsw-alias-bg-overlay`，官方描述就是 "Overlay and popover background"）。
**即使主题把浮层色定义成带 alpha 的，底色也保证它实心。**

**防回归**：新增 `test/theme-tokens.test.mjs` —— 把 CSS 里用到的每个 `--dsw-*`
与 `cordis_inspect_query`（client / Theme / listTokens）返回的**注册表**逐一核对，
并额外断言浮层必须是不透明两层写法。写错一个变量名，测试直接失败。

### 5.5 每个对话的注入其实一直没生效（0.3.0）

**症状**：配置能存、预览能看，但每个对话的专属设定**从来没进过提示词** —— 一律回落全局。
界面上完全看不出来。宿主日志在喊（这是唯一线索）：

```
[W] [agent-profiles] 本对话的段落注册失败，本次降级为全局注入：
    prompt section "agent-profiles:persona" is already registered
    (for a per-agent override, register through that agent's `agent.ctx` instead)
```

**根因**：我用的是**插件 ctx 上取的那个** `systemPrompt`：

```js
const systemPrompt = ctx.get("systemPrompt");        // ← 插件作用域
ctx.on("agent/created", ({ agent }) => {
  agent.ctx.effect(() => systemPrompt.section({ … })); // ← 代理把注册落回插件层
});
```

cordis 的服务代理是**按「取它的那个 ctx」绑定作用域**的。用插件的 ctx 取到的服务去注册，
落点是插件层，于是和全局那段同名冲突 —— 宿主那句提示就是答案：
「要按 agent 覆盖，就从**那个 agent 的** `agent.ctx` 注册」。

**修复**：

```js
const scopedSystemPrompt = agentCtx.get("systemPrompt");   // ← 从 agent 自己的 ctx 取
agentCtx.effect(() => scopedSystemPrompt.section({ … }));
```

**为什么四个测试套件都没抓到**：假的 `systemPrompt` 允许重复注册、假的 `agentCtx` 没有
`systemPrompt`，于是「注册落错作用域」在测试里**根本不可能失败**。
现在 `test/host-wiring.test.mjs` 的假对象会**像宿主一样拒绝同层重名**，
并断言「全局层只有全局那一段、作用域那段落在 agent 作用域里」。
改完这条假规则，测试立刻抓出了另一处我自己的错误假设 —— 说明它现在真的在干活。

**教训**：日志里那条 `[W]` 是唯一能发现它的地方。这类「静默降级」的设计有个副作用 ——
降级日志不打，功能没了你也不知道。所以关键降级路径**必须留一行可查的日志**。

---

## 6. 验证状态

| 项 | 结果 |
|---|---|
| 安装 | `application: applied`，`warnings: []`，无构建脚本待批 |
| 行状态 | `include:agent-profiles` → `enabled: true`, `fiberPhase: "active"` |
| Host 启动日志 | `[agent-profiles] 就绪：3 套配置，当前「通用助手」，数据 <安装根>\.dsh-agent-profiles-data\profiles.json`，**无任何告警/报错** |
| 数据层自测 | `test/store.test.mjs` → **176 项断言全过**（垃圾输入、损坏文件、删最后一套、导入合并撞 id、并发写、写失败回滚、上限截断、会话绑定 / 清空即删除 / 悬空绑定清理 / 按最近淘汰 / 删配置自动解绑 / 导出不含会话 / 落盘读回、注入文本三层合成，**以及头像白名单（PNG/JPEG/WebP/GIF 接受，SVG 与伪 data URL 拒绝）、长度上限、副本携带、导出携带、不进提示词**） |
| Host API 自测 | `test/routes.test.mjs` → **84 项断言全过**（真实处理器 + mock req/res：状态读取、变更分发、非法输入、413/405、同源守卫四分支、预览、导出往返、脚本投递、index 注入幂等、注销，**以及 session.set / clear / clearAll 的完整往返与拒绝路径**） |
| **长期记忆自测** | `test/memory.test.mjs` → **70 项断言全过**：后台提炼到第 5 回合触发并写入、送进模型的摘录有长度上限、调模型失败与「压缩结果为空」都只告警不写脏数据、拿不到 `llm` / `sessionQuery` / `tools` 只降级不抛、同一会话并发触发不重复写、**写入目标必须是本对话生效的那套配置（切了配置不能写错地方）**、记忆工具的描述与渲染文案（含 `isConcurrencySafe() === false`） |
| **界面渲染自测** | `test/client-render.test.mjs` → **124 项断言全过**：首帧非空、有数据后完整渲染、点左栏另一套配置编辑区跟着换、带 `sessionId` 时下拉与本对话面板取值、**头像三态（设了 → `<img>`；没设 → emoji 图标；`onError` → 回落到图标且不留破图）**、**助手消息条目按会话绑定取配置（未绑定回落全局）**、接口失败显示原因、错误边界兜得住、幂等栅栏生效 |
| **Host 接线自测** | `test/host-wiring.test.mjs` → **56 项断言全过**：全局段落注册、`agent/created` 监听、**清理函数必须返回 thenable（5.3 事故点）**、**作用域段落必须落在 agent 作用域而不是插件作用域（5.5 事故点）**、拿不到 `agent.ctx` / 作用域里没有 `systemPrompt` / 注册抛错都只降级不冒泡、resume 先注销旧的、逃生开关生效、段落文本按会话取内容 |
| **主题 token 审计** | `test/theme-tokens.test.mjs` → **12 项断言全过**：CSS 里用到的 11 个 token 全部在主题注册表内，且浮层是不透明两层写法（5.4 事故点） |
| 机制探针 | `test/cordis-effect-probe.mjs` → 用**真 cordis** 复现宿主的销毁姿势：旧写法抛 `reading 'catch'`，新写法通过 |
| 客户端加载 | 渲染进程 HTTP 缓存里出现本插件 bundle（写入时刻 = 插件激活时刻）；`settings.section` 占用者 `agent-profiles`（order 25） |

**仍然要你确认的部分**：

1. **我看不到页面**，也没有浏览器控制。修好的是「有没有东西」；观感（分栏比例、明暗主题）请你过一眼。
2. 客户端 bundle 由宿主的 clientModules 提供（其响应可被缓存），所以**新代码要刷新页面才生效**；
   若刷新后还是旧样子，**重启一次 DSH** 必定生效 —— 重启同时也会把更新过的
   dsh-knowledge / dsh-theme-pack / dsh-team-chat 的 Host 半重新加载。
3. 「模型确实收到了注入内容」**有证据链，但要按对的方法查**：桌面端 Web 服务在路由之前就做对端准入
   （连 `/` 都返回 403，curl 类探活进不来），所以要看**会话日志** ——
   事件 `system/message`，字段 `data.message.content[0].text`（用 `test/inspect-session.mjs`
   搜**注入文本**（如「以下设定由用户」），**别搜段落名** —— 段落名只在源码里，搜它必然 0 命中，
   而 0 命中会被误读成「没注入」，我们就这么误判过一次）。
   所以我把它做成**你自己能看到**的：设置页底部的「注入统计：已组装 N 次 · 其中空 EMPTY 次 · 最近 AT」，
   `N` 由宿主每次组装提示词时累加 —— 它不是零，就说明注入链路真的在跑。
   默认的「通用助手」自带内容，装好即生效，点「生成预览」就能看到。

---

## 7. 自测怎么跑

```powershell
# 本机若没有独立的 node，可用 DSH 自带的 Electron 当 Node：
#   $node = "<安装根>\DSH Desktop.exe"
# 本测试借官方 Host 目录里的 react，先指向它（否则测试会打印说明并以退出码 2 失败）：
$env:DSH_APP_DIR = "<安装根>/resources/app"
$env:ELECTRON_RUN_AS_NODE = "1"
$node = "<安装根>\DSH Desktop.exe"
cd <本仓库>\dsh-agent-profiles
& $node test\store.test.mjs
& $node test\routes.test.mjs
& $node test\client-render.test.mjs
& $node test\jsx-probe.mjs        # 复现 jsx-runtime 与 createElement 的签名差异
$env:DSH_APP_DIR = ""             # 只对借 react 的那几个有用，跑完可清
```

`test/inspect-session.mjs` 是排查用的：把会话日志（`.jsonl.zstd`，多帧拼接）解开并按**事件类型分组**
统计关键词命中 —— 单看「出现几次」会被插件源码本身骗到（`write` 工具的参数就是文件内容）。

### 关于「重新安装」本地 bundle

本地 bundle 在 profile 里是 **junction 链接**（依赖写成 `link:C:/...`），所以：

- 改完源码，**磁盘上就已经是新的了**，不存在「需要重新拷进去」这一步；pnpm 那边只会说 `Already up to date`。
- 对**已安装**的本地 bundle 再调 `install_bundle`，管理器会返回
  `application: "failed"` + `error.code: "ambiguous-install"` ——
  它无法判断这是「安装」还是「更新」，于是拒绝猜测。
  **这不是安装失败**：`list_bundles` 里它们仍是 `installed: true, enabled: true`，行也都健在。
- 让改动真正跑起来只有两件事：Host 半需要**重启 DSH**（换模块代际），客户端半需要**刷新页面**。
