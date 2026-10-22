/** The start-screen greeting: time of day plus the signed-in person's own first name. */
import { describe, expect, it } from "vitest";
import { greetingFor } from "@/components/studio/greeting";
import { displayNameFrom } from "@/lib/auth-flow";

describe("greeting", () => {
  it("uses each person's own first name", () => {
    expect(greetingFor(20, "Johannes Smith")).toBe("Good evening, Johannes");
    expect(greetingFor(9, "Ada Lovelace")).toBe("Good morning, Ada");
    expect(greetingFor(14, "  Grace  ")).toBe("Good afternoon, Grace");
  });

  it("says just the time of day when there's no name (guests)", () => {
    expect(greetingFor(14, null)).toBe("Good afternoon");
    expect(greetingFor(3, "")).toBe("Good evening");
  });

  it("GitHub sign-ins without a name use their username", () => {
    expect(displayNameFrom({ user_name: "octocat", preferred_username: "octocat" })).toBe("octocat");
    expect(displayNameFrom({ name: "Mona Lisa", user_name: "octocat" })).toBe("Mona Lisa");
    expect(displayNameFrom({})).toBeNull();
  });
});
