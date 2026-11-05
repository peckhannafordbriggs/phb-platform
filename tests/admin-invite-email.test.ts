import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInviteEmail, PLATFORM_PUBLIC_URL } from "@/lib/admin/invite-email";

describe("invite email", () => {
  it("points at the production URL and signs off with the inviter's name", () => {
    const { subject, body } = buildInviteEmail({ firstName: "Karthik", lastName: "Rachamolla" });

    expect(subject).toBe("You're invited to the PH+B Platform");
    expect(PLATFORM_PUBLIC_URL).toBe("https://platform.phb1899.com");
    expect(body).toContain(PLATFORM_PUBLIC_URL);
    expect(body).toContain("Sign in with Microsoft");
    expect(body).toContain("let me know you've signed up");
    expect(body.endsWith("Thanks,\nKarthik Rachamolla")).toBe(true);
    expect(body).not.toContain("localhost");
  });

  it("still reads correctly when the inviter has no name on file", () => {
    const { body } = buildInviteEmail({ firstName: " ", lastName: "" });
    expect(body.endsWith("\nThanks")).toBe(true);
  });

  it("the button copies only; it never calls an API that could send", async () => {
    const source = await readFile(
      path.join(process.cwd(), "app/(platform)/admin/invite-email-button.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/fetch\(|sendMail|\/api\//);
  });
});
