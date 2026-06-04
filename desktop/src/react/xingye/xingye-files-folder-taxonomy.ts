/**
 * 资料柜文件夹「分工指南」——每个文件夹**专放什么 / 不放什么 / 写成什么体例**的单一来源。
 *
 * 为什么需要：初始化/批量/单条三条 prompt 之前只把文件夹名+一句描述喂给模型，
 * 没有强调每个夹的边界，于是模型会
 *   1. 把个人往事/童年回忆当成「世界观」写成第一人称小说体（应是世界设定/规律的归纳口吻）；
 *   2. 同一件事（同一个人、同一段往事）拆成几乎一样的两条，散落在不同文件夹——
 *      而硬去重 `detectFilesDuplicate` 只在**同 folder 内**比 title，跨柜子不拦，于是漏网。
 *
 * 本模块把「文件夹语义」抽成纯函数（无 React / fs / 网络依赖，好单测），供
 * `xingye-files-prompts.ts`（单条草稿）与 `xingye-files-batch-prompts.ts`
 * （初始化 / 批量两阶段）共用，保证三条路径对"哪个夹放什么"口径一致。
 *
 * 与 `folderBoostCategories`（xingye-files-ai.ts）的关系：那个把文件夹粗分到 lore 分类用于
 * **提权检索**（people / aboutUser 都归 relationship）；这里要的是更细的**内容分工**（人际 ≠ 关于 user）。
 * 粒度不同但「哪些夹算记人」必须同口径，故 folderBoostCategories **复用本分类器**（按 kind 再映射到提权
 * 分类），不再各维护一套关键词——历史上两套关键词漂移过，导致「联系人/人物/人脉」夹拿不到通讯录注入。
 */

export type XingyeFilesFolderKind =
  | 'worldview'
  | 'people'
  | 'aboutUser'
  | 'clues'
  | 'unverified'
  | 'other';

/**
 * 按文件夹名把它归到一种「内容分工」。文件夹可被用户自定义，所以走最宽松的关键词猜测；
 * 猜不出（自定义夹）返回 'other'，调用方退回到只用该夹的描述、不附加分工指南。
 *
 * 判定顺序有意义：先认「关于 user」（名字里含 user，否则会被 people 抢走），
 * 再「世界观」（"设定/规则"等也归这），再「人际」、「线索」、「待确认」。
 */
export function classifyXingyeFilesFolder(name: string): XingyeFilesFolderKind {
  const n = (name ?? '').trim().toLowerCase();
  if (!n) return 'other';
  if (/关于\s*user|关于用户|关于\s*你/.test(n)) return 'aboutUser';
  if (/世界观|世界|设定|规则|规律|法则/.test(n)) return 'worldview';
  if (/人际|关系|亲友|朋友|家人|联系人|人物|人脉/.test(n)) return 'people';
  if (/线索|发现|观察|留意/.test(n)) return 'clues';
  if (/待确认|存疑|核实|不确定|未证实|真假/.test(n)) return 'unverified';
  return 'other';
}

type FolderGuide = {
  /** 这个夹**专门收**什么。 */
  put: string;
  /** 哪些内容**不该进**这个夹、应该去哪个夹。 */
  avoid: string;
  /** 写正文时的**体例/口吻**（最关键：世界观要归纳口吻，不是第一人称小说）。 */
  voice: string;
};

