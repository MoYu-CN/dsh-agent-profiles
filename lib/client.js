/**
 * dsh-agent-profiles —— 模块⑦：浏览器半（设置页 + 输入框快速切换器）。
 *
 * ## 形态：lazy-CJS，不是 ESM
 * DSH 用普通 `<script>` 加载客户端 bundle，裸 `export` 是语法错误。
 * 正确形态是 `__ModuleLoader__.load({id, factory})`，`id` **必须等于包名**。
 *
 * ## 三条不能碰的红线（都是本机其他插件真踩过的）
 * 1. **幂等栅栏必须有**：注入的脚本可能被执行两次（官方前端插件恢复流程会重跑），
 *    loader 遇同 id 二次 `load()` 直接抛 `duplicate factory registration`，
 *    连带整个 web boot 层不激活。
 * 2. **`ctx` 不在 factory 闭包里**：它是 `apply(ctx)` 的参数。
 *    在 factory 里直接写 `ctx.xxx` ⇒ `ReferenceError` ⇒ renderer boot failed。
 *    所有要 ctx 的东西都必须惰性求值（本文件用 `ctxRef` 桥接 + 惰性 `bind`）。
 * 3. **CSS 常量里禁止出现反引号**：本文件因此通篇不用模板字符串，
 *    CSS 用「单引号字符串数组 + join」，出错面最小。
 *
 * ## 不 require 任何 Harness Client 包
 * 官方 practices.md 明令禁止（它们随版本变化、plain-JS 无类型检查，
 * 一个抛错的组件会清空整个插槽条目）。控件全部自己写，
 * 样式只用 `--dsw-alias-*` token —— token 改名最多让外观退化，不会让渲染炸掉。
 *
 * ## 界面结构（需求⑤：列表与编辑区分栏）
 *
 * ```
 * ┌─ 提示条 / 二次确认条 ──────────────────────────────┐
 * ├──────────────┬──────────────────────────────────┤
 * │ 配置列表      │ 编辑区                            │
 * │ · 当前标记    │ · 名称 / 图标                      │
 * │ · 新建/复制   │ · 角色设定 / 性格 / 说话 / 准则     │
 * │ · 导入/导出   │ · 长期记忆摘要 + 记忆条目 + 注入开关 │
 * │ · 恢复默认    │ · 注入内容预览                     │
 * └──────────────┴──────────────────────────────────┘
 * ```
 */
