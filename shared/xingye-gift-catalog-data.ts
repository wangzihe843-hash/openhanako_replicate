/**
 * 星野赠礼系统 · 礼物图集「纯数据层」（无图片依赖，服务端可直接 import）。
 *
 * 客户端目录 desktop/src/react/xingye/xingye-gift-catalog.ts 在此之上叠加 Vite
 * 静态 import 的图片 URL；服务端（心跳掉落 / 共享库存）只需要 id/名称，不碰图片，
 * 故把数据抽到这里做单一事实源，避免两边各维护一份 110 条目录而漂移。
 *
 * - kind=real 为真实历史/现实世界观集，fictional 为虚构特有集；
 * - timeline 仅 real 集有（1=古代 2=近代 3=现代）；
 * - anchorSet 是虚构集「所包含/熟知」的真实集 —— 两者共同驱动认知矩阵
 *   （native/mundane/historical/alien，见 xingye-gift-era-resolver.ts）。
 */

export type XingyeGiftSetId =
  | "modern"
  | "cn_ancient"
  | "republican"
  | "west_medieval"
  | "wuxia"
  | "xianxia"
  | "west_fantasy"
  | "steampunk"
  | "cyberpunk"
  | "wasteland"
  | "space";

export type XingyeGiftSetKind = 'real' | 'fictional';

/** 礼物条目的「无图片」数据层；客户端在其上挂 image 形成 XingyeGiftItem。 */
export interface XingyeGiftItemData {
  id: string;
  setId: XingyeGiftSetId;
  nameZh: string;
  /** 一句话中文描述：喂给初始化 LLM、也做 UI tooltip。 */
  desc: string;
}

export interface XingyeGiftSetData {
  id: XingyeGiftSetId;
  labelZh: string;
  kind: XingyeGiftSetKind;
  /** real 集的时间线位置：1=古代 2=近代 3=现代。 */
  timeline?: 1 | 2 | 3;
  /** fictional 集锚定的 real 集（它的世界里「日常存在/史书可见」的真实文明）。 */
  anchorSet?: XingyeGiftSetId;
  items: XingyeGiftItemData[];
}

