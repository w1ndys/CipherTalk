/**
 * 中文意图模式配置
 *
 * 将散落在代码各处的中文正则统一管理为可维护的配置。
 * 新增/修改模式只需在此文件中操作，无需修改路由逻辑。
 */

/** 意图模式定义 */
export interface IntentPattern {
  /** 模式名称（调试用） */
  name: string
  /** 匹配正则 */
  pattern: RegExp
}

// ─── 统计 / 计数 类意图 ─────────────────────────────────────

// ─── 直接回答 / 闲聊 类意图 ─────────────────────────────────

export const DIRECT_ANSWER_PATTERNS: IntentPattern[] = [
  { name: '寒暄', pattern: /^(你好|您好|hi|hello|hey|哈喽|嗨|在吗|早上好|上午好|中午好|下午好|晚上好|晚安)[!！。.\s]*$/i },
  { name: '感谢确认', pattern: /^(谢谢|感谢|多谢|辛苦了|好的|好|ok|收到|明白|了解|可以|行|嗯|嗯嗯|再见|拜拜)[!！。.\s]*$/i },
  { name: '能力询问', pattern: /^(你是谁|你能做什么|你可以做什么|你会什么|怎么用|如何使用|能帮我什么|你有什么功能)[?？!！。.\s]*$/i }
]

/** 统计计数类关键词 */
export const STATS_PATTERNS: IntentPattern[] = [
  { name: '发言排行', pattern: /谁.*(最多|最少|发言|说话|次数)/ },
  { name: '消息统计', pattern: /多少条|几条|统计|次数|频率|排行/ }
]

// ─── 趋势 / 总结 类意图 ─────────────────────────────────────

export const SUMMARY_PATTERNS: IntentPattern[] = [
  { name: '总结概括', pattern: /总结|概括|关系|变化|趋势|梳理|复盘/ }
]

// ─── 媒体 / 文件 类意图 ─────────────────────────────────────

export const MEDIA_PATTERNS: IntentPattern[] = [
  { name: '媒体文件', pattern: /文件|链接|图片|照片|视频|语音|表情|附件|http|www\./i }
]

// ─── 精确证据 类意图 ─────────────────────────────────────────

export const EVIDENCE_PATTERNS: IntentPattern[] = [
  { name: '原文查找', pattern: /有没有|是否|说过|提到|原文|哪条|React|Markdown/i }
]

// ─── 参与者聚焦 类意图 ───────────────────────────────────────

export const PARTICIPANT_PATTERNS: IntentPattern[] = [
  { name: '参与者', pattern: /谁|哪个人|他说|她说|发了什么|说了什么/ }
]

// ─── 最近进展 类意图 ─────────────────────────────────────────

export const RECENT_PATTERNS: IntentPattern[] = [
  { name: '最近', pattern: /最近|刚刚|刚才|最新|现在|当前|前面|上面|最后/ }
]

// ─── 时段词 ─────────────────────────────────────────────────

export const DAY_PART_PATTERNS: IntentPattern[] = [
  { name: '凌晨', pattern: /凌晨|半夜/ },
  { name: '上午', pattern: /早上|上午/ },
  { name: '中午', pattern: /中午/ },
  { name: '下午', pattern: /下午/ },
  { name: '晚上', pattern: /晚上|夜里/ }
]

// ─── 搜索噪音词（应从搜索查询中移除）────────────────────────

/** 泛化的疑问词（不适合直接搜索） */
export const GENERIC_QUERY_WORDS = /^(什么|哪个|哪些|什么时候|为什么|怎么|如何|最近|刚刚|刚才|我们|他们|对方|是否|有没有|是不是|可以|看到|知道|消息|聊天|内容|问题|回复|回答)$/

/** 问句式查询（不适合直接搜索） */
export const QUESTION_LIKE_PREFIX = /^(谁|哪个人|哪位|有没有人|有没有谁|有没有|是否|是否有人|我们|他们|大家|群里|这个聊天|这段聊天|当前|现在|最近)/
export const QUESTION_LIKE_SUFFIX = /(吗|么|呢|啊|呀|吧|没有|没|是什么|怎么回事|多少|几次|哪条)$/

/** 搜索词的噪音前缀 */
export const SEARCH_NOISE_PREFIX = /^(关于|有关|围绕|那个|这个|一下|下|用过|使用过|使用|提到过|提到|提及|聊过|聊到|聊起|说过|说起|发过|分享过|讨论过|问过|了解|会不会|会|懂|试过|推荐过|出现过|包含)/

/** 搜索词的噪音后缀 */
export const SEARCH_NOISE_SUFFIX = /(的人|的情况|的消息|这件事|这事|相关内容|相关消息|吗|么|呢|啊|呀|吧|了|没有|没)$/g

/** 搜索词中的截断尾巴 */
export const SEARCH_TAIL_NOISE = /(谁|哪个人|哪位|什么时候|多少|几次|次数|频率|排行|最多|最少).*$/g

// ─── 动词宾语提取 ───────────────────────────────────────────

/** 动词+宾语模式 */
export const VERB_OBJECT_PATTERN = /(用过|使用过|使用|提到过|提到|提及|聊过|聊到|聊起|说过|说起|发过|分享过|讨论过|问过|了解|会不会|会|懂|试过|推荐过|出现过|包含)(.{2,32})/g

/** "关于/有关" 引导模式 */
export const ABOUT_PATTERN = /(关于|有关|围绕)(.{2,32})/g

// ─── 会话统计类型检测 ────────────────────────────────────────

/** 非关键词统计问题（应使用 session_statistics） */
export const NON_KEYWORD_STATS = /(图片|照片|语音|视频|表情|文件|链接|红包|转账|说话最多|发言最多|谁.*最多|谁.*最少|活跃|几点|什么时候|多少条|总共|总量|类型)/

/** 关键词证据统计问题 */
export const KEYWORD_EVIDENCE_STATS = /(关键词|这个词|这个短语|出现|提到|提及|说过|包含|几次|次数|频率|谁.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|哪个人.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|哪位.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|有没有.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|是否.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过))/

/** 具体证据问题（需要搜索验证） */
export const CONCRETE_EVIDENCE_QUERY = /(谁|哪个人|哪位|有没有人|有没有谁|有没有|是否|是否有人|哪条|原文)/
export const CONCRETE_EVIDENCE_VERB = /(用过|使用过|使用|提到过|提到|提及|聊过|聊到|聊起|说过|说起|发过|分享过|讨论过|问过|了解|会不会|会|懂|试过|推荐过|出现过|包含)/

// ─── 辅助函数 ────────────────────────────────────────────────

/** 测试是否匹配任一模式 */
export function matchesAny(text: string, patterns: IntentPattern[]): boolean {
  return patterns.some((p) => p.pattern.test(text))
}

/** 获取第一个匹配的模式名称 */
export function firstMatchName(text: string, patterns: IntentPattern[]): string | undefined {
  return patterns.find((p) => p.pattern.test(text))?.name
}