(() => {
	var KEY = "__DSH_AGENT_PROFILES_REGISTERED__";
	var loader = globalThis.window?.__ModuleLoader__;
	if (loader === undefined) return;
	if (globalThis[KEY] === true) return;
	globalThis[KEY] = true;

	loader.load({
		id: "dsh-agent-profiles",
		factory: (require) => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

			// ⚠⚠ **必须用 React.createElement，绝不能用 react/jsx-runtime 的 jsx()**。
			//   两者签名完全不同：
			//     createElement(type, props, ...children)   ← 子元素是变长参数
			//     jsx(type, props, maybeKey)                ← 第三个参数是 key！
			//   把后者当前者用，**所有子元素都会被当成 key 丢掉**：组件照常返回、
			//   不抛错、控制台一行提示都没有，只是渲染出一个空壳 ——
			//   表现就是「设置页一片空白」，而且从报错里完全看不出原因。
			//
			//   实测（test/jsx-probe.mjs）：
			//     jsx("div", {className}, child1, child2)
			//       → props.children === undefined, key === "[object Object]"
			//     jsx(Fragment, null, child)
			//       → TypeError: Cannot convert undefined or null to object
			//   官方模板用的就是 `React.createElement`，别改回去。
			var React = require("react");
			var h = React.createElement;
			var Fragment = React.Fragment;
			var useState = React.useState;
			var useEffect = React.useEffect;
			var useRef = React.useRef;

			var NS = "dsh-agent-profiles";

			// ── i18n ─────────────────────────────────────────────
			// ctx.locale 上没有 t(ns,key)，只有 register / bind / translate。
			// 姿势：ctx.locale.register(NS, locale, dict) 若干次 → bind(NS)。
			// ⚠ 词条在这里内联而不是 fetch locale/*.json：
			//   客户端 bundle 是普通 <script>，多一次请求就多一个失败点；
			//   locale/*.json 是给**宿主读插件元数据**（插件卡片标题/描述）用的，
			//   两者消费者不同，不是重复。
			var DICT_ZH = {
				"nav.title": "智能体配置",
				"page.title": "智能体配置",
				"page.subtitle": "建多套配置，指定全局默认用哪套；每个对话还能单独固定一套，并写本对话专属的设定与记忆。切换后从下一次回复开始生效，历史记录不受影响。",
				"list.title": "配置列表",
				"list.new": "新建",
				"list.duplicate": "复制",
				"list.import": "导入",
				"list.export": "导出",
				"list.restore": "恢复默认",
				"list.empty": "还没有配置",
				"list.noRole": "（未填角色设定）",
				"notice.created": "已新建",
				"notice.duplicated": "已复制",
				"notice.deleted": "已删除",
				"notice.activated": "已切换",
				"notice.restored": "已恢复默认",
				"notice.sessionsCleared": "已清除全部对话专属设定",
				"notice.importedMerge": "已合并导入",
				"notice.importedReplace": "已覆盖导入",
				"notice.exported": "已导出 N 套配置。",
				"notice.failed": "操作失败",
				"hint.keepOne": "至少要保留一套配置。",
				"meta.lastError": "上次读写错误：",
				"badge.active": "当前",
				"editor.none": "从左边选一套配置开始编辑。",
				"editor.name": "名称",
				"editor.nameHint": "显示在列表和快速切换里的名字。",
				"editor.icon": "图标",
				"editor.iconHint": "一个 emoji，用于区分配置。",
				"avatar.label": "头像",
				"avatar.upload": "上传图片",
				"avatar.remove": "移除头像",
				"avatar.hint": "支持 PNG / JPEG / WebP / GIF，上传后自动缩到最长边 512px 再保存（一般几十 KB，跟着配置一起导出）。不设头像时显示上面的 emoji 图标；图片读不出来时同样回落到图标，不会留破图。",
				"avatar.failed": "图片读取失败，换一张试试。",
				"avatar.tooBig": "这张图处理后仍然太大，换一张小一点的。",
				"avatar.picked": "头像已就绪，点「保存」生效。",
				"turnHead.hint": "本对话当前生效的智能体（在「智能体配置」里切换）",
				"editor.save": "保存",
				"editor.saved": "已保存",
				"editor.revert": "撤销改动",
				"editor.dirty": "有未保存改动",
				"editor.activate": "设为当前配置",
				"editor.active": "当前已启用",
				"editor.activateHint": "切换立即生效，只影响之后的对话；历史消息不会被改写。",
				"editor.delete": "删除这套配置",
				"field.role": "角色设定",
				"field.roleHint": "你是谁、擅长什么。写清职责边界，模型才知道哪些事该做、哪些该推掉。",
				"field.roleChips": "套用模板：",
				"tpl.engineer.label": "编程助手",
				"tpl.engineer.role": "你是一名资深软件工程师，擅长把模糊需求拆成可执行的小步，并给出能直接跑的实现。",
				"tpl.writer.label": "写作教练",
				"tpl.writer.role": "你是一名中文写作教练，帮用户把想法变成结构清晰、读得下去的文字。",
				"tpl.translator.label": "翻译",
				"tpl.translator.role": "你是一名中英互译专家，追求准确与自然，保留原文语气，不擅自增删信息。",
				"tpl.pm.label": "产品经理",
				"tpl.pm.role": "你是一名产品经理，负责澄清需求、划定范围、排出优先级，并明确说出不做什么。",
				"tpl.analyst.label": "数据分析",
				"tpl.analyst.role": "你是一名数据分析师，先确认口径与数据来源，再给结论，并标注置信度与局限。",
				"tpl.learner.label": "学习伙伴",
				"tpl.learner.role": "你是一名学习伙伴，用提问带用户自己想明白，而不是直接给答案。",
				"field.personality": "性格特点",
				"field.personalityHint": "语气与态度倾向，例如「严谨、直接、不绕弯子」。",
				"field.speech": "说话习惯",
				"field.speechHint": "输出格式偏好，例如「先给结论再给理由」「不用客套话」。",
				"field.rules": "行为准则",
				"field.rulesHint": "必须遵守的硬规则，一行一条。这里写的内容优先级高于默认风格。",
				"field.memorySummary": "长期记忆摘要",
				"memory.usage": "长期记忆占用 N / M 字；超过上限会自动提炼压缩。",
				"field.memorySummaryHint": "希望助手长期记住的背景概况（比逐条记忆更凝练）。",
				"memory.title": "记忆条目",
				"memory.hint": "一条一件具体的事。开启注入后会随每次会话一起发给模型。",
				"memory.inject": "将记忆注入到每次会话",
				"memory.injectOn": "已开启：记忆会随每次会话发送。",
				"memory.injectOff": "已关闭：摘要与条目都不会发送，配置里其他内容照常生效。",
				"memory.add": "添加",
				"memory.addPlaceholder": "例如：用户的主力语言是 TypeScript",
				"memory.empty": "还没有记忆条目。",
				"memory.count": "共 N 条",
				"memory.clear": "清空全部",
				"memory.edit": "编辑",
				"memory.save": "确定",
				"memory.cancel": "取消",
				"memory.del": "删除",
				"preview.title": "注入内容预览",
				"preview.hint": "这是当前草稿会注入到系统提示词里的原文。空配置不注入任何内容。",
				"preview.load": "生成预览",
				"preview.reload": "刷新预览",
				"preview.empty": "（当前配置没有可注入的内容）",
				"preview.chars": "共 N 字",
				"confirm.delete": "删除「NAME」？不可撤销。",
				"confirm.restore": "恢复默认会替换掉全部现有配置，且不可撤销。",
				"confirm.switch": "「NAME」有未保存改动。",
				"confirm.importMerge": "合并导入：保留现有配置，把文件里的配置追加为副本。",
				"confirm.importReplace": "覆盖导入：用文件里的配置替换现有全部配置。",
				"confirm.do": "确认",
				"confirm.cancel": "取消",
				"confirm.saveThenSwitch": "保存并切换",
				"confirm.discardThenSwitch": "放弃改动并切换",
				"quick.label": "切换智能体配置",
				"quick.title": "切换智能体配置（立即生效，只影响之后的对话）",
				"quick.loading": "读取配置…",
				"quick.failed": "配置读取失败",
				"quick.follow": "跟随全局",
				"quick.title": "切换本对话的智能体配置（立即生效，只影响之后的回复）",
				"quick.titleGlobal": "切换全局智能体配置（未拿到会话 id，改动会影响所有对话）",
				"quick.panel": "本对话的智能体设定",
				"quick.pinnedMark": "本对话",
				"session.title": "本对话的智能体",
				"session.hint": "只对这个对话生效：用哪套配置、追加什么设定与记忆都在这里改。保存后从下一次回复起生效，历史消息不会被改写。",
				"session.binding": "本对话使用",
				"session.followGlobal": "跟随全局",
				"session.pinned": "已固定：",
				"session.note": "本对话补充设定",
				"session.noteHint": "只在本对话生效，会追加到系统提示词里。例如「这次只讨论方案，先别改代码」。",
				"session.memTitle": "本对话专属记忆",
				"session.memHint": "一条一件具体的事，只在这个对话里注入；不受配置里「记忆注入」开关影响。",
				"session.save": "保存到本对话",
				"session.clear": "清除本对话设定",
				"session.scope": "会话 id",
				"err.load": "读取配置失败",
				"boundary.short": "智能体配置渲染失败（悬停看原文）",
				"boundary.compactTitle": "智能体配置渲染失败（插件缺陷，配置本身没坏）。原始错误：",
				"boundary.title": "「智能体配置」界面渲染失败：",
				"boundary.hint": "这是插件缺陷，不是你的配置坏了：配置文件仍在磁盘上，路径见下方「存储位置」。请把上面这段报错反馈给插件作者。",
				"err.importParse": "文件不是合法 JSON。",
				"loading": "读取中…",
				"meta.store": "存储位置",
				"meta.counts": "配置 COUNT 套 · 记忆 MEM 条",
				"meta.inject": "注入统计：本对话段 SN 次 · 全局兜底段 GN 次 · 其中空 EMPTY 次 · 最近 AT",
				"meta.injectHint": "「本对话段」由每个对话自己的作用域段落累加 —— 它不是零，就说明「每个对话独立注入」真的在跑。「全局兜底段」是拿不到会话上下文时走的那条。「空」= 那一刻没有可注入的内容（例如只填了名称）。",
				"meta.sessions": "对话专属设定 SESSIONS 个 · 对话专属记忆 SMEM 条",
				"settings.clearSessions": "清除全部对话专属设定",
				"confirm.clearSessions": "清除全部对话的专属设定？各对话改回跟随全局（配置本身不动）。",
				"settings.sessionHint": "每个对话可以单独指定用哪套配置：在输入框左侧的下拉里选，点旁边的 ⚙ 打开「本对话的智能体」写专属设定与记忆。",
			};
			var DICT_EN = {
				"nav.title": "Agent Profiles",
				"page.title": "Agent Profiles",
				"page.subtitle": "Create multiple profiles and choose the global default; each conversation can also pin its own profile plus its own instructions and memory. Switching applies from the next reply and never rewrites history.",
				"list.title": "Profiles",
				"list.new": "New",
				"list.duplicate": "Duplicate",
				"list.import": "Import",
				"list.export": "Export",
				"list.restore": "Restore defaults",
				"list.empty": "No profiles yet",
				"list.noRole": "(no role set)",
				"notice.created": "Created",
				"notice.duplicated": "Duplicated",
				"notice.deleted": "Deleted",
				"notice.activated": "Switched",
				"notice.restored": "Defaults restored",
				"notice.sessionsCleared": "All conversation overrides cleared",
				"notice.importedMerge": "Imported (merged)",
				"notice.importedReplace": "Imported (replaced)",
				"notice.exported": "Exported N profiles.",
				"notice.failed": "The operation failed",
				"hint.keepOne": "At least one profile has to remain.",
				"meta.lastError": "Last read/write error: ",
				"badge.active": "ACTIVE",
				"editor.none": "Pick a profile on the left to start editing.",
				"editor.name": "Name",
				"editor.nameHint": "Shown in the list and in the quick switcher.",
				"editor.icon": "Icon",
				"editor.iconHint": "One emoji that tells profiles apart.",
				"avatar.label": "Avatar",
				"avatar.upload": "Upload image",
				"avatar.remove": "Remove avatar",
				"avatar.hint": "PNG / JPEG / WebP / GIF. Images are downscaled to 512px before saving (usually a few tens of KB) and travel with the profile when you export. With no avatar the emoji icon above is shown; if an image fails to load it falls back to the icon as well instead of showing a broken image.",
				"avatar.failed": "Could not read that image — try another one.",
				"avatar.tooBig": "That image is still too large after processing — try a smaller one.",
				"avatar.picked": "Avatar ready. Click Save to apply.",
				"turnHead.hint": "The profile in force for this conversation (switch it in Agent Profiles)",
				"editor.save": "Save",
				"editor.saved": "Saved",
				"editor.revert": "Revert",
				"editor.dirty": "Unsaved changes",
				"editor.activate": "Set active",
				"editor.active": "Currently active",
				"editor.activateHint": "Takes effect immediately for later turns only; history is never rewritten.",
				"editor.delete": "Delete this profile",
				"field.role": "Role",
				"field.roleHint": "Who you are and what you are good at. Stating the boundary tells the model what to decline.",
				"field.roleChips": "Templates:",
				"tpl.engineer.label": "Engineering",
				"tpl.engineer.role": "You are a senior software engineer. You break vague requests into small steps that can actually be carried out, and you give implementations that run as written.",
				"tpl.writer.label": "Writing coach",
				"tpl.writer.role": "You are a writing coach. You help the user turn rough ideas into clearly structured, readable prose, and you keep their own voice.",
				"tpl.translator.label": "Translation",
				"tpl.translator.role": "You are a Chinese-English translator. You aim for accuracy and natural phrasing, keep the original tone, and never add or drop information on your own.",
				"tpl.pm.label": "Product manager",
				"tpl.pm.role": "You are a product manager. You clarify the request, fix the scope, rank priorities, and state plainly what you are not going to do.",
				"tpl.analyst.label": "Data analysis",
				"tpl.analyst.role": "You are a data analyst. You confirm the definitions and the data sources first, then give conclusions, marking how confident you are and where the limits are.",
				"tpl.learner.label": "Study partner",
				"tpl.learner.role": "You are a study partner. You ask questions that lead the user to work it out themselves instead of handing over the answer.",
				"field.personality": "Personality",
				"field.personalityHint": "Tone and attitude, e.g. rigorous, direct, no waffle.",
				"field.speech": "Speaking style",
				"field.speechHint": "Output preferences, e.g. conclusion first, no pleasantries.",
				"field.rules": "Ground rules",
				"field.rulesHint": "Hard rules, one per line. These outrank the default style.",
				"field.memorySummary": "Long-term memory summary",
				"memory.usage": "Long-term memory uses N / M characters; past the cap it is condensed automatically.",
				"field.memorySummaryHint": "Background you want the assistant to keep in mind, more condensed than single memories.",
				"memory.title": "Memory entries",
				"memory.hint": "One concrete fact per entry. When injection is on they travel with every session.",
				"memory.inject": "Inject memory into every session",
				"memory.injectOn": "On: memory is sent with every session.",
				"memory.injectOff": "Off: neither the summary nor the entries are sent; the rest still applies.",
				"memory.add": "Add",
				"memory.addPlaceholder": "e.g. The user works mainly in TypeScript",
				"memory.empty": "No memory entries yet.",
				"memory.count": "N entries",
				"memory.clear": "Clear all",
				"memory.edit": "Edit",
				"memory.save": "OK",
				"memory.cancel": "Cancel",
				"memory.del": "Delete",
				"preview.title": "Injected prompt preview",
				"preview.hint": "Exactly what this draft injects into the system prompt. An empty profile injects nothing.",
				"preview.load": "Generate preview",
				"preview.reload": "Refresh",
				"preview.empty": "(this profile has nothing to inject)",
				"preview.chars": "N characters",
				"confirm.delete": "Delete \"NAME\"? This cannot be undone.",
				"confirm.restore": "Restoring defaults replaces every existing profile. This cannot be undone.",
				"confirm.switch": "\"NAME\" has unsaved changes.",
				"confirm.importMerge": "Merge import: keep current profiles and append the file's profiles as copies.",
				"confirm.importReplace": "Replace import: overwrite every current profile with the file's.",
				"confirm.do": "Confirm",
				"confirm.cancel": "Cancel",
				"confirm.saveThenSwitch": "Save and switch",
				"confirm.discardThenSwitch": "Discard and switch",
				"quick.label": "Switch agent profile",
				"quick.title": "Switch agent profile (applies from the next reply only)",
				"quick.loading": "Loading profiles…",
				"quick.failed": "Failed to load profiles",
				"quick.follow": "Follow global",
				"quick.title": "Switch this conversation's agent profile (applies from the next reply only)",
				"quick.titleGlobal": "Switch the global agent profile (no session id available — this affects every conversation)",
				"quick.panel": "This conversation's agent settings",
				"quick.pinnedMark": "Conversation",
				"session.title": "Agent for this conversation",
				"session.hint": "Applies to this conversation only: which profile it uses, plus any extra settings and memory. Saving takes effect from the next reply; history is never rewritten.",
				"session.binding": "This conversation uses",
				"session.followGlobal": "Follow global",
				"session.pinned": "Pinned to: ",
				"session.note": "Extra instructions for this conversation",
				"session.noteHint": "Applies here only and is appended to the system prompt. For example: \"discuss the plan only, don't touch code yet\".",
				"session.memTitle": "Memory for this conversation",
				"session.memHint": "One concrete fact per entry, injected in this conversation only; the profile's memory-injection switch does not apply.",
				"session.save": "Save to this conversation",
				"session.clear": "Clear conversation settings",
				"session.scope": "Session id",
				"err.load": "Failed to load profiles",
				"boundary.short": "Agent Profiles failed to render (hover for details)",
				"boundary.compactTitle": "Agent Profiles failed to render (plugin defect — your profiles are intact). Original error: ",
				"boundary.title": "The Agent Profiles settings page failed to render: ",
				"boundary.hint": "This is a plugin defect, not a broken configuration: the file is still on disk at the path shown below. Please report the error above to the plugin author.",
				"err.importParse": "The file is not valid JSON.",
				"loading": "Loading…",
				"meta.store": "Stored at",
				"meta.counts": "COUNT profiles · MEM memories",
				"meta.inject": "Injection: SN per-conversation · GN global fallback · EMPTY empty · last AT",
				"meta.injectHint": "\"Per-conversation\" counts the scoped section each conversation owns — a non-zero value proves per-conversation injection runs. \"Global fallback\" is the path used when no session context is available. \"Empty\" means nothing was injectable at that moment (a name alone injects nothing).",
				"meta.sessions": "SESSIONS conversations customised · SMEM conversation memories",
				"settings.clearSessions": "Clear all per-conversation settings",
				"confirm.clearSessions": "Clear every conversation's settings? They go back to following the global profile (the profiles themselves are untouched).",
				"settings.sessionHint": "Each conversation can pick its own profile: choose one in the dropdown left of the composer, then click ⚙ for that conversation's own instructions and memory.",
			};

			var bindLocale = null;
			var ctxRef = null;
			var getCtx = function () { return ctxRef; };

			/**
			 * 兜底词条：显式给的优先，其次回落到内置中文词典。
			 *
			 * ⚠ 为什么必须回落到 DICT_ZH：组件里大量写作
			 *   `tt("field.roleHint", "")` —— 显式兜底是空串。
			 *   一旦 locale 注册没成功（服务缺失、注册抛错、语言没命中），
			 *   `tt` 就会返回那个空串，于是**标签还在、说明文字整片消失**：
			 *   界面看起来像坏了，但没有任何报错。让兜底链始终有中文可用，
			 *   最坏情况是显示中文，而不是显示空白。
			 */
			var fallbackOf = function (key, explicit) {
				if (typeof explicit === "string" && explicit !== "") return explicit;
				var zh = DICT_ZH[key];
				if (typeof zh === "string") return zh;
				return explicit !== undefined ? explicit : key;
			};

			/**
			 * 取词条。**带真实兜底**：
			 * bind() 在缺词条时可能返回 key 本身（非空串），所以
			 * 只判空是不够的 —— 必须同时判「等于 key」才算没命中。
			 */
			var tt = function (key, fallback) {
				if (bindLocale !== null) {
					try {
						var value = bindLocale(key);
						if (typeof value === "string" && value !== "" && value !== key) return value;
					} catch {
						/* 取词条失败就落到兜底，绝不让它把渲染带崩 */
					}
				}
				return fallbackOf(key, fallback);
			};
			/** 词条里的 N / NAME / COUNT / MEM 占位替换（不做花哨的插值）。 */
			var fill = function (template, tokens) {
				var out = template;
				for (var name in tokens) {
					out = out.split(name).join(String(tokens[name]));
				}
				return out;
			};

			// ── 数据层：模块级缓存 + 订阅 ──────────────────────────
			// 设置页与输入框切换器是**两个独立挂载的组件**，却共享同一份状态。
			// 各拉各的会出现「设置页改了名字，输入框还显示旧名字」。
			// 所以：一份缓存 + 一个监听集合，写操作后统一广播。
			var listeners = new Set();
			var cache = { loading: true, error: null, state: null, meta: null };
			var inflight = null;

			function notify() {
				listeners.forEach(function (fn) {
					try {
						fn();
					} catch {
						/* 单个订阅者出错不该影响其他订阅者 */
					}
				});
			}
			function setCache(patch) {
				cache = Object.assign({}, cache, patch);
				notify();
			}

			/** 拉取整份状态（Host 是唯一真相）。 */
			function refresh() {
				if (inflight !== null) return inflight;
				inflight = fetch("/__ap/state", { headers: { accept: "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (data) {
						inflight = null;
						if (data && data.ok === true) {
							setCache({ loading: false, error: null, state: data.state, meta: data.meta });
						} else {
							setCache({ loading: false, error: (data && data.error) || "state failed" });
						}
					})
					.catch(function (error) {
						inflight = null;
						setCache({ loading: false, error: String((error && error.message) || error) });
					});
				return inflight;
			}

			/**
			 * 发一个变更操作。
			 * ⚠ POST 带 `content-type: application/json`，同源守卫会校验
			 *   Origin/Referer —— 同源 fetch 由浏览器自动带上，不需要自定义头。
			 */
			function command(op) {
				return fetch("/__ap/command", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(op),
				})
					.then(function (r) {
						return r.json().then(function (body) { return { status: r.status, body: body }; });
					})
					.then(function (result) {
						if (result.body && result.body.ok === true) {
							setCache({
								loading: false,
								error: null,
								state: result.body.state,
								meta: result.body.meta,
							});
						}
						return result;
					});
			}

			/** 预览草稿（渲染逻辑只有 Host 一份，这里不重复实现）。 */
			function preview(profile) {
				return fetch("/__ap/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ profile: profile }),
				}).then(function (r) { return r.json(); });
			}

			// ── 头像 ─────────────────────────────────────────────
			/**
			 * 头像最长边（存进配置前先缩到这个尺寸）。
			 *
			 * 192 → 512：回合头的头像放到 44px 显示，192 在高分屏上已经是「勉强」，
			 * 用户直接反馈「太糊了」。512 对 44px 显示（含 2x/3x 高分屏）绰绰有余，
			 * 而 webp 压过之后通常仍只有几十 KB。
			 */
			var AVATAR_MAX_EDGE = 512;
			/** 客户端先拦一道，和服务端的 400000 上限留出余量。 */
			var AVATAR_MAX_CHARS = 380000;

			/**
			 * 头像。**三种状态必须分得清**（这是需求里明确要求处理的）：
			 *   ① 设了头像        → `<img>`
			 *   ② 没设（""）      → 该配置的 emoji 图标
			 *   ③ 设了但加载失败  → 同样回落到 emoji 图标，**不留破图**
			 *
			 * ③ 用 `onError` 实现，并且记住「是哪一张坏了」而不是一个布尔值 ——
			 * 否则用户换了一张新图，旧的失败标记还会把新头像挡掉。
			 */
			function Avatar(props) {
				var profile = props.profile ?? null;
				var size = Number.isFinite(props.size) ? props.size : 28;
				var s = useState("");
				var brokenSrc = s[0];
				var setBrokenSrc = s[1];

				var src = profile !== null && typeof profile.avatar === "string" ? profile.avatar : "";
				var icon = profile !== null && typeof profile.icon === "string" && profile.icon !== "" ? profile.icon : "🤖";
				var name = profile !== null && typeof profile.name === "string" ? profile.name : "";
				var box = {
					width: size + "px",
					height: size + "px",
					borderRadius: "999px",
					flex: "0 0 auto",
					fontSize: Math.round(size * 0.55) + "px",
				};

				if (src !== "" && brokenSrc !== src) {
					return h("img", {
						className: "ap-avatar",
						src: src,
						alt: name,
						title: name,
						style: box,
						onError: function () { setBrokenSrc(src); },
					});
				}
				return h(
					"span",
					{
						className: "ap-avatar ap-avatar-fallback",
						style: box,
						title: name,
						// 图标只是装饰：名字在旁边已经念出来了，读屏不必再读一次 emoji。
						"aria-hidden": "true",
					},
					icon,
				);
			}

			/**
			 * 把用户选的图片缩到最长边 `maxEdge` 再转 data URL。
			 *
			 * 为什么必须缩：手机拍的照片动辄 3~8MB，直接 base64 存进 profiles.json
			 * 会让配置文件膨胀到几十 MB，而且**每次保存都要重写整份 JSON**。
			 * 缩到 512px + webp 之后通常只有几十 KB，自包含存储才成立。
			 *
			 * 任何一步失败都回调 `null`，由调用方给出可读提示 ——
			 * 静默失败会让人以为「传了但没生效」。
			 */
			function shrinkImage(file, maxEdge, done) {
				var reader = new FileReader();
				reader.onerror = function () { done(null); };
				reader.onload = function () {
					var image = new Image();
					image.onerror = function () { done(null); };
					image.onload = function () {
						try {
							var width = image.width;
							var height = image.height;
							if (!(width > 0 && height > 0)) { done(null); return; }
							var scale = Math.min(1, maxEdge / Math.max(width, height));
							var targetW = Math.max(1, Math.round(width * scale));
							var targetH = Math.max(1, Math.round(height * scale));
							var canvas = document.createElement("canvas");
							canvas.width = targetW;
							canvas.height = targetH;
							var ctx2d = canvas.getContext("2d");
							if (ctx2d === null) {
								// 拿不到 2d 上下文（极罕见）时退回原图，让长度校验去把关。
								done(String(reader.result));
								return;
							}
							ctx2d.drawImage(image, 0, 0, targetW, targetH);
							// webp 最小；浏览器不支持时 canvas 会自动给 png，两种都在白名单里。
							// 质量 0.85 → 0.92：0.85 在大尺寸下的块状噪点很明显（用户反馈「糊」）。
							done(canvas.toDataURL("image/webp", 0.92));
						} catch {
							done(null);
						}
					};
					image.src = String(reader.result);
				};
				reader.readAsDataURL(file);
			}

			/** 订阅缓存。用 tick 强制重渲染，避免依赖 useSyncExternalStore 的版本差异。 */
			function useStore() {
				var s = useState(0);
				var bump = s[1];
				useEffect(function () {
					var fn = function () { bump(function (n) { return n + 1; }); };
					listeners.add(fn);
					if (cache.state === null) refresh();
					return function () { listeners.delete(fn); };
				}, []);
				return cache;
			}

			// ── 样式 ─────────────────────────────────────────────
			// ⚠ 本段内禁止出现反引号（会提前终止模板串）；本文件因此不用模板串。
			var AP_CSS = [
				".ap-page { font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 10px; }",
				".ap-title { font-size: 14px; font-weight: 600; }",
				".ap-sub { font-size: 11.5px; opacity: 0.62; line-height: 1.6; }",
				".ap-split { display: flex; gap: 14px; align-items: flex-start; }",
				".ap-list { flex: 0 0 232px; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 8px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 6px; }",
				".ap-list-head { display: flex; align-items: center; gap: 6px; }",
				".ap-list-title { font-size: 12px; font-weight: 600; opacity: 0.75; margin-right: auto; }",
				".ap-list-body { display: flex; flex-direction: column; gap: 3px; max-height: 430px; overflow: auto; }",
				".ap-item { display: flex; align-items: center; gap: 7px; padding: 6px 7px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; }",
				".ap-item:hover { background: var(--dsw-alias-interactive-bg-hover); }",
				".ap-item-sel { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-active); }",
				".ap-item-icon { flex: 0 0 auto; font-size: 15px; line-height: 1; }",
				".ap-item-main { flex: 1 1 auto; min-width: 0; }",
				".ap-item-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
				".ap-item-sub { font-size: 11px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
				".ap-badge { flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }",
				".ap-badge-on { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }",
				".ap-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-error-primary); }",
				".ap-list-foot { display: flex; flex-wrap: wrap; gap: 6px; border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 8px; }",
				".ap-editor { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px; }",
				".ap-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 9px; }",
				".ap-card-head { display: flex; align-items: center; gap: 8px; }",
				".ap-card-title { font-size: 12px; font-weight: 600; opacity: 0.8; margin-right: auto; }",
				".ap-field { display: flex; flex-direction: column; gap: 4px; }",
				".ap-label { font-size: 12px; font-weight: 600; }",
				".ap-hint { font-size: 11px; opacity: 0.62; line-height: 1.55; }",
				".ap-input, .ap-textarea, .ap-select { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 5px 8px; font-size: 13px; font-family: inherit; }",
				".ap-input:focus, .ap-textarea:focus, .ap-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }",
				".ap-textarea { resize: vertical; line-height: 1.55; }",
				".ap-icon-input { flex: 0 0 46px; width: 46px; text-align: center; font-size: 16px; padding: 5px 2px; }",
				".ap-row { display: flex; align-items: center; gap: 8px; }",
				".ap-row-wrap { flex-wrap: wrap; }",
				".ap-grow { flex: 1 1 auto; min-width: 0; }",
				".ap-btn { padding: 4px 10px; border-radius: 7px; cursor: pointer; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-family: inherit; }",
				".ap-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
				".ap-btn:disabled { opacity: 0.45; cursor: default; }",
				".ap-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }",
				".ap-btn-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }",
				".ap-btn-sm { padding: 1px 7px; font-size: 11px; }",
				".ap-chip { padding: 2px 8px; border-radius: 999px; border: 1px dashed var(--dsw-alias-border-l2); font-size: 11px; cursor: pointer; background: transparent; color: inherit; font-family: inherit; }",
				".ap-chip:hover { border-style: solid; border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }",
				".ap-switch { width: 38px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); position: relative; cursor: pointer; padding: 0; flex: 0 0 auto; }",
				".ap-switch-on { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }",
				".ap-switch-knob { position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; border-radius: 999px; background: #ffffff; transition: left 0.15s ease; }",
				".ap-switch-on .ap-switch-knob { left: 20px; }",
				".ap-mem { display: flex; align-items: flex-start; gap: 6px; padding: 5px 0; border-bottom: 1px dashed var(--dsw-alias-border-l2); }",
				".ap-mem-last { border-bottom: none; }",
				".ap-mem-text { flex: 1 1 auto; min-width: 0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }",
				".ap-empty { padding: 16px 12px; text-align: center; opacity: 0.65; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 9px; font-size: 12px; }",
				".ap-notice { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }",
				".ap-notice-ok { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }",
				".ap-notice-err { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }",
				".ap-confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); font-size: 12px; }",
				".ap-pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11.5px; line-height: 1.6; background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 8px 10px; margin: 0; max-height: 300px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }",
				".ap-meta { font-size: 11px; opacity: 0.55; overflow-wrap: anywhere; }",
				".ap-quick { max-width: 200px; padding: 3px 8px; font-size: 12px; border-radius: 999px; }",
				// ── 头像 ────────────────────────────────────────────
				".ap-avatar { display: inline-block; object-fit: cover; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); vertical-align: middle; }",
				".ap-avatar-fallback { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }",
				".ap-quick-pinned { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }",
				".ap-quick-wrap { position: relative; display: inline-flex; align-items: center; gap: 5px; }",
				".ap-quick-notice { max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
				// 浮层向上弹：composer 在窗口底部，向下弹会出屏。
				// ⚠⚠ 浮层必须**不透明**。原来只写 `background: var(--dsw-alias-bg-base-secondary)`，
				//   而那个 token 名在主题里**根本不存在** ⇒ 声明被丢弃 ⇒ 背景透明 ⇒
				//   面板后面就是对话正文，字叠字看不清（用户实际反馈）。
				//   现在两层叠加：不透明的底（bg-base）+ 主题的浮层色（bg-overlay，语义就是
				//   「Overlay and popover background」）。即使浮层色带 alpha，底色也保证实心。
				".ap-pop { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 40; width: 340px; max-height: 62vh; overflow: auto; display: flex; flex-direction: column; gap: 9px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background-color: var(--dsw-alias-bg-base); background-image: linear-gradient(var(--dsw-alias-bg-overlay), var(--dsw-alias-bg-overlay)); box-shadow: 0 10px 32px rgba(0, 0, 0, 0.28); text-align: left; }",
				".ap-pop-head { display: flex; align-items: center; gap: 8px; }",
				".ap-pop-head .ap-label { margin-right: auto; font-size: 13px; }",
				// ── 回合头：[头像] 名称 ──────────────────────────────
				// 紧挨在官方「已完成 …」那一行**上面**（同一容器里、排在它前面的兄弟节点，
				// 见 TurnHead 的注释）。所以这里不写 margin 去挤官方布局。
				// ⚠ `flex: 0 0 auto` 不能省：容器很可能是 flex 行，缺了它我这块会被当成
				//   可压缩项，配上 `min-width: 0` + 文本可省略 ⇒ 直接被压成 0 宽 ——
				//   「组件渲染了、DOM 里有、屏幕上什么都看不到」正是这个形态。
				".ap-turn-head { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; min-width: 0; margin: 4px 0 2px; font-size: 13px; font-weight: 600; }",
				".ap-turn-name { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			].join("\n");

			var STYLE_ID = "__DSH_AGENT_PROFILES_STYLE__";

			/**
			 * 挂样式并返回清理函数。
			 * 官方要求：资源必须在 apply 里注册并返回清理，否则插件卸载后
			 * <style> 会永久留在文档里（多个版本叠加会互相打架）。
			 */
			function mountStyle() {
				if (document.getElementById(STYLE_ID) !== null) {
					return function () { /* 已存在，不归本次 effect 管 */ };
				}
				var el = document.createElement("style");
				el.id = STYLE_ID;
				el.textContent = AP_CSS;
				document.head.appendChild(el);
				return function () {
					try {
						el.remove();
					} catch {
						/* 文档可能已卸载 */
					}
				};
			}

			// ── 工具 ─────────────────────────────────────────────
			/** 参与「未保存判定」的字段。id/时间戳不参与。 */
			var EDIT_KEYS = [
				"name",
				"icon",
				"role",
				"personality",
				"speech",
				"rules",
				"memorySummary",
				"injectMemory",
				"memories",
			];
			function pickEditable(profile) {
				var out = {};
				for (var i = 0; i < EDIT_KEYS.length; i += 1) {
					var key = EDIT_KEYS[i];
					out[key] = profile ? profile[key] : undefined;
				}
				if (out.injectMemory === undefined) out.injectMemory = true;
				if (!Array.isArray(out.memories)) out.memories = [];
				return out;
			}
			function sameEditable(a, b) {
				try {
					return JSON.stringify(pickEditable(a)) === JSON.stringify(pickEditable(b));
				} catch {
					return false;
				}
			}
			function cloneJson(value) {
				try {
					return JSON.parse(JSON.stringify(value));
				} catch {
					return value;
				}
			}
			/** 新记忆条目 id。客户端生成只是占位，Host 落盘时会再规整一次。 */
			function localId() {
				return "m-local-" + Math.random().toString(36).slice(2, 10);
			}
			function downloadText(filename, text) {
				var blob = new Blob([text], { type: "application/json;charset=utf-8" });
				var url = URL.createObjectURL(blob);
				var a = document.createElement("a");
				a.href = url;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				a.remove();
				setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
			}
			function stamp() {
				var d = new Date();
				var pad = function (n) { return (n < 10 ? "0" : "") + n; };
				return (
					d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
					"-" + pad(d.getHours()) + pad(d.getMinutes())
				);
			}

			/**
			 * 角色模板：点一下填好「角色设定」这个字段。
			 * ⚠ 标签与正文都走字典（`tpl.*`），**不在这里写死** ——
			 *   写死的话切到英文界面按钮仍是中文（见 DICT_ZH / DICT_EN 两边的 `tpl.*`）。
			 *   `id` 只当 React key 用，不显示。
			 */
			var ROLE_TEMPLATES = [
				{ id: "engineer", labelKey: "tpl.engineer.label", roleKey: "tpl.engineer.role" },
				{ id: "writer", labelKey: "tpl.writer.label", roleKey: "tpl.writer.role" },
				{ id: "translator", labelKey: "tpl.translator.label", roleKey: "tpl.translator.role" },
				{ id: "pm", labelKey: "tpl.pm.label", roleKey: "tpl.pm.role" },
				{ id: "analyst", labelKey: "tpl.analyst.label", roleKey: "tpl.analyst.role" },
				{ id: "learner", labelKey: "tpl.learner.label", roleKey: "tpl.learner.role" },
			];

			// ── 小组件 ───────────────────────────────────────────
			/** 开关。用 role="switch" + aria-checked，键盘与读屏可用。 */
			function Switch(props) {
				var on = props.checked === true;
				return h(
					"button",
					{
						type: "button",
						className: "ap-switch" + (on ? " ap-switch-on" : ""),
						role: "switch",
						"aria-checked": on ? "true" : "false",
						"aria-label": props.label,
						title: props.label,
						disabled: props.disabled === true,
						onClick: function () { props.onChange(!on); },
					},
					h("span", { className: "ap-switch-knob" }),
				);
			}

			/** 「标签 + 说明 + 控件」三段式表单项（需求⑤：每项有明确标签与说明）。 */
			function Field(props) {
				return h(
					"label",
					{ className: "ap-field" },
					h("span", { className: "ap-label" }, props.label),
					props.control,
					props.hint ? h("span", { className: "ap-hint" }, props.hint) : null,
				);
			}

			/** 一个多行文本框字段。 */
			function TextField(props) {
				return h(Field, {
					label: props.label,
					hint: props.hint,
					control: h("textarea", {
						className: "ap-textarea",
						rows: props.rows || 3,
						value: props.value || "",
						placeholder: props.placeholder || "",
						disabled: props.disabled === true,
						onChange: function (ev) { props.onChange(ev.target.value); },
					}),
				});
			}

			/** 二次确认条（破坏性操作一律走它，不用原生 confirm）。 */
			function ConfirmBar(props) {
				return h(
					"div",
					{ className: "ap-confirm" },
					h("span", { className: "ap-grow" }, props.text),
					props.actions.map(function (action) {
						return h(
							"button",
							{
								key: action.label,
								type: "button",
								className: "ap-btn" + (action.primary ? " ap-btn-primary" : ""),
								onClick: action.onClick,
							},
							action.label,
						);
					}),
					h(
						"button",
						{
							type: "button",
							className: "ap-btn",
							onClick: props.onCancel,
						},
						tt("confirm.cancel", "取消"),
					),
				);
			}

			// ── 记忆条目编辑器（在草稿上改，保存时一并落盘）────────
			function MemoryList(props) {
				var memories = props.memories;
				var s1 = useState("");
				var draftText = s1[0];
				var setDraftText = s1[1];
				var s2 = useState(null);
				var editing = s2[0];
				var setEditing = s2[1];
				var s3 = useState("");
				var editingText = s3[0];
				var setEditingText = s3[1];

				var add = function () {
					var body = draftText.trim();
					if (body === "") return;
					props.onChange(
						memories.concat([{ id: localId(), text: body, createdAt: Date.now() }]),
					);
					setDraftText("");
				};

				return h(
					"div",
					{ className: "ap-field" },
					h(
						"div",
						{ className: "ap-card-head" },
						h("span", { className: "ap-label" }, props.title ?? tt("memory.title", "记忆条目")),
						h(
							"span",
							{ className: "ap-hint" },
							fill(tt("memory.count", "共 N 条"), { N: memories.length }),
						),
						memories.length > 0
							? h(
									"button",
									{
										type: "button",
										className: "ap-btn ap-btn-sm ap-btn-danger",
										onClick: function () { props.onChange([]); },
									},
									tt("memory.clear", "清空全部"),
								)
							: null,
					),
					h("span", { className: "ap-hint" }, props.hint ?? tt("memory.hint", "")),
					h(
						"div",
						{ className: "ap-row" },
						h("input", {
							className: "ap-input ap-grow",
							placeholder: tt("memory.addPlaceholder", ""),
							value: draftText,
							onChange: function (ev) { setDraftText(ev.target.value); },
							onKeyDown: function (ev) {
								if (ev.key === "Enter") {
									ev.preventDefault();
									add();
								}
							},
						}),
						h(
							"button",
							{ type: "button", className: "ap-btn ap-btn-primary", onClick: add },
							tt("memory.add", "添加"),
						),
					),
					memories.length === 0
						? h("div", { className: "ap-empty" }, tt("memory.empty", "还没有记忆条目。"))
						: h(
								"div",
								null,
								memories.map(function (memory, index) {
									var isEditing = editing === memory.id;
									return h(
										"div",
										{
											key: memory.id,
											className:
												"ap-mem" + (index === memories.length - 1 ? " ap-mem-last" : ""),
										},
										isEditing
											? h(
													Fragment,
													null,
													h("input", {
														className: "ap-input ap-grow",
														value: editingText,
														onChange: function (ev) { setEditingText(ev.target.value); },
													}),
													h(
														"button",
														{
															type: "button",
															className: "ap-btn ap-btn-sm ap-btn-primary",
															onClick: function () {
																var body = editingText.trim();
																if (body === "") return;
																props.onChange(
																	memories.map(function (m) {
																		return m.id === memory.id ? Object.assign({}, m, { text: body }) : m;
																	}),
																);
																setEditing(null);
															},
														},
														tt("memory.save", "确定"),
													),
												)
											: h(
													Fragment,
													null,
													h("span", { className: "ap-mem-text" }, memory.text),
													h(
														"button",
														{
															type: "button",
															className: "ap-btn ap-btn-sm",
															onClick: function () {
																setEditing(memory.id);
																setEditingText(memory.text);
															},
														},
														tt("memory.edit", "编辑"),
													),
													h(
														"button",
														{
															type: "button",
															className: "ap-btn ap-btn-sm ap-btn-danger",
															title: tt("memory.del", "删除"),
															onClick: function () {
																props.onChange(
																	memories.filter(function (m) { return m.id !== memory.id; }),
																);
															},
														},
														"×",
													),
												),
									);
								}),
							),
				);
			}

			// ── 设置页 ───────────────────────────────────────────
			function SettingsPage() {
				var data = useStore();
				var state = data.state;
				var profiles = (state && state.profiles) || [];
				var activeId = state ? state.activeId : "";

				var s1 = useState(null);
				var selectedId = s1[0];
				var setSelectedId = s1[1];
				var s2 = useState(null);
				var draft = s2[0];
				var setDraft = s2[1];
				var s3 = useState(null);
				var notice = s3[0];
				var setNotice = s3[1];
				var s4 = useState(null);
				var pending = s4[0];
				var setPending = s4[1];
				var s5 = useState(false);
				var busy = s5[0];
				var setBusy = s5[1];
				var s6 = useState(null);
				var previewText = s6[0];
				var setPreviewText = s6[1];

				var fileRef = useRef(null);
				var avatarRef = useRef(null);

				var selected = profiles.find(function (p) { return p.id === selectedId; }) || null;
				var active = profiles.find(function (p) { return p.id === activeId; }) || null;

				// 首次拿到状态时选中「当前配置」——用户最可能想编辑的就是它。
				useEffect(function () {
					if (state === null || selectedId !== null) return;
					if (activeId !== "" && profiles.some(function (p) { return p.id === activeId; })) {
						setSelectedId(activeId);
					} else if (profiles.length > 0) {
						setSelectedId(profiles[0].id);
					}
				}, [state, selectedId, activeId, profiles.length]);

				// 选中项变化（且没有未保存改动）时，把草稿重置为已保存版本。
				useEffect(function () {
					if (selected === null) {
						setDraft(null);
						return;
					}
					setDraft(function (current) {
						if (current !== null && current.id === selected.id && !sameEditable(current, selected)) {
							// 用户正在编辑同一套配置：不要用服务端版本覆盖他的输入。
							return current;
						}
						return cloneJson(selected);
					});
					setPreviewText(null);
				}, [selectedId, state]);

				var dirty = draft !== null && selected !== null && !sameEditable(draft, selected);

				var run = function (op, okText, after) {
					setBusy(true);
					setNotice(null);
					return command(op).then(function (result) {
						setBusy(false);
						if (result.body && result.body.ok === true) {
							setNotice({ kind: "ok", text: okText || result.body.notice || "" });
							if (typeof after === "function") after(result.body);
						} else {
							setNotice({ kind: "err", text: (result.body && result.body.error) || tt("notice.failed") });
						}
						return result;
					});
				};

				/** 切到另一套配置。有未保存改动时先拦一下。 */
				var selectProfile = function (id) {
					if (id === selectedId) return;
					if (dirty === true) {
						setPending({ kind: "switch", id: id });
						return;
					}
					setSelectedId(id);
				};

				var save = function () {
					if (draft === null) return Promise.resolve();
					return run(
						{ op: "profile.update", id: draft.id, patch: pickEditable(draft) },
						tt("editor.saved", "已保存"),
					);
				};

				var patchDraft = function (patch) {
					setDraft(function (current) {
						return current === null ? current : Object.assign({}, current, patch);
					});
					setPreviewText(null);
				};

				// ── 加载 / 错误 ──────────────────────────────────
				if (state === null) {
					return h(
						"div",
						{ className: "ap-page" },
						h(
							"div",
							{ className: "ap-empty" },
							data.error ? tt("err.load", "读取配置失败") + "：" + data.error : tt("loading", "读取中…"),
						),
					);
				}

				var noticeEl =
					notice === null
						? null
						: h(
								"div",
								{
									className:
										"ap-notice " + (notice.kind === "err" ? "ap-notice-err" : "ap-notice-ok"),
								},
								h("span", { className: "ap-grow" }, notice.text),
								h(
									"button",
									{ type: "button", className: "ap-btn ap-btn-sm", onClick: function () { setNotice(null); } },
									"×",
								),
							);

				// ── 确认条 ──────────────────────────────────────
				var confirmEl = null;
				if (pending !== null) {
					if (pending.kind === "delete") {
						var target = profiles.find(function (p) { return p.id === pending.id; });
						confirmEl = h(ConfirmBar, {
							text: fill(tt("confirm.delete", "删除「NAME」？不可撤销。"), {
								NAME: target ? target.name : "",
							}),
							actions: [
								{
									label: tt("confirm.do", "确认"),
									primary: true,
									onClick: function () {
										setPending(null);
										run({ op: "profile.delete", id: pending.id }, tt("notice.deleted")).then(function (result) {
											if (result.body && result.body.ok === true) setSelectedId(null);
										});
									},
								},
							],
							onCancel: function () { setPending(null); },
						});
					} else if (pending.kind === "restore") {
						confirmEl = h(ConfirmBar, {
							text: tt("confirm.restore", "恢复默认会替换掉全部现有配置，且不可撤销。"),
							actions: [
								{
									label: tt("confirm.do", "确认"),
									primary: true,
									onClick: function () {
										setPending(null);
										run({ op: "state.restoreDefaults" }, tt("notice.restored")).then(function () {
											setSelectedId(null);
										});
									},
								},
							],
							onCancel: function () { setPending(null); },
						});
					} else if (pending.kind === "clearSessions") {
						confirmEl = h(ConfirmBar, {
							text: tt("confirm.clearSessions", "清除全部对话的专属设定？各对话改回跟随全局（配置本身不动）。"),
							actions: [
								{
									label: tt("confirm.do", "确认"),
									primary: true,
									onClick: function () {
										setPending(null);
										run({ op: "sessions.clearAll" }, tt("notice.sessionsCleared"));
									},
								},
							],
							onCancel: function () { setPending(null); },
						});
					} else if (pending.kind === "switch") {
						var from = selected ? selected.name : "";
						confirmEl = h(ConfirmBar, {
							text: fill(tt("confirm.switch", "「NAME」有未保存改动。"), { NAME: from }),
							actions: [
								{
									label: tt("confirm.saveThenSwitch", "保存并切换"),
									primary: true,
									onClick: function () {
										var nextId = pending.id;
										setPending(null);
										save().then(function () { setSelectedId(nextId); });
									},
								},
								{
									label: tt("confirm.discardThenSwitch", "放弃改动并切换"),
									onClick: function () {
										var nextId = pending.id;
										setPending(null);
										setSelectedId(nextId);
									},
								},
							],
							onCancel: function () { setPending(null); },
						});
					} else if (pending.kind === "import") {
						confirmEl = h(ConfirmBar, {
							text: tt("confirm.importMerge", "合并导入：保留现有配置，把文件里的配置追加为副本。"),
							actions: [
								{
									label: tt("confirm.importMerge", "合并导入"),
									primary: true,
									onClick: function () {
										var payload = pending.payload;
										setPending(null);
										run({ op: "state.import", mode: "merge", payload: payload }, tt("notice.importedMerge"));
									},
								},
								{
									label: tt("confirm.importReplace", "覆盖导入"),
									onClick: function () {
										var payload = pending.payload;
										setPending(null);
										run({ op: "state.import", mode: "replace", payload: payload }, tt("notice.importedReplace")).then(
											function () { setSelectedId(null); },
										);
									},
								},
							],
							onCancel: function () { setPending(null); },
						});
					}
				}

				// ── 左栏 ────────────────────────────────────────
				var listEl = h(
					"div",
					{ className: "ap-list" },
					h(
						"div",
						{ className: "ap-list-head" },
						h("span", { className: "ap-list-title" }, tt("list.title", "配置列表")),
						h(
							"button",
							{
								type: "button",
								className: "ap-btn ap-btn-sm",
								disabled: busy,
								onClick: function () {
									if (dirty === true) {
										setPending({ kind: "switch", id: "__new__" });
										return;
									}
									run({ op: "profile.create" }, tt("notice.created")).then(function (result) {
										if (result.body && result.body.ok === true) {
											setSelectedId(result.body.state.activeId);
										}
									});
								},
							},
							tt("list.new", "新建"),
						),
						h(
							"button",
							{
								type: "button",
								className: "ap-btn ap-btn-sm",
								disabled: busy || selected === null,
								onClick: function () {
									if (selected === null) return;
									run({ op: "profile.duplicate", id: selected.id }, tt("notice.duplicated")).then(function (result) {
										if (result.body && result.body.ok === true) {
											setSelectedId(result.body.state.activeId);
										}
									});
								},
							},
							tt("list.duplicate", "复制"),
						),
					),
					profiles.length === 0
						? h("div", { className: "ap-empty" }, tt("list.empty", "还没有配置"))
						: h(
								"div",
								{ className: "ap-list-body" },
								profiles.map(function (profile) {
									var isActive = profile.id === activeId;
									var isSelected = profile.id === selectedId;
									var sub = profile.role && profile.role.trim() !== ""
										? profile.role.replace(/\s+/g, " ").slice(0, 34)
										: tt("list.noRole");
									return h(
										"div",
										{
											key: profile.id,
											className: "ap-item" + (isSelected ? " ap-item-sel" : ""),
											role: "button",
											tabIndex: 0,
											title: profile.name,
											onClick: function () { selectProfile(profile.id); },
											onKeyDown: function (ev) {
												if (ev.key === "Enter" || ev.key === " ") {
													ev.preventDefault();
													selectProfile(profile.id);
												}
											},
										},
										h("span", { className: "ap-item-icon" }, profile.icon || "🤖"),
										h(
											"span",
											{ className: "ap-item-main" },
											h(
												"span",
												{ className: "ap-item-name" },
												profile.name,
												isSelected && dirty === true ? h("span", { className: "ap-dot" }) : null,
											),
											h("span", { className: "ap-item-sub" }, sub),
										),
										isActive
											? h("span", { className: "ap-badge ap-badge-on" }, tt("badge.active", "当前"))
											: null,
									);
								}),
							),
					h(
						"div",
						{ className: "ap-list-foot" },
						h(
							"button",
							{
								type: "button",
								className: "ap-btn ap-btn-sm",
								disabled: busy,
								onClick: function () { if (fileRef.current) fileRef.current.click(); },
							},
							tt("list.import", "导入"),
						),
						h(
							"button",
							{
								type: "button",
								className: "ap-btn ap-btn-sm",
								disabled: busy,
								onClick: function () {
									setBusy(true);
									fetch("/__ap/export", { headers: { accept: "application/json" } })
										.then(function (r) { return r.json(); })
										.then(function (payload) {
											setBusy(false);
											downloadText(
												"agent-profiles-" + stamp() + ".json",
												JSON.stringify(payload, null, 2),
											);
											setNotice({ kind: "ok", text: fill(tt("notice.exported"), { N: payload.profileCount || 0 }) });
										})
										.catch(function (error) {
											setBusy(false);
											setNotice({ kind: "err", text: String((error && error.message) || error) });
										});
								},
							},
							tt("list.export", "导出"),
						),
						h(
							"button",
							{
								type: "button",
								className: "ap-btn ap-btn-sm ap-btn-danger",
								disabled: busy,
								onClick: function () { setPending({ kind: "restore" }); },
							},
							tt("list.restore", "恢复默认"),
						),
						h("input", {
							ref: fileRef,
							type: "file",
							accept: "application/json,.json",
							style: { display: "none" },
							onChange: function (ev) {
								var file = ev.target.files && ev.target.files[0];
								ev.target.value = "";
								if (!file) return;
								var reader = new FileReader();
								reader.onload = function () {
									var payload;
									try {
										payload = JSON.parse(String(reader.result));
									} catch {
										setNotice({ kind: "err", text: tt("err.importParse", "文件不是合法 JSON。") });
										return;
									}
									setPending({ kind: "import", payload: payload });
								};
								reader.readAsText(file);
							},
						}),
					),
				);

				// ── 右栏（编辑区）────────────────────────────────
				var editorEl;
				if (draft === null || selected === null) {
					editorEl = h("div", { className: "ap-editor" }, h("div", { className: "ap-empty" }, tt("editor.none", "从左边选一套配置开始编辑。")));
				} else {
					var isActive = selected.id === activeId;
					editorEl = h(
						"div",
						{ className: "ap-editor" },
						// 名称 / 图标
						h(
							"div",
							{ className: "ap-card" },
							h(
								"div",
								{ className: "ap-card-head" },
								h("span", { className: "ap-card-title" }, tt("editor.name", "名称")),
								dirty
									? h("span", { className: "ap-badge" }, tt("editor.dirty", "有未保存改动"))
									: null,
								h(
									"button",
									{
										type: "button",
										className: "ap-btn ap-btn-sm",
										disabled: busy || !dirty,
										onClick: function () { setDraft(cloneJson(selected)); setPreviewText(null); },
									},
									tt("editor.revert", "撤销改动"),
								),
								h(
									"button",
									{
										type: "button",
										className: "ap-btn ap-btn-sm ap-btn-primary",
										disabled: busy || !dirty,
										onClick: function () { save(); },
									},
									tt("editor.save", "保存"),
								),
							),
							h(
								"div",
								{ className: "ap-row" },
								h("input", {
									className: "ap-input ap-icon-input",
									value: draft.icon || "",
									maxLength: 8,
									title: tt("editor.icon", "图标"),
									onChange: function (ev) { patchDraft({ icon: ev.target.value }); },
								}),
								h("input", {
									className: "ap-input ap-grow",
									value: draft.name || "",
									maxLength: 60,
									placeholder: tt("editor.name", "名称"),
									onChange: function (ev) { patchDraft({ name: ev.target.value }); },
								}),
							),
							h("span", { className: "ap-hint" }, tt("editor.iconHint", "") + " · " + tt("editor.nameHint", "")),
							// ── 头像 ──────────────────────────────────
							// 草稿上改，和别的字段一样点「保存」才落盘 ——
							// 传一张图立刻写盘的话，用户后悔就只能再传一次旧的。
							h(
								"div",
								{ className: "ap-row ap-row-wrap" },
								h(Avatar, { profile: draft, size: 44 }),
								h(
									"button",
									{
										type: "button",
										className: "ap-btn ap-btn-sm",
										disabled: busy,
										onClick: function () { if (avatarRef.current) avatarRef.current.click(); },
									},
									tt("avatar.upload", "上传图片"),
								),
								draft.avatar
									? h(
											"button",
											{
												type: "button",
												className: "ap-btn ap-btn-sm ap-btn-danger",
												disabled: busy,
												onClick: function () { patchDraft({ avatar: "" }); },
											},
											tt("avatar.remove", "移除头像"),
										)
									: null,
								h("input", {
									ref: avatarRef,
									type: "file",
									accept: "image/png,image/jpeg,image/webp,image/gif",
									style: { display: "none" },
									onChange: function (ev) {
										var input = ev.target;
										var file = input.files && input.files[0];
										input.value = "";
										if (!file) return;
										setBusy(true);
										shrinkImage(file, AVATAR_MAX_EDGE, function (url) {
											setBusy(false);
											if (url === null || url === "") {
												setNotice({ kind: "err", text: tt("avatar.failed", "图片读取失败，换一张试试。") });
												return;
											}
											if (url.length > AVATAR_MAX_CHARS) {
												setNotice({ kind: "err", text: tt("avatar.tooBig", "这张图处理后仍然太大，换一张小一点的。") });
												return;
											}
											patchDraft({ avatar: url });
											setNotice({ kind: "ok", text: tt("avatar.picked", "头像已就绪，点「保存」生效。") });
										});
									},
								}),
							),
							h("span", { className: "ap-hint" }, tt("avatar.hint", "")),
							h(
								"div",
								{ className: "ap-row ap-row-wrap" },
								h(
									"button",
									{
										type: "button",
										className: "ap-btn ap-btn-primary",
										disabled: busy || isActive,
										onClick: function () {
											// 有未保存改动时，先保存再切换 ——
											// 否则用户会以为「设为当前」把改动也带上了。
											var after = function () {
												run({ op: "profile.activate", id: selected.id }, tt("notice.activated"));
											};
											if (dirty === true) save().then(after);
											else after();
										},
									},
									isActive ? tt("editor.active", "当前已启用") : tt("editor.activate", "设为当前配置"),
								),
								h("span", { className: "ap-hint" }, tt("editor.activateHint", "")),
							),
						),
						// 角色 / 性格 / 说话 / 准则
						h(
							"div",
							{ className: "ap-card" },
							h(TextField, {
								label: tt("field.role", "角色设定"),
								hint: tt("field.roleHint", ""),
								rows: 3,
								value: draft.role,
								onChange: function (value) { patchDraft({ role: value }); },
							}),
							h(
								"div",
								{ className: "ap-row ap-row-wrap" },
								h("span", { className: "ap-hint" }, tt("field.roleChips", "套用模板：")),
								ROLE_TEMPLATES.map(function (template) {
									return h(
										"button",
										{
											key: template.id,
											type: "button",
											className: "ap-chip",
											onClick: function () { patchDraft({ role: tt(template.roleKey) }); },
										},
										tt(template.labelKey),
									);
								}),
							),
							h(TextField, {
								label: tt("field.personality", "性格特点"),
								hint: tt("field.personalityHint", ""),
								rows: 2,
								value: draft.personality,
								onChange: function (value) { patchDraft({ personality: value }); },
							}),
							h(TextField, {
								label: tt("field.speech", "说话习惯"),
								hint: tt("field.speechHint", ""),
								rows: 2,
								value: draft.speech,
								onChange: function (value) { patchDraft({ speech: value }); },
							}),
							h(TextField, {
								label: tt("field.rules", "行为准则"),
								hint: tt("field.rulesHint", ""),
								rows: 4,
								value: draft.rules,
								onChange: function (value) { patchDraft({ rules: value }); },
							}),
						),
						// 记忆
						h(
							"div",
							{ className: "ap-card" },
							h(
								"div",
								{ className: "ap-row" },
								h(Switch, {
									checked: draft.injectMemory !== false,
									label: tt("memory.inject", "将记忆注入到每次会话"),
									onChange: function (value) { patchDraft({ injectMemory: value }); },
								}),
								h(
									"span",
									{ className: "ap-grow" },
									h("span", { className: "ap-label" }, tt("memory.inject", "将记忆注入到每次会话")),
								),
							),
							h(
								"span",
								{ className: "ap-hint" },
								draft.injectMemory !== false
									? tt("memory.injectOn", "")
									: tt("memory.injectOff", ""),
							),
							h(TextField, {
								label: tt("field.memorySummary", "长期记忆摘要"),
								hint: tt("field.memorySummaryHint", ""),
								rows: 3,
								value: draft.memorySummary,
								onChange: function (value) { patchDraft({ memorySummary: value }); },
							}),
							h(MemoryList, {
								memories: Array.isArray(draft.memories) ? draft.memories : [],
								onChange: function (memories) { patchDraft({ memories: memories }); },
							}),
							// 用量显示：让「超限会自动压缩」这件事**看得见**。
							// 上限由宿主给（meta.memoryLimit），客户端不写死数字 ——
							// 写死两份迟早漂移，那时界面说没满、后台却在压缩。
							h(
								"span",
								{ className: "ap-hint" },
								fill(tt("memory.usage", "长期记忆占用 N / M 字；超过上限会自动提炼压缩。"), {
									N: draftMemoryChars(draft),
									M: memoryLimitOf(data),
								}),
							),
						),
						// 预览
						h(
							"div",
							{ className: "ap-card" },
							h(
								"div",
								{ className: "ap-card-head" },
								h("span", { className: "ap-card-title" }, tt("preview.title", "注入内容预览")),
								h(
									"button",
									{
										type: "button",
										className: "ap-btn ap-btn-sm",
										onClick: function () {
											preview(draft).then(function (result) {
												setPreviewText(result && result.ok === true ? result.text : "");
											});
										},
									},
									previewText === null ? tt("preview.load", "生成预览") : tt("preview.reload", "刷新预览"),
								),
							),
							h("span", { className: "ap-hint" }, tt("preview.hint", "")),
							previewText === null
								? null
								: h(
										Fragment,
										null,
										h(
											"span",
											{ className: "ap-hint" },
											fill(tt("preview.chars", "共 N 字"), { N: previewText.length }),
										),
										h("pre", { className: "ap-pre" }, previewText === "" ? tt("preview.empty", "") : previewText),
									),
						),
						// 危险区 + 元信息
						h(
							"div",
							{ className: "ap-card" },
							h(
								"div",
								{ className: "ap-row" },
								h(
									"button",
									{
										type: "button",
										className: "ap-btn ap-btn-danger",
										disabled: busy || profiles.length <= 1,
										onClick: function () { setPending({ kind: "delete", id: selected.id }); },
									},
									tt("editor.delete", "删除这套配置"),
								),
								h(
									"span",
									{ className: "ap-hint" },
									profiles.length <= 1 ? tt("hint.keepOne") : "",
								),
							),
							h(
								"span",
								{ className: "ap-meta" },
								tt("meta.store", "存储位置") + "：" + ((data.meta && data.meta.file) || "—"),
							),
							h(
								"span",
								{ className: "ap-meta" },
								fill(tt("meta.counts", "配置 COUNT 套 · 记忆 MEM 条"), {
									COUNT: (data.meta && data.meta.profileCount) || 0,
									MEM: (data.meta && data.meta.memoryCount) || 0,
								}),
							),
							// 每个对话的专属设定：数量 + 一键清空 + 去哪儿改。
							// 会话会不断新建，这个数字迟早会变成噪音，所以给一条清理路径。
							h(
								"div",
								{ className: "ap-row ap-row-wrap" },
								h(
									"span",
									{ className: "ap-meta" },
									fill(tt("meta.sessions", "对话专属设定 SESSIONS 个 · 对话专属记忆 SMEM 条"), {
										SESSIONS: (data.meta && data.meta.sessionCount) || 0,
										SMEM: (data.meta && data.meta.sessionMemoryCount) || 0,
									}),
								),
								data.meta && data.meta.sessionCount > 0
									? h(
											"button",
											{
												type: "button",
												className: "ap-btn ap-btn-sm ap-btn-danger",
												disabled: busy,
												onClick: function () { setPending({ kind: "clearSessions" }); },
											},
											tt("settings.clearSessions", "清除全部对话专属设定"),
										)
									: null,
							),
							h("span", { className: "ap-hint" }, tt("settings.sessionHint", "")),
							data.meta && data.meta.diagnostics
								? h(
										Fragment,
										null,
										h(
											"span",
											{ className: "ap-meta" },
											fill(
												tt(
													"meta.inject",
													"注入统计：本对话段 SN 次 · 全局兜底段 GN 次 · 其中空 EMPTY 次 · 最近 AT",
												),
												{
													SN: data.meta.diagnostics.rendersSession || 0,
													GN: data.meta.diagnostics.rendersGlobal || 0,
													EMPTY: data.meta.diagnostics.emptyRenders || 0,
													AT: data.meta.diagnostics.lastRenderAt
														? new Date(data.meta.diagnostics.lastRenderAt).toLocaleTimeString()
														: "—",
												},
											),
										),
										h("span", { className: "ap-meta" }, tt("meta.injectHint", "")),
									)
								: null,
							data.meta && data.meta.lastError
								? h("span", { className: "ap-meta ap-notice-err" }, tt("meta.lastError") + data.meta.lastError)
								: null,
						),
					);
				}

				return h(
					"div",
					{ className: "ap-page" },
					h(
						"div",
						null,
						h("div", { className: "ap-title" }, tt("page.title", "智能体配置")),
						h("div", { className: "ap-sub" }, tt("page.subtitle", "")),
					),
					noticeEl,
					confirmEl,
					h("div", { className: "ap-split" }, listEl, editorEl),
				);
			}

			// ── 输入框里的「本对话智能体」控件 ────────────────────
			/**
			 * 一个下拉 + 一个 ⚙ 面板。
			 *
			 * ## 为什么这个控件是**按对话**的
			 * 它挂在 composer 工具行（`conversation.input.left`），
			 * 而这个槽位是 session 作用域的 —— 宿主会把 `sessionId` 当属性传进来。
			 * 「配置我们每个对话的智能体」就应该落在这里：用户看得到当前对话是哪套，
			 * 改一下立刻生效，不必绕进设置页。
			 *
			 * ## 两种模式
			 * - 会话能拿到 id → 下拉写的是**本对话的绑定**（含「跟随全局」这一项）；
			 * - 拿不到 id（理论上不该发生）→ 退化成改全局当前配置，并在 title 里说明。
			 *   宁可功能降级也不要装作能用：装作能用会让用户改了却不知道改到了哪儿。
			 *
			 * ⚠ **首帧绝不返回 null**：槽位账本把「渲染出内容的条目」记为 active，
			 *   返回 null 的条目会停在 active:false；而首帧必然还没有数据。
			 */
			function QuickSwitcher(props) {
				var p = props ?? {};
				var sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
				var data = useStore();
				var state = data.state;
				var profiles = (state && state.profiles) || [];
				var globalActiveId = state ? state.activeId : "";
				var sessions = (state && state.sessions) || {};
				var session = sessionId !== "" ? sessions[sessionId] ?? null : null;
				var bound = session !== null && typeof session.profileId === "string" ? session.profileId : "";
				var hasOverrides = session !== null;

				var s1 = useState(false);
				var open = s1[0];
				var setOpen = s1[1];
				var s2 = useState(null);
				var notice = s2[0];
				var setNotice = s2[1];

				useEffect(function () {
					if (notice === null) return undefined;
					var timer = setTimeout(function () { setNotice(null); }, 3200);
					return function () { clearTimeout(timer); };
				}, [notice]);

				var loading = state === null && data.error === null;
				var failed = state === null && data.error !== null;
				var placeholderLabel = loading
					? tt("quick.loading", "读取配置…")
					: tt("quick.failed", "配置读取失败");

				if (profiles.length === 0) {
					return h(
						"select",
						{
							className: "ap-select ap-quick",
							disabled: true,
							title: failed ? placeholderLabel + "：" + data.error : placeholderLabel,
							"aria-label": placeholderLabel,
						},
						h("option", null, placeholderLabel),
					);
				}

				var globalName = "";
				for (var i = 0; i < profiles.length; i += 1) {
					if (profiles[i].id === globalActiveId) globalName = profiles[i].name;
				}

				/** 下拉改变：有会话 id 就写本对话绑定，否则退回改全局。 */
				var onChange = function (ev) {
					var next = ev.target.value;
					var op =
						sessionId === ""
							? { op: "profile.activate", id: next }
							: { op: "session.set", sessionId: sessionId, patch: { profileId: next === "" ? null : next } };
					command(op).then(function (result) {
						if (result.body && result.body.ok === true) setNotice(result.body.notice || tt("notice.activated"));
						else if (result.body && result.body.error) setNotice(result.body.error);
					});
				};

				return h(
					"span",
					{ className: "ap-quick-wrap" },
					h(
						"select",
						{
							className: "ap-select ap-quick" + (hasOverrides ? " ap-quick-pinned" : ""),
							value: bound,
							title:
								sessionId === ""
									? tt("quick.titleGlobal", "切换全局智能体配置（拿不到会话 id，本次改动影响所有对话）")
									: tt("quick.title", "切换本对话的智能体配置"),
							"aria-label": tt("quick.label", "本对话的智能体配置"),
							onChange: onChange,
						},
						// 「跟随全局」是最常用的一项，放最前面。
						h(
							"option",
							{ value: "" },
							tt("quick.follow", "跟随全局") + (globalName === "" ? "" : "（" + globalName + "）"),
						),
						profiles.map(function (profile) {
							return h(
								"option",
								{ key: profile.id, value: profile.id },
								(profile.icon ? profile.icon + " " : "") + profile.name,
							);
						}),
					),
					h(
						"button",
						{
							type: "button",
							className: "ap-btn ap-btn-sm" + (hasOverrides ? " ap-btn-primary" : ""),
							title: tt("quick.panel", "本对话的智能体设定"),
							"aria-label": tt("quick.panel", "本对话的智能体设定"),
							onClick: function () { setOpen(!open); },
						},
						hasOverrides ? tt("quick.pinnedMark", "本对话") : "⚙",
					),
					open && sessionId !== ""
						? h(SessionPanel, {
								sessionId: sessionId,
								onClose: function () { setOpen(false); },
								onNotice: setNotice,
							})
						: null,
					notice === null ? null : h("span", { className: "ap-hint ap-quick-notice" }, notice),
				);
			}

			/**
			 * 本对话的智能体设定面板：绑定哪套配置 + 本对话独有的补充设定与记忆。
			 *
			 * 做成 composer 里的浮层而不是右栏页签：注册面更小（右栏那套要
			 * `sidebarRightTabs` + `sidebarRight` + `layout` 三个额外依赖，
			 * 任何一个缺失都会让**整个客户端半**不激活），而且模型选择器这类
			 * 官方控件本来就在同一行的位置向上弹层，说明这里弹层是通的。
			 */
			function SessionPanel(props) {
				var sessionId = props.sessionId;
				var data = useStore();
				var state = data.state;
				var profiles = (state && state.profiles) || [];
				var sessions = (state && state.sessions) || {};
				var session = sessions[sessionId] ?? null;

				var s1 = useState(null);
				var draft = s1[0];
				var setDraft = s1[1];
				var s2 = useState(false);
				var busy = s2[0];
				var setBusy = s2[1];
				var s3 = useState(null);
				var notice = s3[0];
				var setNotice = s3[1];

				// 数据到位后初始化一次草稿；之后不再用服务端版本覆盖用户输入。
				useEffect(function () {
					if (state === null) return;
					setDraft(function (current) {
						if (current !== null) return current;
						return {
							note: session?.note ?? "",
							memories: Array.isArray(session?.memories) ? cloneJson(session.memories) : [],
						};
					});
				}, [state]);

				if (draft === null) {
					return h("div", { className: "ap-pop" }, h("div", { className: "ap-hint" }, tt("loading", "读取中…")));
				}

				var run = function (op, done) {
					setBusy(true);
					setNotice(null);
					command(op).then(function (result) {
						setBusy(false);
						if (result.body && result.body.ok === true) {
							var text = result.body.notice || "";
							setNotice(text);
							if (typeof props.onNotice === "function") props.onNotice(text);
							if (typeof done === "function") done();
						} else {
							setNotice((result.body && result.body.error) || tt("notice.failed"));
						}
					});
				};

				var bindingLabel = tt("session.followGlobal", "跟随全局");
				for (var i = 0; i < profiles.length; i += 1) {
					if (profiles[i].id === (state ? state.activeId : "")) {
						bindingLabel = tt("session.followGlobal", "跟随全局") + "（" + profiles[i].name + "）";
					}
				}
				var boundProfile = null;
				if (typeof session?.profileId === "string") {
					for (var k = 0; k < profiles.length; k += 1) {
						if (profiles[k].id === session.profileId) boundProfile = profiles[k];
					}
				}

				return h(
					"div",
					{ className: "ap-pop", role: "dialog", "aria-label": tt("session.title", "本对话的智能体") },
					h(
						"div",
						{ className: "ap-pop-head" },
						h("span", { className: "ap-label" }, tt("session.title", "本对话的智能体")),
						h(
							"button",
							{ type: "button", className: "ap-btn ap-btn-sm", onClick: props.onClose },
							"×",
						),
					),
					h("span", { className: "ap-hint" }, tt("session.hint", "")),

					// 当前用哪套
					h(
						"div",
						{ className: "ap-field" },
						h("span", { className: "ap-label" }, tt("session.binding", "本对话使用")),
						h(
							"span",
							{ className: "ap-hint" },
							boundProfile === null
								? bindingLabel
								: tt("session.pinned", "已固定：") + (boundProfile.icon ? boundProfile.icon + " " : "") + boundProfile.name,
						),
					),

					h(TextField, {
						label: tt("session.note", "本对话补充设定"),
						hint: tt("session.noteHint", ""),
						rows: 3,
						value: draft.note,
						onChange: function (value) { setDraft(Object.assign({}, draft, { note: value })); },
					}),

					h(MemoryList, {
						title: tt("session.memTitle", "本对话专属记忆"),
						hint: tt("session.memHint", ""),
						memories: draft.memories,
						onChange: function (memories) {
							setDraft(Object.assign({}, draft, { memories: memories }));
						},
					}),

					h(
						"div",
						{ className: "ap-row" },
						h(
							"button",
							{
								type: "button",
								className: "ap-btn ap-btn-primary",
								disabled: busy,
								onClick: function () {
									run({ op: "session.set", sessionId: sessionId, patch: { note: draft.note, memories: draft.memories } });
								},
							},
							tt("session.save", "保存到本对话"),
						),
						h(
							"button",
							{
								type: "button",
								className: "ap-btn ap-btn-danger",
								disabled: busy,
								onClick: function () {
									run({ op: "session.clear", sessionId: sessionId }, function () {
										setDraft({ note: "", memories: [] });
									});
								},
							},
							tt("session.clear", "清除本对话设定"),
						),
					),
					notice === null ? null : h("span", { className: "ap-hint" }, notice),
					h("span", { className: "ap-meta" }, tt("session.scope", "会话 id") + "：" + sessionId),
				);
			}

			/**
			 * 一套配置的长期记忆占用（摘要 + 所有条目，按字符算）。
			 *
			 * 和服务端 `store.memoryChars()` **同一个口径** —— 两边算得不一样，
			 * 就会出现「界面说没满、后台却在压缩」这种自相矛盾。
			 */
			function draftMemoryChars(profile) {
				if (profile === null || profile === undefined) return 0;
				var total = typeof profile.memorySummary === "string" ? profile.memorySummary.length : 0;
				var memories = Array.isArray(profile.memories) ? profile.memories : [];
				for (var i = 0; i < memories.length; i += 1) {
					if (memories[i] !== null && typeof memories[i] === "object" && typeof memories[i].text === "string") {
						total += memories[i].text.length;
					}
				}
				return total;
			}

			/** 长期记忆上限：宿主给的；拿不到时退回 5000（和服务端默认值一致）。 */
			function memoryLimitOf(data) {
				var limit = data !== null && data !== undefined && data.meta !== null && data.meta !== undefined
					? data.meta.memoryLimit
					: undefined;
				return Number.isFinite(limit) ? limit : 5000;
			}

			/**
			 * 本对话**实际生效**的那套配置：会话绑定优先，否则全局当前配置。
			 *
			 * 只此一份：界面各处（回合头、面板）必须算出同一个结果，
			 * 各写一遍迟早会不一致，而不一致的界面比不显示更难查。
			 *
			 * @param {object|null} state 状态。
			 * @param {string} sessionId 会话 id（拿不到就传空串）。
			 * @returns {object|null} 配置，找不到返 null。
			 */
			function effectiveProfile(state, sessionId) {
				if (state === null || state === undefined) return null;
				var profiles = state.profiles || [];
				if (sessionId !== "") {
					var session = (state.sessions || {})[sessionId] ?? null;
					if (session !== null && typeof session.profileId === "string") {
						for (var i = 0; i < profiles.length; i += 1) {
							if (profiles[i].id === session.profileId) return profiles[i];
						}
					}
				}
				for (var k = 0; k < profiles.length; k += 1) {
					if (profiles[k].id === state.activeId) return profiles[k];
				}
				return null;
			}

			// ── 回合头（贴着官方「已完成 …」那一行）──────────────────
			/**
			 * 从槽位服务里取出**官方**在某个 keyed 槽里注册的渲染器。
			 *
			 * 用的是 `ctx.get("slots").entries(key)` —— 服务类上的公开方法
			 * （`@deepseek-ai/dsh-client-ui-renderer` 的 `SlotRegistry.entries`，
			 * 转发到 `SlotCore.entries`），返回的条目带 `component`。
			 * **不是**去掏私有字段：这个方法是带 JSDoc 的实现接口。
			 *
			 * @param {Function} self 我自己的组件（用来把自己排除掉）。
			 * @returns {unknown} 官方组件，取不到返 null。
			 */
			function resolveTurnProcessComponent(self) {
				try {
					var slots = getCtx()?.get?.("slots") ?? null;
					if (slots === null || typeof slots.entries !== "function") return null;
					var list = slots.entries("conversation.chat.node");
					if (!Array.isArray(list)) return null;
					for (var i = 0; i < list.length; i += 1) {
						var entry = list[i];
						if (entry === null || typeof entry !== "object") continue;
						if (entry.options?.key !== "turn-process") continue;
						if (entry.component === self) continue;
						// ⚠ 官方那个是 `react.memo(...)` 的产物 —— **是个对象，不是函数**，
						//   只判 function 会永远返回 null，于是整个功能静默不生效。
						var kind = typeof entry.component;
						if (kind !== "function" && kind !== "object") continue;
						if (entry.component === null) continue;
						return entry.component;
					}
					return null;
				} catch {
					return null;
				}
			}

			/** 注册那一刻抓到的官方渲染器：渲染时的兜底引用，防止中途解析失败导致那一行消失。 */
			var capturedTurnProcess = null;

			/**
			 * 客户端诊断上报：把关键节点的事实交给宿主记一笔。
			 *
			 * 为什么需要：客户端跑在浏览器里，`console.warn` **进不了宿主日志**，
			 * 而我看不到页面 —— 「插槽没注册上」这类问题在两边都不可见，只能猜。
			 * 每个 tag 只报一次（不刷屏）；自身失败**绝不影响功能**（fire-and-forget）。
			 */
			var reportedTags = new Set();
			function diag(tag, detail) {
				if (reportedTags.has(tag)) return;
				reportedTags.add(tag);
				try {
					fetch("/__ap/diag", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ tag: tag, detail: String(detail ?? "") }),
					}).catch(function () {
						/* 诊断失败无所谓 */
					});
				} catch {
					/* 同上 */
				}
			}

			/**
			 * 回合头徽标：头像 + 名称。单独成组件，方便只把它自己关进错误边界。
			 */
			function TurnHeadBadge(props) {
				var sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
				var data = useStore();
				var profile = effectiveProfile(data.state, sessionId);
				if (profile === null) return null;
				// 首次真的渲染出来时报一笔：这是「接管成功且组件挂上了」的直接证据。
				diag("turn-head/徽标已渲染", profile.name + "（sessionId=" + (sessionId === "" ? "空" : "有") + "）");
				return h(
					"div",
					{
						className: "ap-turn-head",
						title: tt("turnHead.hint", ""),
						// ref 回调在**提交阶段**触发 ⇒ 报出来了就说明真的挂上了 DOM。
						ref: function (el) {
							reportHeadDom(el);
						},
					},
					h(Avatar, { profile: profile, size: 44 }),
					h("span", { className: "ap-turn-name" }, profile.name),
				);
			}

			/**
			 * 把「渲染出来了但看不见」这类问题变成可读事实。
			 *
			 * 光知道组件被调用是不够的 —— 上一轮的诊断已经证明**注册和渲染都成功**，
			 * 用户却看不到，那问题只可能在 DOM / 布局：被父容器裁掉、被压成 0 宽、
			 * 落进了错误的容器、或者压根没挂载。这几件事只能从 DOM 上读。
			 */
			function reportHeadDom(el) {
				try {
					if (el === null || el === undefined) {
						diag("turn-head/DOM", "ref 为空：组件被调用但没有挂到 DOM 上");
						return;
					}
					var parent = el.parentElement;
					var parentDesc =
						parent === null || parent === undefined
							? "无父节点"
							: parent.tagName +
								"." +
								String(parent.className ?? "").split(" ").slice(0, 3).join(".");
					var rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
					var size =
						rect === null
							? "?"
							: Math.round(rect.width) + "x" + Math.round(rect.height) + "@" + Math.round(rect.left) + "," + Math.round(rect.top);
					var style = typeof globalThis.getComputedStyle === "function" ? globalThis.getComputedStyle(el) : null;
					var display = style === null ? "?" : style.display + "/" + style.visibility + "/" + style.opacity;
					diag(
						"turn-head/DOM",
						"父=" + parentDesc + " 尺寸=" + size + " 样式=" + display + " 挂载=" + (el.isConnected === true),
					);
				} catch (error) {
					diag("turn-head/DOM 探测失败", error?.message ?? String(error));
				}
			}

			/**
			 * 顶替 `conversation.chat.node` 的 `turn-process` 键（官方那行「已完成，用时 …」），
			 * **只在它前面加一个兄弟节点**，官方渲染器原样渲染。
			 *
			 * ## 为什么这样是安全的
			 * 1. **官方渲染器是「拿过来用」而不是「重写」** —— markdown/流式/工具卡/过程详情
			 *    全部还是官方那套，官方升级我跟着受益。取组件用的是公开方法
			 *    `slots.entries(...)`，不是私有字段。
			 * 2. **优先级顶替是槽位系统明确支持的做法**：keyed 槽同 key 同 priority 会抛错并提示
			 *    「register at a different priority to shadow it (lowest renders)」，
			 *    官方在 0，我用 -10 ⇒ **更小者渲染**；哪天注销我这条，官方那条自动回来（可逆）。
			 * 3. **取不到官方组件就完全不注册**（见 applyInner 里的能力探测 + 订阅重试），
			 *    那一行保持官方原样 —— 失败形态是「没有头像」，不是「那一行没了」。
			 * 4. 我自己的那部分（头像+名称）**单独关在错误边界里**，官方渲染器不在边界内：
			 *    我的代码再怎么出错也不会影响官方那一行的渲染。
			 * 5. 返回的是 **Fragment**：不额外包 div，我那个头就只是官方行前面多出来的一个兄弟节点，
			 *    不改变任何既有布局关系。
			 */
			function TurnHead(props) {
				var official = resolveTurnProcessComponent(TurnHead) ?? capturedTurnProcess;
				var nodes = [];
				// ① 我加的：头像 + 名称（出错也只影响这一块）
				//
				// ⚠ 用 **ref 回调**而不是 useRef+useEffect 报 DOM 事实：
				//   ref 回调在**提交阶段**触发，而 useEffect 在提交之后。
				//   上一轮 DOM 那笔没报出来，恰好说明「渲染了但没提交」——
				//   换成 ref 回调后，这两件事就能区分开：报出来了 = 提交了。
				nodes.push(
					h(
						ApBoundary,
						{ key: "ap-head", compact: true, label: "我的头像头" },
						h(TurnHeadBadge, props),
					),
				);
				// ② 官方的：原样，同一个 props，同一个引用。
				//
				// ⚠ 外面套一层边界是**诊断 + 兜底**：如果官方渲染器抛错，
				//   边界既能告诉我错在哪（boundary/捕获/official），
				//   也能让这一行至少留个可见的提示，而不是整块消失。
				if (official !== null && official !== undefined) {
					nodes.push(
						h(
							ApBoundary,
							{ key: "official", compact: true, label: "official" },
							h(official, Object.assign({}, props)),
						),
					);
				}
				return h(Fragment, null, nodes);
			}

			// ── 渲染错误边界 ─────────────────────────────────────
			/**
			 * 官方机制下**组件抛错会清空整个插槽条目** ——
			 * 用户看到的就是「一片空白」，控制台之外没有任何提示，
			 * 排查只能靠猜。这个边界把「沉默的空白」变成「能读的故障」。
			 *
			 * 必须是 class 组件：只有 class 才有 getDerivedStateFromError。
			 * React 的错误边界只捕获**子组件**渲染期抛错，所以用法是
			 * 把它包在真正的内容外面，而不是 try/catch 自己。
			 */
			class ApBoundary extends React.Component {
				constructor(props) {
					super(props);
					this.state = { error: null };
				}

				static getDerivedStateFromError(error) {
					return { error: error };
				}

				componentDidCatch(error) {
					// 上报给宿主日志：这是「渲染期抛错」唯一能看到的地方。
					// 尤其当边界包住的是**官方**渲染器时 —— 它一抛错，
					// 整棵树的这次渲染就被丢弃（组件渲染了但从不挂载，
					// 连 useEffect 都不会跑），界面上只是「什么都没有」。
					diag(
						"boundary/捕获" + (this.props.label === undefined ? "" : "/" + this.props.label),
						String((error && error.message) || error),
					);
					try {
						getCtx()?.logger?.error?.(
							"[dsh-agent-profiles] 界面渲染失败:",
							error?.stack ?? String(error),
						);
					} catch {
						/* 日志不可用也不能影响兜底界面 */
					}
				}

				render() {
					var error = this.state.error;
					if (error === null) return this.props.children;

					var message = String((error && error.message) || error);
					if (this.props.compact === true) {
						// 很窄的位置：可见文字只用中文，**完整原文放进悬停提示**。
						//
						// 用户反馈过两件事，这里一起处理掉：
						//   ① 只有英文原文（"t is not a function"）看不懂 —— 所以前面补一句中文说明；
						//   ② 英文被截断看不全 —— 所以可见文字不再塞原文，原文整段放 title。
						return h(
							"span",
							{
								className: "ap-hint",
								style: { color: "var(--dsw-alias-state-error-primary)" },
								title:
									tt("boundary.compactTitle", "智能体配置渲染失败（插件缺陷，配置本身没坏）。原始错误：") +
									message,
							},
							tt("boundary.short", "智能体配置渲染失败（悬停看原文）"),
						);
					}
					return h(
						"div",
						{ className: "ap-page" },
						h(
							"div",
							{ className: "ap-notice ap-notice-err" },
							tt("boundary.title", "「智能体配置」界面渲染失败：") + message,
						),
						h("pre", { className: "ap-pre" }, String((error && error.stack) || "")),
						h(
							"div",
							{ className: "ap-hint" },
							tt(
								"boundary.hint",
								"这是插件缺陷，不是你的配置坏了：配置文件仍然安全，可直接查看下面的路径。请把上面这段报错反馈给插件作者。",
							),
						),
					);
				}
			}

			/**
			 * 两个槽位条目的最外层组件：内容套一层错误边界。
			 * 单独包一层而不是把边界写进组件内部 —— 边界只捕获**子组件**的渲染错误，
			 * 写在组件自己里面就捕获不到自己。
			 *
			 * ⚠⚠ **props 必须原样透传**。宿主会把标准属性（尤其是
			 *   `conversation.input.left` 的 `sessionId`）作为 props 传给注册的组件；
			 *   包装层如果不接不传，里层组件就永远拿不到会话 id ——
			 *   表现是「每个对话的设定」整个功能静默失效：界面还在、也不报错，
			 *   只是永远显示「跟随全局」。这个 bug 是被 test/client-render 逮住的。
			 */
			function SettingsPageGuarded(props) {
				return h(ApBoundary, null, h(SettingsPage, props));
			}
			function QuickSwitcherGuarded(props) {
				return h(ApBoundary, { compact: true }, h(QuickSwitcher, props));
			}

			// ── apply ────────────────────────────────────────────
			/**
			 * ⚠ 抛错 = fiber FAILED = renderer boot failed（本插件整个不激活），
			 *   而官方不给错误内容。所以先尽力上报堆栈再重抛。
			 */
			function apply(ctx) {
				try {
					ctxRef = ctx;
					bindLocale = ctx.locale.bind(NS);
					var result = applyInner(ctx);
					// apply 走完 = 客户端半活着（插槽条目都已注册）。这条是诊断的基准线：
					// 如果连它都没有，问题根本不在某个槽位，而在 apply 阶段就挂了。
					diag("apply/完成", "客户端半已装配");
					return result;
				} catch (error) {
					// apply 抛错 = 整个客户端半不激活（设置页、切换器、回合头全都不会出现）。
					// 这是最难查的形态：界面上只是「什么都没有」，而控制台之外没有痕迹。
					diag("apply/失败", error?.stack ?? String(error));
					try {
						ctx.logger?.error?.("[dsh-agent-profiles] apply 失败:", error?.stack ?? String(error));
					} catch {
						/* logger 不可用就算了，别把原错误吃掉 */
					}
					throw error;
				}
			}

			function applyInner(ctx) {
				// 词条注册进同一个 effect：插件卸载时一并注销。
				ctx.effect(() => ctx.locale.register(NS, "zh", DICT_ZH));
				ctx.effect(() => ctx.locale.register(NS, "en", DICT_EN));

				return ctx.effect(() => {
					var disposeStyle = mountStyle();

					// ① 设置页（需求⑤：独立一页，分栏展示）
					//
					// ⚠ 用 `id`（list 槽的槽位键），不是 `key` ——
					//   `key` 是 keyed 槽（如 conversation.chat.node）用的，用错会注册不上。
					ctx.slots.inject("settings.section", function () {
						return ctx.slots.register(
							{
								name: "settings.section",
								id: "agent-profiles",
								// 25：紧邻官方「智能体预设」(20)，排在「插件」(15) 之后。
								order: 25,
								// label 传函数：宿主每次投影都重读，于是跟随语言切换，
								// 不需要在 locale 变化时重新注册。
								label: function () { return tt("nav.title", "智能体配置"); },
							},
							SettingsPageGuarded,
						);
					});

					// ② 输入框快速切换器（需求②）
					ctx.slots.inject("conversation.input.left", function () {
						return ctx.slots.register(
							{
								name: "conversation.input.left",
								id: "agent-profiles-switcher",
								order: 40,
								label: function () { return tt("quick.label", "切换智能体配置"); },
							},
							QuickSwitcherGuarded,
						);
					});

					// ③ 回合头：贴着官方「已完成，用时 …」那一行加一个「头像 + 名称」。
					//
					//    那一行是 **官方** 的 `turn-process` 渲染器，宿主没有在它内部
					//    开任何加法座位，所以这里改用槽位系统**明确支持**的优先级顶替：
					//    keyed 槽「同 key 同 priority 会抛错、更小者渲染」，
					//    官方在 0，我用 -10；注销我这条，官方那条自动回来。
					//
					//    ⚠ 两条保险，缺一不可：
					//      ① **能力探测**：取不到官方组件就**根本不注册**（那一行保持官方原样）；
					//      ② **订阅重试**：我的插件可能比 ui-chat 先加载，那一刻官方条目还没出现，
					//         所以要订阅该槽的注册变化，等官方条目出现后再接管。
					//         没有 ② 的话，加载顺序会让这个功能**静默失效**。
					ctx.effect(function () {
						var dispose = null;
						var unsubscribe = null;
						var timer = null;
						var tries = 0;
						var warned = false;

						var describeEntries = function () {
							try {
								var slots = getCtx()?.get?.("slots") ?? null;
								if (slots === null) return "slots=null";
								if (typeof slots.entries !== "function") return "entries=不是函数";
								var list = slots.entries("conversation.chat.node");
								if (!Array.isArray(list)) return "entries 不是数组：" + typeof list;
								var keys = [];
								for (var i = 0; i < list.length && i < 25; i += 1) {
									keys.push(String(list[i]?.options?.key ?? "?"));
								}
								return "长度=" + list.length + " keys=[" + keys.join(",") + "]";
							} catch (error) {
								return "探测抛错：" + (error?.message ?? String(error));
							}
						};

						var attempt = function () {
							if (dispose !== null) return true;
							tries += 1;
							var official = resolveTurnProcessComponent(TurnHead);
							if (official === null) {
								// 只报前几次，避免刷屏；同时把「看到了什么」一并带上 ——
								// 这行日志是判断「官方条目还没出现」还是「解析写错了」的唯一依据。
								if (tries <= 2) diag("turn-head/未找到官方渲染器", "第 " + tries + " 次：" + describeEntries());
								return false;
							}
							capturedTurnProcess = official;
							try {
								dispose = ctx.slots.register(
									{
										name: "conversation.chat.node",
										key: "turn-process",
										// 官方是 0；**更小者渲染**，且同 priority 会抛错。
										priority: -10,
										// ⚠⚠ **必须声明官方那个 locale 命名空间**（`chat`）。
										//
										//   宿主按注册选项里的 `locale` 把 `t`（翻译函数）注入到条目 props。
										//   官方那条注册写的就是 `locale: NS`（NS = "chat"）；我不写 ⇒ 我的 props
										//   里没有 `t` ⇒ 转发给官方组件后它第一句 `t("message.turnProcess.took")`
										//   就抛 **"t is not a function"** ⇒ 整块「已完成 …」被我的兜底替换。
										//   这正是「头像出现了、但下面那行坏了」的真正原因。
										locale: "chat",
									},
									TurnHead,
								);
								diag("turn-head/已接管", "priority=-10 成功，第 " + tries + " 次尝试");
								return true;
							} catch (error) {
								// 注册失败只降级（官方那一行照常），绝不让它冒泡。
								diag("turn-head/注册失败", error?.message ?? String(error));
								getCtx()?.logger?.warn?.(
									"[dsh-agent-profiles] 回合头接管注册失败，已保持官方渲染：" +
										(error?.message ?? String(error)),
								);
								return false;
							}
						};

						try {
							// ① 立刻试一次（官方通常已经注册好了）
							attempt();
							// ② 订阅该槽的注册变化：官方条目晚于本插件出现时靠它补上
							try {
								var slots = getCtx()?.get?.("slots") ?? null;
								if (slots !== null && typeof slots.subscribe === "function") {
									unsubscribe = slots.subscribe("conversation.chat.node", function () {
										attempt();
									});
								} else {
									diag("turn-head/没有订阅能力", "subscribe=" + typeof slots?.subscribe);
								}
							} catch (error) {
								// ⚠ 这里**必须**吞掉：早期版本没包 try/catch，
								//    一旦 subscribe 抛错就会冒泡出 apply ⇒ 整个客户端半不激活
								//    （连设置页都会消失），而现象只是「什么都没出现」，极难查。
								diag("turn-head/订阅失败", error?.message ?? String(error));
							}
							// ③ 兜底轮询：订阅偶发不触发时，几秒内再试几次就够
							if (dispose === null) {
								var tick = function () {
									if (dispose !== null) return;
									if (attempt() === true) return;
									tries += 0;
									if (tries >= 8) {
										if (warned === false) {
											warned = true;
											diag("turn-head/最终放弃", "试了 " + tries + " 次仍未接管；" + describeEntries());
										}
										return;
									}
									timer = setTimeout(tick, 700);
								};
								timer = setTimeout(tick, 700);
							}
						} catch (error) {
							// 整个接管流程**绝不允许**把 apply 带崩。
							diag("turn-head/流程异常", error?.message ?? String(error));
						}

						return function () {
							try {
								if (timer !== null) clearTimeout(timer);
							} catch {
								/* 无妨 */
							}
							try {
								unsubscribe?.();
							} catch {
								/* 取消失败无所谓 */
							}
							try {
								dispose?.();
							} catch {
								/* 注销失败也不该阻断插件卸载 */
							}
							dispose = null;
						};
					});

					// ④ 回合贡献区（`conversation.chat.turnTail`）**不再注册**。
					//
					//    用户看完实际效果后的决定：「回合尾的就不用了，去掉」——
					//    回合头那一份已经把「这条是谁写的」说清楚了，回合尾再来一个是重复。
					//    （留这段注释是为了让下一个改这里的人知道这是**有意去掉**的，
					//      而不是漏了；要恢复就把注册块加回来。）

					return function () {
						disposeStyle();
					};
				});
			}

			exports.inject = ["slots", "locale"];
			exports.apply = apply;
			return module.exports;
		},
	});
})();