const FOLDER_GUIDES: Record<XingyeFilesFolderKind, FolderGuide | null> = {
  worldview: {
    put: '世界本身的设定与规律——地点、势力、行当门道、习俗、禁忌、通行规则，以及 TA 总结出的处世法则。一条讲一个设定/一条规律。',
    avoid: '不放 TA 个人的童年/往事/某天发生的具体情节，不放和某个人的关系亲疏（这些进「人际关系」），不放某次聊天里尚未定论的零碎线索（进「线索与发现」）。',
    voice: '用归纳、规律、条文的口吻写，像在总结「这个世界是怎么运转的、该守哪些规矩」；不要写成第一人称回忆或小说叙事，不要细描某一天的场景、气味、动作。',
  },
  people: {
    put: 'TA 接触过的某个具体的人：是谁、什么关系、相处的分寸与印象、值得记住的往事。一个人一条。',
    avoid: '不放关于 user 本人的资料（进「关于 user」），不放与人无关的世界设定/规则（进「世界观整理」）。',
    voice: '第一人称记人，写「我和这个人」；同一个人只写一条，别把同一个人拆成几条散在不同夹。',
  },
  aboutUser: {
    put: '专门关于 user 这一个人的资料：TA 对 user 的了解、印象、在意的点、相处的底线与分寸。',
    avoid: '不放其他人的资料（进「人际关系」），不放与 user 无关的世界设定（进「世界观整理」）。',
    voice: '第一人称写「我眼里的 user」；只此一人，别和别人混写成一条。',
  },
  clues: {
    put: '日常聊天里 TA 留意到、但还**没下定论**的线索片段：谁提了什么、哪里反常、值得回头查的细节。',
    avoid: '已经成型、能下结论的设定或关系不放这里（分别进「世界观整理」/「人际关系」）；纯属真假存疑、要再核实的进「待确认」。',
    voice: '短，像随手记下的线索备注，点到为止，别展开成完整故事。',
  },
  unverified: {
    put: '真假不确定、需要再核实的传闻、猜测或矛盾说法。',
    avoid: '已经能确认的事别放这里（按性质进对应夹）。',
    voice: '写清「听说/怀疑的是什么」以及「为什么还不能当真」。',
  },
  other: null,
};

/** 跨文件夹散落防护——给规划/单条 prompt 共用，避免同一主题被拆进多个夹。 */
export const FILES_FOLDER_SCATTER_GUARD =
  '同一件事 / 同一个人 / 同一段往事，只归进**一个**最贴切的文件夹——别把几乎一样的内容拆成两三条塞进不同夹（例如同一句「某人答应以后不再瞒着我」，不要既进「关于 user」又进「线索与发现」），也别在不同夹各写一份雷同条目。';

/**
 * 渲染「文件夹清单 + 每个夹的分工指南」块，供规划 prompt 与单条草稿 prompt 共用。
 * 已知默认夹（世界观/人际/关于user/线索/待确认及其近义名）附「放/不放/体例」三行；
 * 自定义夹（classify → other）只列名字+描述，不强加分工。
 *
 * @param emptyMessage 没有任何文件夹时的兜底文案（单条草稿允许新建夹，规划必须复制现有名，
 *                     两者兜底话术不同，由调用方传入）。
 */
export function formatFilesFolderGuideListing(
  folders: ReadonlyArray<{ name: string; description?: string }>,
  emptyMessage = '（资料柜里目前还没有文件夹）',
): string {
  if (!folders.length) return emptyMessage;
  return folders
    .map((f) => {
      const head = `- ${f.name}${f.description ? `：${f.description}` : ''}`;
      const guide = FOLDER_GUIDES[classifyXingyeFilesFolder(f.name)];
      if (!guide) return head;
      return [
        head,
        `    · 放：${guide.put}`,
        `    · 不放：${guide.avoid}`,
        `    · 体例：${guide.voice}`,
      ].join('\n');
    })
    .join('\n');
}

/**
 * 渲染单个目标文件夹的「放什么 / 怎么写」指南块，供 Phase-2 逐条生成与单条草稿
 * （已知 targetFolder 时）用，把世界观这类夹的体例约束直接顶到正文生成跟前。
 * 自定义夹返回空串（不渲染）。
 */
export function formatFilesFolderEntryGuide(folderName: string): string {
  const guide = FOLDER_GUIDES[classifyXingyeFilesFolder(folderName)];
  if (!guide) return '';
  return [
    '【这个文件夹专放什么 / 该怎么写】',
    `- 放：${guide.put}`,
    `- 不放：${guide.avoid}`,
    `- 体例：${guide.voice}`,
  ].join('\n');
}
