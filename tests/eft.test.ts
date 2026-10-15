import { describe, expect, it } from "vitest";
import { buildFit, EftError, fitSignature, parseEft, toEft } from "@/lib/fittings/eft";
import { BY_NAME, NAMES, RIFTER_EFT } from "./fixtures/types";

describe("parseEft", () => {
  it("reads the header, quantities, charges and skips empty slots", () => {
    const parsed = parseEft(RIFTER_EFT);
    expect(parsed.shipName).toBe("Rifter");
    expect(parsed.fitName).toBe("Fast tackle");
    expect(parsed.lines.map((line) => line.name)).not.toContain("[Empty High slot]");
    expect(parsed.lines.find((line) => line.name === "Warp Disruptor II")).toMatchObject({ counted: false });
    expect(parsed.lines.find((line) => line.name === "Warrior II")).toMatchObject({ quantity: 2, counted: true });
    expect(parsed.lines.find((line) => line.name === "200mm AutoCannon II")).toMatchObject({ charge: "EMP S" });
  });

  it("tolerates Windows line endings and leading blank lines", () => {
    expect(parseEft("\r\n\r\n[Rifter, x]\r\nDamage Control II\r\n").lines).toHaveLength(1);
  });

  it("rejects text without a header", () => {
    expect(() => parseEft("Damage Control II")).toThrow(EftError);
  });
});

describe("buildFit", () => {
  it("places modules by their own slot, bays by category", () => {
    const { shipTypeId, items, warnings } = buildFit(parseEft(RIFTER_EFT), BY_NAME);
    expect(shipTypeId).toBe(587);
    expect(items).toEqual([
      { type_id: 2048, flag: "LoSlot0", quantity: 1 },
      { type_id: 31932, flag: "LoSlot1", quantity: 1 },
      { type_id: 526, flag: "MedSlot0", quantity: 1 },
      { type_id: 3244, flag: "MedSlot1", quantity: 1 },
      { type_id: 2873, flag: "HiSlot0", quantity: 1 },
      { type_id: 2873, flag: "HiSlot1", quantity: 1 },
      { type_id: 31668, flag: "RigSlot0", quantity: 1 },
      { type_id: 2488, flag: "DroneBay", quantity: 2 },
      { type_id: 185, flag: "Cargo", quantity: 1000 },
      { type_id: 28668, flag: "Cargo", quantity: 10 },
    ]);
    // Both autocannons carry EMP S: one warning, not one per module.
    expect(warnings).toEqual(["EMP S loaded in 200mm AutoCannon II was left out: EVE fittings carry charges in cargo, not in modules."]);
  });

  it("does not depend on section order", () => {
    const shuffled = "[Rifter, x]\n200mm AutoCannon II\n\nDamage Control II\n";
    expect(buildFit(parseEft(shuffled), BY_NAME).items.map((item) => item.flag)).toEqual(["HiSlot0", "LoSlot0"]);
  });

  it("merges repeated bay lines", () => {
    const fit = buildFit(parseEft("[Rifter, x]\nWarrior II x2\nWarrior II x3\n"), BY_NAME);
    expect(fit.items).toEqual([{ type_id: 2488, flag: "DroneBay", quantity: 5 }]);
  });

  it("names every unknown item at once", () => {
    expect(() => buildFit(parseEft("[Rifter, x]\nFoo\nBar\nFoo\n"), BY_NAME)).toThrow("Unknown items: Foo, Bar.");
  });

  it("insists on a ship hull", () => {
    expect(() => buildFit(parseEft("[Warrior II, x]\nDamage Control II\n"), BY_NAME)).toThrow(/not a ship/);
  });

  it("refuses more modules of a kind than ESI can place", () => {
    const tooMany = `[Rifter, x]\n${"Small Projectile Burst Aerator I\n".repeat(4)}`;
    expect(() => buildFit(parseEft(tooMany), BY_NAME)).toThrow(/Too many rig/);
  });
});

describe("toEft and fitSignature", () => {
  it("round-trips through EFT to the same contents", () => {
    const original = buildFit(parseEft(RIFTER_EFT), BY_NAME);
    const text = toEft({ name: "Fast tackle", shipTypeId: original.shipTypeId, items: original.items }, NAMES);
    expect(text.startsWith("[Rifter, Fast tackle]\nDamage Control II\nNanofiber Internal Structure II\n\nStasis Webifier II")).toBe(true);
    const again = buildFit(parseEft(text), BY_NAME);
    expect(fitSignature(again.shipTypeId, again.items)).toBe(fitSignature(original.shipTypeId, original.items));
  });

  it("ignores which slot number a module occupies", () => {
    const a = [{ type_id: 2873, flag: "HiSlot0", quantity: 1 }];
    const b = [{ type_id: 2873, flag: "HiSlot3", quantity: 1 }];
    expect(fitSignature(587, a)).toBe(fitSignature(587, b));
    expect(fitSignature(587, a)).not.toBe(fitSignature(587, [{ type_id: 2873, flag: "MedSlot0", quantity: 1 }]));
  });
});
