/**
 * 星野赠礼系统 · 礼物图集目录（客户端：在共享数据层 shared/xingye-gift-catalog-data.ts
 * 之上叠加 Vite 静态 import 的图片 URL）。
 *
 * 数据（id/名称/描述/集元信息）是单一事实源，见数据层文件。服务端（心跳掉落 / 共享库存）
 * 只 import 数据层、不碰图片；这里只负责把图片挂回去给 UI 用，保持原有出口形态不变。
 */

import {
  XINGYE_GIFT_SETS_DATA,
  giftKey,
  type XingyeGiftSetData,
  type XingyeGiftItemData,
} from "../../../../shared/xingye-gift-catalog-data";

import imgModernRoseBouquet from "../../assets/xingye-gifts/modern/01-rose-bouquet.png";
import imgModernPerfume from "../../assets/xingye-gifts/modern/02-perfume.png";
import imgModernScarf from "../../assets/xingye-gifts/modern/03-scarf.png";
import imgModernGameConsole from "../../assets/xingye-gifts/modern/04-game-console.png";
import imgModernMilkTea from "../../assets/xingye-gifts/modern/05-milk-tea.png";
import imgModernNecklace from "../../assets/xingye-gifts/modern/06-necklace.png";
import imgModernInstantCamera from "../../assets/xingye-gifts/modern/07-instant-camera.png";
import imgModernStrawberryCake from "../../assets/xingye-gifts/modern/08-strawberry-cake.png";
import imgModernPlushBear from "../../assets/xingye-gifts/modern/09-plush-bear.png";
import imgModernEarphones from "../../assets/xingye-gifts/modern/10-earphones.png";
import imgCnAncientJadePendant from "../../assets/xingye-gifts/cn_ancient/01-jade-pendant.png";
import imgCnAncientSilkFan from "../../assets/xingye-gifts/cn_ancient/02-silk-fan.png";
import imgCnAncientCalligraphySet from "../../assets/xingye-gifts/cn_ancient/03-calligraphy-set.png";
import imgCnAncientHairpin from "../../assets/xingye-gifts/cn_ancient/04-hairpin.png";
import imgCnAncientFoodBox from "../../assets/xingye-gifts/cn_ancient/05-food-box.png";
import imgCnAncientTeaCake from "../../assets/xingye-gifts/cn_ancient/06-tea-cake.png";
import imgCnAncientSachet from "../../assets/xingye-gifts/cn_ancient/07-sachet.png";
import imgCnAncientScroll from "../../assets/xingye-gifts/cn_ancient/08-scroll.png";
import imgCnAncientBronzeMirror from "../../assets/xingye-gifts/cn_ancient/09-bronze-mirror.png";
import imgCnAncientPaperUmbrella from "../../assets/xingye-gifts/cn_ancient/10-paper-umbrella.png";
import imgRepublicanPocketWatch from "../../assets/xingye-gifts/republican/01-pocket-watch.png";
import imgRepublicanVinylRecord from "../../assets/xingye-gifts/republican/02-vinyl-record.png";
import imgRepublicanFountainPen from "../../assets/xingye-gifts/republican/03-fountain-pen.png";
import imgRepublicanLipstick from "../../assets/xingye-gifts/republican/04-lipstick.png";
import imgRepublicanKaleidoscope from "../../assets/xingye-gifts/republican/05-kaleidoscope.png";
import imgRepublicanLaceParasol from "../../assets/xingye-gifts/republican/06-lace-parasol.png";
import imgRepublicanMusicBox from "../../assets/xingye-gifts/republican/07-music-box.png";
import imgRepublicanCandyJar from "../../assets/xingye-gifts/republican/08-candy-jar.png";
import imgRepublicanRoundGlasses from "../../assets/xingye-gifts/republican/09-round-glasses.png";
import imgRepublicanRadio from "../../assets/xingye-gifts/republican/10-radio.png";
import imgWestMedievalSignetRing from "../../assets/xingye-gifts/west_medieval/01-signet-ring.png";
import imgWestMedievalCandlestick from "../../assets/xingye-gifts/west_medieval/02-candlestick.png";
import imgWestMedievalSword from "../../assets/xingye-gifts/west_medieval/03-sword.png";
import imgWestMedievalHeraldicShield from "../../assets/xingye-gifts/west_medieval/04-heraldic-shield.png";
import imgWestMedievalGoblet from "../../assets/xingye-gifts/west_medieval/05-goblet.png";
import imgWestMedievalLute from "../../assets/xingye-gifts/west_medieval/06-lute.png";
import imgWestMedievalHourglass from "../../assets/xingye-gifts/west_medieval/07-hourglass.png";
import imgWestMedievalCirclet from "../../assets/xingye-gifts/west_medieval/08-circlet.png";
import imgWestMedievalQuillInk from "../../assets/xingye-gifts/west_medieval/09-quill-ink.png";
import imgWestMedievalChessKnight from "../../assets/xingye-gifts/west_medieval/10-chess-knight.png";
import imgWuxiaSwordTassel from "../../assets/xingye-gifts/wuxia/01-sword-tassel.png";
import imgWuxiaSecretManual from "../../assets/xingye-gifts/wuxia/02-secret-manual.png";
import imgWuxiaJadeFlute from "../../assets/xingye-gifts/wuxia/03-jade-flute.png";
import imgWuxiaWineGourd from "../../assets/xingye-gifts/wuxia/04-wine-gourd.png";
import imgWuxiaBambooHat from "../../assets/xingye-gifts/wuxia/05-bamboo-hat.png";
import imgWuxiaDagger from "../../assets/xingye-gifts/wuxia/06-dagger.png";
import imgWuxiaThumbRing from "../../assets/xingye-gifts/wuxia/07-thumb-ring.png";
import imgWuxiaWoundSalve from "../../assets/xingye-gifts/wuxia/08-wound-salve.png";
import imgWuxiaGoSet from "../../assets/xingye-gifts/wuxia/09-go-set.png";
import imgWuxiaFoldingFan from "../../assets/xingye-gifts/wuxia/10-folding-fan.png";
import imgXianxiaSpiritStone from "../../assets/xingye-gifts/xianxia/01-spirit-stone.png";
import imgXianxiaElixirBottle from "../../assets/xingye-gifts/xianxia/02-elixir-bottle.png";
import imgXianxiaTalisman from "../../assets/xingye-gifts/xianxia/03-talisman.png";
import imgXianxiaSpiritHerb from "../../assets/xingye-gifts/xianxia/04-spirit-herb.png";
import imgXianxiaJadeSlip from "../../assets/xingye-gifts/xianxia/05-jade-slip.png";
import imgXianxiaFlyingSword from "../../assets/xingye-gifts/xianxia/06-flying-sword.png";
import imgXianxiaWhisk from "../../assets/xingye-gifts/xianxia/07-whisk.png";
import imgXianxiaLotusLamp from "../../assets/xingye-gifts/xianxia/08-lotus-lamp.png";
import imgXianxiaStoragePouch from "../../assets/xingye-gifts/xianxia/09-storage-pouch.png";
import imgXianxiaImmortalPeach from "../../assets/xingye-gifts/xianxia/10-immortal-peach.png";
import imgWestFantasyMagicCrystal from "../../assets/xingye-gifts/west_fantasy/01-magic-crystal.png";
import imgWestFantasySpellScroll from "../../assets/xingye-gifts/west_fantasy/02-spell-scroll.png";
import imgWestFantasyPotion from "../../assets/xingye-gifts/west_fantasy/03-potion.png";
import imgWestFantasyGrimoire from "../../assets/xingye-gifts/west_fantasy/04-grimoire.png";
import imgWestFantasyDragonScale from "../../assets/xingye-gifts/west_fantasy/05-dragon-scale.png";
import imgWestFantasyElfBrooch from "../../assets/xingye-gifts/west_fantasy/06-elf-brooch.png";
import imgWestFantasyCrystalBall from "../../assets/xingye-gifts/west_fantasy/07-crystal-ball.png";
import imgWestFantasyEnchantedRose from "../../assets/xingye-gifts/west_fantasy/08-enchanted-rose.png";
import imgWestFantasyFairyDustJar from "../../assets/xingye-gifts/west_fantasy/09-fairy-dust-jar.png";
import imgWestFantasyWand from "../../assets/xingye-gifts/west_fantasy/10-wand.png";
import imgSteampunkGearWatch from "../../assets/xingye-gifts/steampunk/01-gear-watch.png";
import imgSteampunkAirshipModel from "../../assets/xingye-gifts/steampunk/02-airship-model.png";
import imgSteampunkBrassGoggles from "../../assets/xingye-gifts/steampunk/03-brass-goggles.png";
import imgSteampunkClockworkBird from "../../assets/xingye-gifts/steampunk/04-clockwork-bird.png";
import imgSteampunkTrainModel from "../../assets/xingye-gifts/steampunk/05-train-model.png";
import imgSteampunkPressureGauge from "../../assets/xingye-gifts/steampunk/06-pressure-gauge.png";
import imgSteampunkBrassTelescope from "../../assets/xingye-gifts/steampunk/07-brass-telescope.png";
import imgSteampunkGearPendant from "../../assets/xingye-gifts/steampunk/08-gear-pendant.png";
import imgSteampunkFilamentLamp from "../../assets/xingye-gifts/steampunk/09-filament-lamp.png";
import imgSteampunkBrassCompass from "../../assets/xingye-gifts/steampunk/10-brass-compass.png";
import imgCyberpunkNeuralChip from "../../assets/xingye-gifts/cyberpunk/01-neural-chip.png";
import imgCyberpunkHoloProjector from "../../assets/xingye-gifts/cyberpunk/02-holo-projector.png";
import imgCyberpunkDataShard from "../../assets/xingye-gifts/cyberpunk/03-data-shard.png";
import imgCyberpunkMechButterfly from "../../assets/xingye-gifts/cyberpunk/04-mech-butterfly.png";
import imgCyberpunkEnergyDrink from "../../assets/xingye-gifts/cyberpunk/05-energy-drink.png";
import imgCyberpunkHoloCat from "../../assets/xingye-gifts/cyberpunk/06-holo-cat.png";
import imgCyberpunkRoboDog from "../../assets/xingye-gifts/cyberpunk/07-robo-dog.png";
import imgCyberpunkCryptoKey from "../../assets/xingye-gifts/cyberpunk/08-crypto-key.png";
import imgCyberpunkSprayCan from "../../assets/xingye-gifts/cyberpunk/09-spray-can.png";
import imgCyberpunkMiniDrone from "../../assets/xingye-gifts/cyberpunk/10-mini-drone.png";
import imgWastelandPurifiedWater from "../../assets/xingye-gifts/wasteland/01-purified-water.png";
import imgWastelandCannedFood from "../../assets/xingye-gifts/wasteland/02-canned-food.png";
import imgWastelandBottlecapString from "../../assets/xingye-gifts/wasteland/03-bottlecap-string.png";
import imgWastelandGasMask from "../../assets/xingye-gifts/wasteland/04-gas-mask.png";
import imgWastelandCrankRadio from "../../assets/xingye-gifts/wasteland/05-crank-radio.png";
import imgWastelandShellWindchime from "../../assets/xingye-gifts/wasteland/06-shell-windchime.png";
import imgWastelandSalvagedBook from "../../assets/xingye-gifts/wasteland/07-salvaged-book.png";
import imgWastelandMapFragment from "../../assets/xingye-gifts/wasteland/08-map-fragment.png";
import imgWastelandTinCanPlant from "../../assets/xingye-gifts/wasteland/09-tin-can-plant.png";
import imgWastelandSolarLantern from "../../assets/xingye-gifts/wasteland/10-solar-lantern.png";
import imgSpaceMeteorite from "../../assets/xingye-gifts/space/01-meteorite.png";
import imgSpaceStarProjector from "../../assets/xingye-gifts/space/02-star-projector.png";
import imgSpaceZeroGPlant from "../../assets/xingye-gifts/space/03-zero-g-plant.png";
import imgSpaceSpaceFood from "../../assets/xingye-gifts/space/04-space-food.png";
import imgSpaceStarshipModel from "../../assets/xingye-gifts/space/05-starship-model.png";
import imgSpaceAstronautFigurine from "../../assets/xingye-gifts/space/06-astronaut-figurine.png";
import imgSpaceMoonLamp from "../../assets/xingye-gifts/space/07-moon-lamp.png";
import imgSpaceStardustVial from "../../assets/xingye-gifts/space/08-stardust-vial.png";
import imgSpaceOrrery from "../../assets/xingye-gifts/space/09-orrery.png";
import imgSpaceConstellationPendant from "../../assets/xingye-gifts/space/10-constellation-pendant.png";