export const XINGYE_GIFT_SETS_DATA: XingyeGiftSetData[] = [
  {
    id: "modern",
    labelZh: "现代",
    kind: "real",
    timeline: 3,
    items: [
      { id: "rose_bouquet", setId: "modern", nameZh: "玫瑰花束", desc: "牛皮纸包的红玫瑰花束" },
      { id: "perfume", setId: "modern", nameZh: "香水", desc: "磨砂玻璃瓶装香水，金色瓶盖" },
      { id: "scarf", setId: "modern", nameZh: "针织围巾", desc: "叠好的暖粉色针织围巾" },
      { id: "game_console", setId: "modern", nameZh: "掌上游戏机", desc: "薄荷绿复古掌机" },
      { id: "milk_tea", setId: "modern", nameZh: "珍珠奶茶", desc: "一杯带珍珠的奶茶" },
      { id: "necklace", setId: "modern", nameZh: "心形项链", desc: "礼盒里的金色心形吊坠项链" },
      { id: "instant_camera", setId: "modern", nameZh: "拍立得相机", desc: "奶油色复古拍立得" },
      { id: "strawberry_cake", setId: "modern", nameZh: "草莓蛋糕", desc: "一块奶油草莓蛋糕" },
      { id: "plush_bear", setId: "modern", nameZh: "毛绒玩具熊", desc: "抱抱用的毛绒小熊" },
      { id: "earphones", setId: "modern", nameZh: "无线耳机", desc: "充电盒里的无线耳机" },
    ],
  },
  {
    id: "cn_ancient",
    labelZh: "中国古代",
    kind: "real",
    timeline: 1,
    items: [
      { id: "jade_pendant", setId: "cn_ancient", nameZh: "玉佩", desc: "雕云纹的青玉佩，配红绳流苏" },
      { id: "silk_fan", setId: "cn_ancient", nameZh: "团扇", desc: "绘梅枝的绢面团扇" },
      { id: "calligraphy_set", setId: "cn_ancient", nameZh: "文房墨宝", desc: "毛笔、墨锭与砚台一套" },
      { id: "hairpin", setId: "cn_ancient", nameZh: "金步摇", desc: "垂着珍珠的金花发簪" },
      { id: "food_box", setId: "cn_ancient", nameZh: "点心食盒", desc: "三层提梁木食盒" },
      { id: "tea_cake", setId: "cn_ancient", nameZh: "茶饼", desc: "纸包绳捆的圆茶饼" },
      { id: "sachet", setId: "cn_ancient", nameZh: "绣花香囊", desc: "绣着花的红色香囊，坠流苏" },
      { id: "scroll", setId: "cn_ancient", nameZh: "山水画卷", desc: "半展开的山水手卷" },
      { id: "bronze_mirror", setId: "cn_ancient", nameZh: "铜镜", desc: "背面有纹饰的青铜镜" },
      { id: "paper_umbrella", setId: "cn_ancient", nameZh: "油纸伞", desc: "撑开的油纸伞" },
    ],
  },
  {
    id: "republican",
    labelZh: "民国",
    kind: "real",
    timeline: 2,
    items: [
      { id: "pocket_watch", setId: "republican", nameZh: "黄铜怀表", desc: "带链条的黄铜怀表" },
      { id: "vinyl_record", setId: "republican", nameZh: "黑胶唱片", desc: "一张老唱片" },
      { id: "fountain_pen", setId: "republican", nameZh: "钢笔礼盒", desc: "盒装金尖钢笔" },
      { id: "lipstick", setId: "republican", nameZh: "复古口红", desc: "金管旋开式口红" },
      { id: "kaleidoscope", setId: "republican", nameZh: "万花筒", desc: "黄铜筒身万花筒" },
      { id: "lace_parasol", setId: "republican", nameZh: "蕾丝阳伞", desc: "弯柄蕾丝边阳伞" },
      { id: "music_box", setId: "republican", nameZh: "八音盒", desc: "掀盖木质八音盒" },
      { id: "candy_jar", setId: "republican", nameZh: "玻璃糖罐", desc: "装彩色水果糖的玻璃罐" },
      { id: "round_glasses", setId: "republican", nameZh: "金丝圆框眼镜", desc: "金丝细框圆眼镜" },
      { id: "radio", setId: "republican", nameZh: "老收音机", desc: "木壳台式收音机" },
    ],
  },
  {
    id: "west_medieval",
    labelZh: "西方中世纪",
    kind: "real",
    timeline: 1,
    items: [
      { id: "signet_ring", setId: "west_medieval", nameZh: "纹章戒指", desc: "刻家纹的金质印章戒" },
      { id: "candlestick", setId: "west_medieval", nameZh: "银烛台", desc: "点着蜡烛的银烛台" },
      { id: "sword", setId: "west_medieval", nameZh: "佩剑", desc: "鞘装骑士长剑" },
      { id: "heraldic_shield", setId: "west_medieval", nameZh: "纹章小盾", desc: "绘几何纹章的小盾牌" },
      { id: "goblet", setId: "west_medieval", nameZh: "高脚杯", desc: "镶饰的金属高脚杯" },
      { id: "lute", setId: "west_medieval", nameZh: "鲁特琴", desc: "吟游诗人的鲁特琴" },
      { id: "hourglass", setId: "west_medieval", nameZh: "沙漏", desc: "木框金沙沙漏" },
      { id: "circlet", setId: "west_medieval", nameZh: "王冠头环", desc: "天鹅绒垫上的细金头环" },
      { id: "quill_ink", setId: "west_medieval", nameZh: "羽毛笔与墨水", desc: "白羽毛笔插在墨水瓶里" },
      { id: "chess_knight", setId: "west_medieval", nameZh: "骑士棋子", desc: "象牙白骑士棋子" },
    ],
  },
  {
    id: "wuxia",
    labelZh: "武侠",
    kind: "fictional",
    anchorSet: "cn_ancient",
    items: [
      { id: "sword_tassel", setId: "wuxia", nameZh: "剑穗", desc: "玉珠红穗的剑穗" },
      { id: "secret_manual", setId: "wuxia", nameZh: "武功秘籍", desc: "线装的无名武功秘籍" },
      { id: "jade_flute", setId: "wuxia", nameZh: "玉箫", desc: "坠红穗的青玉箫" },
      { id: "wine_gourd", setId: "wuxia", nameZh: "酒葫芦", desc: "系红绳的酒葫芦" },
      { id: "bamboo_hat", setId: "wuxia", nameZh: "斗笠", desc: "江湖客的竹编斗笠" },
      { id: "dagger", setId: "wuxia", nameZh: "匕首", desc: "鞘装短匕，坠玉饰" },
      { id: "thumb_ring", setId: "wuxia", nameZh: "玉扳指", desc: "温润的玉扳指" },
      { id: "wound_salve", setId: "wuxia", nameZh: "金疮药", desc: "瓷罐装的金疮药" },
      { id: "go_set", setId: "wuxia", nameZh: "围棋罐", desc: "一对围棋棋罐" },
      { id: "folding_fan", setId: "wuxia", nameZh: "折扇", desc: "公子手中的折扇" },
    ],
  },
  {
    id: "xianxia",
    labelZh: "仙侠",
    kind: "fictional",
    anchorSet: "cn_ancient",
    items: [
      { id: "spirit_stone", setId: "xianxia", nameZh: "灵石", desc: "莹莹发光的灵石晶簇" },
      { id: "elixir_bottle", setId: "xianxia", nameZh: "丹药", desc: "白瓷瓶装的金丹" },
      { id: "talisman", setId: "xianxia", nameZh: "符箓", desc: "朱砂绘符的黄纸符箓" },
      { id: "spirit_herb", setId: "xianxia", nameZh: "灵芝仙草", desc: "微微发光的灵芝" },
      { id: "jade_slip", setId: "xianxia", nameZh: "玉简", desc: "存着功法的发光玉简" },
      { id: "flying_sword", setId: "xianxia", nameZh: "飞剑", desc: "通灵的小飞剑" },
      { id: "whisk", setId: "xianxia", nameZh: "拂尘", desc: "道人手中的白拂尘" },
      { id: "lotus_lamp", setId: "xianxia", nameZh: "莲花灯", desc: "长明的莲花灯" },
      { id: "storage_pouch", setId: "xianxia", nameZh: "乾坤袋", desc: "纳物的云纹乾坤袋" },
      { id: "immortal_peach", setId: "xianxia", nameZh: "蟠桃", desc: "一只仙气缭绕的蟠桃" },
    ],
  },
  {
    id: "west_fantasy",
    labelZh: "西幻",
    kind: "fictional",
    anchorSet: "west_medieval",
    items: [
      { id: "magic_crystal", setId: "west_fantasy", nameZh: "魔晶石", desc: "悬浮发光的紫色魔晶" },
      { id: "spell_scroll", setId: "west_fantasy", nameZh: "法术卷轴", desc: "蜡封的羊皮法术卷轴" },
      { id: "potion", setId: "west_fantasy", nameZh: "魔法药水", desc: "粉色冒泡的圆瓶药水" },
      { id: "grimoire", setId: "west_fantasy", nameZh: "魔法书", desc: "镶宝石铜扣的皮面魔法书" },
      { id: "dragon_scale", setId: "west_fantasy", nameZh: "龙鳞", desc: "一枚虹彩龙鳞" },
      { id: "elf_brooch", setId: "west_fantasy", nameZh: "精灵胸针", desc: "叶形银质精灵胸针" },
      { id: "crystal_ball", setId: "west_fantasy", nameZh: "水晶球", desc: "铜座上雾气流转的水晶球" },
      { id: "enchanted_rose", setId: "west_fantasy", nameZh: "永生玫瑰", desc: "玻璃罩里的魔法玫瑰" },
      { id: "fairy_dust_jar", setId: "west_fantasy", nameZh: "萤光瓶", desc: "装着精灵尘的圆玻璃罐" },
      { id: "wand", setId: "west_fantasy", nameZh: "魔杖", desc: "杖尖微光的木魔杖" },
    ],
  },
  {
    id: "steampunk",
    labelZh: "蒸汽朋克",
    kind: "fictional",
    anchorSet: "west_medieval",
    items: [
      { id: "gear_watch", setId: "steampunk", nameZh: "镂空机芯怀表", desc: "露出齿轮组的黄铜怀表" },
      { id: "airship_model", setId: "steampunk", nameZh: "飞艇模型", desc: "木座上的小飞艇模型" },
      { id: "brass_goggles", setId: "steampunk", nameZh: "黄铜护目镜", desc: "皮革绑带的黄铜护目镜" },
      { id: "clockwork_bird", setId: "steampunk", nameZh: "发条机械鸟", desc: "上发条会动的黄铜小鸟" },
      { id: "train_model", setId: "steampunk", nameZh: "蒸汽机车模型", desc: "展示座上的蒸汽火车头" },
      { id: "pressure_gauge", setId: "steampunk", nameZh: "黄铜压力表", desc: "带阀门的黄铜压力表" },
      { id: "brass_telescope", setId: "steampunk", nameZh: "黄铜望远镜", desc: "三节抽拉的黄铜望远镜" },
      { id: "gear_pendant", setId: "steampunk", nameZh: "齿轮项链", desc: "嵌红宝石的双齿轮吊坠" },
      { id: "filament_lamp", setId: "steampunk", nameZh: "灯丝灯泡", desc: "暖光的爱迪生灯泡" },
      { id: "brass_compass", setId: "steampunk", nameZh: "黄铜罗盘", desc: "开盖的黄铜罗盘" },
    ],
  },
  {
    id: "cyberpunk",
    labelZh: "赛博朋克",
    kind: "fictional",
    anchorSet: "modern",
    items: [
      { id: "neural_chip", setId: "cyberpunk", nameZh: "神经芯片", desc: "电路微光的神经接驳芯片" },
      { id: "holo_projector", setId: "cyberpunk", nameZh: "全息投影仪", desc: "投出光影的掌上圆盘" },
      { id: "data_shard", setId: "cyberpunk", nameZh: "数据卡", desc: "存着秘密的发光数据卡" },
      { id: "mech_butterfly", setId: "cyberpunk", nameZh: "机械蝴蝶", desc: "金属翅膀的机械蝴蝶" },
      { id: "energy_drink", setId: "cyberpunk", nameZh: "能量饮料", desc: "夜城限定的能量饮料" },
      { id: "holo_cat", setId: "cyberpunk", nameZh: "全息猫摆件", desc: "桌面全息投影小猫" },
      { id: "robo_dog", setId: "cyberpunk", nameZh: "机器狗玩具", desc: "会摇尾巴的机器小狗" },
      { id: "crypto_key", setId: "cyberpunk", nameZh: "加密钥匙", desc: "电路纹路的实体密钥" },
      { id: "spray_can", setId: "cyberpunk", nameZh: "喷漆罐", desc: "街头涂鸦用的喷漆" },
      { id: "mini_drone", setId: "cyberpunk", nameZh: "微型无人机", desc: "悬停的掌上无人机" },
    ],
  },
  {
    id: "wasteland",
    labelZh: "废土",
    kind: "fictional",
    anchorSet: "modern",
    items: [
      { id: "purified_water", setId: "wasteland", nameZh: "净水", desc: "一瓶珍贵的干净水" },
      { id: "canned_food", setId: "wasteland", nameZh: "罐头", desc: "战前的完好罐头" },
      { id: "bottlecap_string", setId: "wasteland", nameZh: "瓶盖串", desc: "串起来的瓶盖货币" },
      { id: "gas_mask", setId: "wasteland", nameZh: "防毒面具", desc: "滤罐完好的防毒面具" },
      { id: "crank_radio", setId: "wasteland", nameZh: "手摇收音机", desc: "还能响的手摇收音机" },
      { id: "shell_windchime", setId: "wasteland", nameZh: "弹壳风铃", desc: "弹壳做的手工风铃" },
      { id: "salvaged_book", setId: "wasteland", nameZh: "旧书", desc: "烧焦了边角的旧书" },
      { id: "map_fragment", setId: "wasteland", nameZh: "地图残片", desc: "标着补给点的手绘地图" },
      { id: "tin_can_plant", setId: "wasteland", nameZh: "罐头绿植", desc: "罐头里长出的新芽" },
      { id: "solar_lantern", setId: "wasteland", nameZh: "太阳能灯", desc: "夜里发暖光的太阳能灯" },
    ],
  },
  {
    id: "space",
    labelZh: "太空",
    kind: "fictional",
    anchorSet: "modern",
    items: [
      { id: "meteorite", setId: "space", nameZh: "陨石标本", desc: "展示座上的陨石" },
      { id: "star_projector", setId: "space", nameZh: "星图投影仪", desc: "投出星空的小投影仪" },
      { id: "zero_g_plant", setId: "space", nameZh: "零重力盆栽", desc: "悬浮玻璃球里的植物" },
      { id: "space_food", setId: "space", nameZh: "太空食品", desc: "真空包装的太空餐" },
      { id: "starship_model", setId: "space", nameZh: "星舰模型", desc: "展示架上的星舰模型" },
      { id: "astronaut_figurine", setId: "space", nameZh: "宇航员摆件", desc: "拿着小星星的宇航员" },
      { id: "moon_lamp", setId: "space", nameZh: "月球灯", desc: "木托上的月面小夜灯" },
      { id: "stardust_vial", setId: "space", nameZh: "星尘瓶", desc: "瓶装的发光星砂" },
      { id: "orrery", setId: "space", nameZh: "行星仪", desc: "黄铜轨道行星仪" },
      { id: "constellation_pendant", setId: "space", nameZh: "星座吊坠", desc: "星图圆牌吊坠" },
    ],
  },
];

export const XINGYE_GIFT_SET_IDS: XingyeGiftSetId[] = XINGYE_GIFT_SETS_DATA.map((set) => set.id);

/** `setId/giftId` 复合键（礼物 id 仅集内唯一），共享库存与掉落随机选取的统一键。 */
export function giftKey(setId: XingyeGiftSetId, giftId: string): string {
  return `${setId}/${giftId}`;
}

/** 全部 110 个礼物复合键，扁平、稳定顺序（掉落随机取一个、初始化每种 +1 都用它）。 */
export const ALL_GIFT_KEYS: string[] = XINGYE_GIFT_SETS_DATA.flatMap((set) =>
  set.items.map((item) => giftKey(set.id, item.id)),
);

const NAME_BY_KEY = new Map<string, string>(
  XINGYE_GIFT_SETS_DATA.flatMap((set) => set.items.map((item) => [giftKey(set.id, item.id), item.nameZh] as const)),
);

/** 复合键 → 中文名（掉落 toast 点名用）；未知键返回 null。 */
export function giftNameZhByKey(key: string): string | null {
  return NAME_BY_KEY.get(key) ?? null;
}
