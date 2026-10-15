import { describe, expect, it } from "vitest";
import type { Viewer } from "@/lib/auth/accounts";
import { canDeleteFitting, canEditFitting, canManageDoctrines, canReadAudit, canViewFitting, fitsDoctrine } from "@/lib/permissions";

const CORP = 98000001;
const viewer = (userId: string, corporationId: number | null, isSuperUser = false): Viewer => ({
  userId,
  isSuperUser,
  main: { id: 1, name: "Pilot", corporationId, allianceId: null },
});

const owner = viewer("owner", CORP);
const corpmate = viewer("corpmate", CORP);
const outsider = viewer("outsider", 98000002);
const admin = viewer("admin", 98000002, true);
const corpAdmin = viewer("corp-admin", CORP, true);

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

  it("lets super users take down public fits and their own corporation's fits only", () => {
    expect(canDeleteFitting(admin, fit("public"))).toBe(true);
    expect(canDeleteFitting(admin, fit("corporation"))).toBe(false);
    expect(canDeleteFitting(corpAdmin, fit("corporation"))).toBe(true);
    expect(canDeleteFitting(corpAdmin, fit("link"))).toBe(false);
    expect(canDeleteFitting(corpAdmin, fit("private"))).toBe(false);
  });
});

describe("super user scopes", () => {
  it("manages doctrines only for the main's corporation", () => {
    expect(canManageDoctrines(corpAdmin, CORP)).toBe(true);
    expect(canManageDoctrines(admin, CORP)).toBe(false);
    expect(canManageDoctrines(owner, CORP)).toBe(false);
  });

  it("admits only fits the whole corporation can see into a doctrine", () => {
    expect(fitsDoctrine(fit("corporation"), CORP)).toBe(true);
    expect(fitsDoctrine(fit("corporation"), 98000002)).toBe(false);
    expect(fitsDoctrine(fit("public"), 98000002)).toBe(true);
    expect(fitsDoctrine(fit("link"), CORP)).toBe(false);
  });

  it("reads corporation audit entries of its own corporation plus site-wide ones", () => {
    expect(canReadAudit(corpAdmin, CORP)).toBe(true);
    expect(canReadAudit(corpAdmin, null)).toBe(true);
    expect(canReadAudit(admin, CORP)).toBe(false);
    expect(canReadAudit(owner, null)).toBe(false);
  });
});

describe("strictSsl", () => {
  it("upgrades only the modes pg will weaken", async () => {
    const { strictSsl } = await import("@/db/connection-string");
    expect(strictSsl("postgres://h/db?sslmode=require&channel_binding=require")).toBe("postgres://h/db?sslmode=verify-full&channel_binding=require");
    expect(strictSsl("postgres://h/db?x=1&sslmode=prefer")).toBe("postgres://h/db?x=1&sslmode=verify-full");
    expect(strictSsl("postgres://127.0.0.1/db?sslmode=disable")).toBe("postgres://127.0.0.1/db?sslmode=disable");
  });
});
