import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_USER_ID,
  NoCurrentUserError,
  StaticCurrentUserProvider,
  currentUser,
  currentUserId,
  devUserProvider,
  hasCurrentUser,
  resetCurrentUserProvider,
  setCurrentUserProvider,
} from "./current-user.ts";
import { isUuid, type UserId } from "../ids.ts";

describe("currentUser()", () => {
  afterEach(() => resetCurrentUserProvider());

  it("throws until a provider is configured", () => {
    expect(() => currentUser()).toThrow(NoCurrentUserError);
    expect(hasCurrentUser()).toBe(false);
  });

  it("returns the development user through the dev provider", () => {
    setCurrentUserProvider(devUserProvider);
    expect(currentUser().id).toBe(DEV_USER_ID);
    expect(currentUserId()).toBe(DEV_USER_ID);
    expect(hasCurrentUser()).toBe(true);
  });

  it("the development identity is a UUID, not an email or machine name", () => {
    expect(isUuid(DEV_USER_ID)).toBe(true);
    expect(DEV_USER_ID).not.toContain("@");
  });

  it("can be swapped for another provider without changing call sites", () => {
    const other = "11111111-1111-4111-8111-111111111111" as UserId;
    setCurrentUserProvider(new StaticCurrentUserProvider({ id: other }));
    expect(currentUserId()).toBe(other);
    setCurrentUserProvider(devUserProvider);
    expect(currentUserId()).toBe(DEV_USER_ID);
  });

  it("propagates a provider that has no session as NoCurrentUserError semantics", () => {
    setCurrentUserProvider({
      get() {
        throw new NoCurrentUserError();
      },
    });
    expect(hasCurrentUser()).toBe(false);
    expect(() => currentUser()).toThrow(NoCurrentUserError);
  });
});