export type {
  XingyeGiftSetId,
  XingyeGiftSetKind,
} from "../../../../shared/xingye-gift-catalog-data";
import type { XingyeGiftSetId } from "../../../../shared/xingye-gift-catalog-data";
export { XINGYE_GIFT_SET_IDS, giftKey } from "../../../../shared/xingye-gift-catalog-data";

/** 复合键 `setId/giftId` → 打包后的图片 URL。 */
const GIFT_IMAGES: Record<string, string> = {
  "modern/rose_bouquet": imgModernRoseBouquet,
  "modern/perfume": imgModernPerfume,
  "modern/scarf": imgModernScarf,
  "modern/game_console": imgModernGameConsole,
  "modern/milk_tea": imgModernMilkTea,
  "modern/necklace": imgModernNecklace,
  "modern/instant_camera": imgModernInstantCamera,
  "modern/strawberry_cake": imgModernStrawberryCake,
  "modern/plush_bear": imgModernPlushBear,
  "modern/earphones": imgModernEarphones,
  "cn_ancient/jade_pendant": imgCnAncientJadePendant,
  "cn_ancient/silk_fan": imgCnAncientSilkFan,
  "cn_ancient/calligraphy_set": imgCnAncientCalligraphySet,
  "cn_ancient/hairpin": imgCnAncientHairpin,
  "cn_ancient/food_box": imgCnAncientFoodBox,
  "cn_ancient/tea_cake": imgCnAncientTeaCake,
  "cn_ancient/sachet": imgCnAncientSachet,
  "cn_ancient/scroll": imgCnAncientScroll,
  "cn_ancient/bronze_mirror": imgCnAncientBronzeMirror,
  "cn_ancient/paper_umbrella": imgCnAncientPaperUmbrella,
  "republican/pocket_watch": imgRepublicanPocketWatch,
  "republican/vinyl_record": imgRepublicanVinylRecord,
  "republican/fountain_pen": imgRepublicanFountainPen,
  "republican/lipstick": imgRepublicanLipstick,
  "republican/kaleidoscope": imgRepublicanKaleidoscope,
  "republican/lace_parasol": imgRepublicanLaceParasol,
  "republican/music_box": imgRepublicanMusicBox,
  "republican/candy_jar": imgRepublicanCandyJar,
  "republican/round_glasses": imgRepublicanRoundGlasses,
  "republican/radio": imgRepublicanRadio,
  "west_medieval/signet_ring": imgWestMedievalSignetRing,
  "west_medieval/candlestick": imgWestMedievalCandlestick,
  "west_medieval/sword": imgWestMedievalSword,
  "west_medieval/heraldic_shield": imgWestMedievalHeraldicShield,
  "west_medieval/goblet": imgWestMedievalGoblet,
  "west_medieval/lute": imgWestMedievalLute,
  "west_medieval/hourglass": imgWestMedievalHourglass,
  "west_medieval/circlet": imgWestMedievalCirclet,
  "west_medieval/quill_ink": imgWestMedievalQuillInk,
  "west_medieval/chess_knight": imgWestMedievalChessKnight,
  "wuxia/sword_tassel": imgWuxiaSwordTassel,
  "wuxia/secret_manual": imgWuxiaSecretManual,
  "wuxia/jade_flute": imgWuxiaJadeFlute,
  "wuxia/wine_gourd": imgWuxiaWineGourd,
  "wuxia/bamboo_hat": imgWuxiaBambooHat,
  "wuxia/dagger": imgWuxiaDagger,
  "wuxia/thumb_ring": imgWuxiaThumbRing,
  "wuxia/wound_salve": imgWuxiaWoundSalve,
  "wuxia/go_set": imgWuxiaGoSet,
  "wuxia/folding_fan": imgWuxiaFoldingFan,
  "xianxia/spirit_stone": imgXianxiaSpiritStone,
  "xianxia/elixir_bottle": imgXianxiaElixirBottle,
  "xianxia/talisman": imgXianxiaTalisman,
  "xianxia/spirit_herb": imgXianxiaSpiritHerb,
  "xianxia/jade_slip": imgXianxiaJadeSlip,
  "xianxia/flying_sword": imgXianxiaFlyingSword,
  "xianxia/whisk": imgXianxiaWhisk,
  "xianxia/lotus_lamp": imgXianxiaLotusLamp,
  "xianxia/storage_pouch": imgXianxiaStoragePouch,
  "xianxia/immortal_peach": imgXianxiaImmortalPeach,
  "west_fantasy/magic_crystal": imgWestFantasyMagicCrystal,
  "west_fantasy/spell_scroll": imgWestFantasySpellScroll,
  "west_fantasy/potion": imgWestFantasyPotion,
  "west_fantasy/grimoire": imgWestFantasyGrimoire,
  "west_fantasy/dragon_scale": imgWestFantasyDragonScale,
  "west_fantasy/elf_brooch": imgWestFantasyElfBrooch,
  "west_fantasy/crystal_ball": imgWestFantasyCrystalBall,
  "west_fantasy/enchanted_rose": imgWestFantasyEnchantedRose,
  "west_fantasy/fairy_dust_jar": imgWestFantasyFairyDustJar,
  "west_fantasy/wand": imgWestFantasyWand,
  "steampunk/gear_watch": imgSteampunkGearWatch,
  "steampunk/airship_model": imgSteampunkAirshipModel,
  "steampunk/brass_goggles": imgSteampunkBrassGoggles,
  "steampunk/clockwork_bird": imgSteampunkClockworkBird,
  "steampunk/train_model": imgSteampunkTrainModel,
  "steampunk/pressure_gauge": imgSteampunkPressureGauge,
  "steampunk/brass_telescope": imgSteampunkBrassTelescope,
  "steampunk/gear_pendant": imgSteampunkGearPendant,
  "steampunk/filament_lamp": imgSteampunkFilamentLamp,
  "steampunk/brass_compass": imgSteampunkBrassCompass,
  "cyberpunk/neural_chip": imgCyberpunkNeuralChip,
  "cyberpunk/holo_projector": imgCyberpunkHoloProjector,
  "cyberpunk/data_shard": imgCyberpunkDataShard,
  "cyberpunk/mech_butterfly": imgCyberpunkMechButterfly,
  "cyberpunk/energy_drink": imgCyberpunkEnergyDrink,
  "cyberpunk/holo_cat": imgCyberpunkHoloCat,
  "cyberpunk/robo_dog": imgCyberpunkRoboDog,
  "cyberpunk/crypto_key": imgCyberpunkCryptoKey,
  "cyberpunk/spray_can": imgCyberpunkSprayCan,
  "cyberpunk/mini_drone": imgCyberpunkMiniDrone,
  "wasteland/purified_water": imgWastelandPurifiedWater,
  "wasteland/canned_food": imgWastelandCannedFood,
  "wasteland/bottlecap_string": imgWastelandBottlecapString,
  "wasteland/gas_mask": imgWastelandGasMask,
  "wasteland/crank_radio": imgWastelandCrankRadio,
  "wasteland/shell_windchime": imgWastelandShellWindchime,
  "wasteland/salvaged_book": imgWastelandSalvagedBook,
  "wasteland/map_fragment": imgWastelandMapFragment,
  "wasteland/tin_can_plant": imgWastelandTinCanPlant,
  "wasteland/solar_lantern": imgWastelandSolarLantern,
  "space/meteorite": imgSpaceMeteorite,
  "space/star_projector": imgSpaceStarProjector,
  "space/zero_g_plant": imgSpaceZeroGPlant,
  "space/space_food": imgSpaceSpaceFood,
  "space/starship_model": imgSpaceStarshipModel,
  "space/astronaut_figurine": imgSpaceAstronautFigurine,
  "space/moon_lamp": imgSpaceMoonLamp,
  "space/stardust_vial": imgSpaceStardustVial,
  "space/orrery": imgSpaceOrrery,
  "space/constellation_pendant": imgSpaceConstellationPendant,
};

