import type { TypeInfo } from "@/lib/fittings/eft";

// Real type ids/groups, so fixtures read like the game; slot kinds as the dogma effects give them.
export const TYPES: TypeInfo[] = [
  { id: 587, name: "Rifter", groupId: 25, categoryId: 6, slot: null },
  { id: 2048, name: "Damage Control II", groupId: 60, categoryId: 7, slot: "lo" },
  { id: 31932, name: "Nanofiber Internal Structure II", groupId: 763, categoryId: 7, slot: "lo" },
  { id: 526, name: "Stasis Webifier II", groupId: 65, categoryId: 7, slot: "med" },
  { id: 3244, name: "Warp Disruptor II", groupId: 52, categoryId: 7, slot: "med" },
  { id: 2873, name: "200mm AutoCannon II", groupId: 55, categoryId: 7, slot: "hi" },
  { id: 31668, name: "Small Projectile Burst Aerator I", groupId: 779, categoryId: 7, slot: "rig" },
  { id: 2488, name: "Warrior II", groupId: 100, categoryId: 18, slot: null },
  { id: 185, name: "EMP S", groupId: 83, categoryId: 8, slot: null },
  { id: 28668, name: "Nanite Repair Paste", groupId: 916, categoryId: 17, slot: null },
];

export const BY_NAME = new Map(TYPES.map((type) => [type.name.toLowerCase(), type]));
export const BY_ID = new Map(TYPES.map((type) => [type.id, type]));
export const NAMES = new Map(TYPES.map((type) => [type.id, type.name]));

export const RIFTER_EFT = `[Rifter, Fast tackle]
Damage Control II
Nanofiber Internal Structure II

Stasis Webifier II
Warp Disruptor II /OFFLINE

200mm AutoCannon II, EMP S
200mm AutoCannon II, EMP S
[Empty High slot]

Small Projectile Burst Aerator I

Warrior II x2

EMP S x1000
Nanite Repair Paste x10
`;
