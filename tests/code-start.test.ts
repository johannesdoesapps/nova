/**
 * Orbis Code's start screen isn't only a website builder: a new project's type comes from what the request
 * describes (or the user's choice), and the examples cover websites, scripts, APIs and command-line tools.
 */
import { describe, expect, it } from "vitest";
import { CODE_EXAMPLES, projectTypeFor, SITE_EXAMPLES } from "@/lib/code/site-examples";

describe("a new project's type from the request", () => {
  it.each([
    ["Build a landing page for my bakery", "website"],
    ["Make a quiz game for my class", "website"],
    ["A React dashboard for my sales data", "website"],
    ["Write a Python script that renames my photos by date", "python"],
    ["Analyse sales.csv with pandas", "python"],
    ["Build a Node.js API for a to-do list", "node"],
    ["Make a Discord bot that posts a daily quote", "node"],
    ["Create a command-line tip calculator", "node"],
    ["A REST API with an admin dashboard", "node"],
    ["Implement a sorting algorithm and explain it", "blank"],
  ])("%s → %s", (request, type) => {
    expect(projectTypeFor(request)).toBe(type);
  });

  it("every example starts the kind of project it describes", () => {
    for (const x of SITE_EXAMPLES) expect(projectTypeFor(x.prompt), x.label).toBe("website");
    expect(CODE_EXAMPLES.map((x) => projectTypeFor(x.prompt))).toEqual(["python", "node", "node"]);
  });
});