export interface XingyeGiftItem extends XingyeGiftItemData {
  /** 打包后的图片 URL（Vite 静态 import）。 */
  image: string;
}

export interface XingyeGiftSet extends Omit<XingyeGiftSetData, 'items'> {
  items: XingyeGiftItem[];
}

/** 数据层 + 图片：每个 item 按复合键挂回 image，集元信息原样透传。 */
export const XINGYE_GIFT_SETS: XingyeGiftSet[] = XINGYE_GIFT_SETS_DATA.map((set) => ({
  ...set,
  items: set.items.map((item) => ({
    ...item,
    image: GIFT_IMAGES[giftKey(set.id, item.id)] ?? '',
  })),
}));

const SET_BY_ID = new Map(XINGYE_GIFT_SETS.map((set) => [set.id, set]));
const GIFT_BY_KEY = new Map(
  XINGYE_GIFT_SETS.flatMap((set) => set.items.map((item) => [giftKey(set.id, item.id), item] as const)),
);

export function getGiftSet(id: XingyeGiftSetId): XingyeGiftSet {
  const set = SET_BY_ID.get(id);
  if (!set) throw new Error('unknown gift set: ' + id);
  return set;
}

/** setId/giftId 复合键查询；找不到返回 null（礼物 id 仅在集内唯一）。 */
export function getGiftByKey(setId: XingyeGiftSetId, giftId: string): XingyeGiftItem | null {
  return GIFT_BY_KEY.get(giftKey(setId, giftId)) ?? null;
}
