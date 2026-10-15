import { describe, expect, it } from "vitest";
import type { Viewer } from "@/lib/auth/accounts";
import { canDeleteFitting, canEditFitting, canViewFitting } from "@/lib/permissions";

const CORP = 98000001;
const viewer = (userId: string, corporationId: number | null, isAdmin = false): Viewer => ({
  userId,
  isAdmin,
  main: { id: 1, name: "Pilot", corporationId, allianceId: null },
});

const owner = viewer("owner", CORP);
const corpmate = viewer("corpmate", CORP);
const outsider = viewer("outsider", 98000002);
const admin = viewer("admin", 98000002, true);

const fit = (visibility: "private" | "corporation" | "link" | "public") => ({
  ownerId: "owner",
  visibility,
  corporationId: visibility === "corporation" ? CORP : null,
  shareToken: visibility === "link" ? "secret" : null,
});

describe("canViewFitting", () => {
  it.each([
    // visibility, viewer, token, expected
    ["private", owner, undefined, true],
    ["private", corpmate, undefined, false],
    ["private", admin, undefined, false],
    ["corporation", corpmate, undefined, true],
    ["corporation", outsider, undefined, false],
    ["corporation", null, undefined, false],
    ["link", outsider, "secret", true],
    ["link", null, "secret", true],
    ["link", corpmate, undefined, false],
    ["link", corpmate, "wrong", false],
    ["public", null, undefined, true],
  ] as const)("%s fit, viewer %#", (visibility, who, token, expected) => {
    expect(canViewFitting(who, fit(visibility), token)).toBe(expected);
  });

  it("follows the viewer's current main: switching main to another corp drops corp access", () => {
    expect(canViewFitting(viewer("corpmate", 98000002), fit("corporation"))).toBe(false);
  });
});

describe("edit and delete", () => {
  it("lets only the owner edit", () => {
    expect(canEditFitting(owner, fit("public"))).toBe(true);
    expect(canEditFitting(corpmate, fit("corporation"))).toBe(false);
    expect(canEditFitting(admin, fit("public"))).toBe(false);
  });

  it("lets admins take down shared fits but not private ones", () => {
    expect(canDeleteFitting(admin, fit("public"))).toBe(true);
    expect(canDeleteFitting(admin, fit("private"))).toBe(false);
  });
});
